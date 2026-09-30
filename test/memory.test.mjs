import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { EVENTS } from '../server/catalog.mjs';
import { removePerson } from '../server/wipe.mjs';

const JEFF = '+13306975523', MIKE = '+13306975524';
function setup() {
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: '+15005550006', TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32),
    SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', SMS_ALLOWED_RECIPIENTS: `${JEFF},${MIKE}`, PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0' }, { messages: { create: async () => ({ sid: 'SM' + 'e'.repeat(32), status: 'queued' }) } });
  return { store, sms, m: sms.memory };
}

test('facts: remember, dedupe, opposite likes, sensitive and forbidden rules, forget', () => {
  const { store, m } = setup();
  m.remember(JEFF, { kind: 'like', value: 'Scenic drives' });
  assert.equal(m.remember(JEFF, { kind: 'like', value: 'scenic drives!' }).updated, true); // same fact, strengthened
  assert.equal(m.list(JEFF).length, 1);
  m.remember(JEFF, { kind: 'dislike', value: 'scenic drives' }); // changed their mind
  assert.deepEqual(m.list(JEFF).map(f => f.kind), ['dislike']);
  m.remember(JEFF, { kind: 'person', value: 'wife', about: 'Deborah' });
  assert.throws(() => m.remember(JEFF, { kind: 'note', value: 'card 4242 4242 4242 4242' }), /vault/);
  assert.throws(() => m.remember(JEFF, { kind: 'note', value: 'goes to church Sundays', sensitive: true, source: 'inferred' }), /only kept when they tell you/);
  m.remember(JEFF, { kind: 'rhythm', value: 'free Sunday afternoons', source: 'inferred' });
  assert.match(m.card(JEFF), /People: wife \(Deborah\).*Not into: scenic drives.*Usually: free Sunday afternoons\?/);
  assert.equal(m.card(MIKE), ''); // nothing leaks across people
  assert.deepEqual(m.forget(JEFF, 'deborah').map(f => f.value), ['wife']);
  assert.ok(!/Deborah/.test(m.card(JEFF)));
  store.close();
});

test('the card has a hard size cap and limits come first; stale guesses fade', () => {
  const { store, m } = setup();
  for (let i = 0; i < 40; i++) m.remember(JEFF, { kind: 'like', value: `a long description of a favorite thing number ${i}` });
  m.remember(JEFF, { kind: 'constraint', value: 'no car' });
  const card = m.card(JEFF);
  assert.ok(card.length <= 850, `card is ${card.length} chars`); assert.match(card, /^Limits: no car/);
  m.remember(JEFF, { kind: 'rhythm', value: 'early riser', source: 'inferred' });
  store.db.prepare("UPDATE memory_facts SET expires_at=1 WHERE value='early riser'").run();
  assert.ok(!m.list(JEFF).some(f => f.value === 'early riser'));
  for (let i = 0; i < 30; i++) m.remember(JEFF, { kind: 'note', value: `note ${i}` });
  assert.ok(m.list(JEFF).length <= 60);
  store.close();
});

test('behavior: picks and outings become "tends to pick"; old preferences migrate; wipes remove memory', () => {
  const { store, sms, m } = setup();
  const { id, state } = store.create('Jeff'), digest = store.digestOf(id); sms.flow.link(JEFF, digest, state, 'host');
  const comedy = EVENTS.find(e => e.category === 'comedy') || EVENTS[0];
  store.hostAction(id, 'location'); store.hostAction(id, 'vibe', { category: comedy.category }); store.hostAction(id, 'accept', { eventId: comedy.id }); store.hostAction(id, 'confirm'); store.hostAction(id, 'happened');
  assert.match(m.card(JEFF), new RegExp(`Tends to pick: ${comedy.category}`));
  store.db.prepare('DELETE FROM memory_meta').run(); store.db.prepare('DELETE FROM memory_signals').run();
  assert.ok(m.migrate() >= 1); assert.equal(m.migrate(), 0); // once
  m.remember(JEFF, { kind: 'home', value: 'Harbor Springs, MI' });
  removePerson(sms, JEFF);
  assert.equal(m.list(JEFF).length, 0); assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_signals WHERE person=?').get(JEFF).n, 0);
  store.close();
});
