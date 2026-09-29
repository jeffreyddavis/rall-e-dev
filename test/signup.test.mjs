import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { Signup } from '../server/signup.mjs';

const ME = '+13306975523';
function setup(overrides = {}) {
  const store = new Store(':memory:');
  const env = { SMS_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'test-token', TWILIO_FROM_NUMBER: '+15005550006',
    TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32), SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', SMS_ALLOWED_RECIPIENTS: ME,
    PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', ...overrides };
  let n = 0; const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + String(n++).padStart(32, '0'), status: 'queued' }) } });
  const signup = new Signup(store, sms);
  const texts = () => store.db.prepare("SELECT body, kind, media FROM sms_log WHERE phone=? AND direction='out' ORDER BY rowid").all(ME);
  const lastCode = () => /code is (\d{6})/.exec(texts().filter(x => x.kind === 'otp').at(-1).body)[1];
  return { store, sms, signup, texts, lastCode };
}

test('phone-first signup texts a code, links the phone, and signs a returning member back into the same account', async () => {
  const t = setup();
  assert.deepEqual(t.signup.sendCode({ phone: '(330) 697-5523' }), { sent: true });
  assert.throws(() => t.signup.sendCode({ phone: '330-697-5523' }), /30 seconds/);
  assert.throws(() => t.signup.verify({ phone: ME, code: '000000'.replace(/./g, (c, i) => String((Number(t.lastCode()[i]) + 1) % 10)) }), /doesn’t match/);
  const v = t.signup.verify({ phone: ME, code: t.lastCode() });
  assert.equal(v.existing, false); assert.ok(v.verification);
  assert.throws(() => t.signup.verify({ phone: ME, code: t.lastCode() }), /expired/); // codes are single-use
  const { id, state } = t.signup.create(v.verification, 'Jeff');
  assert.equal(state.name, 'Jeff');
  assert.throws(() => t.signup.create(v.verification, 'Jeff'), /expired/); // verification is single-use
  assert.equal(t.sms.flow.threadsFor(ME)[0].role, 'host');
  const kinds = t.texts().map(x => x.kind); assert.deepEqual(kinds, ['otp', 'welcome', 'card']);
  assert.match(t.texts()[1].body, /Welcome to Rall-e, Jeff! This is my number/);

  // Later, on another device: the same phone signs back into the same account.
  t.store.db.prepare('UPDATE signup_codes SET requested=? WHERE phone=?').run('[]', ME);
  t.signup.sendCode({ phone: ME });
  const again = t.signup.verify({ phone: ME, code: t.lastCode() });
  assert.equal(again.existing, true); assert.equal(again.name, 'Jeff');
  assert.equal(t.store.get(again.session).id, t.store.get(id).id);
  t.store.hostAction(again.session, 'location'); assert.equal(t.store.get(id).stage, 'vibe'); // the alias acts on the same plan
  await t.sms.idle(); t.store.close();
});

test('non-testers cannot receive codes in live mode; preview shows the code and never links the phone', async () => {
  const live = setup();
  assert.throws(() => live.signup.sendCode({ phone: '+14155550123' }), /approved testers/);
  assert.throws(() => live.signup.sendCode({ phone: '12' }), /US mobile/);
  await live.sms.idle(); live.store.close();
  const preview = setup({ SMS_MODE: 'preview' });
  const r = preview.signup.sendCode({ phone: ME }); assert.equal(r.sent, false); assert.match(r.demoCode, /^\d{6}$/);
  const v = preview.signup.verify({ phone: ME, code: r.demoCode });
  preview.signup.create(v.verification, 'Jeff');
  assert.equal(preview.sms.flow.threadsFor(ME).length, 0);
  preview.store.close();
});

test('five wrong codes lock the code', async () => {
  const t = setup(); t.signup.sendCode({ phone: ME });
  const wrong = t.lastCode() === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) assert.throws(() => t.signup.verify({ phone: ME, code: wrong }), /doesn’t match/);
  assert.throws(() => t.signup.verify({ phone: ME, code: t.lastCode() }), /Too many/);
  await t.sms.idle(); t.store.close();
});

test('someone new can opt in from a shared page: consent box + texted code, then Rall-e can text them', async () => {
  const t = setup(), TORI = '+14155550123';
  const code = () => /code is (\d{6})/.exec(t.store.db.prepare("SELECT body FROM sms_log WHERE phone=? AND kind='otp' ORDER BY rowid DESC").get(TORI).body)[1];
  assert.throws(() => t.signup.sendCode({ phone: TORI }), /approved testers/); // no join, no texts
  assert.throws(() => t.signup.sendCode({ phone: TORI, join: 'share-token' }), /Tick the box/);
  assert.deepEqual(t.signup.sendCode({ phone: TORI, join: 'share-token', consent: true }), { sent: true });
  assert.equal(t.sms.allowed.has(TORI), false); // not until they prove the number
  const v = t.signup.verify({ phone: TORI, code: code() });
  assert.equal(t.sms.allowed.has(TORI), true); assert.equal(t.sms.testers.has(TORI), false);
  t.signup.create(v.verification, 'Tori');
  assert.equal(t.sms.flow.threadsFor(TORI)[0].role, 'host');
  assert.ok(t.store.db.prepare("SELECT 1 FROM sms_log WHERE phone=? AND kind='welcome' AND status!='blocked'").get(TORI));
  assert.equal(new Sms(t.store, { SMS_MODE: 'preview' }).allowed.has(TORI), true); // remembered across restarts
  await t.sms.idle(); t.store.close();
});

test('self opt-ins are capped per day', async () => {
  const t = setup({ SMS_OPTIN_DAILY_LIMIT: '1' });
  t.sms.optIn('+14155550124', 'x', 'c');
  assert.throws(() => t.signup.sendCode({ phone: '+14155550125', join: 'x', consent: true }), /full for today/);
  await t.sms.idle(); t.store.close();
});
