import { test } from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';

const account = 'AC' + 'a'.repeat(32), sid = 'SM' + 'b'.repeat(32), from = '+15005550006', to = '+15005550001';
let calls = 0;
const uniqueSid = () => 'SM' + (calls++).toString(16).padStart(32, '0');
function setup(overrides = {}, send = async () => ({ sid: calls++ ? uniqueSid() : sid, status: 'queued' })) {
  calls = 0;
  const store = new Store(':memory:');
  const { id } = store.create('Alex'); store.hostAction(id, 'location'); store.hostAction(id, 'vibe', { category: 'nature' }); store.hostAction(id, 'accept');
  const state = store.hostAction(id, 'invite', { names: ['Mike'] }), person = state.plan.participants[0];
  const env = { SMS_MODE: 'live', TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: 'test-token-not-a-real-credential', TWILIO_FROM_NUMBER: from,
    TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32), SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', SMS_ALLOWED_RECIPIENTS: to, PUBLIC_BASE_URL: 'https://rally.example', SMS_DAILY_LIMIT: '20', SMS_SEND_SPACING_MS: '0', ...overrides };
  const sms = new Sms(store, env, { messages: { create: send } });
  return { store, id, sms, env, person, preview: () => sms.preview(id, { participant: person.id, to, kind: 'invite' }) };
}
test('preview never sends; live requires allowlist, presenter authentication and explicit consent', async () => {
  let count = 0; const a = setup({ SMS_MODE: 'preview' }, async () => { count++; });
  assert.throws(() => a.sms.authorize('wrong'), /presenter password/); a.sms.authorize(a.env.SMS_OPERATOR_KEY);
  const draft = a.preview(); assert.match(draft.body, /sample outing/); assert.equal(draft.recipient.includes(to), false);
  await assert.rejects(a.sms.send(a.id, { id: draft.id, consent: true }), /disabled/); assert.equal(count, 0); a.store.close();
  const b = setup(); const d = b.preview(); await assert.rejects(b.sms.send(b.id, { id: d.id }), /agreed/);
  const other = b.sms.preview(b.id, { participant: b.person.id, to: '+15005550009', kind: 'invite' });
  await assert.rejects(b.sms.send(b.id, { id: other.id, consent: true }), /approved tester/); b.store.close();
});
test('concurrent clicks, new drafts and another session cannot duplicate or claim a send', async () => {
  let count = 0, complete; const a = setup({}, () => { count++; return new Promise(r => { complete = r; }); });
  const d = a.preview(), first = a.sms.send(a.id, { id: d.id, consent: true });
  assert.equal((await a.sms.send(a.id, { id: d.id, consent: true })).status, 'submitting');
  const other = a.store.create('Other'); await assert.rejects(a.sms.send(other.id, { id: d.id, consent: true }), /Preview/);
  complete({ sid, status: 'queued' }); await first;
  await assert.rejects(a.sms.send(a.id, { id: a.preview().id, consent: true }), /already/); assert.equal(count, 1); a.store.close();
});
test('changed plans invalidate drafts; daily cap survives demo reset', async () => {
  const a = setup({ SMS_DAILY_LIMIT: '1' }); const d = a.preview(); a.store.hostAction(a.id, 'addStop', { eventId: 'dinner' });
  await assert.rejects(a.sms.send(a.id, { id: d.id, consent: true }), /changed/);
  await a.sms.send(a.id, { id: a.preview().id, consent: true });
  a.store.reset(a.id); a.store.hostAction(a.id, 'vibe', { category: 'nature' }); a.store.hostAction(a.id, 'accept');
  const s = a.store.hostAction(a.id, 'invite', { names: ['Someone'] }); const next = a.sms.preview(a.id, { participant: s.plan.participants[0].id, to, kind: 'invite' });
  await assert.rejects(a.sms.send(a.id, { id: next.id, consent: true }), /daily/); a.store.close();
});
test('signed delivery callbacks reject modified URLs and cannot regress delivered status', async () => {
  const a = setup(); const d = a.preview(); await a.sms.send(a.id, { id: d.id, consent: true });
  const path = `/api/twilio/status?id=${d.id}`, params = { AccountSid: account, MessageSid: sid, MessageStatus: 'delivered' };
  const signature = twilio.getExpectedTwilioSignature(a.env.TWILIO_AUTH_TOKEN, a.env.PUBLIC_BASE_URL + path, params);
  a.sms.validate(path, signature, params); assert.throws(() => a.sms.validate(path + 'x', signature, params), /signature/);
  assert.throws(() => a.sms.validate(path, signature, { ...params, MessageStatus: 'failed' }), /signature/);
  a.sms.callback(d.id, params); a.sms.callback(d.id, { ...params, MessageStatus: 'sent' });
  assert.equal(a.sms.status(a.id).messages[0].status, 'delivered'); a.store.close();
});
test('incoming RSVP is shared once; STOP persists across reset and blocks later sends', async () => {
  const a = setup(); await a.sms.send(a.id, { id: a.preview().id, consent: true });
  const message = { MessageSid: 'SM' + 'c'.repeat(32), From: to, To: from, Body: 'YES' };
  assert.doesNotMatch(a.sms.inbound(message), /<Message>/); assert.equal(a.store.get(a.id).plan.participants[0].response, 'yes');
  await a.sms.idle(); assert.match(a.store.db.prepare("SELECT body FROM sms_log WHERE phone=? AND direction='out'").get(to).body, /You’re in/);
  const revision = a.store.get(a.id).revision; a.sms.inbound(message); assert.equal(a.store.get(a.id).revision, revision);
  assert.match(a.store.get(a.id).activity[0].text, /SMS/);
  a.sms.inbound({ ...message, MessageSid: 'SM' + 'd'.repeat(32), Body: 'STOP' });
  a.store.reset(a.id); a.store.hostAction(a.id, 'vibe', { category: 'nature' }); a.store.hostAction(a.id, 'accept');
  const s = a.store.hostAction(a.id, 'invite', { names: ['Mike'] }), d = a.sms.preview(a.id, { participant: s.plan.participants[0].id, to, kind: 'invite' });
  await assert.rejects(a.sms.send(a.id, { id: d.id, consent: true }), /opted out/); a.store.close();
});
test('US numbers are normalized and outbound uses the messaging service, not From', async () => {
  let payload; const a = setup({}, async options => { payload = options; return { sid, status: 'accepted' }; });
  const d = a.sms.preview(a.id, { participant: a.person.id, to: '(500) 555-0001', kind: 'invite' });
  assert.equal(d.allowed, true);
  assert.equal((await a.sms.send(a.id, { id: d.id, consent: true })).status, 'accepted');
  assert.equal(payload.to, to); assert.equal(payload.messagingServiceSid, a.env.TWILIO_MESSAGING_SERVICE_SID);
  assert.equal(payload.from, undefined); a.store.close();
});
test('replies go to the most recent plan; PLANS/SWITCH choose another; a timeout is not retried', async () => {
  const a = setup({}, async () => { throw new Error('timeout'); }); const d = a.preview();
  assert.equal((await a.sms.send(a.id, { id: d.id, consent: true })).status, 'unknown');
  assert.equal((await a.sms.send(a.id, { id: d.id, consent: true })).status, 'unknown');
  const b = a.store.create('Other'); a.store.hostAction(b.id, 'vibe', { category: 'nature' }); a.store.hostAction(b.id, 'accept');
  const s = a.store.hostAction(b.id, 'invite', { names: ['Same tester'] });
  const d2 = a.sms.preview(b.id, { participant: s.plan.participants[0].id, to, kind: 'invite' }); await a.sms.send(b.id, { id: d2.id, consent: true });
  a.sms.inbound({ MessageSid: 'SM' + 'e'.repeat(32), From: to, To: from, Body: 'YES' });
  assert.equal(a.store.get(a.id).plan.participants[0].response, 'pending'); assert.equal(a.store.get(b.id).plan.participants[0].response, 'yes');
  a.sms.inbound({ MessageSid: 'SM' + 'f'.repeat(32), From: to, To: from, Body: 'PLANS' });
  a.sms.inbound({ MessageSid: 'SM' + '1'.repeat(32), From: to, To: from, Body: 'SWITCH 2' });
  a.sms.inbound({ MessageSid: 'SM' + '2'.repeat(32), From: to, To: from, Body: 'maybe' });
  assert.equal(a.store.get(a.id).plan.participants[0].response, 'maybe'); assert.equal(a.store.get(b.id).plan.participants[0].response, 'yes');
  const bodies = a.store.db.prepare("SELECT body FROM sms_log WHERE phone=? AND direction='out' ORDER BY created").all(to).map(r => r.body).join('\n');
  assert.match(bodies, /1\) .*from Other/); await a.sms.idle(); a.store.close();
});
test('picture messages (MM ids) are accepted for inbound texts and delivery callbacks', async () => {
  const a = setup(); await a.sms.send(a.id, { id: a.preview().id, consent: true });
  a.sms.inbound({ MessageSid: 'MM' + 'c'.repeat(32), From: to, To: from, Body: 'YES', NumMedia: '1' });
  assert.equal(a.store.get(a.id).plan.participants[0].response, 'yes');
  await a.sms.idle(); a.store.close();
});
