import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { registerEvent } from '../server/catalog.mjs';

// Not a 555 number: lab numbers never get proactive texts.
const ME = '+13108675309', FRIEND = '+13108675310', MALIBU = { label: 'Malibu, CA', lat: 34.03, lng: -118.78 };
const at = iso => Date.parse(iso);
const DEC7_10AM = at('2026-12-07T18:00:00Z'), DEC8_10AM = at('2026-12-08T18:00:00Z'); // Los Angeles times

// Stand-ins for NOAA, Open-Meteo, a web page, robots.txt and Haiku.
function setup({ tides = [], rain = [0, 0, 0, 0], pages = [], verdict = { relevant: true, summary: 'The parking lot is closed until Nov 1.' } } = {}) {
  const store = new Store(':memory:'), calls = [];
  const days = ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-12', '2026-12-13', '2026-12-14', '2026-12-15'];
  const json = d => ({ ok: true, status: 200, headers: new Map(), json: async () => d, text: async () => JSON.stringify(d) });
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url));
    if (url.includes('mdapi/prod/webapi/stations.json')) return json({ stations: [{ id: '9410840', name: 'Santa Monica', lat: 34.0083, lng: -118.5 }, { id: '1612340', name: 'Honolulu', lat: 21.3, lng: -157.86 }] });
    if (url.includes('datagetter')) return json({ predictions: tides });
    if (url.includes('open-meteo.com')) return json({ daily: url.includes('past_days=3') ? { time: days.slice(0, 4), precipitation_sum: rain, sunrise: [], sunset: [] }
      : { time: days, precipitation_sum: days.map(() => 0), sunrise: days.map(d => `${d}T06:50`), sunset: days.map(d => `${d}T16:50`) } });
    if (url.endsWith('/robots.txt')) return url.includes('blocked.example') ? { ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /' } : { ok: false, status: 404, text: async () => '' };
    if (url.includes('beaches.example')) { const html = pages.length > 1 ? pages.shift() : pages[0]; return { ok: true, status: 200, headers: new Map(), text: async () => html }; }
    if (url.includes('api.anthropic.com')) return json({ content: [{ type: 'tool_use', id: 't', name: 'verdict', input: verdict }], usage: {} });
    throw new Error(`unexpected fetch ${url}`);
  };
  const env = { SMS_MODE: 'preview', ANTHROPIC_API_KEY: 'k', SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', SMS_ALLOWED_RECIPIENTS: `${ME},${FRIEND}` };
  const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, fetchImpl);
  const nudges = [];
  sms.discovery.saveLocation(ME, MALIBU);
  sms.flow.agent.tzFor = () => 'America/Los_Angeles';
  sms.flow.operatorNudge = (phone, what) => nudges.push({ phone, what });
  return { store, sms, a: sms.alerts, nudges, calls };
}

test('low tides: daylight minus tides at the nearest NOAA station, each day once', async () => {
  const t = setup({ tides: [
    { t: '2026-12-08 01:33', v: '-1.400', type: 'L' }, // dark: skipped
    { t: '2026-12-08 15:21', v: '-0.705', type: 'L' }, // daylight minus tide
    { t: '2026-12-08 07:55', v: '6.075', type: 'H' },
    { t: '2026-12-09 15:56', v: '-0.300', type: 'L' }, // not low enough
    { t: '2026-12-10 16:40', v: '-1.100', type: 'L' }  // 10 minutes before sunset: too close to dark
  ] });
  const w = await t.a.watch(ME, { what: 'tide pooling at Leo Carrillo', kind: 'low_tide' });
  assert.match(t.a.explain(w), /NOAA tide predictions at Santa Monica for daylight low tides at or below -0.5 ft/);
  const r = await t.a.tick(DEC7_10AM);
  assert.deepEqual(r, { checked: 1, sent: 1 });
  assert.match(t.nudges[0].what, /Tue, Dec 8: -0\.7 ft at 3:21 PM/);
  assert.doesNotMatch(t.nudges[0].what, /-1\.4|-0\.3|-1\.1/);
  assert.match(t.nudges[0].what, /slippery rocks/);
  // The next day's check doesn't repeat Dec 8.
  await t.a.tick(DEC8_10AM + 4 * 3600000);
  assert.equal(t.nudges.length, 1);
  // Inland, far from any station: refused in plain words.
  t.sms.discovery.geocode = async () => ({ label: 'Denver, CO', lat: 39.74, lng: -104.99 });
  await assert.rejects(t.a.watch(ME, { what: 'tides', kind: 'low_tide', near: 'Denver' }), /no NOAA tide station near there/);
  t.store.close();
});

