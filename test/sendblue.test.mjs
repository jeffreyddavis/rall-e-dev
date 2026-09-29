import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';

const ME = '+13306975523', LINE = '+13055550000', HOOK = 'h'.repeat(32);
function setup(env = {}, anthropic) {
  const store = new Store(':memory:'), calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body || '{}'); calls.push({ url, body, headers: init.headers });
    if (url.includes('api.anthropic.com')) return { ok: true, status: 200, json: async () => anthropic(body) };
    return { ok: true, status: 200, json: async () => url.endsWith('send-message') ? { message_handle: `OUT-${n++}`, status: 'QUEUED' } : { status: 'OK' } };
  };
  const sms = new Sms(store, { SMS_MODE: 'live', MESSAGING_PROVIDER: 'sendblue', SENDBLUE_API_KEY: 'k', SENDBLUE_API_SECRET: 's', SENDBLUE_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: HOOK,
    SMS_ALLOWED_RECIPIENTS: ME, SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', ...env }, undefined, fetchImpl);
  const inbound = (content, handle, extra = {}) => sms.sendblueInbound(HOOK, { content, from_number: ME, to_number: LINE, message_handle: handle, is_outbound: false, service: 'iMessage', ...extra });
  return { store, sms, calls, inbound, sent: () => calls.filter(c => c.url.endsWith('send-message')) };
}

test('Sendblue carries texts both ways as iMessage, with authenticated webhooks and delivery status', async () => {
  const t = setup();
  assert.equal(t.sms.provider, 'sendblue'); assert.equal(t.sms.live, true);
  assert.throws(() => t.sms.sendblueInbound('wrong', { content: 'hi' }), /Invalid webhook/);
  t.inbound('Hi', 'IN-1'); t.inbound('Hi', 'IN-1'); // duplicate delivery is ignored
  t.sms.sendblueInbound(HOOK, { content: 'echo', from_number: LINE, to_number: ME, message_handle: 'X', is_outbound: true });
  await t.sms.idle();
  const [first] = t.sent();
  assert.equal(t.sent().length, 1); assert.equal(first.body.number, ME); assert.equal(first.body.from_number, LINE); assert.match(first.body.content, /first name/);
  assert.equal(first.headers['sb-api-key-id'], 'k'); assert.match(first.body.status_callback, /^https:\/\/rall-e\.ai\/api\/sendblue\/status\?key=h{32}&log=/);
  const id = /log=(.+)$/.exec(first.body.status_callback)[1];
  t.sms.sendblueStatus(HOOK, id, { message_handle: 'OUT-0', status: 'DELIVERED' });
  assert.equal(t.store.db.prepare('SELECT status, sid FROM sms_log WHERE id=?').get(id).status, 'delivered');
  t.inbound('Jeff', 'IN-2'); await t.sms.idle();
  assert.ok(t.sent().some(c => /Nice to meet you, Jeff/.test(c.body.content)));
  assert.ok(t.sent().some(c => (c.body.media_url || '').startsWith('https://rall-e.ai/rall-e.vcf'))); // contact card as iMessage attachment
  t.store.close();
});

test('the agent can tapback-react to an iMessage and shows a typing indicator; reactions are not offered for SMS', async () => {
  const replies = [
    body => { assert.ok(body.tools.some(x => x.name === 'react')); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'react', input: { reaction: '👋' } }, { type: 'tool_use', id: 't2', name: 'start_account', input: { first_name: 'Jeff' } }] }; },
    () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hey Jeff! Where are you based?' }] }),
    body => { assert.match(body.tools.find(x => x.name === 'react').description, /start of your reply/); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'react', input: { reaction: '👍' } }] }; },
    () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '' }] })
  ];
  const t = setup({ ANTHROPIC_API_KEY: 'a' }, body => replies.shift()(body));
  t.inbound("hey I'm Jeff", 'IN-9'); await t.sms.flow.idle(); await t.sms.idle();
  const reaction = t.calls.find(c => c.url.endsWith('send-reaction'));
  assert.deepEqual(reaction.body, { from_number: LINE, message_handle: 'IN-9', reaction: '👋' });
  assert.ok(t.calls.some(c => c.url.endsWith('send-typing-indicator') && c.body.number === ME));
  assert.equal(t.sent().filter(c => c.body.content === 'Hey Jeff! Where are you based?').length, 1);
  t.inbound('ok', 'IN-10', { service: 'SMS' }); await t.sms.flow.idle(); await t.sms.idle();
  assert.equal(replies.length, 0); // every scripted model turn was used (no silent fallback)
  assert.equal(t.sent().at(-1).body.content, '👍'); // no tapbacks over SMS: the emoji is sent as the text
  assert.equal(t.calls.filter(c => c.url.endsWith('send-reaction')).length, 1);
  t.store.close();
});

