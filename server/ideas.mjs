// "Teach Rall-e" (Mike's #1), structured instead of open prompts: members text tips (a hidden gem, a website with
// local events, or feedback) and they land in the team's Ideas inbox in /ops. Nothing a member sends changes how
// Rall-e behaves until someone on the team approves it:
//   - an approved gem becomes a "Recommended by a Rall-e member" spot the agent sees near that city,
//   - an approved site is added as an event source,
//   - feedback and feature ideas are the team's task list (status + notes).
import { randomBytes } from 'node:crypto';
import { fail } from './store.mjs';
import { stats } from './stats.mjs';

// event: a public event someone texted a flyer or screenshot of (Marc #16); approving it adds it to the event index.
export const KINDS = ['gem', 'source', 'feedback', 'feature', 'event'];
export const STATUSES = ['new', 'approved', 'doing', 'done', 'declined'];
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const DAY = 86400000;

export class Ideas {
  constructor(sms) {
    this.sms = sms; this.db = sms.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ideas (id TEXT PRIMARY KEY, phone TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, city TEXT, url TEXT, note TEXT,
      status TEXT NOT NULL DEFAULT 'new', team_note TEXT, lat REAL, lng REAL, created INTEGER NOT NULL, updated INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'text')`);
    try { this.db.exec('ALTER TABLE ideas ADD COLUMN data TEXT'); } catch {} // a flyer event's details (JSON)
  }
  add(phone, { kind, title, city = '', url = '', note = '', source = 'text', data = null }) {
    if (!KINDS.includes(kind)) fail(400, 'Kind must be gem, source, feedback, feature or event.');
    const t = clean(title, 140); if (!t) fail(400, 'What’s the tip?');
    if (phone && this.db.prepare('SELECT COUNT(*) AS n FROM ideas WHERE phone=? AND created>?').get(phone, Date.now() - DAY).n >= 20) fail(429, 'That’s a lot of tips for one day. Send more tomorrow!');
    const u = /^https?:\/\/\S+$/i.test(url || '') ? clean(url, 300) : null;
    const id = `id_${randomBytes(5).toString('base64url')}`, now = Date.now();
    this.db.prepare('INSERT INTO ideas (id, phone, kind, title, city, url, note, created, updated, source, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, phone || null, kind, t, clean(city, 60) || null, u, clean(note, 500) || null, now, now, source, data ? JSON.stringify(data) : null);
    stats.bump(`ideas_${kind}`, 1, phone);
    return this.get(id);
  }
  get(id) { return this.db.prepare('SELECT * FROM ideas WHERE id=?').get(id); }
  // The inbox for /ops: newest first; phone numbers never leave the server (first name only).
  list({ status = '' } = {}) {
    return this.db.prepare(`SELECT * FROM ideas ${status ? 'WHERE status=?' : ''} ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'doing' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, created DESC LIMIT 200`).all(...(status ? [status] : []))
      .map(r => ({ id: r.id, kind: r.kind, title: r.title, city: r.city, url: r.url, note: r.note, event: r.kind === 'event' && r.data ? JSON.parse(r.data) : null, status: r.status, teamNote: r.team_note, created: r.created, updated: r.updated, from: r.phone ? (this.sms.invites?.nameOf(r.phone) || 'A member') : (r.source === 'team' ? 'Team' : 'Unknown') }));
  }
  // Team review. Approving a gem places it on the map; approving a site adds it as a source.
  async update(id, { status, teamNote }) {
    const r = this.get(id); if (!r) fail(404, 'No such idea.');
    if (status && !STATUSES.includes(status)) fail(400, 'Unknown status.');
    let result = '';
    if (status === 'approved' && r.status !== 'approved') {
      if (r.kind === 'gem') {
        const at = await this.sms.discovery.locate({ id: 'gem', venue: r.title, address: null, area: r.city || '' }).catch(() => null);
        if (!at) fail(400, 'Couldn’t find that place on the map. Add the city or a fuller name in the note, then approve again.');
        this.db.prepare('UPDATE ideas SET lat=?, lng=? WHERE id=?').run(at.lat, at.lng, id);
      }
      if (r.kind === 'event') {
        const d = JSON.parse(r.data || '{}');
        if (!d.date) fail(400, 'This flyer event has no date. Add it in the note as YYYY-MM-DD, then approve again.');
        await this.sms.sources.addEvent({ title: r.title, date: d.date, time: d.time || '', venue: d.place || '', address: d.address || '', city: r.city || d.city || '', price: d.price || '', url: r.url || '', description: d.details || '' });
        result = 'Added to the event index (it shows up in searches near that city).';
      }
      if (r.kind === 'source') {
        if (!r.url || !r.city) fail(400, 'A source needs a link and a city.');
        const s = await this.sms.sources.add({ url: r.url, city: r.city, name: r.title }).catch(e => { if (e.status === 409) return null; throw e; });
        result = s ? `Added as a source (${s.found} events).` : 'Already a source.';
      }
    }
    this.db.prepare('UPDATE ideas SET status=COALESCE(?, status), team_note=COALESCE(?, team_note), updated=? WHERE id=?').run(status || null, teamNote == null ? null : clean(teamNote, 500), Date.now(), id);
    return { idea: this.list().find(x => x.id === id), result };
  }
  // Approved hidden gems near a spot, for the agent (credited to the member who shared them).
  gemsNear(loc, km = 25) {
    if (loc?.lat == null) return [];
    const dLat = km / 111, dLng = km / (111 * Math.cos(loc.lat * Math.PI / 180));
    return this.db.prepare("SELECT * FROM ideas WHERE kind='gem' AND status='approved' AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY updated DESC LIMIT 10")
      .all(loc.lat - dLat, loc.lat + dLat, loc.lng - dLng, loc.lng + dLng)
      .map(r => `${r.title}${r.note ? ` (${r.note.slice(0, 120)})` : ''}, recommended by ${r.phone ? (this.sms.invites?.nameOf(r.phone) || 'a member') : 'the team'}`);
  }
  wipe(phone) { return this.db.prepare('UPDATE ideas SET phone=NULL WHERE phone=?').run(phone).changes; } // keep the tip, drop who sent it
}
