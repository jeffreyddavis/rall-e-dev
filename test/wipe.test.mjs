import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { wipeTexts, removePerson, wipeAllConversations } from '../server/wipe.mjs';

const HOST = '+13105550101', MIKE = '+13105550102', TORI = '+13105550104';
function planWithGroup() {
  const store = new Store(':memory:'), sms = new Sms(store, { SMS_MODE: 'preview', PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0' });
  const t = (p, b) => sms.flow.receive(sms.labPhone(p), b);
  t(HOST, 'hey'); t(HOST, 'Jeff'); t(HOST, 'yes'); t(HOST, '4'); t(HOST, 'yes'); t(HOST, 'Mike 310-555-0102, Tori 310-555-0104');
  t(MIKE, 'yes'); t(TORI, 'yes'); t(TORI, 'I can drive everyone');
  return { store, sms, count: p => store.db.prepare('SELECT COUNT(*) n FROM sms_log WHERE phone=?').get(p).n, plan: () => sms.flow.threadsFor(HOST)[0].s };
}

test('wipe texts: their conversation and group messages go, they stay on the plan', () => {
  const x = planWithGroup();
  assert.ok(x.count(TORI) > 0); assert.ok(x.plan().activity.some(a => a.text === 'Tori: I can drive everyone'));
  const r = wipeTexts(x.sms, TORI);
  assert.equal(x.count(TORI), 0); assert.ok(r.texts > 0);
  assert.ok(!x.plan().activity.some(a => a.text.startsWith('Tori: ')));
  assert.ok(x.plan().plan.participants.some(p => p.name === 'Tori')); assert.ok(x.count(HOST) > 0);
  x.store.close();
});

test('remove person: off the plan, no threads left; a host removal deletes their plans; wipe-all clears every text', () => {
  const x = planWithGroup();
  removePerson(x.sms, TORI);
  assert.ok(!x.plan().plan.participants.some(p => p.name === 'Tori')); assert.equal(x.sms.flow.threadsFor(TORI).length, 0);
  const digest = x.sms.flow.threadsFor(HOST)[0].digest;
  removePerson(x.sms, HOST);
  assert.equal(x.store.db.prepare('SELECT COUNT(*) n FROM sessions WHERE id=?').get(digest).n, 0);
  assert.equal(x.sms.flow.threadsFor(MIKE).length, 0);
  wipeAllConversations(x.sms);
  assert.equal(x.store.db.prepare('SELECT COUNT(*) n FROM sms_log').get().n, 0);
  x.store.close();
});