test('rain: a big storm near the trail means waterfalls are running, at most once every 5 days', async () => {
  const t = setup({ rain: [0.2, 0.9, 0.4, 0] });
  t.sms.discovery.geocode = async place => ({ label: `${place}, CA`, lat: 34.2, lng: -118.13 });
  const w = await t.a.watch(ME, { what: 'Eaton Canyon falls after big storms', kind: 'rain', near: 'Altadena' });
  assert.match(t.a.explain(w), /when 1\+ inches fall within 3 days/);
  await t.a.tick(DEC7_10AM);
  assert.match(t.nudges[0].what, /About 1\.5 inches of rain fell there since Mon, Dec 7, so waterfalls and creeks should be running.*trail is open/s);
  await t.a.tick(DEC7_10AM + 7 * 3600000); // still wet, 7 hours later: no repeat
  assert.equal(t.nudges.length, 1);
  t.store.close();
});

test('pages: a change is texted only when it is about what they asked; robots.txt and no-bots sites are respected', async () => {
  const base = '<html><body><h1>Paradise Cove Beach</h1><p>Open daily 6 AM to 10 PM. Parking $50 per car.</p></body></html>';
  const t = setup({ pages: [base, base.replace('Parking $50 per car.', 'The parking lot is closed until Nov 1 for repairs.')] });
  const w = await t.a.watch(ME, { what: 'Paradise Cove beach access and parking', kind: 'page', url: 'https://beaches.example/paradise-cove' });
  assert.match(t.a.explain(w), /Watching https:\/\/beaches\.example\/paradise-cove for changes/);
  await t.a.tick(DEC7_10AM);
  assert.equal(t.nudges.length, 1);
  assert.match(t.nudges[0].what, /beaches\.example\/paradise-cove\. It changed: The parking lot is closed until Nov 1\./);
  await assert.rejects(t.a.watch(ME, { what: 'x', kind: 'page', url: 'https://blocked.example/page' }), /robots\.txt/);
  await assert.rejects(t.a.watch(ME, { what: 'x', kind: 'page', url: 'https://dice.fm/event/123' }), /forbids automated reading/);
  await assert.rejects(t.a.watch(ME, { what: 'x', kind: 'page', url: 'paradise cove website' }), /full public link/);

  // An unrelated change (a new footer line): checked, but nobody is texted.
  const u = setup({ pages: [base, base + '<footer>Copyright 2027 County of Los Angeles</footer>'], verdict: { relevant: false } });
  await u.a.watch(ME, { what: 'Paradise Cove parking', kind: 'page', url: 'https://beaches.example/pc' });
  assert.deepEqual(await u.a.tick(DEC7_10AM), { checked: 1, sent: 0 });
  t.store.close(); u.store.close();
});

test('plan reminders: the evening before and the morning of, to the host and everyone going; "no reminders" stops them', async () => {
  const t = setup();
  registerEvent({ id: 'tm_rem', short: 'Jazz at the Baked Potato', venue: 'The Baked Potato', time: 'Tue, Dec 8 · 8:00 PM', kind: 'event' });
  const plan = { id: 'pl_1', name: 'Jeff', plan: { title: 'Jazz night', status: 'confirmed', stops: ['tm_rem'], when: { date: '2026-12-08', time: '20:00' },
    participants: [{ id: 'p1', name: 'Mike', response: 'yes' }, { id: 'p2', name: 'Dana', response: 'maybe' }], suggestions: [] } };
  t.store.db.prepare('INSERT INTO sessions (id, state) VALUES (?, ?)').run('dg_1', JSON.stringify(plan));
  const thread = (phone, role, participant) => t.store.db.prepare('INSERT INTO sms_threads (phone, digest, plan, participant, role, updated) VALUES (?,?,?,?,?,?)').run(phone, 'dg_1', 'pl_1', participant, role, Date.now());
  thread(ME, 'host', ''); thread(FRIEND, 'guest', 'p1');

  assert.equal(t.a.reminders(at('2026-12-07T21:00:00Z')), 0); // Dec 7, 1 PM: too early
  assert.equal(t.a.reminders(at('2026-12-08T02:00:00Z')), 2); // Dec 7, 6 PM: the evening before
  assert.match(t.nudges[0].what, /reminder about the plan "Jazz night" tomorrow \(Tue, Dec 8 at 8:00 PM\)\. They are hosting it\..*Jazz at the Baked Potato at The Baked Potato.*Who's in: Jeff, Mike.*Text "no reminders"/s);
  assert.match(t.nudges[1].what, /They said they're going \(Jeff is hosting\)/);
  assert.equal(t.a.reminders(at('2026-12-08T03:00:00Z')), 0); // once
  await t.sms.flow.receive(FRIEND, 'no reminders');
  assert.equal(t.a.remindersOn(FRIEND), false);
  assert.equal(t.a.reminders(at('2026-12-08T17:00:00Z')), 1); // Dec 8, 9 AM: the morning of, host only now
  assert.doesNotMatch(t.nudges.at(-1).what, /Text "no reminders"/); // the off line only comes with the first one
  t.store.close();
});
