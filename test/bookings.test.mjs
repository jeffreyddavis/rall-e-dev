import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { platformOf, prefill } from '../server/bookings.mjs';
import { eventById } from '../server/catalog.mjs';

const A = '+13107770921';
function setup(pages = {}) {
  const store = new Store(':memory:');
  const env = { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', SMS_ALLOWED_RECIPIENTS: A };
  const fetchImpl = async url => pages[url] ? { ok: true, status: 200, text: async () => pages[url], json: async () => ({}) } : { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, fetchImpl);
  return { store, sms };
}

test('booking links: finds the venue\'s own booking page and fills in party, date and time', async () => {
  assert.equal(platformOf('https://www.opentable.com/r/casa-vega-sherman-oaks'), 'OpenTable');
  assert.equal(platformOf('https://resy.com/cities/la/venues/nua'), 'Resy');
  assert.equal(platformOf('https://example.com'), '');
  assert.equal(prefill('https://resy.com/cities/la/venues/nua', 'Resy', { date: '2026-10-03', party: 4 }), 'https://resy.com/cities/la/venues/nua?seats=4&date=2026-10-03');
  assert.equal(prefill('https://www.opentable.com/r/casa-vega?corrid=abc&sd=2025-01-13T23%3A00%3A00&p=2', 'OpenTable', { date: '2026-10-03', time: '19:30', party: 2 }), 'https://www.opentable.com/r/casa-vega?covers=2&dateTime=2026-10-03T19%3A30');
  const { store, sms } = setup({ 'https://nua.example/': '<a href="https://resy.com/cities/la/venues/nua">Reserve</a>' });
  sms.sources = null; // no robots check in this test
  const e = { ...eventById('dinner'), id: 'gp_test', placeId: null, website: 'https://nua.example/' };
  const r = await sms.bookings.reserve(A, null, e, { party: 4, date: '2026-10-03', time: '19:00' });
  assert.equal(r.platform, 'Resy'); assert.equal(r.exact, true);
  assert.equal(r.url, 'https://resy.com/cities/la/venues/nua?seats=4&date=2026-10-03');
  // no booking page: an OpenTable search for the place
  const r2 = await sms.bookings.reserve(A, null, { ...e, id: 'gp_other', website: 'https://nothing.example/' }, { party: 2, date: '2026-10-04', time: '18:00' });
  assert.equal(r2.exact, false); assert.match(r2.url, /^https:\/\/www\.opentable\.com\/s\?covers=2&dateTime=2026-10-04T18%3A00&term=/);
  store.close();
});

test('bookings and purchases roll up into transaction volume; lab numbers are left out', () => {
  const { store, sms } = setup(), b = sms.bookings;
  const id = b.record(A, null, { kind: 'reservation', merchant: 'Casa Vega', party: 4, status: 'link_sent' });
  b.update(A, null, { status: 'confirmed', confirmation: 'ABC123' });
  assert.equal(b.get(id).status, 'confirmed');
  b.record(A, null, { kind: 'tickets', merchant: 'Comedy Store', amountCents: 8400, status: 'purchased' });
  b.record('+13105550150', null, { kind: 'tickets', merchant: 'Lab', amountCents: 99999, status: 'purchased' });
  const r = b.report();
  assert.equal(r.all.count, 2); assert.equal(r.all.cents, 8400);
  assert.equal(r.all.byKind.reservation.count, 1); assert.equal(r.all.byKind.tickets.cents, 8400);
  assert.equal(r.recent.length, 2);
  store.close();
});

test('when Rall-e can call restaurants, a table offer asks "want me to call?" and never hands over the number', async () => {
  const { store, sms } = setup(); sms.sources = null;
  const e = { ...eventById('dinner'), id: 'gp_call', placeId: null, website: 'https://nothing.example/' };
  const agent = sms.flow.agent, input = { event_id: 'gp_call', party_size: 2, date: '2026-10-03', time: '19:00' };
  sms.bookings.reserve = async () => ({ exact: true, platform: 'Resy', url: 'https://resy.com/x', phone: '(310) 555-0144' });
  const { registerEvent } = await import('../server/catalog.mjs'); registerEvent(e);
  sms.voice = { enabled: true };
  const offer = await agent.run(A, 'book_table', input, { t: null }, 'book it');
  assert.match(offer, /want me to call them for you\?/); assert.match(offer, /Never give them the restaurant's phone number/);
  assert.ok(!offer.includes('555-0144'));
  sms.voice = { enabled: false };
  assert.match(await agent.run(A, 'book_table', input, { t: null }, 'book it'), /Their phone: \(310\) 555-0144/);
  store.close();
});
