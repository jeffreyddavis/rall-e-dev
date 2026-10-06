// Long-term product analytics and "gaps" (what people ask for that Rall-e can't do yet). Both are anonymous and
// survive conversation wipes: counters per day, people only as salted hashes (for "active" and "returning"), and
// for gaps a single scrubbed example per category, never who asked.
import { createHmac, randomBytes } from 'node:crypto';

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const fictional = phone => /^\+1\d{3}555\d{4}$/.test(phone || ''); // SMS lab numbers are test noise
// Strip anything personal from an example ask: phone numbers, emails, links, street numbers, @handles.
export const scrub = text => String(text || '').replace(/https?:\/\/\S+/g, '[link]').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]').replace(/\b\d{2,5}\s+[A-Z][a-z]+\s+(St|Ave|Blvd|Rd|Dr|Way|Ln)\b\.?/g, '[address]').replace(/@\w+/g, '@[name]').replace(/\s+/g, ' ').trim().slice(0, 160);

export const stats = {
  db: null, salt: '',
  attach(db) {
    if (this.db === db) return; this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS stat_counts (day TEXT NOT NULL, event TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, event));
      CREATE TABLE IF NOT EXISTS stat_actives (day TEXT NOT NULL, who TEXT NOT NULL, PRIMARY KEY (day, who));
      CREATE TABLE IF NOT EXISTS stat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gaps (category TEXT PRIMARY KEY, n INTEGER NOT NULL, example TEXT NOT NULL, source TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);`);
    // Gap follow-up: status (open / in_progress / fixed / by_design) and a note on what was done.
    for (const col of ["status TEXT NOT NULL DEFAULT 'open'", 'note TEXT', 'status_at INTEGER']) { try { db.exec(`ALTER TABLE gaps ADD COLUMN ${col}`); } catch {} }
    // Who already asked for a gap: a salted hash per category (can't be traced to a number or linked across gaps).
    db.exec('CREATE TABLE IF NOT EXISTS gap_people (category TEXT NOT NULL, who TEXT NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY (category, who))');
    let row = db.prepare("SELECT value FROM stat_meta WHERE key='salt'").get();
    if (!row) { row = { value: randomBytes(24).toString('hex') }; db.prepare("INSERT INTO stat_meta VALUES ('salt', ?)").run(row.value); }
    this.salt = row.value;
  },
  // One time: seed the counters from the texts already on record, so history from the test period isn't lost.
  backfill() {
    const db = this.db;
    if (!db || db.prepare("SELECT 1 FROM stat_meta WHERE key='backfilled'").get() || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='sms_log'").get()) return;
    const rows = db.prepare("SELECT phone, direction, kind, created, status, sid FROM sms_log WHERE status NOT IN ('blocked','preview')").all();
    const add = (d, e) => db.prepare('INSERT INTO stat_counts VALUES (?,?,1) ON CONFLICT(day, event) DO UPDATE SET n=n+1').run(d, e);
    for (const r of rows) {
      if (fictional(r.phone)) continue;
      const d = day(r.created);
      if (r.direction === 'in') { add(d, 'texts_in'); db.prepare('INSERT OR IGNORE INTO stat_actives VALUES (?,?)').run(d, createHmac('sha256', this.salt).update(r.phone).digest('hex').slice(0, 20)); }
      else if (r.sid) { add(d, 'texts_out'); if (['option', 'group', 'card', 'invite'].includes(r.kind)) add(d, `texts_out_${r.kind}`); }
    }
    db.prepare("INSERT INTO stat_meta VALUES ('backfilled', ?)").run(String(Date.now()));
  },
  bump(event, n = 1, phone = '') {
    if (!this.db || fictional(phone) || !n) return;
    this.db.prepare('INSERT INTO stat_counts VALUES (?,?,?) ON CONFLICT(day, event) DO UPDATE SET n=n+excluded.n').run(day(), event, n);
  },
  // A person was active today, stored only as a salted hash so no one can tell who.
  active(phone) {
    if (!this.db || !phone || fictional(phone)) return;
    this.db.prepare('INSERT OR IGNORE INTO stat_actives VALUES (?,?)').run(day(), createHmac('sha256', this.salt).update(phone).digest('hex').slice(0, 20));
  },
  // Something they asked for that Rall-e couldn't do (or that failed). One example per category, newest wins.
  gap(category, example, source = 'agent', phone = '') {
    if (!this.db || fictional(phone)) return;
    const cat = String(category || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'other', ex = scrub(example) || '(no example)';
    // One ask per person per conversation: the same person and gap within 24 hours counts once (the AI tends to log it
    // again on every reply). People are counted too, so "32 times" reads as "32 asks from 4 people".
    if (phone) {
      const who = createHmac('sha256', this.salt).update(`${cat}|${phone}`).digest('hex').slice(0, 20), now = Date.now();
      const seen = this.db.prepare('SELECT last_at FROM gap_people WHERE category=? AND who=?').get(cat, who);
      this.db.prepare('INSERT INTO gap_people VALUES (?,?,?) ON CONFLICT(category, who) DO UPDATE SET last_at=excluded.last_at').run(cat, who, now);
      if (seen && now - seen.last_at < 86400000) { this.db.prepare('UPDATE gaps SET example=?, last_at=? WHERE category=?').run(ex, now, cat); return; }
    }
    this.db.prepare('INSERT INTO gaps (category, n, example, source, first_at, last_at) VALUES (?,1,?,?,?,?) ON CONFLICT(category) DO UPDATE SET n=n+1, example=excluded.example, source=excluded.source, last_at=excluded.last_at').run(cat, ex, source, Date.now(), Date.now());
  },
  setGap(category, { status, note }) {
    if (!['open', 'in_progress', 'fixed', 'by_design'].includes(status)) throw Object.assign(new Error('Unknown status.'), { status: 400 });
    const r = this.db.prepare('UPDATE gaps SET status=?, note=?, status_at=? WHERE category=?').run(status, String(note || '').slice(0, 300), Date.now(), category);
    if (!r.changes) throw Object.assign(new Error('Unknown gap.'), { status: 404 });
  },
  // Rall-e's plan events, counted by kind.
  planEvent({ action, data = {}, via, actor }) {
    if (via === 'lab') return;
    const map = { accept: 'plans_created', confirm: 'plans_confirmed', addStop: 'stops_added', removeStop: 'stops_removed', suggest: 'ideas_suggested', vote: 'votes', joined: 'joined_from_share', reopen: 'plans_reopened', drop: 'plans_called_off', happened: 'plans_happened', selectSuggestion: 'ideas_adopted', chat: 'group_messages', removeGuest: 'guests_removed' };
    if (map[action]) this.bump(map[action]);
    if (action === 'invite') this.bump('invites_sent', (data.added || []).length);
    if (['rsvp', 'smsReply', 'text'].includes(action) && actor !== 'host') { const r = String(data.response || data.text || '').toLowerCase(); if (['yes', 'maybe', 'no'].includes(r)) this.bump(`rsvp_${r}`); }
  },

  report() {
    const db = this.db, since = n => day(Date.now() - n * 86400000);
    const sum = (event, from = '0000') => db.prepare('SELECT COALESCE(SUM(n),0) n FROM stat_counts WHERE event=? AND day>=?').get(event, from).n;
    const events = db.prepare('SELECT DISTINCT event FROM stat_counts').all().map(r => r.event);
    const totals = Object.fromEntries(events.map(e => [e, sum(e)])), week = Object.fromEntries(events.map(e => [e, sum(e, since(6))]));
    const days = [...Array(14)].map((_, i) => since(13 - i));
    const series = days.map(d => ({ day: d, texts_in: db.prepare("SELECT COALESCE(SUM(n),0) n FROM stat_counts WHERE day=? AND event='texts_in'").get(d).n,
      texts_out: db.prepare("SELECT COALESCE(SUM(n),0) n FROM stat_counts WHERE day=? AND event='texts_out'").get(d).n, active: db.prepare('SELECT COUNT(*) n FROM stat_actives WHERE day=?').get(d).n }));
    const people = db.prepare('SELECT COUNT(DISTINCT who) n FROM stat_actives').get().n;
    const returning = db.prepare('SELECT COUNT(*) n FROM (SELECT who FROM stat_actives GROUP BY who HAVING COUNT(DISTINCT day) >= 2)').get().n;
    const active7 = db.prepare('SELECT COUNT(DISTINCT who) n FROM stat_actives WHERE day>=?').get(since(6)).n;
    const since0 = db.prepare('SELECT MIN(day) d FROM stat_counts').get().d;
    return { since: since0, totals, week, series, people: { all: people, returning, active7 },
      gaps: db.prepare('SELECT g.category, g.n, g.example, g.source, g.first_at, g.last_at, g.status, g.note, g.status_at, (SELECT COUNT(*) FROM gap_people p WHERE p.category=g.category) AS people FROM gaps g ORDER BY g.n DESC, g.last_at DESC LIMIT 500').all()
        .map(g => ({ ...g, again: g.status === 'fixed' && g.status_at && g.last_at > g.status_at })) }; // "seen again since it was marked fixed"
  }
};
