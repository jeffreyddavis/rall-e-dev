import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { stats, scrub } from '../server/stats.mjs';

test('insights: anonymous counters and hashed actives; gaps keep one scrubbed example per type; lab numbers ignored', () => {
  const store = new Store(':memory:'), sms = new Sms(store, { SMS_MODE: 'preview', PUBLIC_BASE_URL: 'https://rall-e.ai' });
  sms.log('+14155230100', 'in', 'hi'); sms.log('+14155230100', 'in', 'again'); sms.log('+14155230111', 'in', 'yo');
  sms.log('+13105550199', 'in', 'lab text'); // fictional 555 lab number: not counted
  stats.gap('Book or buy tickets!', 'Jeff wants tickets bought, call 330-697-5523 or jeff@example.com', 'agent', '+14155230100');
  stats.gap('book_or_buy_tickets', 'wants seats bought for comedy Saturday', 'agent', '+14155230100');
  stats.planEvent({ action: 'invite', data: { added: ['a', 'b'] } }); stats.planEvent({ action: 'accept' });
  const r = stats.report();
  assert.equal(r.totals.texts_in, 3); assert.equal(r.people.all, 2); assert.equal(r.totals.invites_sent, 2); assert.equal(r.totals.plans_created, 1);
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM stat_actives').all()).includes('4155230100')); // only hashes
  assert.deepEqual(r.gaps.map(g => [g.category, g.n, g.example]), [['book_or_buy_tickets', 2, 'wants seats bought for comedy Saturday']]);
  assert.equal(scrub('call 330-697-5523 or jeff@example.com at https://x.co'), 'call [number] or [email] at [link]');
  stats.setGap('book_or_buy_tickets', { status: 'fixed', note: 'done' });
  assert.equal(stats.report().gaps[0].status, 'fixed'); assert.equal(stats.report().gaps[0].again, false);
  store.db.prepare('UPDATE gaps SET status_at=status_at-1000').run();
  stats.gap('book_or_buy_tickets', 'asked again later', 'agent', '+14155230100');
  assert.equal(stats.report().gaps[0].again, true); // seen again after it was marked fixed
  assert.throws(() => stats.setGap('book_or_buy_tickets', { status: 'bogus' }), /Unknown status/);
  store.close();
});
