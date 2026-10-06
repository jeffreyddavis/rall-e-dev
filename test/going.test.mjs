import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';

const [A, B, C, D, E] = ['+13107770931', '+13107770932', '+13107770933', '+13107770934', '+13107770935'];
test('who else is going: only connected friends who chose to share', () => {
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai' }, { messages: { create: async () => ({}) } }, async () => ({ ok: false, json: async () => ({}) }));
  const db = store.db, thread = (phone, digest, role) => db.prepare('INSERT INTO sms_threads (phone, digest, plan, participant, role, muted, updated) VALUES (?,?,?,?,?,0,?)').run(phone, digest, 'p1', role === 'host' ? '' : phone, role, Date.now());
  thread(A, 'd1', 'host'); thread(B, 'd1', 'guest');                       // B planned with A
  db.prepare('INSERT INTO host_contacts VALUES (?,?,?,?,?)').run('d1', 'dana', 'Dana', D, Date.now()); // A saved D
  thread(E, 'd9', 'host'); db.prepare('INSERT INTO host_contacts VALUES (?,?,?,?,?)').run('d9', 'alex', 'Alex', A, Date.now()); // E saved A
  const g = sms.going;
  assert.deepEqual([...g.connections(A)].sort(), [B, D, E].sort());
  const date = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  g.mark(B, { name: 'TechCrunch Disrupt 2026', date, share: true });   // connected + sharing: shown
  g.mark(C, { name: 'TechCrunch Disrupt', date, share: true });        // sharing but not connected: hidden
  g.mark(D, { name: 'Disrupt by TechCrunch', date, share: false });    // connected but private: hidden
  g.mark(E, { name: 'Some Other Conference', date, share: true });     // connected, different event
  assert.equal(g.whoElse(A, { name: 'TechCrunch Disrupt', date }).length, 1);
  g.setShare(D, true);
  assert.equal(g.whoElse(A, { name: 'techcrunch disrupt', date }).length, 2);
  assert.equal(g.whoElse(A, { name: 'TechCrunch Disrupt', date: '2030-01-01' }).length, 0); // different day
  // B (sharing) was already going; when D starts sharing, B gets one heads-up text (A isn't going, so A gets none).
  const heads = () => db.prepare("SELECT phone, body FROM sms_log WHERE kind='going'").all();
  assert.ok(heads().length <= 1); // texts only go out 8 AM to 9 PM in the friend's time zone
  if (heads().length) { assert.equal(heads()[0].phone, B); assert.match(heads()[0].body, /is going to TechCrunch Disrupt 2026 too/); }
  g.setShare(D, true); assert.ok(heads().length <= 1); // never twice
  assert.equal(g.unmark(B, 'TechCrunch Disrupt'), 1);
  assert.equal(g.whoElse(A, { name: 'TechCrunch Disrupt', date }).length, 1);
  store.close();
});

test('friends going show on options, and "I\'m in" joins the friend\'s plan for it', async () => {
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_ALLOWED_RECIPIENTS: `${A},${B}` }, { messages: { create: async () => ({}) } }, async () => ({ ok: false, json: async () => ({}) }));
  const { registerEvent } = await import('../server/catalog.mjs');
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const jazz = registerEvent({ id: 'tm_jazz', kind: 'event', short: 'Jazz Night', venue: 'Hollywood Bowl', localDate: date, time: 'Sat 8 PM', title: 'Jazz Night', category: 'music', priceText: '$48' });
  // Mike (A) hosts a plan for the jazz night and shares that he's going; Marc (B) is his saved contact.
  const { id } = store.create('Mike'); store.hostAction(id, 'accept', { eventId: 'tm_jazz' });
  const s = store.get(id), digest = store.resolve(id);
  store.db.prepare("INSERT INTO sms_threads (phone, digest, plan, participant, role, muted, updated) VALUES (?, ?, ?, '', 'host', 0, ?)").run(A, digest, s.id, Date.now());
  store.db.prepare('INSERT INTO host_contacts VALUES (?,?,?,?,?)').run(digest, 'marc', 'Marc', B, Date.now());
  sms.invites.nameOf = p => ({ [A]: 'Mike', [B]: 'Marc' })[p] || '';
  sms.going.mark(A, { name: 'Jazz Night at the Bowl', date, eventId: 'tm_jazz', share: true });
  const plans = sms.going.friendPlans(B, { name: jazz.short, date, eventId: jazz.id });
  assert.deepEqual(plans.map(p => [p.who, p.title]), [['Mike', s.plan.title]]);
  // In search results the option says who's going and that there's a plan to join.
  sms.discovery.location = () => ({ lat: 34.1, lng: -118.3, label: 'Los Angeles, CA' });
  sms.discovery.search = async () => [jazz]; sms.discovery.remember = () => {};
  const found = await sms.flow.agent.run(B, 'find_things', { what: 'jazz' }, { t: null }, 'jazz this weekend?');
  assert.match(found, /Jazz Night[\s\S]*FRIENDS GOING: Mike \(Mike has a plan for it they can join: join_friends_plan\)/);
  // "I'm in, put me with Mike": Marc joins Mike's plan as going.
  const out = await sms.flow.agent.run(B, 'join_friends_plan', { event_id: 'tm_jazz', friend: 'Mike' }, { t: null }, "I'm in, put me with Mike");
  assert.match(out, /Joined Mike's plan/);
  assert.ok(store.get(id).plan.participants.some(p => p.name === 'Marc' && p.response === 'yes'));
  assert.match(await sms.flow.agent.run(B, 'join_friends_plan', { event_id: 'tm_jazz' }, { t: null }, 'again'), /already on Mike's plan/);
  // Someone not connected to Mike sees nothing.
  assert.match(await sms.flow.agent.run(C, 'join_friends_plan', { event_id: 'tm_jazz' }, { t: null }, 'me too'), /No friend's plan/);
  store.close();
});
