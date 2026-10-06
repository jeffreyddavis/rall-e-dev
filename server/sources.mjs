// Curated event sources (Mike's "data pipeline playbook"): the team adds feeds and pages per city in /ops, Rall-e pulls
// events from them on a schedule, and they show up in searches next to Ticketmaster and Google Places.
//   - Calendar feeds (.ics): Luma calendars, Meetup groups, venues, Google Calendars, etc. Parsed directly.
//   - Event web pages: schema.org Event data when the page has it (most event sites do); otherwise Claude reads the page
//     text and pulls out the events. We honor robots.txt and only read public pages; no logins, no private invites.
import { createHash } from 'node:crypto';
import { fail } from './store.mjs';
import { registerEvent } from './catalog.mjs';
import { meter } from './usage.mjs';
import { stats } from './stats.mjs';
import { isPublicUrl, botsForbidden } from './publicurl.mjs';
export { isPublicUrl, botsForbidden };

const DAY = 86400000, UA = 'Rall-e event finder (+https://rall-e.ai)';
const short = v => createHash('sha256').update(String(v)).digest('base64url').slice(0, 10);
const CATEGORIES = ['music', 'comedy', 'sports', 'theatre', 'arts', 'nightlife', 'dinner', 'museums', 'nature', 'movies', 'fitness', 'community', 'event'];
const guessCategory = text => {
  const t = ` ${String(text).toLowerCase()} `, has = re => re.test(t);
  return has(/\b(concert|live music|band|dj|jazz|orchestra|karaoke)\b/) ? 'music' : has(/\b(comedy|stand-?up|improv)\b/) ? 'comedy'
    : has(/\b(hike|hiking|trail|walk|beach|kayak|camping|nature)\b/) ? 'nature' : has(/\b(yoga|run club|running|workout|fitness|pilates|bootcamp|cycling)\b/) ? 'fitness'
    : has(/\b(game night|board games?|trivia)\b/) ? 'nightlife' : has(/\b(match|tournament|vs\.?)\b/) ? 'sports' : has(/\b(theater|theatre|play|musical)\b/) ? 'theatre'
    : has(/\b(art|gallery|exhibit|museum)\b/) ? 'arts' : has(/\b(dinner|tasting|brunch|food|supper)\b/) ? 'dinner' : has(/\b(party|club)\b/) ? 'nightlife'
    : has(/\b(meetup|networking|community|volunteer|workshop)\b/) ? 'community' : 'event';
};
const clock = hm => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const label = (date, time) => { const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); return time ? `${day} · ${clock(time)}` : day; };

