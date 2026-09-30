import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tzFromLng, localNow, planTiming, stamp } from '../server/timeline.mjs';
import { registerEvent } from '../server/catalog.mjs';

test('time zones from longitude, and local "now" in that zone', () => {
  assert.equal(tzFromLng(45.4, -85.0), 'America/New_York'); // northern Michigan
  assert.equal(tzFromLng(34.1, -118.3), 'America/Los_Angeles'); assert.equal(tzFromLng(41.9, -87.6), 'America/Chicago'); assert.equal(tzFromLng(33.4, -112.1), 'America/Phoenix');
  const n = localNow('America/New_York', Date.parse('2026-09-30T03:05:00Z')); // 11:05 PM Tuesday in Michigan
  assert.equal(n.date, '2026-09-29'); assert.equal(n.time, '23:05'); assert.equal(n.weekday, 'Tuesday'); assert.equal(n.daypart, 'late evening');
  assert.equal(stamp(Date.parse('2026-09-29T21:37:00Z'), 'America/New_York'), 'Tue 5:37 PM');
});

test('plan timing: upcoming, underway, probably over tonight, and past', () => {
  const plan = (when, extra = {}) => ({ plan: { status: 'confirmed', stops: [], participants: [], when, ...extra } });
  const at = iso => localNow('America/New_York', Date.parse(iso));
  const day = { date: '2026-09-29', time: '', basis: 'they said it' };
  assert.match(planTiming(plan(day), at('2026-09-29T14:00:00Z')), /today .*It is today; it may be underway/);
  assert.match(planTiming(plan(day), at('2026-09-30T03:05:00Z')), /late evening now, so today's outing is most likely over/);
  assert.match(planTiming(plan(day), at('2026-10-01T15:00:00Z')), /2 days ago.*almost certainly happened/);
  assert.match(planTiming(plan({ date: '2026-10-03', time: '16:00' }), at('2026-09-30T15:00:00Z')), /Sat, Oct 3 around 16:00 \(in 3 days\).*upcoming/);
  assert.match(planTiming(plan(day, { progress: { done: [], status: 'underway' } }), at('2026-09-29T20:00:00Z')), /underway right now/);
  assert.match(planTiming(plan(null), at('2026-09-29T14:00:00Z')), /not saved yet.*set_plan_time/);
  registerEvent({ id: 'tm_timeline1', short: 'Show', time: 'x', localDate: '2026-10-02', startsAt: '2026-10-02T19:30:00' });
  assert.match(planTiming({ plan: { status: 'proposed', stops: ['tm_timeline1'], participants: [] } }, at('2026-09-30T15:00:00Z')), /Fri, Oct 2 around 19:30.*from its stops/);
  assert.match(planTiming(plan(day, { status: 'happened' }), at('2026-09-29T14:00:00Z')), /over \(marked as happened\)/);
});