test('without Sendblue settings, Twilio stays the channel', () => {
  const t = setup({ SENDBLUE_API_KEY: '' });
  assert.equal(t.sms.provider, 'twilio'); t.store.close();
});

test('recipients Sendblue refuses (unverified on a sandbox line) fall back to Twilio SMS', async () => {
  const store = new Store(':memory:'), twilioSent = [], MIKE = '+14018712212';
  const contacts = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    if (url.endsWith('/api/v2/contacts')) contacts.push(body);
    if (url.endsWith('send-message') && body.number === MIKE) return { ok: false, status: 400, json: async () => ({ status: 'ERROR', error_message: 'This contact must be verified before sending messages to it.' }) };
    return { ok: true, status: 200, json: async () => ({ message_handle: 'OUT', status: 'QUEUED' }) };
  };
  const sms = new Sms(store, { SMS_MODE: 'live', MESSAGING_PROVIDER: 'sendblue', SENDBLUE_API_KEY: 'k', SENDBLUE_API_SECRET: 's', SENDBLUE_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: HOOK,
    TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: '+14157924712', TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32),
    SMS_ALLOWED_RECIPIENTS: `${ME},${MIKE}`, SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0' },
    { messages: { create: async p => { twilioSent.push(p); return { sid: 'SM' + String(twilioSent.length).padStart(32, '0'), status: 'queued' }; } } }, fetchImpl);
  sms.deliver(MIKE, 'hello Mike'); sms.deliver(MIKE, 'second'); sms.deliver(ME, 'hello Jeff'); await sms.idle();
  assert.deepEqual(twilioSent.map(p => p.to), [MIKE, MIKE, MIKE]);
  assert.equal(twilioSent[0].body, 'hello Mike'); assert.match(twilioSent[1].body, /Rall-e is on iMessage 💙 Tap https:\/\/rall-e\.ai\/imessage and hit send/); assert.equal(twilioSent[2].body, 'second');
  assert.ok(contacts.some(c => c.number === MIKE && c.sendblue_number === LINE)); // added as a Sendblue contact automatically
  await sms.nudgeImessage(MIKE); assert.equal(twilioSent.length, 3); // nudged only once
  sms.sendblueInbound(HOOK, { content: 'Hi Rall-e', from_number: MIKE, to_number: LINE, message_handle: 'IN-M', service: 'iMessage' }); // their first iMessage verifies them
  assert.equal(sms.sendblueRefused.has(MIKE), false);
  store.close();
});