// ---------- iCalendar ----------
export function parseIcs(text, lng = -100) {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/), out = [];
  let ev = null;
  const unesc = v => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { ev = {}; continue; }
    if (/^END:VEVENT/i.test(line)) { if (ev?.title && ev.date) out.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const [key, ...params] = line.slice(0, i).split(';'), value = line.slice(i + 1), K = key.toUpperCase();
    if (K === 'SUMMARY') ev.title = unesc(value);
    else if (K === 'LOCATION') { ev.address = unesc(value); ev.venue = ev.address.split(',')[0]; }
    else if (K === 'GEO') { const [la, lo] = value.split(/[;,]/).map(Number); if (Number.isFinite(la) && Number.isFinite(lo)) { ev.lat = la; ev.lng = lo; } }
    else if (K === 'URL') ev.url = value.trim();
    else if (K === 'DESCRIPTION') ev.description = unesc(value).slice(0, 300);
    else if (K === 'DTSTART') {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z)?)?/.exec(value); if (!m) continue;
      if (m[4] && m[6]) { // UTC: shift to the source's local time (approximate from longitude; ±1h for DST)
        const local = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + (Math.round(lng / 15) + 1) * 3600000).toISOString();
        ev.date = local.slice(0, 10); ev.time = local.slice(11, 16);
      } else { ev.date = `${m[1]}-${m[2]}-${m[3]}`; ev.time = m[4] ? `${m[4]}:${m[5]}` : ''; }
      if (params.some(p => /VALUE=DATE$/i.test(p))) ev.time = '';
    }
  }
  return out;
}
// ---------- schema.org Event JSON-LD ----------
export function parseJsonLd(html) {
  const out = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = [].concat(node['@type'] || []).join(' ');
    if (/Event\b/.test(type) && node.name && node.startDate) {
      const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(String(node.startDate)), place = [].concat(node.location || [])[0] || {}, addr = place.address;
      const offer = [].concat(node.offers || [])[0] || {};
      if (m) out.push({ title: String(node.name).slice(0, 120), date: m[1], time: m[2] || '', venue: place.name || '', url: node.url || offer.url || '',
        address: typeof addr === 'string' ? addr : [addr?.streetAddress, addr?.addressLocality, addr?.addressRegion].filter(Boolean).join(', '),
        price: offer.price != null && offer.price !== '' ? (Number(offer.price) ? `$${Number(offer.price)}` : 'Free') : '', description: String(node.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300),
        image: [].concat(node.image || [])[0]?.url || [].concat(node.image || [])[0] || null });
    }
    Object.values(node).forEach(v => typeof v === 'object' && visit(v));
  };
  for (const m of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { visit(JSON.parse(m[1].trim())); } catch {} }
  return out;
}
// ---------- per-source rules ----------
// A rule says where a source's events really are when its page shows none (they load a second later from an API, a
// feed or a widget). The debugging agent (server/sourcedebug.mjs) finds and tests them; refreshes use them first.
//   {type:'ics', url} · {type:'jsonld', url} · {type:'ai', url} (AI reads that page) ·
//   {type:'browser', url} (opened in headless Chromium first, server/renderer.mjs; then its events or AI reading) ·
//   {type:'json', url, items:'path.to.list', fields:{title, start, time?, venue?, address?, url?, image?, description?, price?}}
// Paths are dotted ("venue.name", "images.0.url"). In a rule's url, {today} and {end} are today and today + 90 days.
// Errors that are ours, not the site's (shown that way in /ops, retried within the hour).
const OUR_SIDE = /^(AI reader|Page browser):/;
export const OUR_SIDE_NOTE = 'Rall-e had a problem reading this, on our side (not the site\x27s). It retries within the hour.';
export const RULE_TYPES = { ics: 'calendar feed', jsonld: 'event page', ai: 'page (read by AI)', json: 'JSON API', browser: 'page in a browser' };
const at = (obj, path) => !path ? undefined : String(path).split('.').filter(Boolean).reduce((v, k) => v == null ? v : v[k], obj);
export function whenOf(value, lng = -100) {
  if (value == null || value === '') return null;
  const shift = ms => { const d = new Date(ms + (Math.round(lng / 15) + 1) * 3600000).toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 16) }; };
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) { const n = Number(value); return shift(n < 1e12 ? n * 1000 : n); }
  const s = String(value).trim(), m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s);
  if (m) return m[2] && /(Z|[+-]00:?00)$/i.test(s) ? shift(Date.parse(s.replace(' ', 'T'))) : { date: m[1], time: m[2] || '' }; // a UTC time moves to local
  const t = Date.parse(s); if (Number.isNaN(t)) return null;
  const d = new Date(t), p = n => String(n).padStart(2, '0'); // written out ("Oct 7, 2026 7:00 PM"): already local
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: /\d:\d\d/.test(s) ? `${p(d.getHours())}:${p(d.getMinutes())}` : '' };
}
const timeOf = v => { const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(String(v || '')); if (!m) return ''; let h = Number(m[1]) % (m[3] ? 12 : 24); if (/pm/i.test(m[3] || '')) h += 12; return `${String(h).padStart(2, '0')}:${m[2]}`; };
export function ruleUrl(template, base) {
  const day = n => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
  try { return new URL(String(template || '').replace(/\{today\}/g, day(0)).replace(/\{end\}/g, day(90)), base).href; } catch { return ''; }
}
export function jsonEvents(data, rule, base, lng) {
  const list = rule.items ? at(data, rule.items) : data, f = rule.fields || {};
  if (!Array.isArray(list)) throw new Error(`No list at "${rule.items || '(top level)'}" in that JSON.`);
  const text = v => String(v ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const link = v => { try { return v ? new URL(String(v), base).href : ''; } catch { return ''; } };
  return list.map(x => {
    const w = whenOf(at(x, f.start), lng), title = text(at(x, f.title)).slice(0, 120);
    if (!w || !title) return null;
    const price = at(x, f.price);
    return { title, date: w.date, time: f.time ? timeOf(at(x, f.time)) : w.time, venue: text(at(x, f.venue)).slice(0, 120), address: text(at(x, f.address)).slice(0, 200),
      url: link(at(x, f.url)), image: link(at(x, f.image)) || null, description: text(at(x, f.description)).slice(0, 300),
      price: price == null || price === '' ? '' : typeof price === 'number' ? (price ? `$${price}` : 'Free') : text(price).slice(0, 40) };
  }).filter(Boolean);
}
const pageText = html => String(html).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<a [^>]*href="([^"]+)"[^>]*>/gi, ' [link $1] ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

