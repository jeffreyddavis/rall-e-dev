import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';

const SECRET = 'inbound-test-secret-at-least-24-chars';
function setup() {
  const store = new Store(':memory:');
  const fetchImpl = async url => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ results: [{ geometry: { location: { lat: 34.05, lng: -118.24 } }, address_components: [], formatted_address: 'Los Angeles, CA' }] }) });
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', GOOGLE_MAPS_API_KEY: 'gk', ANTHROPIC_API_KEY: 'k', INBOUND_EMAIL_SECRET: SECRET }, { messages: { create: async () => ({}) } }, fetchImpl);
  const d1 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), d2 = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  let calls = 0;
  sms.flow.agent.fetch = async (url, init) => { calls++; assert.match(JSON.parse(init.body).messages[0].content, /Saturday run/);
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ usage: {}, content: [{ type: 'tool_use', name: 'save_newsletter', input: { city: 'Los Angeles, CA', events: [
      { title: 'Saturday Griffith Loop', date: d1, time: '07:00', venue: 'Griffith Park', price: 'Free' }, { title: 'Full Moon Run', date: d2, time: '20:00', venue: 'Silver Lake Reservoir' }, { title: 'Old run', date: '2020-01-01' }] } }] }) }; };
  return { store, sms, calls: () => calls };
}
const mail = (id, from = 'hello@echoparkrun.example') => ({ MessageID: id, From: from, FromFull: { Email: from, Name: 'Echo Park Run Club' }, To: 'events@rall-e.ai', OriginalRecipient: 'events@rall-e.ai', Subject: 'This month at EPRC', TextBody: 'Join our Saturday run at Griffith Park, 7 AM, free. Full moon run on the 15th at the reservoir. '.repeat(4) });

test('newsletters to events@: a new sender goes to review, approval adds the events and trusts the sender', async () => {
  const { store, sms, calls } = setup(), n = sms.newsletters;
  assert.equal(n.authorized(`Basic ${Buffer.from(`inbound:${SECRET}`).toString('base64')}`), true);
  assert.equal(n.authorized(`Basic ${Buffer.from('inbound:wrong').toString('base64')}`), false); assert.equal(n.authorized(''), false);
  assert.deepEqual(n.receive({ ...mail('m0'), To: 'jeff@rall-e.ai', OriginalRecipient: 'jeff@rall-e.ai' }), { ignored: true }); // only events@
  assert.deepEqual(n.receive(mail('m1')), { queued: true }); assert.deepEqual(n.receive(mail('m1')), { duplicate: true });
  await n.chain;
  const idea = sms.ideas.list().find(i => i.kind === 'newsletter');
  assert.match(idea.title, /Newsletter from Echo Park Run Club: 2 upcoming events/); assert.equal(idea.city, 'Los Angeles, CA');
  assert.equal(sms.sources.near({ lat: 34.05, lng: -118.24 }, { start: Date.now(), end: Date.now() + 30 * 86400000 }).length, 0); // nothing until approved
  const { result } = await sms.ideas.update(idea.id, { status: 'approved' });
  assert.match(result, /Added 2 events and trusted this sender/);
  const near = sms.sources.near({ lat: 34.05, lng: -118.24 }, { start: Date.now(), end: Date.now() + 30 * 86400000 });
  assert.deepEqual(near.map(e => e.short).sort(), ['Full Moon Run', 'Saturday Griffith Loop']); assert.equal(near[0].source, 'Echo Park Run Club newsletter');
  // The next newsletter from that sender goes straight in, no new idea.
  n.receive(mail('m2')); await n.chain;
  assert.equal(sms.ideas.list().filter(i => i.kind === 'newsletter').length, 1); assert.equal(calls(), 2);
  assert.equal(n.recent()[0].status, 'added');
  store.close();
});

test('declining a newsletter blocks the sender', async () => {
  const { store, sms, calls } = setup(), n = sms.newsletters;
  n.receive(mail('b1', 'spam@nope.example')); await n.chain;
  const idea = sms.ideas.list().find(i => i.kind === 'newsletter');
  assert.match((await sms.ideas.update(idea.id, { status: 'declined' })).result, /Sender blocked/);
  assert.deepEqual(n.receive(mail('b2', 'spam@nope.example')), { blocked: true }); await n.chain;
  assert.equal(calls(), 1); // never read again
  store.close();
});
