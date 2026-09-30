// Agent memory, phase 1 (see docs/MEMORY.md): short structured facts per person plus behavior signals, rendered into a
// small "what I know" card each turn. Nothing here is a transcript; the card has a hard size cap, and a person's facts
// are only ever used in their own conversation.
import { randomBytes } from 'node:crypto';
import { fail } from './store.mjs';
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
import { eventById } from './catalog.mjs';
import { stats } from './stats.mjs';

export const KINDS = ['constraint', 'like', 'dislike', 'home', 'person', 'rhythm', 'style', 'note'];
const LABEL = { constraint: 'Limits', home: 'Home base', person: 'People', like: 'Likes', dislike: 'Not into', rhythm: 'Usually', style: 'Texting style', note: 'Notes' };
const WEIGHT = { constraint: 5, home: 4, person: 3.5, dislike: 3, like: 2.5, style: 2.5, rhythm: 2, note: 1 }; // what makes the card first
const CARD_CHARS = 800, MAX_ACTIVE = 60, DAY = 86400000, INFERRED_DAYS = 90;
const norm = v => String(v || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
// Things that never belong in memory (they go to the vault, or nowhere).
const FORBIDDEN = /\b(\d[ -]?){13,19}\b|password|passcode|\bpin\b|social security|\bssn\b|routing number|account number/i;

export class Memory {
  constructor(sms) {
    this.sms = sms; this.db = sms.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_facts (id TEXT PRIMARY KEY, person TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, about TEXT,
        source TEXT NOT NULL, confidence REAL NOT NULL, visibility TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL,
        confirmed_at INTEGER NOT NULL, expires_at INTEGER, archived INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS memory_facts_person ON memory_facts(person, archived);
      CREATE TABLE IF NOT EXISTS memory_signals (person TEXT NOT NULL, type TEXT NOT NULL, subject TEXT NOT NULL, weight REAL NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_signals_person ON memory_signals(person, at);
      CREATE TABLE IF NOT EXISTS memory_meta (k TEXT PRIMARY KEY, v TEXT);`);
  }

  // ---------- facts ----------
  remember(person, { kind, value, about = '', source = 'said', sensitive = false, evidence = null }) {
    if (!person) fail(400, 'No one to remember this for.');
    if (!KINDS.includes(kind)) fail(400, `Kind must be one of: ${KINDS.join(', ')}.`);
    const text = clean(value || '', 120); if (!text) fail(400, 'Nothing to remember.');
    if (FORBIDDEN.test(text)) fail(400, 'That belongs in the secure vault (or nowhere), not in memory.');
    if (sensitive && source !== 'said') fail(400, 'Sensitive details are only kept when they tell you themselves.');
    const now = Date.now(), visibility = sensitive ? 'sensitive' : 'self', key = norm(text);
    const active = this.facts(person);
    // Said beats inferred, and newer beats older: an opposite like/dislike about the same thing is retired.
    const opposite = { like: 'dislike', dislike: 'like' }[kind];
    if (opposite) for (const f of active.filter(f => f.kind === opposite && norm(f.value) === key)) this.db.prepare('UPDATE memory_facts SET archived=1 WHERE id=?').run(f.id);
    const same = active.find(f => f.kind === kind && norm(f.value) === key && norm(f.about) === norm(about));
    if (same) {
      const ev = [...new Set([...JSON.parse(same.evidence), ...(evidence ? [evidence] : [])])].slice(-10);
      const src = same.source === 'said' || source === 'said' ? 'said' : source;
      this.db.prepare('UPDATE memory_facts SET confidence=MIN(1, confidence + 0.15), confirmed_at=?, source=?, evidence=?, expires_at=? WHERE id=?')
        .run(now, src, JSON.stringify(ev), src === 'said' ? null : now + INFERRED_DAYS * DAY, same.id);
      return { ...this.get(same.id), updated: true };
    }
    const id = randomBytes(6).toString('base64url');
    this.db.prepare('INSERT INTO memory_facts (id, person, kind, value, about, source, confidence, visibility, evidence, created, confirmed_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, person, kind, text, clean(about || '', 40) || null, source, source === 'said' ? 0.9 : 0.5, visibility, JSON.stringify(evidence ? [evidence] : []), now, now, source === 'said' ? null : now + INFERRED_DAYS * DAY);
    stats.bump(`memory_${source}`, 1, person);
    this.trim(person);
    return this.get(id);
  }
  get(id) { return this.db.prepare('SELECT * FROM memory_facts WHERE id=?').get(id); }
  facts(person, { all = false } = {}) {
    this.db.prepare('UPDATE memory_facts SET archived=1 WHERE person=? AND archived=0 AND expires_at IS NOT NULL AND expires_at<?').run(person, Date.now()); // stale guesses fade
    return this.db.prepare(`SELECT * FROM memory_facts WHERE person=? ${all ? '' : 'AND archived=0'} ORDER BY created`).all(person);
  }
  score(f) { const age = (Date.now() - f.confirmed_at) / DAY; return (WEIGHT[f.kind] || 1) * f.confidence * (f.source === 'said' ? 1 : 0.7) / (1 + age / 60); }
  trim(person) {
    const active = this.facts(person); if (active.length <= MAX_ACTIVE) return;
    for (const f of active.sort((a, b) => this.score(a) - this.score(b)).slice(0, active.length - MAX_ACTIVE)) this.db.prepare('UPDATE memory_facts SET archived=1 WHERE id=?').run(f.id);
  }
  // "Forget that": by id, or every active fact whose text matches.
  forget(person, what) {
    const q = norm(what); if (!q) return [];
    const hits = this.facts(person, { all: true }).filter(f => f.id === what || norm(f.value).includes(q) || q.includes(norm(f.value)) || (f.about && norm(f.about) === q));
    for (const f of hits) this.db.prepare('DELETE FROM memory_facts WHERE id=?').run(f.id);
    if (hits.length) stats.bump('memory_forgotten', hits.length, person);
    return hits;
  }
  remove(person, id) { return this.db.prepare('DELETE FROM memory_facts WHERE id=? AND person=?').run(id, person).changes > 0; }

  // ---------- behavior ----------
  signal(person, type, subject, weight = 1) {
    if (!person || !subject) return;
    this.db.prepare('INSERT INTO memory_signals VALUES (?,?,?,?,?)').run(person, type, String(subject).slice(0, 60), weight, Date.now());
  }
  // Tastes shown by what they did (picks, votes, outings they went on), recent behavior counting more.
  tastes(person) {
    const rows = this.db.prepare('SELECT subject, weight, at FROM memory_signals WHERE person=? AND at>?').all(person, Date.now() - 365 * DAY);
    const score = {};
    for (const r of rows) score[r.subject] = (score[r.subject] || 0) + r.weight / (1 + (Date.now() - r.at) / (90 * DAY));
    return Object.entries(score).filter(([, v]) => v >= 1.5).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
  }

  // ---------- the card ----------
  // At most ~200 tokens: limits first, then home, people, dislikes, likes, style, rhythm, notes; stale guesses drop first.
  card(person) {
    const facts = this.facts(person).sort((a, b) => this.score(b) - this.score(a));
    const groups = {};
    for (const f of facts) (groups[f.kind] ||= []).push(`${f.value}${f.about ? ` (${f.about})` : ''}${f.source === 'said' ? '' : '?'}`);
    const parts = []; let used = 0;
    for (const kind of Object.keys(LABEL).sort((a, b) => WEIGHT[b] - WEIGHT[a])) {
      if (!groups[kind]) continue;
      const line = `${LABEL[kind]}: ${groups[kind].join('; ')}`;
      const room = CARD_CHARS - used; if (room < 40) break;
      const fit = line.length <= room ? line : `${line.slice(0, room - 1)}…`;
      parts.push(fit); used += fit.length + 3;
    }
    const tastes = this.tastes(person);
    if (tastes.length && used < CARD_CHARS - 40) parts.push(`Tends to pick: ${tastes.join(', ')}`);
    return parts.length ? parts.join(' · ') : '';
  }
  // For "what do you know about me?" and the /me page.
  list(person) { return this.facts(person).map(f => ({ id: f.id, kind: f.kind, label: LABEL[f.kind], value: f.value, about: f.about, source: f.source, sensitive: f.visibility === 'sensitive', since: f.created })); }

  // ---------- wiring ----------
  // Behavior signals from plan activity: outings that happened count for the host and friends who went.
  attach(store) {
    store.listen(({ digest, s, action, actor, via, data = {} }) => {
      if (via === 'lab' || !s) return;
      const flow = this.sms.flow, cats = s.plan.stops.map(id => eventById(id)?.category).filter(Boolean);
      const phoneOf = pid => this.db.prepare('SELECT phone FROM sms_threads WHERE digest=? AND plan=? AND participant=?').get(digest, s.id, pid)?.phone;
      if (action === 'happened') {
        const host = flow.hostPhone(digest); for (const c of cats) this.signal(host, 'went', c, 2);
        for (const p of s.plan.participants.filter(x => x.response === 'yes')) { const ph = phoneOf(p.id); for (const c of cats) this.signal(ph, 'went', c, 2); }
      }
      if (action === 'addStop' && data.eventId) this.signal(flow.hostPhone(digest), 'added', eventById(data.eventId)?.category, 1);
      if (['rsvp', 'smsReply'].includes(action) && actor !== 'host') {
        const r = String(data.response || data.text || '').toLowerCase();
        if (/^(yes|no)$/.test(r)) { const ph = phoneOf(actor); for (const c of cats) this.signal(ph, r === 'yes' ? 'rsvp_yes' : 'rsvp_no', c, r === 'yes' ? 0.5 : -0.5); }
      }
    });
  }
  // One-time: the old per-session preference counters become behavior signals for the host's phone.
  migrate() {
    if (this.db.prepare("SELECT 1 FROM memory_meta WHERE k='migrated_preferences'").get()) return 0;
    let n = 0;
    for (const row of this.db.prepare("SELECT digest, phone FROM sms_threads WHERE role='host'").all()) {
      try {
        const s = this.sms.store.load(row.digest);
        for (const [cat, count] of Object.entries(s.preferences || {})) if (count > 0) { this.signal(row.phone, 'history', cat, Math.min(count, 5)); n++; }
      } catch {}
    }
    this.db.prepare("INSERT OR REPLACE INTO memory_meta VALUES ('migrated_preferences', ?)").run(String(Date.now()));
    return n;
  }
  wipe(person) { return this.db.prepare('DELETE FROM memory_facts WHERE person=?').run(person).changes + this.db.prepare('DELETE FROM memory_signals WHERE person=?').run(person).changes; }
}
