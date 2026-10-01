import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { RESERVATION_OUTPUT } from '../server/voice.mjs';

const MEMBER = '+13107770921', VENUE = '+13107770922';
const DATE = `${new Date().getFullYear() + 1}-10-03`;
const EVENT = { id: 'gp_restaurant', placeId: 'place-123', venue: 'The Test Kitchen', short: 'The Test Kitchen' };
function setup(provider = 'twilio', outboundLimit = false) {
  const store = new Store(':memory:'), requests = [];
  const env = { SMS_MODE: 'live', VAPI_CALLS_ENABLED: 'live', VAPI_API_KEY: 'test-vapi-key', VAPI_PHONE_NUMBER_ID: 'voice-number-id',
    GOOGLE_MAPS_API_KEY: 'test-google-key', SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24',
    SMS_ALLOWED_RECIPIENTS: MEMBER, PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0' };
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/call') && init.method === 'POST' && outboundLimit)
      return { ok: false, status: 400, json: async () => ({ message: "Couldn't Start Call. Numbers Bought On Vapi Have A Daily Outbound Call Limit." }), headers: new Headers() };
    const data = String(url).includes('places.googleapis.com') ? { nationalPhoneNumber: VENUE, types: ['restaurant'], businessStatus: 'OPERATIONAL' }
      : String(url).includes('/phone-number/') ? { provider, status: 'active', number: '+13105550123' }
      : String(url).endsWith('/call') && init.method === 'POST' ? { id: 'vapi-call-1', status: 'queued' }
      : String(url).endsWith('/call/vapi-call-1') ? { id: 'vapi-call-1', status: 'ended', artifact: { structuredOutputs: { 'output-id': { name: RESERVATION_OUTPUT.name, result: { outcome: 'no_answer' } } } } }
      : {};
    return { ok: true, status: 200, json: async () => data, headers: new Headers() };
  };
  const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, fetchImpl);
  return { store, sms, requests, options: { party: 2, date: DATE, time: '19:00', requestText: 'Please call the restaurant' } };
}

test('restaurant call needs explicit request and handles the Vapi number outbound limit', async () => {
  const t = setup('vapi', true);
  await assert.rejects(t.sms.voice.start(MEMBER, null, EVENT, { ...t.options, requestText: 'Book it' }), /explicitly/);
  await assert.rejects(t.sms.voice.start(MEMBER, null, EVENT, t.options), /provider’s outbound limit/);
  assert.equal(t.requests.filter(r => r.url === 'https://api.vapi.ai/call').length, 1);
  assert.equal(t.sms.voice.list(MEMBER)[0].status, 'failed');
  t.store.close();
});

test('call request has no arbitrary destination or card data; signed callback confirms once', async () => {
  const t = setup(), voice = t.sms.voice;
  const started = await voice.start(MEMBER, null, { ...EVENT, phone: '+14155550199' }, t.options);
  const request = t.requests.find(r => r.url === 'https://api.vapi.ai/call');
  const payload = JSON.parse(request.init.body);
  assert.equal(payload.customer.number, VENUE);
  assert.match(payload.assistant.firstMessage, /AI assistant/);
  assert.equal(payload.assistant.artifactPlan.recordingEnabled, false);
  assert.equal(payload.assistant.artifactPlan.pcapEnabled, false);
  assert.equal(payload.assistant.artifactPlan.transcriptPlan.enabled, true);
  assert.deepEqual(payload.assistant.model.tools, [{ type: 'endCall' }]);
  assert.equal(payload.assistant.artifactPlan.structuredOutputs[0].name, RESERVATION_OUTPUT.name);
  assert.ok(!request.init.body.includes('14155550199'));
  const secret = payload.assistant.server.headers['x-rally-voice-secret'];
  assert.throws(() => voice.webhook(started.id, 'wrong', {}), /Invalid call webhook/);
  const report = { message: { type: 'end-of-call-report', call: { id: 'vapi-call-1' }, analysis: { structuredData: { outcome: 'confirmed', confirmed_date: DATE, confirmed_time: '19:00', confirmed_party: 2, confirmation: 'ABC123' } } } };
  voice.webhook(started.id, secret, report); voice.webhook(started.id, secret, report);
  assert.equal(t.sms.bookings.get(started.bookingId).status, 'confirmed');
  const texts = t.store.db.prepare("SELECT body FROM sms_log WHERE phone=? AND kind='booking'").all(MEMBER);
  assert.equal(texts.length, 1); assert.match(texts[0].body, /confirmed a table/);
  t.store.close();
});

