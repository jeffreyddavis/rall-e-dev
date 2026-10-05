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

test('a held note goes out once it is approved in /ops; the summary shows what went out and what waits', () => {
  const { store, sms, out } = setup();
  const w = new WhatsNew(sms, { releases: [{ id: 'r1', date: '2026-10-01', text: 'Live one.' }, { id: 'r2', date: '2026-10-02', text: 'Waiting one.', hold: true }] });
  w.tick(AFTERNOON);
  let s = w.summary();
  assert.deepEqual(s.held.map(r => r.id), ['r2']); assert.deepEqual(s.released.map(r => [r.id, r.sent]), [['r1', 2]]); assert.equal(s.members, 2);
  assert.throws(() => w.approve('r1'), /already live/); assert.throws(() => w.approve('nope'), /No such release note/);
  w.approve('r2');
  s = w.summary();
  assert.deepEqual(s.held, []); assert.deepEqual(s.released.map(r => r.id), ['r2', 'r1']); // newest first
  w.tick(AFTERNOON + 4 * 3600000);
  assert.match(out(A).at(-1), /Waiting one\./);
  store.close();
});

test('team-only dev updates go to the core testers, under their own heading, and members never see them', () => {
  const { store, sms, out } = setup();
  const C = '+13107770913'; sms.allowed.add(C); // an opted-in member, not a core tester
  const w = new WhatsNew(sms, { releases: [{ id: 'm1', date: '2026-10-05', text: 'For everyone.' }, { id: 't1', date: '2026-10-05', team: true, text: 'Team tool.' }] });
  w.joined = () => 0; // everyone joined before these notes
  w.tick(AFTERNOON);
  assert.match(out(A)[0], /^What's new on Rall-e:\n• For everyone\.\nFor the Rall-e team:\n• Team tool\.\n\(Text "no updates"/);
  const member = store.db.prepare("SELECT body FROM sms_log WHERE phone=? AND kind='update'").all(C).map(r => r.body);
  assert.equal(member.length, 1); assert.doesNotMatch(member[0], /Team tool|Rall-e team/);
  assert.match(w.recent(5, A).join('\n'), /\(team\) Team tool/); assert.doesNotMatch(w.recent(5, C).join('\n'), /Team tool/);
  assert.equal(w.summary().released.find(r => r.id === 't1').team, true);
  store.close();
});
