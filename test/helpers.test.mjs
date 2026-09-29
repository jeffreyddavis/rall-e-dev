import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { eventById } from '../server/catalog.mjs';

const ME = '+13105550101';
function setup() {
  const fetchImpl = async (url, init = {}) => {
    const reply = url.includes('api.weather.gov/points') ? { properties: { forecast: 'https://api.weather.gov/gridpoints/LOX/1,1/forecast', relativeLocation: { properties: { city: 'Beverly Hills' } } } }
      : url.includes('/forecast') ? { properties: { periods: [{ name: 'Saturday', startTime: '2026-10-03T06:00:00-07:00', temperature: 71, temperatureUnit: 'F', probabilityOfPrecipitation: { value: 70 }, shortForecast: 'Rain Showers', windSpeed: '5 mph' }] } }
      : url.includes('geocode') ? { results: [{ geometry: { location: { lat: 34.1, lng: -118.3 } } }] }
      : url.includes('contact.vcf') ? null : {};
    if (url.includes('contact.vcf')) return { ok: true, arrayBuffer: async () => Buffer.from('BEGIN:VCARD\r\nFN:Tori Smith\r\nTEL;type=CELL:(415) 555-0123\r\nEND:VCARD') };
    return { ok: true, status: 200, headers: new Map(), json: async () => reply };
  };
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', GOOGLE_MAPS_API_KEY: 'gk', TICKETMASTER_API_KEY: 'tm' }, { messages: { create: async () => ({}) } }, fetchImpl);
  sms.discovery.saveLocation(ME, { label: 'Hollywood, Los Angeles, CA', lat: 34.1, lng: -118.33 });
  return { store, sms };
}

test('weather comes from the National Weather Service and is cached', async () => {
  const t = setup();
  const w = await t.sms.discovery.weather(t.sms.discovery.location(ME));
  assert.equal(w.place, 'Beverly Hills'); assert.match(t.sms.discovery.weatherText(w), /Saturday \(2026-10-03\): Rain Showers, 71°F, 70% chance of rain/);
  t.sms.discovery.fetch = async () => { throw new Error('should be cached'); };
  assert.equal((await t.sms.discovery.weather(t.sms.discovery.location(ME))).place, 'Beverly Hills');
  t.store.close();
});

test('their own event becomes a stop with a time, a place and coordinates; it can go in a calendar', async () => {
  const t = setup();
  const e = await t.sms.discovery.customEvent(ME, { title: 'BBQ at Jeff’s', date: '2026-10-03', time: '16:00', place: 'Jeff’s place', address: '123 Main St' });
  assert.match(e.id, /^cu_/); assert.equal(eventById(e.id).short, 'BBQ at Jeff’s'); assert.equal(e.time, 'Sat, Oct 3 · 4:00 PM'); assert.equal(e.startsAt, '2026-10-03T16:00:00');
  assert.deepEqual([e.lat, e.lng], [34.1, -118.3]);
  const errand = await t.sms.discovery.customEvent(ME, { title: 'Pick up milk' }); assert.equal(errand.time, 'Time to be decided'); assert.equal(errand.startsAt, null);
  await assert.rejects(t.sms.discovery.customEvent(ME, { title: '' }), /title/);
  t.store.close();
});

test('a contact card texted in is saved to the host’s contacts (and never texted)', async () => {
  const t = setup();
  const { id, state } = t.store.create('Jeff'); t.sms.flow.link(ME, t.store.digestOf(id), state, 'host');
  const note = await t.sms.flow.contactCard(ME, { url: 'https://example.com/contact.vcf', type: 'text/vcard' });
  assert.match(note, /shared a contact card: Tori Smith \(saved to their contacts/);
  assert.equal(t.sms.flow.contactFor(t.store.digestOf(id), 'Tori'), '+14155550123');
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM sms_log WHERE phone='+14155550123'").get().n, 0);
  t.store.close();
});
