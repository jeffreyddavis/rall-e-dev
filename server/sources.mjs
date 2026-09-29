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
    for (const r of this.db.prepare('SELECT data FROM curated_events WHERE day >= ?').all(new Date(Date.now() - DAY).toISOString().slice(0, 10))) registerEvent(JSON.parse(r.data));
  }
  get discovery() { return this.sms.discovery; }
  list() { return this.db.prepare('SELECT id, url, name, city, kind, created, fetched, found, error, active FROM event_sources ORDER BY created DESC').all(); }
  async add({ url, city, name = '' }) {
    let u; try { u = new URL(String(url || '').trim()); } catch { fail(400, 'Paste a full link (https://…).'); }
    if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) fail(400, 'Paste a public web link.');
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
  remove(id) { this.db.prepare('DELETE FROM curated_events WHERE source=?').run(id); return this.db.prepare('DELETE FROM event_sources WHERE id=?').run(id).changes > 0; }
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
  async refresh(id) {
    const src = this.db.prepare('SELECT * FROM event_sources WHERE id=?').get(id); if (!src) fail(404, 'No such source.');
    const done = (found, kind, error = null) => { this.db.prepare('UPDATE event_sources SET fetched=?, found=?, kind=COALESCE(?, kind), error=? WHERE id=?').run(Date.now(), found, kind, error, id); return { found, error }; };
    try {
      const u = new URL(src.url);
      if (!(await this.allowed(u))) return done(0, null, 'This site asks bots not to read that page (robots.txt).');
      const r = await this.fetch(src.url, { headers: { 'User-Agent': UA, Accept: 'text/calendar, text/html;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
      if (!r.ok) return done(0, null, `The page answered ${r.status}.`);
      const body = (await r.text()).slice(0, 3_000_000), type = r.headers.get('content-type') || '';
      let raw, kind;
      if (/text\/calendar/i.test(type) || /^\s*BEGIN:VCALENDAR/.test(body)) { raw = parseIcs(body, src.lng); kind = 'calendar feed'; }
      else { raw = parseJsonLd(body); kind = 'event page'; if (!raw.length) { raw = await this.extract(pageText(body), src); kind = 'page (read by AI)'; } }
      const today = new Date().toISOString().slice(0, 10), horizon = new Date(Date.now() + 90 * DAY).toISOString().slice(0, 10);
      const upcoming = raw.filter(e => e.title && e.date >= today && e.date <= horizon).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).slice(0, 150);
      const events = [];
      for (const e of upcoming) events.push(await this.shape(e, src));
      this.db.prepare('DELETE FROM curated_events WHERE source=?').run(id);
      const put = this.db.prepare('INSERT OR REPLACE INTO curated_events VALUES (?,?,?,?,?,?)');
      for (const e of events) { registerEvent(e); put.run(e.id, id, e.localDate, e.lat, e.lng, JSON.stringify(e)); }
      return done(events.length, kind, raw.length && !events.length ? 'No upcoming events found in the next 90 days.' : raw.length ? null : 'No events found on that page.');
    } catch (error) { return done(0, null, String(error.message).slice(0, 160)); }
  }
  // Claude reads a page that has no structured event data.
  async extract(text, src) {
    const agent = this.sms.flow.agent; if (!agent?.key) return [];
    const body = { model: agent.model, max_tokens: 6000, system: 'You extract upcoming public events from web page text for an event-discovery app. Only include real, specific events with a date. Never invent details.',
      tools: [{ name: 'save_events', description: 'Save the events found on the page.', input_schema: { type: 'object', properties: { events: { type: 'array', maxItems: 60, items: { type: 'object', properties: {
        title: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM 24h, or empty' }, venue: { type: 'string' }, address: { type: 'string' },
        price: { type: 'string', description: 'e.g. "$20", "Free", or empty' }, url: { type: 'string', description: 'Link to the event if the page has one' }, description: { type: 'string', description: 'One sentence' },
        category: { type: 'string', enum: CATEGORIES } }, required: ['title', 'date'] } } }, required: ['events'] } }],
      tool_choice: { type: 'tool', name: 'save_events' },
      messages: [{ role: 'user', content: `Today is ${new Date().toISOString().slice(0, 10)}. These events are in or near ${src.city}. Page: ${src.url}\n\n${text.slice(0, 60000)}` }] };
    const r = await agent.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', 'x-api-key': agent.key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
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
    const from = new Date(start).toISOString().slice(0, 10), to = new Date(end).toISOString().slice(0, 10), dLat = 0.45, dLng = 0.45 / Math.cos(loc.lat * Math.PI / 180);
    const rows = this.db.prepare('SELECT data FROM curated_events WHERE day BETWEEN ? AND ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY day LIMIT 200')
      .all(from, to, loc.lat - dLat, loc.lat + dLat, loc.lng - dLng, loc.lng + dLng).map(r => JSON.parse(r.data));
    const words = String(what).toLowerCase().split(/\W+/).filter(w => w.length > 3 && !/something|things|thing|this|weekend|tonight|week|with|around|near|good|some/.test(w));
    const match = e => { const hay = `${e.short} ${e.description} ${e.category} ${e.venue}`.toLowerCase(); return (!category || e.category === category || hay.includes(category)) && (!words.length || words.some(w => hay.includes(w))); };
    const hits = rows.filter(match);
    return (hits.length ? hits : category || words.length ? [] : rows).slice(0, 8);
  }
  schedule() {
    if (this.timer) return;
    const tick = async () => { for (const s of this.db.prepare('SELECT id FROM event_sources WHERE active=1 AND (fetched IS NULL OR fetched < ?)').all(Date.now() - 12 * 3600000)) await this.refresh(s.id).catch(() => {}); };
    this.timer = setInterval(() => tick().catch(() => {}), 3600000); this.timer.unref?.();
    setTimeout(() => tick().catch(() => {}), 60000).unref?.();
  }
}
