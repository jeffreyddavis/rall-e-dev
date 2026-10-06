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
  // Same person, same gap, same conversation: one ask (the example stays the latest).
  assert.deepEqual(r.gaps.map(g => [g.category, g.n, g.people, g.example]), [['book_or_buy_tickets', 1, 1, 'wants seats bought for comedy Saturday']]);
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM gap_people').all()).includes('4155230100')); // only hashes
  assert.equal(scrub('call 330-697-5523 or jeff@example.com at https://x.co'), 'call [number] or [email] at [link]');
  stats.setGap('book_or_buy_tickets', { status: 'fixed', note: 'done' });
  assert.equal(stats.report().gaps[0].status, 'fixed'); assert.equal(stats.report().gaps[0].again, false);
  store.db.prepare('UPDATE gaps SET status_at=status_at-1000').run();
  stats.gap('book_or_buy_tickets', 'asked again later', 'agent', '+14155230100');
  assert.equal(stats.report().gaps[0].again, true); // seen again after it was marked fixed
  assert.throws(() => stats.setGap('book_or_buy_tickets', { status: 'bogus' }), /Unknown status/);
  store.close();
});

test('gaps count each person once per conversation (24 hours), and how many people asked', () => {
  const store = new Store(':memory:'); new Sms(store, { SMS_MODE: 'preview', PUBLIC_BASE_URL: 'https://rall-e.ai' });
  const A = '+14155230200', B = '+14155230201', row = () => stats.report().gaps.find(g => g.category === 'venue_food');
  for (let i = 0; i < 5; i++) stats.gap('venue_food', 'does the venue serve food?', 'agent', A); // logged on every reply in one conversation
  assert.deepEqual([row().n, row().people], [1, 1]);
  stats.gap('venue_food', 'is there food at the show?', 'agent', B);
  assert.deepEqual([row().n, row().people], [2, 2]);
  store.db.prepare('UPDATE gap_people SET last_at=last_at-90000000').run(); // a day later A asks again: a new ask, same person
  stats.gap('venue_food', 'food at the bowl?', 'agent', A);
  assert.deepEqual([row().n, row().people], [3, 2]);
  stats.gap('venue_food', 'auto-detected', 'auto', ''); // no person (automatic): counted as before
  assert.equal(row().n, 4);
  store.close();
});
