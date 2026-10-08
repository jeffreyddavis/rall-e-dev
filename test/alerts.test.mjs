import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { registerEvent } from '../server/catalog.mjs';

// Not a 555 number: lab numbers never get proactive texts.
const ME = '+13108675309', LA = { label: 'Los Angeles, CA', lat: 34.05, lng: -118.25 };
const at = iso => Date.parse(iso);
const THU_4PM = at('2026-10-08T23:00:00Z'), THU_5AM_NEXT = at('2026-10-09T12:00:00Z'), FRI_10AM = at('2026-10-09T17:00:00Z'); // Los Angeles times
const ev = (id, short, extra = {}) => { const e = { id, short, title: short, venue: 'The Echo', area: 'Echo Park', time: 'Sat, Oct 17 · 8:00 PM', kind: 'event', ...extra }; registerEvent(e); return e; };

function setup({ results = [] } = {}) {
  const store = new Store(':memory:'), judged = [];
  // Only the alert judge (Haiku) calls the API here: it keeps listings whose line mentions Khruangbin or Halloween.
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); judged.push(body);
    const text = body.messages[0].content, ids = [...text.matchAll(/^(\w+): .*(Khruangbin|Halloween)/gm)].map(m => m[1]);
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ content: [{ type: 'tool_use', id: 't', name: 'matches', input: { ids } }], usage: {} }) };
  };
  const env = { SMS_MODE: 'preview', ANTHROPIC_API_KEY: 'k', TICKETMASTER_API_KEY: 'tm', SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', SMS_ALLOWED_RECIPIENTS: ME };
  const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, fetchImpl);
  const d = sms.discovery, a = sms.alerts, nudges = [];
  d.saveLocation(ME, LA);
  d.search = async () => results.slice();
  d.recent = () => [{ id: 'tm_old' }];
  sms.flow.agent.tzFor = () => 'America/Los_Angeles';
  sms.flow.operatorNudge = (phone, what) => nudges.push({ phone, what });
  return { store, sms, a, d, nudges, judged, results };
}

test('watches: new listings that really match are texted once, in the daytime, never mid-conversation', async () => {
  const t = setup({ results: [ev('tm_old', 'Khruangbin (already shown)'), ev('tm_1', 'Khruangbin at the Greek'), ev('tm_2', 'Tribute band night')] });
  const w = await t.a.watch(ME, { what: 'Khruangbin playing LA', search: 'Khruangbin' });
  assert.equal(w.place, 'Los Angeles, CA');
  assert.match(t.a.stateLine(ME), /Watching for them.*Khruangbin playing LA/);

  let r = await t.a.tick(THU_4PM);
  assert.deepEqual(r, { checked: 1, sent: 1 });
  assert.equal(t.judged.length, 1); assert.equal(t.judged[0].model, 'claude-haiku-5-5');
  assert.doesNotMatch(t.judged[0].messages[0].content, /already shown/); // what Rall-e just showed them isn't news
  assert.equal(t.nudges.length, 1); assert.match(t.nudges[0].what, /watch for "Khruangbin playing LA".*tm_1: Khruangbin at the Greek/s);
  assert.doesNotMatch(t.nudges[0].what, /Tribute band/);
  assert.equal(t.a.get(w.id).hits, 1);

  // Nothing new and not due yet: no second text.
  r = await t.a.tick(THU_4PM + 60000); assert.deepEqual(r, { checked: 0, sent: 0 });

  // Next check finds another match at 5 AM their time: held until daytime.
  t.results.push(ev('tm_3', 'Khruangbin late show'));
  r = await t.a.tick(THU_5AM_NEXT); assert.deepEqual(r, { checked: 1, sent: 0 });
  assert.ok(t.a.get(w.id).pending);
  // 10 AM, but they texted Rall-e 5 minutes ago: wait.
  t.store.db.prepare("INSERT INTO sms_log (phone, direction, body, kind, status, created) VALUES (?, 'in', 'hi', 'reply', 'received', ?)").run(ME, FRI_10AM - 5 * 60000);
  r = await t.a.tick(FRI_10AM); assert.equal(r.sent, 0);
  r = await t.a.tick(FRI_10AM + 20 * 60000); assert.equal(r.sent, 1);
  assert.match(t.nudges[1].what, /tm_3: Khruangbin late show/); assert.equal(t.a.get(w.id).pending, null);

  assert.deepEqual(t.a.stop(ME, 'khruangbin'), ['Khruangbin playing LA']);
  assert.match(t.a.describeWatches(ME), /Not watching/);
  t.store.close();
});

