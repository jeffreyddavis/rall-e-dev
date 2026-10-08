// Proactive alerts (Mike, 10-07): Rall-e texts first when something a member cares about shows up.
//   - Watches, saved with the watch_for tool. Kinds:
//       listing  ("tell me when X plays LA", "let me know when Halloween displays open"): checked about twice a day with
//                the same search find_things uses; a cheap model (Haiku) keeps only listings that clearly match.
//       low_tide (tide pooling): NOAA tide predictions at the nearest station, daily; daylight low tides at or below a
//                height (default -0.5 ft), each day alerted once.
//       rain     (waterfalls and creeks after storms): Open-Meteo rain totals near the place every 6 hours; alerts when
//                the last 3 days reach a total (default 1 inch), at most once every 5 days.
//       page     (beach access, parking, trail closures, a venue's news): a public web page, read twice a day (robots.txt
//                and no-bots sites respected); when it changes, Haiku decides whether the change is about what they asked.
//     Matches wait for a good moment, then Rall-e texts them in its own voice (operatorNudge).
//   - Weekend picks: opt-in ("weekend picks on", the weekend_picks tool, or their /me page). Thursday afternoons their
//     time, Rall-e texts 2–3 ideas for the weekend from find_things and what it knows about them.
//   - Plan reminders: for confirmed plans with a date, the host and everyone who said yes get a reminder the evening before
//     (5–8 PM) and the morning of (8–11 AM, for plans after 11 AM). On by default; "no reminders" turns them off.
//   - "Tell Rall-e about you" on /me: tastes saved into memory, which all of the above use.
// Kind to people, like the "what's new" texts: 9 AM to 8 PM their time (reminders: their own windows above), never
// mid-conversation, alerts and picks at most every few hours, and only to members who are opted in and haven't texted STOP.
import { randomBytes, createHash } from 'node:crypto';
import { fail } from './store.mjs';
import { stats } from './stats.mjs';
import { meter } from './usage.mjs';
import { localNow, planWhen } from './timeline.mjs';
import { eventById } from './catalog.mjs';
import { isPublicUrl, botsForbidden } from './publicurl.mjs';
import { pageText } from './sources.mjs';

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, LAB = /^\+1\d{3}555\d{4}$/;
const MAX_WATCHES = 10, WINDOW = [9, 20], GAP = 3 * HOUR, UA = 'Rall-e alerts (+https://rall-e.ai)';
export const KINDS = ['listing', 'low_tide', 'rain', 'page'];
const EVERY = { listing: 12 * HOUR, low_tide: 24 * HOUR, rain: 6 * HOUR, page: 12 * HOUR };
const LABEL = { listing: '', low_tide: 'low tides', rain: 'rain for waterfalls', page: 'page changes' };
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const hashOf = t => createHash('sha1').update(t).digest('hex');
const mins = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };
const hm12 = hm => { const [h, m] = String(hm).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const niceDay = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayAfter = d => new Date(Date.parse(`${d}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
const km = (a, b) => { const r = x => x * Math.PI / 180, h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
export const WEEKEND_OFF = /^\s*(no|stop|pause|mute) (the |my )?weekend( picks| texts?)?[.!]?\s*$|^\s*weekend picks off[.!]?\s*$/i;
export const WEEKEND_ON = /^\s*weekend picks on[.!]?\s*$/i;
export const REMINDERS_OFF = /^\s*(no|stop|pause|mute) (the |my |plan )?reminders[.!]?\s*$|^\s*reminders off[.!]?\s*$/i;
export const REMINDERS_ON = /^\s*reminders on[.!]?\s*$/i;
// The "about you" form: each field becomes like/dislike facts in memory, tagged with what they're about.
export const TASTE_FIELDS = { music: 'music', comedy: 'comedy', food: 'food', activities: 'things to do' };

export class Alerts {
  constructor(sms, env = process.env) {
    this.sms = sms; this.db = sms.db; this.dailyChecks = Number(env.ALERT_CHECKS_DAILY || 200);
    this.db.exec(`CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, phone TEXT NOT NULL, what TEXT NOT NULL, query TEXT NOT NULL, category TEXT,
        place TEXT NOT NULL, loc TEXT NOT NULL, created INTEGER NOT NULL, until INTEGER NOT NULL, checked INTEGER, alerted INTEGER, hits INTEGER NOT NULL DEFAULT 0,
        seen TEXT NOT NULL DEFAULT '[]', pending TEXT, active INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS watches_phone ON watches(phone, active);
      CREATE TABLE IF NOT EXISTS weekend_picks (phone TEXT PRIMARY KEY, on_ INTEGER NOT NULL, at INTEGER NOT NULL, last_key TEXT);
      CREATE TABLE IF NOT EXISTS alert_log (phone TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS alert_checks (watch TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tide_stations (id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_reminders (plan TEXT NOT NULL, phone TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (plan, phone, kind));
      CREATE TABLE IF NOT EXISTS reminder_prefs (phone TEXT PRIMARY KEY, on_ INTEGER NOT NULL, at INTEGER NOT NULL);`);
    for (const col of ["kind TEXT NOT NULL DEFAULT 'listing'", 'params TEXT', 'state TEXT']) try { this.db.exec(`ALTER TABLE watches ADD COLUMN ${col}`); } catch {}
  }
  get discovery() { return this.sms.discovery; }
  get agent() { return this.sms.flow?.agent; }
  get fetch() { return this.sms.sources?.fetch || globalThis.fetch; }
  member(phone) { return this.sms.allowed?.has(phone) && !this.sms.isStopped?.(phone) && !LAB.test(phone); }
  midConversation(phone, now) { return now - (this.db.prepare("SELECT MAX(created) m FROM sms_log WHERE phone=? AND direction='in'").get(phone)?.m || 0) < 15 * MINUTE; }

  // ---------- watches ----------
  async watch(phone, { what, search = '', category = '', days = 60, near = '', kind = 'listing', url = '', tide_ft = null, rain_in = null } = {}) {
    if (!KINDS.includes(kind)) fail(400, `Kind must be one of: ${KINDS.join(', ')}.`);
    const w = clean(what, 140); if (!w) fail(400, 'Say what to watch for.');
    if (this.db.prepare('SELECT COUNT(*) n FROM watches WHERE phone=? AND active=1').get(phone).n >= MAX_WATCHES) fail(429, `They already have ${MAX_WATCHES} watches. Stop one first.`);
    let loc = this.discovery?.location(phone), params = {}, state = null;
    if (kind === 'page') {
      const u = clean(url, 400);
      if (!/^https?:\/\//i.test(u) || !isPublicUrl(u)) fail(400, 'A page watch needs the full public link (https://…). Ask them for it.');
      if (botsForbidden(u)) fail(400, 'That site forbids automated reading, so it can’t be watched.');
      const text = await this.readPage(u);
      params = { url: u }; state = { hash: hashOf(text), text: text.slice(0, 30000) };
      loc = loc || { label: new URL(u).hostname };
    } else {
      if (near) loc = await this.discovery.geocode(near).catch(() => null) || fail(400, `Couldn't find "${clean(near, 60)}". Ask for a city or ZIP.`);
      if (!loc) fail(400, 'Their location is unknown: ask where to watch (city or ZIP), or save their location first.');
      if (kind !== 'listing' && loc.lat == null) fail(400, 'This needs a place on the map: ask for a city or ZIP.');
      if (kind === 'low_tide') {
        const st = await this.nearestStation(loc);
        if (!st || st.km > 80) fail(400, 'There’s no NOAA tide station near there: tide alerts only work along the coast.');
        params = { station: st.id, stationName: st.name, lat: st.lat, lng: st.lng, maxFt: tide_ft == null || !Number.isFinite(+tide_ft) ? -0.5 : Math.max(-3, Math.min(1, +tide_ft)) };
      }
      if (kind === 'rain') params = { inches: rain_in == null || !Number.isFinite(+rain_in) ? 1 : Math.max(0.25, Math.min(6, +rain_in)) };
    }
    const id = `wa_${randomBytes(5).toString('base64url')}`, now = Date.now(), until = now + Math.min(Math.max(Number(days) || 60, 3), 180) * DAY;
    // Whatever Rall-e just showed them doesn't count as news.
    const seen = kind === 'listing' ? (this.discovery.recent?.(phone) || []).map(e => e.id) : [];
    this.db.prepare('INSERT INTO watches (id, phone, what, query, category, place, loc, created, until, seen, kind, params, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, phone, w, kind === 'listing' ? clean(search, 100) || w : w, clean(category, 30) || null, clean(loc.label || near, 80) || 'near them',
        JSON.stringify({ label: loc.label, lat: loc.lat, lng: loc.lng }), now, until, JSON.stringify(seen), kind, JSON.stringify(params), state ? JSON.stringify(state) : null);
    stats.bump(`watches_set${kind === 'listing' ? '' : `_${kind}`}`, 1, phone);
    return this.get(id);
  }
  get(id) { return this.db.prepare('SELECT * FROM watches WHERE id=?').get(id); }
  watches(phone) { return this.db.prepare('SELECT * FROM watches WHERE phone=? AND active=1 AND until>? ORDER BY created').all(phone, Date.now()); }
  // What the agent tells them about a new watch.
  explain(w) {
    const p = JSON.parse(w.params || '{}'), until = new Date(w.until).toISOString().slice(0, 10);
    if (w.kind === 'low_tide') return `Watching NOAA tide predictions at ${p.stationName} for daylight low tides at or below ${p.maxFt} ft, until ${until}. You check daily and text them a few days ahead of each one.`;
    if (w.kind === 'rain') return `Watching rainfall near ${w.place}: when ${p.inches}+ inches fall within 3 days, you text them that waterfalls and creeks should be running (at most once every 5 days), until ${until}.`;
    if (w.kind === 'page') return `Watching ${p.url} for changes about "${w.what}", until ${until}. You check about twice a day and text them only when a change is about that.`;
    return `Watching for "${w.what}" near ${w.place} until ${until}. You check about twice a day and text them when something new turns up.`;
  }
  // Stop by id, by words in what they're watching for, or "all". Returns what was stopped.
  stop(phone, which = '') {
    const q = clean(which, 100).toLowerCase(), list = this.watches(phone);
    const hit = q === 'all' || q === 'everything' ? list : list.filter(w => w.id === which || (q && (w.what.toLowerCase().includes(q) || q.includes(w.what.toLowerCase()))));
    for (const w of hit) this.db.prepare('UPDATE watches SET active=0 WHERE id=?').run(w.id);
    return hit.map(w => w.what);
  }
  describeWatches(phone) {
    const list = this.watches(phone);
    return list.length ? list.map(w => `${w.what}${LABEL[w.kind] ? ` [${LABEL[w.kind]}]` : ''} (near ${w.place}; until ${new Date(w.until).toISOString().slice(0, 10)}${w.hits ? `; texted them ${w.hits} time${w.hits > 1 ? 's' : ''}` : ''})`).join('\n') : 'Not watching for anything.';
  }
  // For the agent's situation: what's being watched and whether weekend picks are on.
  stateLine(phone) {
    const list = this.watches(phone);
    return [list.length ? `Watching for them (you'll text when something new turns up): ${list.map(w => `${w.what}${LABEL[w.kind] ? ` [${LABEL[w.kind]}]` : ''}`).join('; ')}` : '',
      `Weekend picks: ${this.wantsWeekend(phone) ? 'ON (Thursday afternoon texts with 2–3 ideas)' : 'off'}`].filter(Boolean).join('\n');
  }
  checksToday() { return this.db.prepare('SELECT COUNT(*) n FROM alert_checks WHERE at>?').get(Date.now() - DAY).n; }
  // One check. Whatever it finds is added to the watch's pending list, sent at the next good moment.
  async check(w, now = Date.now()) {
    const seen = new Set(JSON.parse(w.seen || '[]')), st = JSON.parse(w.state || '{}'), p = JSON.parse(w.params || '{}');
    this.db.prepare('INSERT INTO alert_checks VALUES (?, ?)').run(w.id, now);
    let found;
    if (w.kind === 'low_tide') found = await this.checkTide(p, seen, now);
    else if (w.kind === 'rain') found = await this.checkRain(w, p, st, now);
    else if (w.kind === 'page') found = await this.checkPage(w, p, st);
    else {
      // Listings: search like find_things does, keep what's new for this watch, have Haiku keep the true matches.
      const all = await this.discovery.search(JSON.parse(w.loc), { what: w.query, category: w.category || '', days: 30 });
      const fresh = all.filter(e => !seen.has(e.id)); for (const e of fresh) seen.add(e.id);
      found = fresh.length ? await this.judge(w, fresh) : [];
    }
    const pending = [...JSON.parse(w.pending || '[]'), ...found].slice(-6);
    this.db.prepare('UPDATE watches SET checked=?, seen=?, state=?, pending=? WHERE id=?')
      .run(now, JSON.stringify([...seen].slice(-400)), Object.keys(st).length ? JSON.stringify(st) : w.state, pending.length ? JSON.stringify(pending) : null, w.id);
    return found;
  }
  // A small structured question to the background model (Haiku).
  async ask(system, content, tool) {
    const agent = this.agent; if (!agent?.key) return null;
    const body = { model: agent.backgroundModel || agent.model, max_tokens: 1500, system, tools: [tool], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content }] };
    const r = await agent.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(60000), headers: agent.claudeHeaders(), body: JSON.stringify(body) });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`AI: ${result?.error?.message || r.status}`);
    meter.ai(result.usage, r.headers, body.model);
    return result.content?.find(c => c.type === 'tool_use')?.input || null;
  }
  async judge(w, events) {
    const out = await this.ask('You decide which new event and place listings match what a person asked to be alerted about. Be strict: keep a listing only if it clearly is what they asked for (the right artist, the right kind of event, the right thing opening). If none match, return an empty list.',
      `They asked to hear about: "${w.what}" (near ${w.place}).\nNew listings:\n${events.map(e => this.discovery.describe(e)).join('\n')}\n\nCall matches with the ids that clearly match (an empty list if none).`,
      { name: 'matches', description: 'Report the listings that clearly match.', input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } });
    const ids = new Set(out?.ids || []);
    return events.filter(e => ids.has(e.id)).map(e => e.id);
  }

  // ---------- low tides (NOAA) ----------
  async stations() {
    let rows = this.db.prepare('SELECT id, name, lat, lng FROM tide_stations').all();
    if (rows.length) return rows;
    const r = await this.fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (!r?.ok) fail(502, 'NOAA’s tide stations aren’t answering right now. Try again later.');
    const add = this.db.prepare('INSERT OR REPLACE INTO tide_stations VALUES (?,?,?,?)');
    for (const s of (await r.json()).stations || []) if (s.id && Number.isFinite(+s.lat) && Number.isFinite(+s.lng)) add.run(String(s.id), clean(s.name, 80) || String(s.id), +s.lat, +s.lng);
    return this.db.prepare('SELECT id, name, lat, lng FROM tide_stations').all();
  }
  async nearestStation(loc) {
    let best = null;
    for (const s of await this.stations()) { const d = km(loc, s); if (!best || d < best.km) best = { ...s, km: d }; }
    return best;
  }
  async meteo(lat, lng, { past = 0, days = 8 } = {}) {
    const r = await this.fetch(`https://api.open-meteo.com/v1/forecast?latitude=${(+lat).toFixed(3)}&longitude=${(+lng).toFixed(3)}&daily=precipitation_sum,sunrise,sunset&past_days=${past}&forecast_days=${days}&timezone=auto&precipitation_unit=inch`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    return (await r.json()).daily || { time: [], precipitation_sum: [], sunrise: [], sunset: [] };
  }
  // The next ~8 days of low tides at or below the height, at least 30 minutes after sunrise and before sunset; the lowest
  // one per day, each day once.
  async checkTide(p, seen, now) {
    const begin = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
    const r = await this.fetch(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&datum=MLLW&station=${encodeURIComponent(p.station)}&begin_date=${begin}&range=192&interval=hilo&units=english&time_zone=lst_ldt&format=json&application=rall-e`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`NOAA ${r.status}`);
    const tides = (await r.json()).predictions || [], sun = await this.meteo(p.lat, p.lng, { days: 9 });
    const light = new Map(sun.time.map((d, i) => [d, [mins(String(sun.sunrise[i]).slice(11)) + 30, mins(String(sun.sunset[i]).slice(11)) - 30]]));
    const best = new Map();
    for (const x of tides) {
      const day = String(x.t).slice(0, 10), time = String(x.t).slice(11, 16), ft = +x.v, l = light.get(day);
      if (x.type !== 'L' || !(ft <= p.maxFt) || !l || mins(time) < l[0] || mins(time) > l[1] || seen.has(`tide:${day}`)) continue;
      if (!best.has(day) || ft < best.get(day).ft) best.set(day, { kind: 'tide', day, time, ft });
    }
    const out = [...best.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(0, 3);
    for (const x of out) seen.add(`tide:${x.day}`);
    return out;
  }
  // ---------- rain (waterfalls) ----------
  async checkRain(w, p, st, now) {
    const loc = JSON.parse(w.loc), d = await this.meteo(loc.lat, loc.lng, { past: 3, days: 1 });
    const total = d.precipitation_sum.reduce((a, b) => a + (+b || 0), 0);
    if (total < p.inches || (st.lastStorm && now - st.lastStorm < 5 * DAY)) return [];
    st.lastStorm = now;
    return [{ kind: 'rain', inches: Math.round(total * 10) / 10, since: d.time.find((t, i) => +d.precipitation_sum[i] >= 0.1) || d.time[0] }];
  }
  // ---------- page changes ----------
  async readPage(u) {
    if (this.sms.sources?.allowed && !(await this.sms.sources.allowed(new URL(u)))) fail(400, 'That site asks bots not to read this page (robots.txt), so it can’t be watched.');
    const r = await this.fetch(u, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.5' }, signal: AbortSignal.timeout(20000), redirect: 'follow' }).catch(() => null);
    if (!r?.ok) fail(502, `Couldn’t open that page${r ? ` (error ${r.status})` : ''}.`);
    return pageText((await r.text()).slice(0, 3_000_000)).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  }
  async checkPage(w, p, st) {
    const text = await this.readPage(p.url), h = hashOf(text);
    if (h === st.hash) return [];
    const lines = t => t.split('\n').map(s => s.trim()).filter(s => s.length > 15);
    const before = new Set(lines(st.text || '')), now = new Set(lines(text));
    const added = [...now].filter(s => !before.has(s)).slice(0, 60), removed = [...before].filter(s => !now.has(s)).slice(0, 30);
    st.hash = h; st.text = text.slice(0, 30000);
    if (!added.length && !removed.length) return [];
    const v = await this.ask('A person asked to be told when a web page changes in a way that matters to them. Decide if this change is about what they asked (ignore dates, ads, menus, counters and other noise). If it is, summarize the news in one plain sentence.',
      `They asked about: "${w.what}". Page: ${p.url}\nLines added:\n${added.join('\n') || '(none)'}\nLines removed:\n${removed.join('\n') || '(none)'}`,
      { name: 'verdict', description: 'Whether the change matters to them, and the news in one sentence.', input_schema: { type: 'object', properties: { relevant: { type: 'boolean' }, summary: { type: 'string' } }, required: ['relevant'] } });
    return v?.relevant ? [{ kind: 'page', url: p.url, summary: clean(v.summary, 400) || 'The page changed.' }] : [];
  }

  // ---------- weekend picks ----------
  wantsWeekend(phone) { return this.db.prepare('SELECT on_ FROM weekend_picks WHERE phone=?').get(phone)?.on_ === 1; }
  setWeekend(phone, on) {
    this.db.prepare('INSERT INTO weekend_picks (phone, on_, at) VALUES (?,?,?) ON CONFLICT(phone) DO UPDATE SET on_=excluded.on_, at=excluded.at').run(phone, on ? 1 : 0, Date.now());
    stats.bump(on ? 'weekend_picks_on' : 'weekend_picks_off', 1, phone);
  }
  // ---------- plan reminders ----------
  remindersOn(phone) { return this.db.prepare('SELECT on_ FROM reminder_prefs WHERE phone=?').get(phone)?.on_ !== 0; }
  setReminders(phone, on) {
    this.db.prepare('INSERT INTO reminder_prefs (phone, on_, at) VALUES (?,?,?) ON CONFLICT(phone) DO UPDATE SET on_=excluded.on_, at=excluded.at').run(phone, on ? 1 : 0, Date.now());
    stats.bump(on ? 'reminders_on' : 'reminders_off', 1, phone);
  }
  reminders(now = Date.now()) {
    let sent = 0;
    for (const row of this.db.prepare(`SELECT id, state FROM sessions WHERE state LIKE '%"status":"confirmed"%'`).all()) {
      let s; try { s = JSON.parse(row.state); } catch { continue; }
      const p = s.plan; if (p?.status !== 'confirmed' || !p.stops?.length) continue;
      const when = planWhen(p); if (!when?.date) continue;
      const planKey = s.id || row.id, host = this.sms.flow?.hostPhone?.(row.id);
      const people = [...(host ? [{ phone: host, host: true }] : []), ...p.participants.filter(x => x.response === 'yes')
        .map(x => ({ phone: this.db.prepare("SELECT phone FROM sms_threads WHERE digest=? AND role='guest' AND participant=? ORDER BY updated DESC").get(row.id, x.id)?.phone }))].filter(x => x.phone);
      for (const who of people) {
        if (!this.member(who.phone) || !this.remindersOn(who.phone)) continue;
        const t = localNow(this.agent?.tzFor?.(who.phone) || 'America/New_York', now);
        const kind = when.date === dayAfter(t.date) && t.hour >= 17 && t.hour < 20 ? 'eve'
          : when.date === t.date && t.hour >= 8 && t.hour < 11 && (!when.time || when.time >= '11:00') ? 'morning' : null;
        if (!kind || this.db.prepare('SELECT 1 FROM plan_reminders WHERE plan=? AND phone=? AND kind=?').get(planKey, who.phone, kind) || this.midConversation(who.phone, now)) continue;
        const first = !this.db.prepare("SELECT 1 FROM alert_log WHERE phone=? AND kind='reminder'").get(who.phone);
        this.db.prepare('INSERT INTO plan_reminders VALUES (?,?,?,?)').run(planKey, who.phone, kind, now);
        this.nudge(who.phone, 'reminder', `${planKey}:${kind}`, this.reminderText(s, p, when, kind, who, first)); sent++;
      }
    }
    return sent;
  }
  reminderText(s, p, when, kind, who, first) {
    const stops = p.stops.map(id => eventById(id)).filter(Boolean).map(e => `${e.short}${e.venue ? ` at ${e.venue}` : ''}${e.time ? ` (${e.time})` : ''}`).join('; ') || 'see their plan page';
    const going = [s.name, ...p.participants.filter(x => x.response === 'yes').map(x => x.name)].filter(Boolean);
    return `Behind the scenes: an automatic reminder about the plan "${p.title}" ${kind === 'eve' ? 'tomorrow' : 'today'} (${niceDay(when.date)}${when.time ? ` at ${hm12(when.time)}` : ''}). `
      + `${who.host ? 'They are hosting it.' : `They said they're going (${s.name} is hosting).`} Stops: ${stops}. Who's in: ${going.join(', ')}. `
      + 'Text them a short, friendly reminder: when and where to be, who is coming, and a weather heads-up only if it matters (get_weather). Two or three short lines. Don\'t ask them to confirm again.'
      + (first ? ' End with: (Text "no reminders" to turn these off.)' : '');
  }

  // ---------- sending ----------
  // Same courtesy rules as the "what's new" texts, plus a gap between proactive texts.
  ready(phone, now = Date.now()) {
    const h = localNow(this.agent?.tzFor?.(phone) || 'America/New_York', now).hour;
    if (h < WINDOW[0] || h >= WINDOW[1] || this.midConversation(phone, now)) return false;
    const last = this.db.prepare('SELECT MAX(at) m FROM alert_log WHERE phone=?').get(phone)?.m || 0;
    return now - last >= GAP;
  }
  nudge(phone, kind, ref, instruction) {
    this.db.prepare('INSERT INTO alert_log VALUES (?,?,?,?)').run(phone, kind, ref, Date.now());
    stats.bump(`alerts_${kind}`, 1, phone);
    this.sms.flow.operatorNudge(phone, instruction);
  }
  alertText(w, events) {
    return `Behind the scenes: they asked you to watch for "${w.what}" near ${w.place} (on ${new Date(w.created).toISOString().slice(0, 10)}). Something new turned up:\n${events.map(e => this.discovery.describe(e)).join('\n')}\n`
      + 'Text them now: say you spotted this because they asked, give the best match in one or two lines (what, when, where, price, link if any), and ask if they want to plan it. '
      + 'If one of these isn\'t really what they asked for, leave it out. You\'ll keep watching unless they say stop (stop_watching).';
  }
  natureText(w, items) {
    const p = JSON.parse(w.params || '{}'), head = `Behind the scenes: they asked you to watch for "${w.what}"`;
    if (w.kind === 'low_tide') return `${head} (daylight low tides near ${w.place}). NOAA predicts these low tides at ${p.stationName}:\n${items.map(x => `${niceDay(x.day)}: ${x.ft.toFixed(1)} ft at ${hm12(x.time)}`).join('\n')}\n`
      + 'Text them now: the best day and time (be there 30–60 minutes before low tide), and one short safety line (watch the incoming tide and slippery rocks). Ask if they want to plan it.';
    if (w.kind === 'rain') { const x = items.at(-1); return `${head} near ${w.place}. About ${x.inches} inches of rain fell there since ${niceDay(x.since)}, so waterfalls and creeks should be running for the next few days. `
      + 'Text them now: suggest going in the next day or two, remind them to check the trail is open (storms close trails) and to be careful at creek crossings, and ask if they want to plan it.'; }
    return `${head} on ${p.url}. It changed: ${items.map(x => x.summary).join(' ')} Text them the news in one or two lines with the link.`;
  }
  weekendText(phone) {
    const n = this.db.prepare("SELECT COUNT(*) n FROM alert_log WHERE phone=? AND kind='weekend'").get(phone).n;
    return 'Behind the scenes: it\'s their weekly weekend picks text (they turned these on). Use find_things for this coming weekend (Friday to Sunday) near them, guided by what you know about them (likes, dislikes, limits, who they go out with). '
      + 'Text 2–3 picks, one short line each (what, day and time, one reason it fits them), then ask if they want to plan one. Keep it short and specific; no generic filler. '
      + 'If you know little about them, add one line inviting them to tell you what they\'re into (or to fill in "About you" on their page, get_my_page). '
      + (n % 4 === 0 ? 'End with: (Text "no weekend picks" to stop these.)' : '');
  }
  // Runs every few minutes from server/index.mjs. Checks due watches (within a daily budget), sends what's ready.
  async tick(now = Date.now()) {
    if (!this.agent?.enabled) return { checked: 0, sent: 0 };
    let checked = 0, sent = 0;
    this.db.prepare('UPDATE watches SET active=0 WHERE active=1 AND until<?').run(now);
    this.db.prepare('DELETE FROM alert_checks WHERE at<?').run(now - 2 * DAY);
    const due = this.db.prepare('SELECT * FROM watches WHERE active=1 AND (checked IS NULL OR checked<?) ORDER BY COALESCE(checked, 0) LIMIT 20').all(now - Math.min(...Object.values(EVERY)))
      .filter(w => !w.checked || now - w.checked >= (EVERY[w.kind] || EVERY.listing)).slice(0, 10);
    for (const w of due) {
      if (!this.member(w.phone) || (w.kind === 'listing' && !this.discovery?.enabled)) continue;
      if (this.checksToday() >= this.dailyChecks) break;
      try { await this.check(w, now); checked++; } catch (e) { console.error(`Watch ${w.id}:`, e.message); this.db.prepare('UPDATE watches SET checked=? WHERE id=?').run(now - (EVERY[w.kind] || EVERY.listing) + HOUR, w.id); } // retry in an hour
    }
    for (const w of this.db.prepare('SELECT * FROM watches WHERE active=1 AND pending IS NOT NULL').all()) {
      if (!this.member(w.phone) || !this.ready(w.phone, now)) continue;
      const items = JSON.parse(w.pending), listing = (w.kind || 'listing') === 'listing';
      const events = listing ? items.map(id => eventById(id)).filter(Boolean) : items;
      this.db.prepare('UPDATE watches SET pending=NULL, alerted=?, hits=hits+? WHERE id=?').run(now, events.length ? 1 : 0, w.id);
      if (!events.length) continue;
      if (listing) this.discovery.remember(w.phone, events); // so the agent can plan with these ids
      this.nudge(w.phone, listing ? 'watch' : w.kind, w.id, listing ? this.alertText(w, events) : this.natureText(w, events)); sent++;
    }
    for (const r of this.db.prepare('SELECT * FROM weekend_picks WHERE on_=1').all()) {
      const t = localNow(this.agent.tzFor?.(r.phone) || 'America/New_York', now);
      if (t.weekday !== 'Thursday' || t.hour < 15 || t.hour >= 19 || r.last_key === t.date) continue;
      if (!this.discovery?.enabled || !this.member(r.phone) || !this.discovery.location(r.phone) || !this.ready(r.phone, now)) continue;
      this.db.prepare('UPDATE weekend_picks SET last_key=? WHERE phone=?').run(t.date, r.phone);
      this.nudge(r.phone, 'weekend', t.date, this.weekendText(r.phone)); sent++;
    }
    sent += this.reminders(now);
    return { checked, sent };
  }

  // ---------- their page (/me) ----------
  forPage(phone) { return { weekend: this.wantsWeekend(phone), reminders: this.remindersOn(phone), watches: this.watches(phone).map(w => ({ id: w.id, what: w.what, place: w.place, until: w.until, kind: w.kind })) }; }
  stopById(phone, id) { return this.db.prepare('UPDATE watches SET active=0 WHERE id=? AND phone=?').run(id, phone).changes > 0; }
  // "About you": comma-separated likes per field, plus things they're not into. Saved as their own words in memory.
  saveTastes(phone, input = {}) {
    const memory = this.sms.memory; let saved = 0;
    const items = v => clean(v, 300).split(/[,;]/).map(x => clean(x, 60)).filter(x => x.length > 1).slice(0, 8);
    for (const [field, about] of Object.entries(TASTE_FIELDS)) for (const value of items(input[field])) { memory.remember(phone, { kind: 'like', value, about }); saved++; }
    for (const value of items(input.avoid)) { memory.remember(phone, { kind: 'dislike', value }); saved++; }
    if (typeof input.weekend === 'boolean' && input.weekend !== this.wantsWeekend(phone)) this.setWeekend(phone, input.weekend);
    if (typeof input.reminders === 'boolean' && input.reminders !== this.remindersOn(phone)) this.setReminders(phone, input.reminders);
    if (saved) stats.bump('tastes_saved_page', saved, phone);
    return saved;
  }
}