export class Sources {
  constructor(sms, env = process.env, fetchImpl = globalThis.fetch) {
    this.sms = sms; this.db = sms.db; this.env = env; this.fetch = fetchImpl;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_sources (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, name TEXT, city TEXT NOT NULL, lat REAL, lng REAL, kind TEXT,
        created INTEGER NOT NULL, fetched INTEGER, found INTEGER NOT NULL DEFAULT 0, error TEXT, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS curated_events (id TEXT PRIMARY KEY, source TEXT NOT NULL, day TEXT NOT NULL, lat REAL, lng REAL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS curated_events_day ON curated_events(day);`);
    for (const col of ['text_hash TEXT', 'rule TEXT', 'debug_tries INTEGER NOT NULL DEFAULT 0', 'debug_note TEXT', 'debug_at INTEGER', 'debug_browser INTEGER NOT NULL DEFAULT 0', 'debug_cause TEXT', 'debug_done INTEGER']) try { this.db.exec(`ALTER TABLE event_sources ADD COLUMN ${col}`); } catch {}
    this.db.exec('CREATE TABLE IF NOT EXISTS source_debug_runs (source TEXT NOT NULL, at INTEGER NOT NULL)');
    this.debugQueue = new Set(); this.debugChain = Promise.resolve(); this.debugDaily = Number(env.SOURCE_DEBUG_DAILY || 40);
    for (const r of this.db.prepare('SELECT data FROM curated_events WHERE day >= ?').all(new Date(Date.now() - DAY).toISOString().slice(0, 10))) registerEvent(JSON.parse(r.data));
  }
  get discovery() { return this.sms.discovery; }
  list() {
    return this.db.prepare("SELECT id, url, name, city, kind, created, fetched, found, error, active, rule, debug_tries, debug_note, debug_at, debug_cause, debug_done FROM event_sources WHERE url NOT LIKE 'rall-e:%' ORDER BY created DESC").all()
      .map(({ rule, ...s }) => ({ ...s, rule: rule ? RULE_TYPES[JSON.parse(rule).type] || 'rule' : null, debugging: this.debugQueue.has(s.id) }));
  }
  async add({ url, city, name = '' }) {
    let u; try { u = new URL(String(url || '').trim()); } catch { fail(400, 'Paste a full link (https://…).'); }
    if (!isPublicUrl(u.href)) fail(400, 'Paste a public web link.');
    if (botsForbidden(u.href)) fail(400, 'That site forbids automated access, so it can\x27t be a source. Add the venue\x27s own events page instead, or add events by hand.');
    if (!String(city || '').trim()) fail(400, 'Which city are these events in?');
    const place = await this.discovery.geocode(String(city).trim());
    if (place?.lat == null) fail(400, 'I couldn’t find that city. Try "Austin, TX".');
    if (this.db.prepare('SELECT 1 FROM event_sources WHERE url=?').get(u.href)) fail(409, 'That source is already on the list.');
    const id = short(u.href);
    this.db.prepare('INSERT INTO event_sources (id, url, name, city, lat, lng, created) VALUES (?,?,?,?,?,?,?)').run(id, u.href, String(name).trim().slice(0, 60) || u.hostname.replace(/^www\./, ''), place.label, place.lat, place.lng, Date.now());
    stats.bump('sources_added');
    await this.refresh(id).catch(() => {});
    return this.list().find(s => s.id === id);
  }
  // Small local music venues near someone who asked about live music: their own websites become sources (up to 8 per
  // area, once a week), read on the normal schedule, so the next search already knows who's playing where.
  async adoptMusicVenues(loc) {
    if (!this.discovery?.keys?.google) return 0;
    const k = `music|${loc.lat.toFixed(1)},${loc.lng.toFixed(1)}`;
    this.db.exec('CREATE TABLE IF NOT EXISTS source_adoptions (k TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    if (this.db.prepare('SELECT 1 FROM source_adoptions WHERE k=? AND at>?').get(k, Date.now() - 7 * DAY)) return 0;
    this.db.prepare('INSERT OR REPLACE INTO source_adoptions VALUES (?, ?)').run(k, Date.now());
    const { BIG_VENUE } = await import('./discovery.mjs');
    const reviews = t => Number(/\((\d+)\)/.exec(t.rating || '')?.[1] || 0);
    const found = await this.discovery.places(loc, 'live music bars and small music venues', 'music');
    const picks = found.filter(v => v.website && !BIG_VENUE.test(`${v.short} ${v.description || ''}`) && reviews(v) < 8000
      && !this.db.prepare('SELECT 1 FROM event_sources WHERE url=?').get(v.website)).slice(0, 8);
    let n = 0;
    for (const v of picks) { try { await this.add({ url: v.website, city: loc.label, name: v.short, auto: true }); n++; } catch {} }
    stats.bump('music_venues_adopted', n);
    return n;
  }
  remove(id) { if (id === 'manual') fail(400, 'Remove those events one at a time below.'); this.db.prepare('DELETE FROM curated_events WHERE source=?').run(id); return this.db.prepare('DELETE FROM event_sources WHERE id=?').run(id).changes > 0; }
  async allowed(u) {
    const r = await this.fetch(`${u.origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r?.ok) return true;
    let applies = false, rules = [];
    for (const raw of (await r.text()).split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim(), [k, ...v] = line.split(':'), val = v.join(':').trim();
      if (/^user-agent$/i.test(k)) applies = val === '*' || /rall-e/i.test(val); else if (applies && /^disallow$/i.test(k) && val) rules.push(val); else if (applies && /^allow$/i.test(k)) rules.push(`!${val}`);
    }
    // robots.txt patterns: prefix match, "*" = anything, "$" = end of path; the longest matching rule wins.
    const test = r => new RegExp(`^${r.replace(/^!/, '').replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\?\$$/, '$')}`).test(path);
    const path = u.pathname + u.search, hit = rules.filter(test).sort((a, b) => b.length - a.length)[0];
    return !hit || hit.startsWith('!');
  }
  async refresh(id, { debug = true } = {}) {
    const src = this.db.prepare('SELECT * FROM event_sources WHERE id=?').get(id); if (!src) fail(404, 'No such source.');
    if (src.url.startsWith('rall-e:')) return { found: src.found, error: null }; // added by hand, nothing to fetch
    const done = (found, kind, error = null) => {
      this.db.prepare('UPDATE event_sources SET fetched=?, found=?, kind=COALESCE(?, kind), error=? WHERE id=?').run(Date.now(), found, kind, error, id);
      // People add sources that have events, so 0 or 1 almost always means we read it wrong: work out how, once or twice.
      if (debug && found <= 1 && !/robots\.txt|forbids automated access/.test(error || '')) this.debugLater(id);
      return { found, error };
    };
    try {
      let got = null;
      if (src.rule) {
        const rule = JSON.parse(src.rule), kind = `${RULE_TYPES[rule.type]} (saved rule)`;
        got = await this.ruleEvents(rule, src, { cached: true }).then(raw => raw.length ? { raw, kind } : null).catch(e => e.unchanged ? { done: [src.found, kind] } : null);
      }
      got ||= await this.pageEvents(src);
      if (got.done) return done(...got.done);
      const { raw, kind } = got;
      const today = new Date().toISOString().slice(0, 10), horizon = new Date(Date.now() + 90 * DAY).toISOString().slice(0, 10);
      const upcoming = raw.filter(e => e.title && e.date >= today && e.date <= horizon).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).slice(0, 150);
      const events = [];
      for (const e of upcoming) events.push(await this.shape(e, src));
      this.db.prepare('DELETE FROM curated_events WHERE source=?').run(id);
      const put = this.db.prepare('INSERT OR REPLACE INTO curated_events VALUES (?,?,?,?,?,?)');
      for (const e of events) { registerEvent(e); put.run(e.id, id, e.localDate, e.lat, e.lng, JSON.stringify(e)); }
      return done(events.length, kind, raw.length && !events.length ? 'No upcoming events found in the next 90 days.' : raw.length ? null : 'No events found on that page.');
    } catch (error) {
      const msg = String(error.message);
      // Our side failed (the AI reader or the page browser), not the site: keep the events we had, don't spend a
      // debugging run on it, and try again within the hour instead of in 12.
      if (OUR_SIDE.test(msg)) {
        this.db.prepare('UPDATE event_sources SET fetched=?, error=? WHERE id=?').run(Date.now() - 11 * 3600000, `${OUR_SIDE_NOTE} Details: ${msg}`.slice(0, 500), id);
        return { found: src.found, error: msg };
      }
      return done(0, null, msg.slice(0, 300));
    }
  }
  // The source's own link: a feed, schema.org events, Localist, a feed the page links to, else AI reads the page.
  // Returns { raw, kind } or { done: [found, kind, error] } when there's nothing new to read.
  async pageEvents(src) {
    const u = new URL(src.url);
    if (botsForbidden(u.href)) return { done: [0, null, 'This site forbids automated access in its terms, so we never read it (robots.txt-style block).'] };
    if (!(await this.allowed(u))) return { done: [0, null, 'This site asks bots not to read that page (robots.txt).'] };
    const r = await this.fetch(src.url, { headers: { 'User-Agent': UA, Accept: 'text/calendar, text/html;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
    if (!r.ok) return { done: [0, null, `The page answered ${r.status}.`] };
    const body = (await r.text()).slice(0, 3_000_000), type = r.headers.get('content-type') || '';
    if (/text\/calendar/i.test(type) || /^\s*BEGIN:VCALENDAR/.test(body)) return { raw: parseIcs(body, src.lng), kind: 'calendar feed' };
    // Localist (many universities, museums, cities) has an open JSON API; prefer it over the page.
    const viaLocalist = /localist/i.test(body) ? await this.localist(u).catch(() => []) : [];
    let raw = viaLocalist.length ? viaLocalist : parseJsonLd(body), kind = viaLocalist.length ? 'Localist calendar' : 'event page';
    // A calendar feed the page links to or its CMS exposes (The Events Calendar, CivicPlus, etc.) beats AI reading.
    if (!raw.length) { const feed = await this.findFeed(u, body, src.lng ?? -100).catch(() => null); if (feed?.events.length) { raw = feed.events; kind = 'calendar feed (found on page)'; } }
    if (!raw.length) {
      // Reading a page with AI costs money: when the text hasn't changed since last time, keep the events we have.
      const text = pageText(body), h = short(text);
      if (src.text_hash === h && src.found > 1) return { done: [src.found, 'page (read by AI)'] };
      raw = await this.extract(text, src); kind = 'page (read by AI)';
      this.db.prepare('UPDATE event_sources SET text_hash=? WHERE id=?').run(h, src.id);
    }
    return { raw, kind };
  }
  // Events through a saved rule (see RULE_TYPES above). Also what the debugging agent tests a rule with.
  // With `cached`, AI reading is skipped when the page text hasn't changed (the events we have stay).
  async ruleEvents(rule, src, { cached = false } = {}) {
    const url = ruleUrl(rule.url, src.url);
    if (!RULE_TYPES[rule.type]) throw new Error(`Unknown rule type "${rule.type}".`);
    if (!isPublicUrl(url)) throw new Error('A rule needs a public web link.');
    if (botsForbidden(url)) throw new Error('That site forbids automated access (its terms), so we never read it.');
    if (!(await this.allowed(new URL(url)))) throw new Error('That site asks bots not to read this link (robots.txt).');
    const readText = async html => {
      const found = parseJsonLd(html); if (found.length) return found;
      const text = pageText(html), h = short(text);
      if (cached && src.id && src.text_hash === h && src.found > 1) throw Object.assign(new Error('unchanged'), { unchanged: true });
      const events = await this.extract(text, { ...src, url });
      if (src.id) this.db.prepare('UPDATE event_sources SET text_hash=? WHERE id=?').run(h, src.id);
      return events;
    };
    if (rule.type === 'browser') {
      const page = await this.render(url);
      if (!page) throw new Error('The page browser isn\'t running on this server.');
      if (page.status >= 400) throw new Error(`The page answered ${page.status}.`);
      return readText(page.html);
    }
    const accept = { json: 'application/json, */*;q=0.5', ics: 'text/calendar, */*;q=0.5' }[rule.type] || 'text/html, */*;q=0.5';
    const r = await this.fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
    if (!r.ok) throw new Error(`The link answered ${r.status}.`);
    const body = (await r.text()).slice(0, 5_000_000);
    if (rule.type === 'ics') return parseIcs(body, src.lng ?? -100);
    if (rule.type === 'jsonld') return parseJsonLd(body);
    if (rule.type === 'ai') return readText(body);
    let data; try { data = JSON.parse(body.replace(/^[^[{]*/, '')); } catch { throw new Error('That link doesn\'t return JSON.'); }
    return jsonEvents(data, rule, url, src.lng ?? -100);
  }
  // The page as a browser shows it after its JavaScript runs (server/renderer.mjs, its own service). null when that
  // service isn't installed or doesn't answer, so everything else works without it.
  async render(url) {
    const r = await this.fetch(`${this.env.RENDER_URL || 'http://127.0.0.1:3108'}/render`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }), signal: AbortSignal.timeout(60000) }).catch(() => null);
    if (!r) return null;
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`Page browser: ${d?.error || r.status}`);
    return d;
  }
  async renderAvailable() {
    const r = await this.fetch(`${this.env.RENDER_URL || 'http://127.0.0.1:3108'}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    return Boolean(r?.ok);
  }
  saveRule(id, rule, note) { this.db.prepare('UPDATE event_sources SET rule=?, debug_note=? WHERE id=?').run(JSON.stringify(rule), String(note || '').slice(0, 300), id); }
  // Queue one debugging run (server/sourcedebug.mjs), at most twice per source unless someone asks again in /ops.
  // Why a debugging run can't start now, in words for /ops (null when it can).
  debugBlocker(src, force = false) {
    if (!src || src.url.startsWith('rall-e:')) return 'There is nothing to check for this source.';
    if (this.debugQueue.has(src.id)) return 'It is already being checked.';
    if (!this.debugger || !this.sms.flow?.agent?.key) return 'The AI isn\x27t set up on this server.';
    if (!force && src.debug_tries >= 2) return 'It was already checked twice.';
    if (this.db.prepare('SELECT COUNT(*) AS n FROM source_debug_runs WHERE at>?').get(Date.now() - DAY).n >= this.debugDaily) return `Today's ${this.debugDaily} checks are used up. Try again tomorrow.`;
    return null;
  }
  // The Try to fix button: start a run now (or queue it) and say what happened.
  tryToFix(id) {
    const why = this.debugBlocker(this.db.prepare('SELECT * FROM event_sources WHERE id=?').get(id), true);
    if (why) return { queued: false, message: why };
    this.debugLater(id, { force: true });
    const ahead = this.debugQueue.size - 1;
    return { queued: true, message: ahead ? `Queued behind ${ahead} other check${ahead > 1 ? 's' : ''}.` : 'Trying now. It takes about a minute.' };
  }
  debugLater(id, { force = false } = {}) {
    const src = this.db.prepare('SELECT * FROM event_sources WHERE id=?').get(id);
    if (this.debugBlocker(src, force)) return false;
    this.db.prepare('UPDATE event_sources SET debug_tries=?, debug_at=? WHERE id=?').run(force ? 1 : src.debug_tries + 1, Date.now(), id);
    this.db.prepare('INSERT INTO source_debug_runs VALUES (?, ?)').run(id, Date.now());
    this.debugQueue.add(id);
    this.debugChain = this.debugChain.then(async () => {
      try {
        const result = await this.debugger.run(id).catch(e => ({ note: `The check failed: ${String(e.message).slice(0, 120)}`, cause: 'error' }));
        if (result?.saved) await this.refresh(id, { debug: false }).catch(() => {});
        else this.db.prepare('UPDATE event_sources SET debug_note=? WHERE id=?').run(String(result?.note || 'No way to read its events found.').slice(0, 300), id);
        // What /ops reports: fixed, or why not (forbidden_site, robots, login, no_upcoming, cant_find, error).
        this.db.prepare('UPDATE event_sources SET debug_cause=?, debug_done=? WHERE id=?').run(result?.saved ? 'fixed' : result?.cause || 'cant_find', Date.now(), id);
      } catch (e) { console.error('Source debug:', e.message); } finally { this.debugQueue.delete(id); }
    });
    return true;
  }
  // Localist calendars: /api/2/events (public reads). One entry per upcoming occurrence.
  async localist(u) {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const r = await this.fetch(`${u.origin}/api/2/events?days=90&pp=100&page=${page}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) break;
      const d = await r.json();
      for (const { event: e } of d.events || []) for (const { event_instance: i } of e.event_instances || []) {
        const start = String(i.start || '');
        out.push({ title: e.title, date: start.slice(0, 10), time: i.all_day ? '' : start.slice(11, 16), venue: e.location_name || e.location || '', address: [e.address, e.geo?.city, e.geo?.state].filter(Boolean).join(', '),
          lat: Number(e.geo?.latitude) || undefined, lng: Number(e.geo?.longitude) || undefined, price: e.free ? 'Free' : e.ticket_cost || '', url: e.ticket_url || e.localist_url, image: e.photo_url || null, description: String(e.description_text || '').replace(/\s+/g, ' ').slice(0, 300) });
      }
      if (!d.page?.next_page) break;
    }
    return out;
  }
  // Calendar feeds hiding behind a page: <link rel="alternate" type="text/calendar">, .ics / ?ical=1 / webcal links,
  // CivicPlus iCalendar.aspx feeds, and The Events Calendar's /events/?ical=1. Returns merged events from up to 5 feeds.
  async findFeed(u, html, lng = -100) {
    const abs = h => { try { return new URL(h.replace(/^webcal:/i, 'https:').replace(/&amp;/g, '&'), u).href; } catch { return ''; } };
    const links = [...html.matchAll(/<link[^>]+type=["']text\/calendar["'][^>]*>/gi)].map(m => /href=["']([^"']+)/i.exec(m[0])?.[1]).filter(Boolean)
      .concat([...html.matchAll(/href=["']([^"'#]+)["']/gi)].map(m => m[1]).filter(h => /\.ics\b|[?&]ical=1|^webcal:|icalendar\.aspx/i.test(h)));
    const tribe = /tribe-events|the-events-calendar/i.test(html) ? [`${u.origin}/events/?ical=1`] : [];
    const candidates = [...new Set([...links.map(abs), ...tribe].filter(Boolean))].slice(0, 8), events = [];
    let used = 0;
    for (const c of candidates) {
      if (used >= 5) break;
      const cu = new URL(c); if (!(await this.allowed(cu))) continue;
      const r = await this.fetch(c, { headers: { 'User-Agent': UA, Accept: 'text/calendar, text/html;q=0.5' }, signal: AbortSignal.timeout(15000), redirect: 'follow' }).catch(() => null);
      if (!r?.ok) continue;
      const text = (await r.text()).slice(0, 3_000_000);
      if (/^\s*BEGIN:VCALENDAR/.test(text)) { events.push(...parseIcs(text, lng)); used++; continue; }
      // CivicPlus' iCalendar.aspx page lists one feed per calendar category.
      if (/icalendar\.aspx/i.test(c)) for (const f of [...new Set([...text.matchAll(/href=["']([^"']*iCalendar\.aspx\?[^"']*catID=[^"']+)["']/gi)].map(m => abs(m[1])))].slice(0, 4)) {
        const fr = await this.fetch(f, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }).catch(() => null);
        const ft = fr?.ok ? await fr.text() : ''; if (/^\s*BEGIN:VCALENDAR/.test(ft)) { events.push(...parseIcs(ft, lng)); used++; }
      }
    }
    return { events };
  }
  // One-off events the team adds by hand (supper clubs, pop-ups, night markets: places with no feed at all).
  manualSource() {
    let src = this.db.prepare("SELECT * FROM event_sources WHERE url='rall-e:manual'").get();
    if (!src) { this.db.prepare("INSERT INTO event_sources (id, url, name, city, created, kind) VALUES ('manual', 'rall-e:manual', 'Added by the team', 'Anywhere', ?, 'added by hand')").run(Date.now()); src = this.db.prepare("SELECT * FROM event_sources WHERE id='manual'").get(); }
    return src;
  }
  async addEvent({ title, date, time = '', venue = '', address = '', city = '', price = '', url = '', description = '' }) {
    const t = String(title || '').trim(); if (!t) fail(400, 'Give the event a name.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail(400, 'Pick a date.');
    if (!String(city || '').trim()) fail(400, 'Which city is it in?');
    const place = await this.discovery.geocode(String(city).trim()); if (place?.lat == null) fail(400, 'I couldn’t find that city. Try "Austin, TX".');
    const src = { ...this.manualSource(), city: place.label, lat: place.lat, lng: place.lng };
    const e = await this.shape({ title: t.slice(0, 120), date, time: /^\d{1,2}:\d{2}$/.test(time) ? time : '', venue: String(venue).trim(), address: String(address).trim(), price: String(price).trim(), url: /^https?:\/\//.test(url) ? url : '', description: String(description).trim() }, src);
    e.source = 'Added by the team';
    registerEvent(e); this.db.prepare('INSERT OR REPLACE INTO curated_events VALUES (?,?,?,?,?,?)').run(e.id, 'manual', e.localDate, e.lat, e.lng, JSON.stringify(e));
    this.db.prepare("UPDATE event_sources SET found=(SELECT COUNT(*) FROM curated_events WHERE source='manual'), fetched=? WHERE id='manual'").run(Date.now());
    stats.bump('manual_events_added');
    return this.manualEvents();
  }
  manualEvents() { return this.db.prepare("SELECT id, day, data FROM curated_events WHERE source='manual' AND day >= ? ORDER BY day").all(new Date(Date.now() - DAY).toISOString().slice(0, 10)).map(r => { const e = JSON.parse(r.data); return { id: r.id, title: e.short, date: r.day, time: e.time, venue: e.venue, area: e.area, url: e.url }; }); }
  removeEvent(id) { this.db.prepare("DELETE FROM curated_events WHERE source='manual' AND id=?").run(String(id || '')); this.db.prepare("UPDATE event_sources SET found=(SELECT COUNT(*) FROM curated_events WHERE source='manual') WHERE id='manual'").run(); return this.manualEvents(); }
  // Claude reads a page that has no structured event data.
  async extract(text, src) {
    const agent = this.sms.flow.agent; if (!agent?.key) return [];
    const body = { model: agent.model, max_tokens: 16000, system: 'You extract upcoming public events from web page text for an event-discovery app. Only include real, specific events with a date. Never invent details. Always answer by calling save_events exactly once (with an empty list if the page has no events).',
      tools: [{ name: 'save_events', description: 'Save the events found on the page.', input_schema: { type: 'object', properties: { events: { type: 'array', maxItems: 60, items: { type: 'object', properties: {
        title: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM 24h, or empty' }, venue: { type: 'string' }, address: { type: 'string' },
        price: { type: 'string', description: 'e.g. "$20", "Free", or empty' }, url: { type: 'string', description: 'Link to the event if the page has one' }, description: { type: 'string', description: 'One sentence' },
        category: { type: 'string', enum: CATEGORIES } }, required: ['title', 'date'] } } }, required: ['events'] } }],
      tool_choice: { type: 'auto' }, // forced tool choice isn't supported with this model's thinking; the system prompt requires the call
      messages: [{ role: 'user', content: `Today is ${new Date().toISOString().slice(0, 10)}. These events are in or near ${src.city}. Page: ${src.url}\n\n${text.slice(0, 60000)}` }] };
    const r = await agent.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(120000),
      headers: agent.claudeHeaders(), body: JSON.stringify(body) });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`AI reader: ${result?.error?.message || r.status}`);
    meter.ai(result.usage, r.headers);
    return result.content?.find(c => c.type === 'tool_use')?.input?.events || [];
  }
  async shape(e, src) {
    const time = /^\d{1,2}:\d{2}$/.test(e.time || '') ? e.time.padStart(5, '0') : '';
    const where = [e.venue, e.address].filter(Boolean).join(', ');
    let lat = src.lat, lng = src.lng;
    if (Number.isFinite(e.lat) && Number.isFinite(e.lng)) ({ lat, lng } = e);
    else if (where) { const at = await this.discovery.locate({ id: 'x', venue: e.venue, address: e.address || null, area: src.city }).catch(() => null); if (at) ({ lat, lng } = at); }
    const category = CATEGORIES.includes(e.category) ? e.category : guessCategory(`${e.title} ${e.description || ''}`);
    return this.discovery.shape({ id: `cs_${short(`${src.id}|${e.title}|${e.date}|${time}`)}`, source: src.name, kind: 'event', category, short: e.title.slice(0, 120),
      venue: e.venue || src.name, area: src.city, address: e.address || null, lat, lng, time: label(e.date, time), localDate: e.date, startsAt: time ? `${e.date}T${time}:00` : null,
      price: /\d/.test(e.price || '') ? Number(String(e.price).replace(/[^\d.]/g, '')) || null : 0, priceText: e.price || 'See listing', url: e.url || src.url,
      image: e.image || null, description: (e.description || `From ${src.name}.`).slice(0, 300), curated: true });
  }
  // Curated events near someone, within the dates asked for, loosely matching what they want.
  near(loc, { what = '', category = '', start = Date.now(), end = Date.now() + 7 * DAY } = {}) {
    if (loc?.lat == null) return [];
    const from = new Date(start).toISOString().slice(0, 10), to = new Date(end - 1).toISOString().slice(0, 10), dLat = 0.45, dLng = 0.45 / Math.cos(loc.lat * Math.PI / 180);
    const rows = this.db.prepare('SELECT data FROM curated_events WHERE day BETWEEN ? AND ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY day LIMIT 200')
      .all(from, to, loc.lat - dLat, loc.lat + dLat, loc.lng - dLng, loc.lng + dLng).map(r => JSON.parse(r.data));
    const words = String(what).toLowerCase().split(/\W+/).filter(w => w.length > 3 && !/something|things|thing|this|weekend|tonight|week|with|around|near|good|some/.test(w));
    const match = e => { const hay = `${e.short} ${e.description} ${e.category} ${e.venue}`.toLowerCase(); return (!category || e.category === category || hay.includes(category)) && (!words.length || words.some(w => hay.includes(w))); };
    const hits = rows.filter(match);
    const list = hits.length ? hits : category || words.length ? [] : rows;
    // Spread over the days asked for (a weekend search shouldn't be all Friday).
    const byDay = [...new Set(list.map(e => e.localDate))].map(d => list.filter(e => e.localDate === d)), mixed = [];
    for (let i = 0; mixed.length < Math.min(12, list.length); i++) for (const b of byDay) if (b[i] && mixed.length < 12) mixed.push(b[i]);
    return mixed;
  }
  async sweepDebug() {
    const browser = await this.renderAvailable();
    for (const s of this.db.prepare("SELECT id, debug_tries, debug_browser FROM event_sources WHERE active=1 AND url NOT LIKE 'rall-e:%' AND found<=1 AND (error IS NULL OR (error NOT LIKE '%robots.txt%' AND error NOT LIKE '%forbids automated access%'))").all()) {
      if (s.debug_tries < 2) this.debugLater(s.id); else if (browser && !s.debug_browser) this.debugLater(s.id, { force: true });
    }
  }
  schedule() {
    if (this.timer) return;
    // Sources that failed on our side (e.g. the AI key problem on 10-05) are read again right after startup.
    this.db.prepare("UPDATE event_sources SET fetched=NULL WHERE error LIKE 'AI reader:%' OR error LIKE 'Page browser:%' OR error LIKE 'Rall-e had a problem reading this%'").run();
    const tick = async () => { for (const s of this.db.prepare("SELECT id FROM event_sources WHERE active=1 AND url NOT LIKE 'rall-e:%' AND (fetched IS NULL OR fetched < ?)").all(Date.now() - 12 * 3600000)) await this.refresh(s.id).catch(() => {}); };
    this.timer = setInterval(() => tick().catch(() => {}), 3600000); this.timer.unref?.();
    setTimeout(() => tick().catch(() => {}), 60000).unref?.();
    // Sources already showing 0 or 1 events get their debugging run too (one at a time, within the daily cap). Once the
    // page browser is installed, ones whose runs never had it get one more run with it, even past the usual 2 tries.
    setTimeout(() => this.sweepDebug().catch(() => {}), 90000).unref?.();
  }
}
