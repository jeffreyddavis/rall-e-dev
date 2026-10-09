import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { QR_WORDS, qrCardPng, qrCardSvg } from '../server/qr.mjs';

const JEFF = '+13306975523', STRANGER = '+13105550199';
function setup() {
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'test-token', TWILIO_FROM_NUMBER: '+15005550006',
    TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32), SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', SMS_ALLOWED_RECIPIENTS: JEFF,
    PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0' }, { messages: { create: async () => ({ sid: 'SM' + 'd'.repeat(32), status: 'queued' }) } });
  const { id } = store.create('Jeff'); sms.flow.link(JEFF, store.digestOf(id), store.get(id), 'host');
  const texts = phone => store.db.prepare("SELECT body, kind, media FROM sms_log WHERE phone=? AND direction='out' ORDER BY rowid").all(phone);
  return { store, sms, texts };
}

test('QR keyword: the ways people ask, and not ordinary sentences', () => {
  for (const t of ['QR', 'qr code', 'My QR code', 'send me my invite QR code!', 'text me my Rall-e qr code please', 'show my qr']) assert.match(t, QR_WORDS, t);
  for (const t of ['is there a qr code for the museum?', 'qr code menu at dinner', 'the qr code didn\'t work']) assert.doesNotMatch(t, QR_WORDS, t);
});

test('the card is a portrait PNG with the inviter\'s name and link on it', async () => {
  const png = qrCardPng({ url: 'https://rall-e.ai/i/jeff-ab12c', name: 'Jeff' });
  const meta = await sharp(png).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 1080, 1350]);
  const svg = qrCardSvg({ url: 'https://rall-e.ai/i/jeff-ab12c', name: 'Jeff <b>' });
  assert.match(svg, /Jeff &lt;b&gt;’s invite/); assert.match(svg, /rall-e\.ai\/i\/jeff-ab12c/);
});

test('a member who texts "QR" gets their invite QR code as a picture; non-members get nothing', async () => {
  const t = setup(), code = t.sms.invites.defaultLink(JEFF);
  await t.sms.flow.receive(JEFF, 'my QR code');
  const sent = t.texts(JEFF).filter(x => x.kind === 'invite_qr');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].media, `https://rall-e.ai/i/${code}/qr.png`);
  assert.match(sent[0].body, /phone camera at it to join with your invite \(10 of 10 left\)\. It's also on your page, full screen: https:\/\/rall-e\.ai\/me\//);
  await t.sms.flow.receive(STRANGER, 'QR');
  assert.equal(t.texts(STRANGER).filter(x => x.kind === 'invite_qr').length, 0);
  await t.sms.idle(); t.store.close();
});