test('call result for a changed time stays unconfirmed and missed webhook is reconciled', async () => {
  const t = setup(), voice = t.sms.voice;
  const started = await voice.start(MEMBER, null, EVENT, t.options);
  const request = JSON.parse(t.requests.find(r => r.url === 'https://api.vapi.ai/call').init.body);
  const secret = request.assistant.server.headers['x-rally-voice-secret'];
  voice.webhook(started.id, secret, { message: { type: 'end-of-call-report', call: { id: 'vapi-call-1' }, analysis: { structuredData: { outcome: 'confirmed', confirmed_date: DATE, confirmed_time: '20:00' } } } });
  assert.equal(t.sms.bookings.get(started.bookingId).status, 'requested');
  assert.match(t.store.db.prepare("SELECT body FROM sms_log WHERE kind='booking'").get().body, /did not confirm/);
  assert.equal(voice.list(MEMBER)[0].result, 'unclear');
  t.store.close();

  const u = setup(); const other = await u.sms.voice.start(MEMBER, null, EVENT, u.options);
  u.store.db.prepare('UPDATE voice_calls SET created=? WHERE id=?').run(Date.now() - 60000, other.id);
  await u.sms.voice.reconcile();
  assert.equal(u.sms.voice.list(MEMBER)[0].result, 'no_answer');
  assert.equal(u.store.db.prepare("SELECT COUNT(*) n FROM sms_log WHERE kind='booking'").get().n, 1);
  u.store.close();
});

test('documented call end reasons report no answer or start failure without claiming a booking', async () => {
  for (const reason of ['customer-did-not-answer', 'customer-busy', 'call.start.error-vapi-number-outbound-daily-limit']) {
    const t = setup(), voice = t.sms.voice;
    const started = await voice.start(MEMBER, null, EVENT, t.options);
    voice.complete(started.id, { call: { id: 'vapi-call-1', endedReason: reason } });
    const failed = reason.startsWith('call.start');
    assert.equal(voice.list(MEMBER)[0].result, failed ? 'start_failed' : 'no_answer');
    const body = t.store.db.prepare("SELECT body FROM sms_log WHERE kind='booking'").get().body;
    assert.match(body, failed ? /could not connect/ : /No one answered/);
    assert.equal(t.sms.bookings.get(started.bookingId).status, failed ? 'failed' : 'requested');
    t.store.close();
  }
});

test('structured output arrives after the call ends and must confirm the exact party size', async () => {
  const t = setup(), voice = t.sms.voice;
  const started = await voice.start(MEMBER, null, EVENT, t.options);
  t.store.db.prepare('UPDATE voice_calls SET created=? WHERE id=?').run(Date.now() - 10 * 60000, started.id);
  const call = { id: 'vapi-call-1', endedAt: new Date().toISOString(), endedReason: 'assistant-ended-call' };
  voice.complete(started.id, { call });
  assert.equal(voice.list(MEMBER)[0].status, 'ended');
  assert.equal(t.store.db.prepare("SELECT COUNT(*) n FROM sms_log WHERE kind='booking'").get().n, 0);
  await assert.rejects(voice.start(MEMBER, null, EVENT, t.options), /already in progress/);
  voice.complete(started.id, { call, artifact: { structuredOutputs: { 'output-id': { name: RESERVATION_OUTPUT.name,
    result: { outcome: 'confirmed', confirmed_date: DATE, confirmed_time: '19:00', confirmed_party: 3 } } } } });
  assert.equal(t.sms.bookings.get(started.bookingId).status, 'requested');
  assert.equal(voice.list(MEMBER)[0].result, 'unclear');
  t.store.close();

  const u = setup(), other = await u.sms.voice.start(MEMBER, null, EVENT, u.options);
  u.sms.voice.complete(other.id, { call: { id: 'vapi-call-1', artifact: { structuredOutputs: { 'output-id': { name: RESERVATION_OUTPUT.name,
    result: { outcome: 'confirmed', confirmed_date: DATE, confirmed_time: '19:00', confirmed_party: 2 } } } } } });
  assert.equal(u.sms.bookings.get(other.bookingId).status, 'confirmed');
  u.store.close();
});

test('an authenticated result arriving before a create timeout is preserved and never leaves a pending call', async () => {
  const t = setup(), voice = t.sms.voice, original = voice.fetch;
  voice.fetch = async (url, init) => {
    if (String(url).endsWith('/call') && init?.method === 'POST') {
      const payload = JSON.parse(init.body), server = payload.assistant.server;
      voice.webhook(new URL(server.url).searchParams.get('id'), server.headers['x-rally-voice-secret'], {
        message: { type: 'end-of-call-report', call: { id: 'vapi-call-1' }, endedReason: 'customer-did-not-answer' }
      });
      throw new Error('create response timed out');
    }
    return original(url, init);
  };
  const call = await voice.start(MEMBER, null, EVENT, t.options);
  assert.equal(call.status, 'completed');
  assert.equal(voice.list(MEMBER)[0].result, 'no_answer');
  assert.equal(t.store.db.prepare("SELECT COUNT(*) n FROM sms_log WHERE kind='booking'").get().n, 1);
  t.store.close();
});
