import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { EVENTS } from '../server/catalog.mjs';

const JULIAN = '+13306975523', MIKE = '+13306975524', DAVE = '+13306975525';
test('group poll: friends pick, rank or defer; the host is texted and sees the tally', () => {
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: '+15005550006', TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32),
    SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', SMS_ALLOWED_RECIPIENTS: `${JULIAN},${MIKE}`, PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0' }, { messages: { create: async () => ({ sid: 'SM' + 'f'.repeat(32), status: 'queued' }) } });
  const { id, state } = store.create('Julian'), digest = store.digestOf(id); sms.flow.link(JULIAN, digest, state, 'host');
  store.hostAction(id, 'location'); store.hostAction(id, 'vibe', { category: 'dinner' }); store.hostAction(id, 'accept');
  const s = store.hostAction(id, 'invite', { names: ['Mike', 'Dave', 'Sam'] }), [mike, dave, sam] = s.plan.participants;
  sms.flow.linkGuest(digest, s, mike.id, MIKE); sms.flow.linkGuest(digest, s, dave.id, DAVE);
  const t = { digest, s: store.get(id), phone: JULIAN };
  const ids = EVENTS.slice(0, 3).map(e => e.id);
  assert.throws(() => sms.polls.create(t, { title: 'x', eventIds: [ids[0]] }), /at least 2/);
  const r = sms.polls.create(t, { title: 'Saturday dinner', eventIds: ids });
  assert.deepEqual(r.texted, ['Mike']); assert.deepEqual(r.forward.map(f => f.name), ['Dave', 'Sam']); // Dave isn't opted in; Sam has no phone
  const out = phone => store.db.prepare("SELECT body FROM sms_log WHERE phone=? AND direction='out' ORDER BY rowid DESC").get(phone)?.body || '';
  const mikeLink = /\/q\/([\w-]{16})/.exec(out(MIKE))[1];
  assert.match(out(MIKE), /Julian wants the group’s take on Saturday dinner/);
  let v = sms.polls.view(mikeLink);
  assert.equal(v.total, 4); assert.equal(v.answered, 0); assert.equal(v.asker, 'Julian'); assert.equal(v.tally, null); assert.equal(v.options.length, 3);
  v = sms.polls.answer(mikeLink, { mode: 'pick', pick: ids[1] });
  assert.equal(v.answered, 1); assert.equal(v.people.find(p => p.name === 'Mike').answer.pick, ids[1]);
  assert.match(out(JULIAN), /Mike picked .* 1 of 4 answered/);
  sms.polls.answer(r.forward[0].link.split('/q/')[1], { mode: 'rank', ranking: [ids[2], ids[1], ids[0]] });
  assert.throws(() => sms.polls.answer(r.forward[1].link.split('/q/')[1], { mode: 'rank', ranking: [ids[0]] }), /Rank all/);
  sms.polls.answer(r.forward[1].link.split('/q/')[1], { mode: 'defer' });
  assert.match(out(JULIAN), /everyone has weighed in on Saturday dinner\. .* comes out on top/);
  const host = sms.polls.view(r.hostLink.split('/q/')[1]);
  assert.equal(host.isHost, true); assert.equal(host.tally.order[0], ids[1]);
  assert.match(sms.polls.openFor(t.s.id), /Open poll "Saturday dinner": 3 of 4 answered.*Waiting on: Julian/);
  store.hostAction(id, 'confirm'); assert.equal(sms.polls.openFor(t.s.id), '');
  assert.throws(() => sms.polls.answer(mikeLink, { mode: 'pick', pick: ids[0] }), /closed/);
  store.close();
});
