import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { Signup } from '../server/signup.mjs';

const JEFF = '+13306975523', TORI = '+14155550123';
function setup(env = {}) {
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'test-token', TWILIO_FROM_NUMBER: '+15005550006',
    TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32), SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', SMS_ALLOWED_RECIPIENTS: JEFF,
    PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', ...env }, { messages: { create: async () => ({ sid: 'SM' + 'd'.repeat(32), status: 'queued' }) } });
  const signup = new Signup(store, sms, { guess: async () => null });
  const texts = phone => store.db.prepare("SELECT body, kind, status FROM sms_log WHERE phone=? AND direction='out' ORDER BY rowid").all(phone);
  // What the /i/<code> page does: code (with consent), verify, create the account, record the join.
  const join = (code, phone, name) => {
    sms.invites.check(code);
    signup.sendCode({ phone, join: `invite:${code}`, consent: true });
    const otp = /code is (\d{6})/.exec(texts(phone).filter(x => x.kind === 'otp').at(-1).body)[1];
    const v = signup.verify({ phone, code: otp });
    signup.create(v.verification, name, '');
    return sms.invites.recordJoin(code, phone, name);
  };
  return { store, sms, signup, texts, join };
}

test('members get reusable invite links; a join counts, opts the friend in and tells the inviter', () => {
  const t = setup();
  const { store: s } = t; const { id } = s.create('Jeff'); t.sms.flow.link(JEFF, s.digestOf(id), s.get(id), 'host');
  assert.throws(() => t.sms.invites.create(TORI), /Only Rall-e members/);
  const code = t.sms.invites.defaultLink(JEFF);
  assert.match(code, /^jeff-[a-z0-9]{5}$/); assert.equal(t.sms.invites.defaultLink(JEFF), code); // stable
  assert.deepEqual(t.sms.invites.lookup(code), { code, owner: JEFF, inviter: 'Jeff', remaining: 10 });
  assert.throws(() => t.sms.invites.create(JEFF, 'Bad Name'), /lowercase/);
  assert.equal(t.sms.invites.create(JEFF, 'friends-of-jeff').url, 'https://rall-e.ai/i/friends-of-jeff');
  assert.throws(() => t.sms.invites.create(JEFF, 'friends-of-jeff'), /taken/);
  assert.equal(t.join('friends-of-jeff', TORI, 'Tori'), true);
  assert.ok(t.sms.allowed.has(TORI)); // opted in with consent + code
  assert.equal(t.sms.flow.threadsFor(TORI)[0].role, 'host');
  assert.match(t.texts(TORI).find(x => x.kind === 'welcome').body, /Welcome to Rall-e, Tori!/);
  assert.match(t.texts(JEFF).at(-1).body, /Tori just joined Rall-e with your invite! 1 of 10 invites used/);
  assert.equal(t.sms.invites.recordJoin(code, TORI, 'Tori'), false); // counted once
  const view = t.sms.invites.view(JEFF);
  assert.equal(view.used, 1); assert.deepEqual(view.links.map(l => [l.code, l.joins]), [[code, 0], ['friends-of-jeff', 1]]); assert.equal(view.joined[0].name, 'Tori');
  // Tori is a member now and has her own invites.
  assert.equal(t.sms.invites.lookup(t.sms.invites.defaultLink(TORI)).remaining, 10);
  t.store.close();
});

test('used-up invites send people to the waitlist; the private page link works and expires', () => {
  const t = setup({ INVITES_PER_USER: '1' });
  const { id } = t.store.create('Jeff'); t.sms.flow.link(JEFF, t.store.digestOf(id), t.store.get(id), 'host');
  const code = t.sms.invites.defaultLink(JEFF);
  t.join(code, TORI, 'Tori');
  assert.throws(() => t.sms.invites.check(code), /all used up.*waitlist/);
  assert.throws(() => t.sms.invites.lookup('nope-nope-nope'), /isn’t working/);
  const page = t.sms.invites.pageLink(JEFF), token = page.split('/me/')[1];
  assert.equal(t.sms.invites.phoneFor(token), JEFF);
  t.store.db.prepare('UPDATE me_links SET expires=0').run();
  assert.throws(() => t.sms.invites.phoneFor(token), /expired/);
  const w = t.sms.invites.joinWaitlist('+12125550100', 'Sam');
  assert.deepEqual(w, { waitlisted: true, position: 1 }); assert.deepEqual(t.sms.invites.joinWaitlist('+12125550100', 'Sam'), { waitlisted: true, position: 1 });
  assert.deepEqual(t.sms.invites.joinWaitlist(JEFF, 'Jeff'), { member: true });
  assert.throws(() => t.sms.invites.joinWaitlist('+1212', 'Sam'), /US mobile/);
  t.store.close();
});
