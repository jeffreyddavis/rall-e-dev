import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';

const JEFF = '+13306975523', MIKE = '+13306975524';
const hasSharp = await import('sharp').then(() => true, () => false);
const photo = (w = 600, h = 400) => { const data = Buffer.alloc(w * h * 4, 180); return jpeg.encode({ data, width: w, height: h }, 90).data; };

test('profile photos: texted or uploaded, re-encoded to 320x320, shown on plan pages', { skip: !hasSharp && 'sharp not installed here' }, async () => {
  const store = new Store(':memory:');
  const fetches = [];
  const sms = new Sms(store, { SMS_MODE: 'live', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15005550006',
    TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'c'.repeat(32), SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', SMS_ALLOWED_RECIPIENTS: `${JEFF},${MIKE}`,
    PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0' }, { messages: { create: async () => ({ sid: 'SM' + 'e'.repeat(32), status: 'queued' }) } },
    async (url, init = {}) => { fetches.push({ url, auth: init.headers?.authorization }); return { ok: true, arrayBuffer: async () => photo(800, 1200) }; });
  const url = await sms.photos.save(JEFF, photo());
  assert.match(url, /^\/img\/u\/[\w-]{12}\.jpg$/); assert.equal(sms.photos.urlFor(JEFF), url);
  const out = jpeg.decode(sms.photos.image(url.slice(7, 19))); assert.deepEqual([out.width, out.height], [320, 320]);
  await assert.rejects(sms.photos.save(JEFF, Buffer.from('not an image')), /couldn’t open that photo/);
  // Texted in on Twilio: downloaded with our credentials.
  const again = await sms.photos.fromText(MIKE, { url: 'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM/Media/ME1' });
  assert.match(fetches[0].auth, /^Basic /); assert.ok(sms.photos.urlFor(MIKE) === again);
  // Plan pages carry the host's and friends' photos.
  const { id, state } = store.create('Jeff'); sms.flow.link(JEFF, store.digestOf(id), state, 'host');
  store.hostAction(id, 'location'); store.hostAction(id, 'vibe', { category: 'dinner' }); store.hostAction(id, 'accept');
  const s = store.hostAction(id, 'invite', { names: ['Mike'] }); sms.flow.linkGuest(store.digestOf(id), s, s.plan.participants[0].id, MIKE);
  const view = store.view(store.get(id));
  assert.equal(view.hostPhoto, url); assert.equal(view.plan.participants[0].photo, again);
  assert.equal(sms.photos.remove(JEFF), true); assert.equal(store.view(store.get(id)).hostPhoto, null);
  store.close();
});
