// Proactive alerts (Mike, 10-07): Rall-e texts first when something a member cares about shows up.
//   - Watches ("tell me when X plays LA", "let me know when Halloween displays open"): saved with the watch_for tool,
//     checked about twice a day with the same search find_things uses; a cheap model (Haiku) keeps only listings that
//     clearly match, and Rall-e texts them once per new match, in its own voice (operatorNudge).
//   - Weekend picks: opt-in ("weekend picks on", the weekend_picks tool, or their /me page). Thursday afternoons their
//     time, Rall-e texts 2–3 ideas for the weekend from find_things and what it knows about them.
//   - "Tell Rall-e about you" on /me: tastes saved into memory, which both of the above use.
// Kind to people, like the "what's new" texts: 9 AM to 8 PM their time, never mid-conversation, at most one of these
// texts every few hours, and only to members who are opted in and haven't texted STOP.
import { randomBytes } from 'node:crypto';
import { fail } from './store.mjs';
import { stats } from './stats.mjs';
import { meter } from './usage.mjs';
import { localNow } from './timeline.mjs';
import { eventById } from './catalog.mjs';

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, LAB = /^\+1\d{3}555\d{4}$/;
const MAX_WATCHES = 10, CHECK_EVERY = 12 * HOUR, WINDOW = [9, 20], GAP = 3 * HOUR;
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const WEEKEND_OFF = /^\s*(no|stop|pause|mute) (the |my )?weekend( picks| texts?)?[.!]?\s*$|^\s*weekend picks off[.!]?\s*$/i;
export const WEEKEND_ON = /^\s*weekend picks on[.!]?\s*$/i;
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
      CREATE TABLE IF NOT EXISTS alert_checks (watch TEXT NOT NULL, at INTEGER NOT NULL);`);
  }
  get discovery() { return this.sms.discovery; }
  get agent() { return this.sms.flow?.agent; }
  member(phone) { return this.sms.allowed?.has(phone) && !this.sms.isStopped?.(phone) && !LAB.test(phone); }

  // ---------- watches ----------
  async watch(phone, { what, search = '', category = '', days = 60, near = '' } = {}) {
    const w = clean(what, 140); if (!w) fail(400, 'Say what to watch for.');
    if (this.db.prepare('SELECT COUNT(*) n FROM watches WHERE phone=? AND active=1').get(phone).n >= MAX_WATCHES) fail(429, `They already have ${MAX_WATCHES} watches. Stop one first.`);
    let loc = this.discovery?.location(phone);
    if (near) loc = await this.discovery.geocode(near).catch(() => null) || fail(400, `Couldn't find "${clean(near, 60)}". Ask for a city or ZIP.`);
    if (!loc) fail(400, 'Their location is unknown: ask where to watch (city or ZIP), or save their location first.');
    const id = `wa_${randomBytes(5).toString('base64url')}`, now = Date.now(), until = now + Math.min(Math.max(Number(days) || 60, 3), 180) * DAY;
    // Whatever Rall-e just showed them doesn't count as news.
    const seen = (this.discovery.recent?.(phone) || []).map(e => e.id);
    this.db.prepare('INSERT INTO watches (id, phone, what, query, category, place, loc, created, until, seen) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, phone, w, clean(search, 100) || w, clean(category, 30) || null, clean(loc.label || near, 80) || 'near them', JSON.stringify({ label: loc.label, lat: loc.lat, lng: loc.lng }), now, until, JSON.stringify(seen));
    stats.bump('watches_set', 1, phone);
    return this.get(id);
  }
  get(id) { return this.db.prepare('SELECT * FROM watches WHERE id=?').get(id); }
  watches(phone) { return this.db.prepare('SELECT * FROM watches WHERE phone=? AND active=1 AND until>? ORDER BY created').all(phone, Date.now()); }
  // Stop by id, by words in what they're watching for, or "all". Returns what was stopped.
  stop(phone, which = '') {
    const q = clean(which, 100).toLowerCase(), list = this.watches(phone);
    const hit = q === 'all' || q === 'everything' ? list : list.filter(w => w.id === which || (q && (w.what.toLowerCase().includes(q) || q.includes(w.what.toLowerCase()))));
    for (const w of hit) this.db.prepare('UPDATE watches SET active=0 WHERE id=?').run(w.id);
    return hit.map(w => w.what);
  }
  describeWatches(phone) {
    const list = this.watches(phone);
    return list.length ? list.map(w => `${w.what} (near ${w.place}; until ${new Date(w.until).toISOString().slice(0, 10)}${w.hits ? `; texted them ${w.hits} time${w.hits > 1 ? 's' : ''}` : ''})`).join('\n') : 'Not watching for anything.';
  }
  // For the agent's situation: what's being watched and whether weekend picks are on.
  stateLine(phone) {
    const list = this.watches(phone);
    return [list.length ? `Watching for them (you'll text when something new turns up): ${list.map(w => w.what).join('; ')}` : '',
      `Weekend picks: ${this.wantsWeekend(phone) ? 'ON (Thursday afternoon texts with 2–3 ideas)' : 'off'}`].filter(Boolean).join('\n');
  }
  checksToday() { return this.db.prepare('SELECT COUNT(*) n FROM alert_checks WHERE at>?').get(Date.now() - DAY).n; }
  // One check: search like find_things does, keep listings that are new for this watch, have Haiku keep the true matches.
  async check(w, now = Date.now()) {
    const loc = JSON.parse(w.loc), seen = new Set(JSON.parse(w.seen || '[]'));
    this.db.prepare('INSERT INTO alert_checks VALUES (?, ?)').run(w.id, now);
    const found = await this.discovery.search(loc, { what: w.query, category: w.category || '', days: 30 });
    const fresh = found.filter(e => !seen.has(e.id));
    for (const e of fresh) seen.add(e.id);
    const matches = fresh.length ? await this.judge(w, fresh) : [];
    const pending = [...JSON.parse(w.pending || '[]'), ...matches].slice(-6);
    this.db.prepare('UPDATE watches SET checked=?, seen=?, pending=? WHERE id=?').run(now, JSON.stringify([...seen].slice(-400)), pending.length ? JSON.stringify(pending) : null, w.id);
    return matches;
  }
  async judge(w, events) {
    const agent = this.agent; if (!agent?.key) return [];
    const body = { model: agent.backgroundModel || agent.model, max_tokens: 1500,
      system: 'You decide which new event and place listings match what a person asked to be alerted about. Be strict: keep a listing only if it clearly is what they asked for (the right artist, the right kind of event, the right thing opening). If none match, return an empty list.',
      tools: [{ name: 'matches', description: 'Report the listings that clearly match.', input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } }],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: `They asked to hear about: "${w.what}" (near ${w.place}).\nNew listings:\n${events.map(e => this.discovery.describe(e)).join('\n')}\n\nCall matches with the ids that clearly match (an empty list if none).` }] };
    const r = await agent.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(60000), headers: agent.claudeHeaders(), body: JSON.stringify(body) });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`AI: ${result?.error?.message || r.status}`);
    meter.ai(result.usage, r.headers, body.model);
    const ids = new Set(result.content?.find(c => c.type === 'tool_use')?.input?.ids || []);
    return events.filter(e => ids.has(e.id)).map(e => e.id);
  }

  // ---------- weekend picks ----------
  wantsWeekend(phone) { return this.db.prepare('SELECT on_ FROM weekend_picks WHERE phone=?').get(phone)?.on_ === 1; }
  setWeekend(phone, on) {
    this.db.prepare('INSERT INTO weekend_picks (phone, on_, at) VALUES (?,?,?) ON CONFLICT(phone) DO UPDATE SET on_=excluded.on_, at=excluded.at').run(phone, on ? 1 : 0, Date.now());
    stats.bump(on ? 'weekend_picks_on' : 'weekend_picks_off', 1, phone);
  }

  // ---------- sending ----------
  // Same courtesy rules as the "what's new" texts, plus a gap between proactive texts.
  ready(phone, now = Date.now()) {
    const h = localNow(this.agent?.tzFor?.(phone) || 'America/New_York', now).hour;
    if (h < WINDOW[0] || h >= WINDOW[1]) return false;
    const lastIn = this.db.prepare("SELECT MAX(created) m FROM sms_log WHERE phone=? AND direction='in'").get(phone)?.m || 0;
    if (now - lastIn < 15 * MINUTE) return false;
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
  weekendText(phone) {
    const n = this.db.prepare("SELECT COUNT(*) n FROM alert_log WHERE phone=? AND kind='weekend'").get(phone).n;
    return 'Behind the scenes: it\'s their weekly weekend picks text (they turned these on). Use find_things for this coming weekend (Friday to Sunday) near them, guided by what you know about them (likes, dislikes, limits, who they go out with). '
      + 'Text 2–3 picks, one short line each (what, day and time, one reason it fits them), then ask if they want to plan one. Keep it short and specific; no generic filler. '
      + 'If you know little about them, add one line inviting them to tell you what they\'re into (or to fill in "About you" on their page, get_my_page). '
      + (n % 4 === 0 ? 'End with: (Text "no weekend picks" to stop these.)' : '');
  }
  // Runs every few minutes from server/index.mjs. Checks due watches (within a daily budget), sends what's ready.
  async tick(now = Date.now()) {
    if (!this.agent?.enabled || !this.discovery?.enabled) return { checked: 0, sent: 0 };
    let checked = 0, sent = 0;
    this.db.prepare('UPDATE watches SET active=0 WHERE active=1 AND until<?').run(now);
    this.db.prepare('DELETE FROM alert_checks WHERE at<?').run(now - 2 * DAY);
    const due = this.db.prepare('SELECT * FROM watches WHERE active=1 AND (checked IS NULL OR checked<?) ORDER BY COALESCE(checked, 0) LIMIT 10').all(now - CHECK_EVERY);
    for (const w of due) {
      if (!this.member(w.phone)) continue;
      if (this.checksToday() >= this.dailyChecks) break;
      try { await this.check(w, now); checked++; } catch (e) { console.error(`Watch ${w.id}:`, e.message); this.db.prepare('UPDATE watches SET checked=? WHERE id=?').run(now - CHECK_EVERY + HOUR, w.id); } // retry in an hour
    }
    for (const w of this.db.prepare('SELECT * FROM watches WHERE active=1 AND pending IS NOT NULL').all()) {
      if (!this.member(w.phone) || !this.ready(w.phone, now)) continue;
      const events = JSON.parse(w.pending).map(id => eventById(id)).filter(Boolean);
      this.db.prepare('UPDATE watches SET pending=NULL, alerted=?, hits=hits+? WHERE id=?').run(now, events.length ? 1 : 0, w.id);
      if (!events.length) continue;
      this.discovery.remember(w.phone, events); // so the agent can plan with these ids
      this.nudge(w.phone, 'watch', w.id, this.alertText(w, events)); sent++;
    }
    for (const r of this.db.prepare('SELECT * FROM weekend_picks WHERE on_=1').all()) {
      const t = localNow(this.agent.tzFor?.(r.phone) || 'America/New_York', now);
      if (t.weekday !== 'Thursday' || t.hour < 15 || t.hour >= 19 || r.last_key === t.date) continue;
      if (!this.member(r.phone) || !this.discovery.location(r.phone) || !this.ready(r.phone, now)) continue;
      this.db.prepare('UPDATE weekend_picks SET last_key=? WHERE phone=?').run(t.date, r.phone);
      this.nudge(r.phone, 'weekend', t.date, this.weekendText(r.phone)); sent++;
    }
    return { checked, sent };
  }

  // ---------- their page (/me) ----------
  forPage(phone) { return { weekend: this.wantsWeekend(phone), watches: this.watches(phone).map(w => ({ id: w.id, what: w.what, place: w.place, until: w.until })) }; }
  stopById(phone, id) { return this.db.prepare('UPDATE watches SET active=0 WHERE id=? AND phone=?').run(id, phone).changes > 0; }
  // "About you": comma-separated likes per field, plus things they're not into. Saved as their own words in memory.
  saveTastes(phone, input = {}) {
    const memory = this.sms.memory; let saved = 0;
    const items = v => clean(v, 300).split(/[,;\n]/).map(x => clean(x, 60)).filter(x => x.length > 1).slice(0, 8);
    for (const [field, about] of Object.entries(TASTE_FIELDS)) for (const value of items(input[field])) { memory.remember(phone, { kind: 'like', value, about }); saved++; }
    for (const value of items(input.avoid)) { memory.remember(phone, { kind: 'dislike', value }); saved++; }
    if (typeof input.weekend === 'boolean' && input.weekend !== this.wantsWeekend(phone)) this.setWeekend(phone, input.weekend);
    if (saved) stats.bump('tastes_saved_page', saved, phone);
    return saved;
  }
}