import { reactionText } from '../server/textflow.mjs';
test('Android: looked-up SMS numbers skip Sendblue entirely, ANDROID/iPhone replies switch channels, reactions arrive as reactions', async () => {
  const store = new Store(':memory:'), twilioSent = [], sb = [], ANDY = '+14155550188';
  const fetchImpl = async (url, init) => {
    if (url.includes('evaluate-service')) return { ok: true, status: 200, json: async () => ({ number: ANDY, service: url.includes(encodeURIComponent(ANDY)) ? 'RCS' : 'iMessage' }) };
    sb.push({ url, body: JSON.parse(init.body || '{}') }); return { ok: true, status: 200, json: async () => ({ message_handle: 'H', status: 'QUEUED' }) };
  };
  const sms = new Sms(store, { SMS_MODE: 'live', MESSAGING_PROVIDER: 'sendblue', SENDBLUE_API_KEY: 'k', SENDBLUE_API_SECRET: 's', SENDBLUE_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: HOOK,
    TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: '+14157924712', TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32),
    SMS_ALLOWED_RECIPIENTS: `${ME},${ANDY}`, SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0' },
    { messages: { create: async p => { twilioSent.push(p); return { sid: 'SM' + String(twilioSent.length).padStart(32, '0'), status: 'queued' }; } } }, fetchImpl);
  sms.deliver(ANDY, 'hi from Rall-e'); await sms.idle();
  assert.deepEqual(twilioSent.map(p => p.body), ['hi from Rall-e']); assert.equal(sb.filter(c => c.url.endsWith('send-message')).length, 0);
  await sms.nudgeImessage(ANDY); assert.equal(twilioSent.length, 1); // no iMessage invite for Android
  assert.deepEqual(sms.phoneService(ANDY), { service: 'SMS', source: 'lookup' });
  // An iPhone owner who says they're on Android is respected over the lookup, and vice versa
  sms.flow.receive(ME, 'ANDROID'); await sms.idle();
  assert.deepEqual(sms.phoneService(ME), { service: 'SMS', source: 'user' });
  assert.match(twilioSent.at(-1).body, /regular texts it is/);
  await sms.setPhoneType(ANDY, 'iphone'); assert.equal(sms.phoneService(ANDY).service, 'iMessage');
  assert.equal(reactionText('Liked “See you at 6”'), '[Reacted 👍 to your message: "See you at 6"]');
  assert.equal(reactionText('😂 to "that was hilarious"'), '[Reacted 😂 to your message: "that was hilarious"]');
  assert.equal(reactionText('I liked the show'), 'I liked the show');
  // An Android user who texts the Sendblue line (RCS) is answered on that same line, not from the Twilio number.
  await sms.setPhoneType(ANDY, 'android'); await sms.idle();
  const before = twilioSent.length, sbBefore = sb.filter(c => c.url.endsWith('send-message')).length;
  sms.sendblueInbound(HOOK, { content: 'what time?', from_number: ANDY, to_number: LINE, message_handle: 'RCS-1', is_outbound: false, service: 'RCS' });
  sms.deliver(ANDY, 'reply on the same line'); await sms.idle();
  assert.equal(sms.lastLine(ANDY), 'sendblue');
  assert.ok(sb.filter(c => c.url.endsWith('send-message')).slice(sbBefore).some(c => c.body.content === 'reply on the same line'));
  assert.ok(!twilioSent.slice(before).some(p => p.body === 'reply on the same line'));
  await sms.idle(); store.close();
});

test('a dedicated line refuses people who have not texted it yet (INBOUND_ONLY_PLAN): they still get the text by Twilio', async () => {
  const store = new Store(':memory:'), twilioSent = [], MARC = '+16039868371';
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    if (url.includes('evaluate-service')) return { ok: true, status: 200, json: async () => ({ service: 'iMessage' }) };
    if (url.endsWith('send-message') && body.number === MARC) return { ok: false, status: 400, json: async () => ({ status: 'ERROR', error_message: 'INBOUND_ONLY_PLAN' }) };
    return { ok: true, status: 200, json: async () => ({ message_handle: 'OUT', status: 'QUEUED' }) };
  };
  const sms = new Sms(store, { SMS_MODE: 'live', MESSAGING_PROVIDER: 'sendblue', SENDBLUE_API_KEY: 'k', SENDBLUE_API_SECRET: 's', SENDBLUE_NUMBER: LINE, SENDBLUE_WEBHOOK_SECRET: HOOK,
    TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: '+14157924712', TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32),
    SMS_ALLOWED_RECIPIENTS: MARC, SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0' },
    { messages: { create: async p => { twilioSent.push(p); return { sid: 'SM' + String(twilioSent.length).padStart(32, '0'), status: 'queued' }; } } }, fetchImpl);
  sms.deliver(MARC, 'Mike is in'); await sms.idle();
  assert.equal(twilioSent[0].body, 'Mike is in');
  assert.notEqual(store.db.prepare("SELECT status FROM sms_log WHERE body='Mike is in'").get().status, 'failed');
  store.close();
});