test('watches: limits, opted-out members, and a place they name', async () => {
  const t = setup({ results: [ev('tm_h', 'Halloween yard display tour')] });
  t.d.geocode = async place => ({ label: `${place}, CA`, lat: 34.1, lng: -118.3 });
  const w = await t.a.watch(ME, { what: 'Halloween displays opening', search: 'Halloween yard display', near: 'Glendale' });
  assert.equal(w.place, 'Glendale, CA');
  for (let i = 0; i < 9; i++) await t.a.watch(ME, { what: `thing ${i}`, search: `thing ${i}` });
  await assert.rejects(t.a.watch(ME, { what: 'one more', search: 'x' }), /already have 10 watches/);
  t.sms.isStopped = () => true; // STOP: nothing is checked or sent
  assert.deepEqual(await t.a.tick(THU_4PM), { checked: 0, sent: 0 });
  assert.equal(t.judged.length, 0);
  t.store.close();
});

test('weekend picks: opt-in, Thursday afternoon their time, once a week, and "no weekend picks" stops them', async () => {
  const t = setup();
  assert.equal(t.a.wantsWeekend(ME), false);
  assert.equal((await t.a.tick(THU_4PM)).sent, 0); // off by default
  t.a.setWeekend(ME, true);
  assert.equal((await t.a.tick(THU_4PM - 24 * 3600000)).sent, 0); // Wednesday
  assert.equal((await t.a.tick(THU_4PM)).sent, 1);
  assert.match(t.nudges[0].what, /weekly weekend picks.*find_things.*Text "no weekend picks" to stop these/s);
  assert.equal((await t.a.tick(THU_4PM + 30 * 60000)).sent, 0); // once per week
  await t.sms.flow.receive(ME, 'no weekend picks'); // the real inbound path (the simulator only takes 555 lab numbers)
  assert.equal(t.a.wantsWeekend(ME), false);
  assert.match(t.store.db.prepare("SELECT body FROM sms_log WHERE phone=? AND direction='out' ORDER BY rowid DESC").get(ME).body, /no more weekend picks/);
  await t.sms.flow.receive(ME, 'weekend picks on');
  assert.equal(t.a.wantsWeekend(ME), true);
  t.store.close();
});

test('"About you" on their page saves tastes into memory and turns weekend picks on or off', () => {
  const t = setup();
  const saved = t.a.saveTastes(ME, { music: 'indie rock, Khruangbin', comedy: 'stand-up', food: 'Thai; ramen', activities: '', avoid: 'clubs', weekend: true });
  assert.equal(saved, 6);
  const facts = t.sms.memory.list(ME).map(f => `${f.kind}:${f.value}${f.about ? `@${f.about}` : ''}`).sort();
  assert.deepEqual(facts, ['dislike:clubs', 'like:Khruangbin@music', 'like:Thai@food', 'like:indie rock@music', 'like:ramen@food', 'like:stand-up@comedy']);
  assert.equal(t.a.wantsWeekend(ME), true);
  assert.deepEqual(t.a.forPage(ME), { weekend: true, watches: [] });
  t.store.close();
});

test('Rall-e sets a watch from a conversation and knows about it next time', async () => {
  const store = new Store(':memory:'); let n = 0;
  const say = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }), tool = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `w${n++}`, name, input }] });
  const sys = b => b.system.map(x => x.text).join('\n\n');
  const script = [
    tool('start_account', { first_name: 'Jeff' }), say('Hi Jeff!'),
    body => { assert.ok(body.tools.some(x => x.name === 'watch_for') && body.tools.some(x => x.name === 'weekend_picks')); assert.match(sys(body), /Weekend picks: off/); return tool('watch_for', { what: 'Khruangbin playing LA', search: 'Khruangbin' }); },
    body => { assert.match(JSON.stringify(body.messages.at(-1)), /Watching for \\"Khruangbin playing LA\\" near Los Angeles, CA/); return say('I’ll text you when they announce an LA show.'); },
    body => { assert.match(sys(body), /Watching for them.*Khruangbin playing LA/); return say('Still watching!'); }
  ];
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body), next = script.shift(); return { ok: true, status: 200, headers: new Map(), json: async () => typeof next === 'function' ? next(body) : next }; };
  const env = { SMS_MODE: 'preview', ANTHROPIC_API_KEY: 'k', TICKETMASTER_API_KEY: 'tm', SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0' };
  const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, fetchImpl);
  const LAB = '+13105550101';
  await sms.simulate(LAB, "Hi! I'm Jeff");
  sms.discovery.saveLocation(LAB, LA);
  await sms.simulate(LAB, 'tell me when Khruangbin plays LA');
  await sms.simulate(LAB, 'anything yet?');
  assert.equal(script.length, 0);
  assert.equal(sms.alerts.watches(LAB).length, 1);
  store.close();
});
