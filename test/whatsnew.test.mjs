import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { WhatsNew } from '../server/whatsnew.mjs';

const A = '+13107770911', B = '+13107770912', LAB = '+13105550199';
function setup() {
  const store = new Store(':memory:');
  const env = { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', SMS_ALLOWED_RECIPIENTS: `${A},${B}` };
  const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, async () => ({ ok: false, json: async () => ({}) }));
  const out = phone => store.db.prepare("SELECT body FROM sms_log WHERE phone=? AND direction='out' AND kind='update'").all(phone).map(r => r.body);
  return { store, sms, out };
}
// 3 PM in New York on a fixed day, so the 9 AM to 8 PM window is open.
const AFTERNOON = Date.parse('2026-10-01T19:00:00Z'), NIGHT = Date.parse('2026-10-02T03:00:00Z');

test('release notes go once to every member, combined, only in the daytime, and respect "no updates"', () => {
  const { store, sms, out } = setup();
  const w = new WhatsNew(sms, { releases: [{ id: 'r1', date: '2026-10-01', text: 'First thing.' }, { id: 'r2', date: '2026-10-01', text: 'Second thing.' }, { id: 'r3', date: '2026-10-01', text: 'Held.', hold: true }] });
  // the lab number is never an audience, even if it were allowed
  sms.allowed.add(LAB);
  assert.deepEqual(w.tick(NIGHT), []);
  assert.deepEqual(w.tick(AFTERNOON).sort(), [A, B]);
  assert.equal(out(A).length, 1);
  assert.match(out(A)[0], /First thing\.\n• Second thing\.\n\(Text "no updates"/);
  assert.doesNotMatch(out(A)[0], /Held/);
  assert.deepEqual(w.tick(AFTERNOON + 3600000), []); // already sent
  w.set(B, false);
  w.releases.push({ id: 'r4', date: '2026-10-01', text: 'Fourth thing.' });
  assert.deepEqual(w.tick(AFTERNOON + 3.5 * 3600000), [A]);
  store.close();
});

test('"no updates" and "updates on" by text; new members skip old news', async () => {
  const { store, sms, out } = setup();
  const C = '+13105550913'; // texts are simulated from a lab number
  await sms.simulate(C, 'no updates');
  assert.equal(sms.whatsNew.wants(C), false);
  await sms.simulate(C, 'Updates on');
  assert.equal(sms.whatsNew.wants(C), true);
  const w = new WhatsNew(sms, { releases: [{ id: 'old', date: '2026-09-01', text: 'Old news.' }] });
  w.live();
  store.db.prepare('UPDATE update_live SET at=? WHERE release=?').run(1000, 'old');
  sms.testers.delete(B); // B joined (first text) after the release went live
  store.db.prepare("INSERT INTO sms_optins VALUES (?, ?, 'test', 'test')").run(B, 2000);
  assert.deepEqual(w.pending(B).map(r => r.id), []);
  assert.deepEqual(w.pending(A).map(r => r.id), ['old']);
  store.close();
});
