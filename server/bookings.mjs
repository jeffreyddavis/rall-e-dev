// Reservations and purchases Rall-e helps with, and the transaction record behind the /ops volume numbers.
// Today Rall-e books through a pre-filled link to the venue's own booking page (OpenTable, Resy, Tock, SevenRooms,
// or an OpenTable search) plus the venue's phone number; the person taps to confirm and tells Rall-e it's booked.
// AI restaurant calls are tracked here with method 'call' (server/voice.mjs). Later: Stripe Link one-time cards and partner APIs.
// We never log in to anyone's Resy/OpenTable account (Resy bans third-party agents) and never handle card numbers.
import { randomBytes } from 'node:crypto';
import { fail } from './store.mjs';
import { stats } from './stats.mjs';

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const PLATFORMS = [
  ['OpenTable', /^https?:\/\/(www\.)?opentable\.com\/(r\/|restref\/|restaurant\/profile\/)/i],
  ['Resy', /^https?:\/\/(www\.)?resy\.com\/cities\/[^/]+\/(venues\/)?[^/?#]+/i],
  ['Tock', /^https?:\/\/(www\.)?exploretock\.com\/[^/?#]+/i],
  ['SevenRooms', /^https?:\/\/(www\.)?sevenrooms\.com\/(reservations|explore)\//i],
  ['Yelp', /^https?:\/\/(www\.)?yelp\.com\/reservations\//i]
];
export const KINDS = ['reservation', 'tickets', 'purchase'];
export const STATUSES = ['link_sent', 'requested', 'confirmed', 'purchased', 'cancelled', 'failed'];
const DONE = new Set(['confirmed', 'purchased']);

export function platformOf(url) { return PLATFORMS.find(([, re]) => re.test(url || ''))?.[0] || ''; }
// Adds the date, time and party size each platform understands, so the page opens on the right slot.
export function prefill(url, platform, { date = '', time = '', party = 2 } = {}) {
  const u = new URL(url);
  // Drop tracking junk copied from the venue's site (corrid, avt, stale dates); keep only OpenTable's restaurant id.
  for (const k of [...u.searchParams.keys()]) if (!(platform === 'OpenTable' && /^(rid|restref)$/i.test(k))) u.searchParams.delete(k);
  u.hash = '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', t = /^\d{2}:\d{2}$/.test(time) ? time : '19:00';
  if (platform === 'OpenTable') { u.searchParams.set('covers', party); if (d) u.searchParams.set('dateTime', `${d}T${t}`); }
  if (platform === 'Resy') { u.searchParams.set('seats', party); if (d) u.searchParams.set('date', d); }
  if (platform === 'Tock') { u.pathname = `${u.pathname.replace(/\/$/, '').split('/').slice(0, 2).join('/')}/search`; u.searchParams.set('size', party); if (d) u.searchParams.set('date', d); u.searchParams.set('time', t); }
  if (platform === 'SevenRooms') { u.searchParams.set('party_size', party); if (d) u.searchParams.set('date', d); }
  return u.href;
}

export class Bookings {
  constructor(sms, env = process.env, fetchImpl = globalThis.fetch) {
    this.sms = sms; this.db = sms.db; this.fetch = fetchImpl;
    this.db.exec(`CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, phone TEXT NOT NULL, digest TEXT, plan TEXT, kind TEXT NOT NULL,
        event_id TEXT, merchant TEXT NOT NULL, url TEXT, party INTEGER, date TEXT, time TEXT, notes TEXT, amount_cents INTEGER, currency TEXT NOT NULL DEFAULT 'usd',
        status TEXT NOT NULL, method TEXT NOT NULL, confirmation TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bookings_phone ON bookings(phone, created);
      CREATE TABLE IF NOT EXISTS booking_links (k TEXT PRIMARY KEY, url TEXT, platform TEXT, phone TEXT, at INTEGER NOT NULL);`);
  }
  get discovery() { return this.sms.discovery; }
  // Where to book a venue: its own reservation page if we can find one (listing URL, Google's website, or a booking
  // link on that website, respecting robots.txt), else an OpenTable search for it. Cached for a week.
  async bookingPage(e) {
    const k = e.placeId || e.id, hit = this.db.prepare('SELECT * FROM booking_links WHERE k=? AND at>?').get(k, Date.now() - 7 * 86400000);
    if (hit) return { url: hit.url, platform: hit.platform, phone: hit.phone };
    let site = e.website || '', phone = '', url = [e.url, e.website].find(platformOf) || '';
    if (e.placeId && this.discovery?.keys?.google) {
      const d = await this.discovery.get(`https://places.googleapis.com/v1/places/${e.placeId}`, { headers: { 'X-Goog-Api-Key': this.discovery.keys.google, 'X-Goog-FieldMask': 'websiteUri,nationalPhoneNumber' } }).catch(() => null);
      site ||= d?.websiteUri || ''; phone = d?.nationalPhoneNumber || '';
      if (!url && platformOf(site)) url = site;
    }
    if (!url && /^https?:/.test(site)) {
      try {
        const u = new URL(site);
        if (!this.sms.sources || await this.sms.sources.allowed(u)) {
          const r = await this.fetch(u.href, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Rall-e; +https://rall-e.ai)' }, signal: AbortSignal.timeout(8000), redirect: 'follow' });
          const html = r.ok ? (await r.text()).slice(0, 1_000_000) : '';
          url = [...html.matchAll(/href="([^"#]+)"/gi)].map(m => m[1].replace(/&amp;/g, '&')).find(platformOf) || '';
        }
      } catch {}
    }
    const platform = platformOf(url);
    this.db.prepare('INSERT OR REPLACE INTO booking_links VALUES (?,?,?,?,?)').run(k, url || null, platform || null, phone || null, Date.now());
    return { url, platform, phone };
  }
  searchLink(e, { date = '', time = '', party = 2 } = {}) {
    const u = new URL('https://www.opentable.com/s'); u.searchParams.set('covers', party);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) u.searchParams.set('dateTime', `${date}T${/^\d{2}:\d{2}$/.test(time) ? time : '19:00'}`);
    u.searchParams.set('term', [e.venue || e.short, (e.area || '').split(',')[0]].filter(Boolean).join(' '));
    return u.href;
  }
  // A table: returns the link to send (pre-filled) and records the request.
  async reserve(phone, t, e, { party = 2, date = '', time = '', notes = '' } = {}) {
    if (!e) fail(400, 'Unknown place.');
    party = Math.max(1, Math.min(20, Number(party) || 2));
    const page = await this.bookingPage(e).catch(() => ({}));
    const url = page.url ? prefill(page.url, page.platform, { date, time, party }) : this.searchLink(e, { date, time, party });
    const id = this.record(phone, t, { kind: 'reservation', eventId: e.id, merchant: e.venue || e.short, url, party, date, time, notes, status: 'link_sent', method: 'link' });
    stats.bump('reservation_links', 1, phone);
    return { id, url, platform: page.platform || 'OpenTable search', phone: page.phone || '', exact: Boolean(page.url) };
  }
  record(phone, t, { kind, eventId = null, merchant, url = null, party = null, date = null, time = null, notes = null, amountCents = null, status = 'requested', method = 'link' }) {
    if (!KINDS.includes(kind)) fail(400, 'Unknown booking kind.');
    const id = `bk_${randomBytes(5).toString('base64url')}`, now = Date.now();
    this.db.prepare('INSERT INTO bookings (id, phone, digest, plan, kind, event_id, merchant, url, party, date, time, notes, amount_cents, status, method, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, phone, t?.digest || null, t?.s?.id || null, kind, eventId, clean(merchant, 80) || 'Unknown', url, party, date || null, time || null, clean(notes, 200) || null, amountCents, status, method, now, now);
    return id;
  }
  latest(phone, kind = '') { return this.db.prepare(`SELECT * FROM bookings WHERE phone=? ${kind ? 'AND kind=?' : ''} ORDER BY created DESC LIMIT 1`).get(...(kind ? [phone, kind] : [phone])); }
  get(id) { return this.db.prepare('SELECT * FROM bookings WHERE id=?').get(id); }
  // "Booked it!" / "got the tickets, $84": marks the latest one done, with the amount if they said it.
  update(phone, id, { status, confirmation = '', amountCents = null, party = null, date = '', time = '' }) {
    const row = id ? this.get(id) : this.latest(phone);
    if (!row || row.phone !== phone) fail(404, 'No booking to update.');
    if (!STATUSES.includes(status)) fail(400, 'Unknown status.');
    this.db.prepare('UPDATE bookings SET status=?, confirmation=COALESCE(?, confirmation), amount_cents=COALESCE(?, amount_cents), party=COALESCE(?, party), date=COALESCE(?, date), time=COALESCE(?, time), updated=? WHERE id=?')
      .run(status, clean(confirmation, 60) || null, Number.isFinite(amountCents) ? Math.round(amountCents) : null, party || null, date || null, time || null, Date.now(), row.id);
    if (DONE.has(status) && !DONE.has(row.status)) stats.bump(row.kind === 'reservation' ? 'reservations_booked' : 'purchases_made', 1, phone);
    return this.get(row.id);
  }
  list(phone, n = 5) { return this.db.prepare('SELECT * FROM bookings WHERE phone=? ORDER BY created DESC LIMIT ?').all(phone, n); }
  describe(b) { return `${b.id}: ${b.kind} at ${b.merchant}${b.party ? ` for ${b.party}` : ''}${b.date ? ` on ${b.date}` : ''}${b.time ? ` ${b.time}` : ''}, ${b.status.replace('_', ' ')}${b.amount_cents != null ? `, $${(b.amount_cents / 100).toFixed(2)}` : ''}`; }
  // For /ops: volume (dollars and counts) completed through Rall-e, by kind, for 7 / 30 days and all time. Lab numbers excluded.
  report() {
    const lab = /^\+1\d{3}555\d{4}$/, now = Date.now();
    const rows = this.db.prepare('SELECT * FROM bookings').all().filter(r => !lab.test(r.phone) && !this.sms.labPhones?.has(r.phone));
    const window = days => {
      const inWin = rows.filter(r => !days || r.created > now - days * 86400000), done = inWin.filter(r => DONE.has(r.status));
      const by = k => { const d = done.filter(r => r.kind === k); return { count: d.length, cents: d.reduce((a, r) => a + (r.amount_cents || 0), 0), started: inWin.filter(r => r.kind === k).length }; };
      return { cents: done.reduce((a, r) => a + (r.amount_cents || 0), 0), count: done.length, started: inWin.length, people: new Set(done.map(r => r.phone)).size, byKind: Object.fromEntries(KINDS.map(k => [k, by(k)])) };
    };
    return { at: now, week: window(7), month: window(30), all: window(0),
      recent: rows.sort((a, b) => b.created - a.created).slice(0, 15).map(r => ({ kind: r.kind, merchant: r.merchant, party: r.party, date: r.date, status: r.status, method: r.method, cents: r.amount_cents, at: r.created })) };
  }
  wipe(phone) { return this.db.prepare('DELETE FROM bookings WHERE phone=?').run(phone).changes; }
}
