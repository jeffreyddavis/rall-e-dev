import { test } from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';

const account = 'AC' + 'a'.repeat(32), sid = 'SM' + 'b'.repeat(32), from = '+15005550006', to = '+15005550001';
function setup(overrides = {}, send = async () => ({ sid, status: 'queued' })) {
  const store = new Store(':memory:');
  const { id } = store.create('Alex'); store.hostAction(id, 'location'); store.hostAction(id, 'vibe', { category: 'nature' }); store.hostAction(id, 'accept');
  const state = store.hostAction(id, 'invite', { names: ['Mike'] }), person = state.plan.participants[0];
  const env = { SMS_MODE: 'live', TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: 'test-token-not-a-real-credential', TWILIO_FROM_NUMBER: from,
    SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', SMS_ALLOWED_RECIPIENTS: to, PUBLIC_BASE_URL: 'https://rally.example', SMS_DAILY_LIMIT: '20', ...overrides };
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
  assert.match(a.sms.inbound(message), /RSVP is updated/); assert.equal(a.store.get(a.id).plan.participants[0].response, 'yes');
  const revision = a.store.get(a.id).revision; a.sms.inbound(message); assert.equal(a.store.get(a.id).revision, revision);
  assert.match(a.store.get(a.id).activity[0].text, /SMS/);
  a.sms.inbound({ ...message, MessageSid: 'SM' + 'd'.repeat(32), Body: 'STOP' });
  a.store.reset(a.id); a.store.hostAction(a.id, 'vibe', { category: 'nature' }); a.store.hostAction(a.id, 'accept');
  const s = a.store.hostAction(a.id, 'invite', { names: ['Mike'] }), d = a.sms.preview(a.id, { participant: s.plan.participants[0].id, to, kind: 'invite' });
  await assert.rejects(a.sms.send(a.id, { id: d.id, consent: true }), /opted out/); a.store.close();
});
test('an ambiguous reply cannot update two plans and a timeout is not retried', async () => {
  const a = setup({}, async () => { throw new Error('timeout'); }); const d = a.preview();
  assert.equal((await a.sms.send(a.id, { id: d.id, consent: true })).status, 'unknown');
  assert.equal((await a.sms.send(a.id, { id: d.id, consent: true })).status, 'unknown');
  const b = a.store.create('Other'); a.store.hostAction(b.id, 'vibe', { category: 'nature' }); a.store.hostAction(b.id, 'accept');
  const s = a.store.hostAction(b.id, 'invite', { names: ['Same tester'] });
  const d2 = a.sms.preview(b.id, { participant: s.plan.participants[0].id, to, kind: 'invite' }); await a.sms.send(b.id, { id: d2.id, consent: true });
  assert.match(a.sms.inbound({ MessageSid: 'SM' + 'e'.repeat(32), From: to, To: from, Body: 'YES' }), /more than one/);
  assert.equal(a.store.get(a.id).plan.participants[0].response, 'pending'); assert.equal(a.store.get(b.id).plan.participants[0].response, 'pending'); a.store.close();
});
