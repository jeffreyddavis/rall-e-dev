// "Who else is going?" (Marc): people tell Rall-e which events they're going to (a concert, TechCrunch Disrupt), and
// Rall-e tells them which of their friends on Rall-e are going too.
// Privacy: someone's plans are only shown to people they're connected to (saved each other as contacts, or have been on
// a plan together), and only when they said friends may see it. The one text we send: when someone shares that they're
// going, connected friends who are going (and sharing) get a one-time "Marc is going too" (8 AM to 9 PM their time).
import { stats } from './stats.mjs';
import { localNow } from './timeline.mjs';
import { eventById } from './catalog.mjs';

const STOP = new Set(['the', 'and', 'with', 'at', 'in', 'on', 'of', 'a', 'an', 'to', 'for', 'live', 'show', 'concert', 'tour', 'night', '2026', '2027']);
const words = v => new Set(String(v || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w)));
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export class Going {
  constructor(sms) {
    this.sms = sms; this.db = sms.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS going_told (friend TEXT NOT NULL, who TEXT NOT NULL, name TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (friend, who, name, date));
      CREATE TABLE IF NOT EXISTS going (phone TEXT NOT NULL, name TEXT NOT NULL, date TEXT NOT NULL, venue TEXT, event_id TEXT, share INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY (phone, name, date));`);
  }
  // Same event = same day and mostly the same words in the name (or the same listing id).
  same(a, b) {
    if (a.date !== b.date) return false;
    if (a.event_id && a.event_id === b.event_id) return true;
    const x = words(a.name), y = words(b.name); if (!x.size || !y.size) return false;
    let both = 0; for (const w of x) if (y.has(w)) both++;
    return both / Math.min(x.size, y.size) >= 0.6;
  }
  mark(phone, { name, date, venue = '', eventId = null, share = false }) {
    const n = clean(name, 120); if (!n) throw Object.assign(new Error('Which event?'), { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw Object.assign(new Error('Which day is it? (YYYY-MM-DD)'), { status: 400 });
    this.db.prepare('INSERT OR REPLACE INTO going VALUES (?,?,?,?,?,?,?)').run(phone, n, date, clean(venue, 80) || null, eventId, share ? 1 : 0, Date.now());
    stats.bump('going_marked', 1, phone);
    const told = share ? this.tellFriends(phone, { name: n, date, eventId }) : [];
    return { name: n, date, share: Boolean(share), told };
  }
  // Friends already going (and sharing) hear once that this person is going too.
  tellFriends(phone, ev) {
    const me = this.sms.invites?.nameOf(phone) || 'A friend', friends = this.connections(phone), told = [];
    for (const r of this.db.prepare('SELECT * FROM going WHERE date=? AND share=1 AND phone != ?').all(ev.date, phone)) {
      if (!friends.has(r.phone) || !this.same(r, { name: ev.name, date: ev.date, event_id: ev.eventId }) || this.sms.isStopped?.(r.phone)) continue;
      if (this.db.prepare('SELECT 1 FROM going_told WHERE friend=? AND who=? AND date=?').get(r.phone, phone, ev.date)) continue;
      const tz = this.sms.flow?.agent?.tzFor?.(r.phone) || 'America/New_York', h = localNow(tz).hour; if (h < 8 || h >= 21) continue;
      this.sms.deliver(r.phone, `Rall-e: heads up, ${me} is going to ${r.name} too!`, { kind: 'going' });
      this.db.prepare('INSERT OR IGNORE INTO going_told VALUES (?,?,?,?)').run(r.phone, phone, r.name, ev.date); told.push(this.sms.invites?.nameOf(r.phone) || 'a friend');
    }
    return told;
  }
  setShare(phone, share, name = '') {
    const rows = this.mine(phone); const target = name ? rows.filter(r => this.same(r, { name, date: r.date })) : rows.slice(0, 1);
    for (const r of target) this.db.prepare('UPDATE going SET share=? WHERE phone=? AND name=? AND date=?').run(share ? 1 : 0, phone, r.name, r.date);
    if (share) for (const r of target) this.tellFriends(phone, { name: r.name, date: r.date, eventId: r.event_id });
    return target.length;
  }
  unmark(phone, name) { const rows = this.mine(phone).filter(r => this.same(r, { name, date: r.date })); for (const r of rows) this.db.prepare('DELETE FROM going WHERE phone=? AND name=? AND date=?').run(phone, r.name, r.date); return rows.length; }
  mine(phone) { return this.db.prepare('SELECT * FROM going WHERE phone=? AND date >= ? ORDER BY at DESC').all(phone, new Date(Date.now() - 86400000).toISOString().slice(0, 10)); }
  // People this person is connected to: contacts they saved, people who saved them, and anyone on a plan with them.
  connections(phone) {
    const out = new Set(), db = this.db;
    const myDigests = db.prepare("SELECT DISTINCT digest FROM sms_threads WHERE phone=? AND role='host'").all(phone).map(r => r.digest);
    for (const d of myDigests) for (const r of db.prepare('SELECT phone FROM host_contacts WHERE digest=?').all(d)) out.add(r.phone);
    for (const r of db.prepare("SELECT t.phone FROM host_contacts c JOIN sms_threads t ON t.digest=c.digest AND t.role='host' WHERE c.phone=?").all(phone)) out.add(r.phone);
    for (const r of db.prepare('SELECT DISTINCT b.phone FROM sms_threads a JOIN sms_threads b ON a.digest=b.digest AND a.plan=b.plan WHERE a.phone=?').all(phone)) out.add(r.phone);
    out.delete(phone);
    return out;
  }
  // Friends going to the same event who said friends may see it. Names only.
  whoElse(phone, event) { return this.friendsGoing(phone, event).map(f => f.name); }
  friendsGoing(phone, event) {
    if (!event?.date) return [];
    const friends = this.connections(phone); if (!friends.size) return [];
    const rows = this.db.prepare('SELECT * FROM going WHERE date=? AND share=1 AND phone != ?').all(event.date, phone).filter(r => friends.has(r.phone) && !this.sms.isStopped?.(r.phone) && this.same(r, { name: event.name, date: event.date, event_id: event.eventId }));
    return [...new Set(rows.map(r => r.phone))].map(p => ({ phone: p, name: this.sms.invites?.nameOf(p) || 'A friend' }));
  }
  // Plans those friends are hosting for this event (Marc #24: "I'm in, put me with them" joins their plan). Only friends
  // who share that they're going, and only open plans.
  friendPlans(phone, event) {
    const flow = this.sms.flow, out = [];
    for (const f of this.friendsGoing(phone, event)) for (const t of flow?.threadsFor(f.phone) || []) {
      if (t.role !== 'host' || !['proposed', 'confirmed'].includes(t.s.plan.status)) continue;
      const stops = t.s.plan.stops.map(id => eventById(id)).filter(Boolean);
      const hit = t.s.plan.stops.includes(event.eventId) || stops.some(e => this.same({ name: e.short, date: e.localDate || String(e.startsAt || '').slice(0, 10) }, { name: event.name, date: event.date }));
      if (hit && !out.some(x => x.digest === t.digest)) out.push({ who: f.name, digest: t.digest, title: t.s.plan.title, token: this.sms.store.shareToken(t.s, t.digest) });
    }
    return out;
  }
  wipe(phone) { this.db.prepare('DELETE FROM going_told WHERE friend=? OR who=?').run(phone, phone); return this.db.prepare('DELETE FROM going WHERE phone=?').run(phone).changes; }
}
