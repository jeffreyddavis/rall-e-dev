// Favorites (Mike's #2): "my top 5 restaurants in Boston". Each list has a public, shareable page (/f/<token>) that
// shows first names and places only. Friends' favorites (saved contacts either way, or shared plans; see going.mjs)
// show up for the agent when it searches near that city, and favorites feed the person's own taste memory.
import { randomBytes } from 'node:crypto';
import { fail } from './store.mjs';
import { stats } from './stats.mjs';

export const CATEGORIES = ['restaurants', 'bars', 'coffee', 'breakfast & brunch', 'music venues', 'date spots', 'outdoors', 'things to do', 'dessert', 'pizza', 'tacos', 'sushi'];
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const MAX = 5;

export class Favorites {
  constructor(sms) {
    this.sms = sms; this.db = sms.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS fav_lists (id TEXT PRIMARY KEY, phone TEXT NOT NULL, category TEXT NOT NULL, city TEXT NOT NULL, lat REAL, lng REAL, token TEXT NOT NULL UNIQUE, updated INTEGER NOT NULL, UNIQUE (phone, category, city));
      CREATE TABLE IF NOT EXISTS fav_items (list TEXT NOT NULL, rank INTEGER NOT NULL, name TEXT NOT NULL, note TEXT, address TEXT, area TEXT, lat REAL, lng REAL, url TEXT, place_id TEXT, PRIMARY KEY (list, rank));
      CREATE TABLE IF NOT EXISTS fav_friend_pages (token TEXT PRIMARY KEY, phone TEXT NOT NULL, city TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, created INTEGER NOT NULL);`);
  }
  // "Where do my friends go in Austin?" (Marc #25, like Corner): every place on connected friends' lists near a city.
  friendsPlaces(phone, loc, km = 40) {
    if (loc?.lat == null || !this.sms.going) return [];
    const friends = [...this.sms.going.connections(phone)]; if (!friends.length) return [];
    const dLat = km / 111, dLng = km / (111 * Math.cos(loc.lat * Math.PI / 180));
    return this.db.prepare(`SELECT l.phone, l.category, l.city, i.rank, i.name, i.note, i.address, i.area, i.url FROM fav_lists l JOIN fav_items i ON i.list=l.id
      WHERE l.phone IN (${friends.map(() => '?').join(',')}) AND l.lat BETWEEN ? AND ? AND l.lng BETWEEN ? AND ? ORDER BY l.category, i.rank, l.updated DESC`)
      .all(...friends, loc.lat - dLat, loc.lat + dLat, loc.lng - dLng, loc.lng + dLng)
      .map(({ phone: p, ...r }) => ({ ...r, who: this.sms.invites?.nameOf(p) || 'A friend' }));
  }
  // A shareable page of those places (/fp/<token>, 30 days). It shows friends' first names and places, never numbers,
  // and always the lists as they are now.
  friendsPage(phone, loc) {
    const old = this.db.prepare('SELECT token FROM fav_friend_pages WHERE phone=? AND city=? AND created>?').get(phone, loc.label, Date.now() - 30 * 86400000);
    const token = old?.token || randomBytes(9).toString('base64url');
    if (!old) this.db.prepare('INSERT INTO fav_friend_pages VALUES (?,?,?,?,?,?)').run(token, phone, loc.label, loc.lat, loc.lng, Date.now());
    return `${this.sms.base || 'https://rall-e.ai'}/fp/${token}`;
  }
  friendsView(token) {
    const p = this.db.prepare('SELECT * FROM fav_friend_pages WHERE token=? AND created>?').get(String(token || ''), Date.now() - 30 * 86400000);
    if (!p) fail(404, 'This page isn’t available anymore. Text Rall-e for a fresh one.');
    const places = this.friendsPlaces(p.phone, { lat: p.lat, lng: p.lng }), groups = [];
    for (const r of places) { let g = groups.find(x => x.category === r.category); if (!g) groups.push(g = { category: r.category, items: [] }); g.items.push({ name: r.name, who: r.who, rank: r.rank, note: r.note, area: r.area || r.address, url: r.url }); }
    return { city: p.city, for: this.sms.invites?.nameOf(p.phone) || '', friends: [...new Set(places.map(r => r.who))], groups };
  }
  get discovery() { return this.sms.discovery; }
  url(token) { return `${this.sms.base || 'https://rall-e.ai'}/f/${token}`; }
  // Saves (or replaces) a top-N list; each place is looked up on Google so the page has an address and a map link.
  async set(phone, { category, city, places }) {
    const cat = clean(category, 40).toLowerCase(); if (!cat) fail(400, 'Top 5 what? (restaurants, bars, coffee…)');
    const where = await this.discovery.geocode(clean(city, 60)).catch(() => null); if (where?.lat == null) fail(400, 'Which city is this list for?');
    const list = (places || []).map(p => typeof p === 'string' ? { name: p } : p).map(p => ({ name: clean(p.name, 100), note: clean(p.note, 160) })).filter(p => p.name).slice(0, MAX);
    if (!list.length) fail(400, 'Name at least one place.');
    const found = await Promise.all(list.map(p => this.discovery.keys?.google ? this.discovery.places({ lat: where.lat, lng: where.lng, label: where.label }, p.name, '', '', { anyHours: true }).then(r => r[0]).catch(() => null) : null));
    let row = this.db.prepare('SELECT * FROM fav_lists WHERE phone=? AND category=? AND city=?').get(phone, cat, where.label);
    if (!row) { const id = `fl_${randomBytes(5).toString('base64url')}`; this.db.prepare('INSERT INTO fav_lists VALUES (?,?,?,?,?,?,?,?)').run(id, phone, cat, where.label, where.lat, where.lng, randomBytes(9).toString('base64url'), Date.now()); row = this.db.prepare('SELECT * FROM fav_lists WHERE id=?').get(id); }
    this.db.prepare('DELETE FROM fav_items WHERE list=?').run(row.id);
    list.forEach((p, i) => { const g = found[i];
      this.db.prepare('INSERT INTO fav_items VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id, i + 1, g?.short && namesMatch(g.short, p.name) ? g.short : p.name, p.note || null, g?.address || null, g?.area || null, g?.lat ?? null, g?.lng ?? null, g?.url || g?.website || null, g?.placeId || null); });
    this.db.prepare('UPDATE fav_lists SET updated=? WHERE id=?').run(Date.now(), row.id);
    this.sms.memory?.signal(phone, 'favorite', cat, 2);
    stats.bump('favorites_saved', 1, phone);
    return this.view(row.token);
  }
  // Public page data: first name, list, places. Never a phone number.
  view(token) {
    const l = this.db.prepare('SELECT * FROM fav_lists WHERE token=?').get(String(token || '')); if (!l) fail(404, 'This list isn’t available anymore.');
    const items = this.db.prepare('SELECT rank, name, note, address, area, url FROM fav_items WHERE list=? ORDER BY rank').all(l.id);
    return { who: this.sms.invites?.nameOf(l.phone) || 'A Rall-e member', category: l.category, city: l.city, items, url: this.url(l.token), updated: l.updated };
  }
  mine(phone) { return this.db.prepare('SELECT * FROM fav_lists WHERE phone=? ORDER BY updated DESC').all(phone).map(l => this.view(l.token)); }
  remove(phone, category, city = '') {
    const rows = this.db.prepare('SELECT * FROM fav_lists WHERE phone=?').all(phone).filter(l => l.category.includes(clean(category, 40).toLowerCase()) && (!city || l.city.toLowerCase().includes(city.toLowerCase())));
    for (const l of rows) { this.db.prepare('DELETE FROM fav_items WHERE list=?').run(l.id); this.db.prepare('DELETE FROM fav_lists WHERE id=?').run(l.id); }
    return rows.length;
  }
  // Friends' favorite places near a spot (for the agent), e.g. "Marc's #1 restaurant in Los Angeles: Bestia".
  friendsNear(phone, loc, km = 30) {
    if (loc?.lat == null || !this.sms.going) return [];
    const friends = [...this.sms.going.connections(phone)]; if (!friends.length) return [];
    const dLat = km / 111, dLng = km / (111 * Math.cos(loc.lat * Math.PI / 180));
    return this.db.prepare(`SELECT l.phone, l.category, l.city, i.rank, i.name, i.note FROM fav_lists l JOIN fav_items i ON i.list=l.id WHERE l.phone IN (${friends.map(() => '?').join(',')}) AND l.lat BETWEEN ? AND ? AND l.lng BETWEEN ? AND ? ORDER BY l.updated DESC, i.rank LIMIT 15`)
      .all(...friends, loc.lat - dLat, loc.lat + dLat, loc.lng - dLng, loc.lng + dLng)
      .map(r => `${this.sms.invites?.nameOf(r.phone) || 'A friend'}'s #${r.rank} ${r.category} in ${r.city.split(',')[0]}: ${r.name}${r.note ? ` (${r.note})` : ''}`);
  }
  // Friends' lists anywhere (for "what are Marc's favorites in Austin?").
  friendsLists(phone, { name = '', city = '' } = {}) {
    const friends = [...(this.sms.going?.connections(phone) || [])]; if (!friends.length) return [];
    return friends.flatMap(f => this.mine(f)).filter(v => (!name || v.who.toLowerCase() === name.toLowerCase()) && (!city || v.city.toLowerCase().includes(city.toLowerCase())));
  }
  wipe(phone) { for (const l of this.db.prepare('SELECT id FROM fav_lists WHERE phone=?').all(phone)) this.db.prepare('DELETE FROM fav_items WHERE list=?').run(l.id); return this.db.prepare('DELETE FROM fav_lists WHERE phone=?').run(phone).changes; }
}
const namesMatch = (a, b) => { const w = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(x => x.length > 2)); const x = w(a), y = w(b); for (const t of y) if (x.has(t)) return true; return false; };
