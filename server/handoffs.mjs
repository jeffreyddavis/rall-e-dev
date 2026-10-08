// Human helpers (Mike, 10-07): when Rall-e can't finish something a person could (a table the booking link and the
// restaurant call couldn't get, a question only a phone call answers), the agent hands it to the team's queue in
// /ops with the hand_off tool. A helper claims it, does it, and records what happened; Rall-e then texts the member
// the result in its own voice (operatorNudge, so opt-in, STOP and caps all apply).
// Helpers log in to /ops with their own key and see only this queue. They never take payments or card details.
// The hand_off tool is only offered while at least one helper is active, so members see no change until then.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from './store.mjs';
import { stats } from './stats.mjs';

export const KINDS = ['reservation', 'call', 'info', 'other'];
export const PROMISE = 'a person on the Rall-e team will take it from here and text them back, usually within a few hours during the day';
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const hash = v => createHash('sha256').update(String(v)).digest('hex');
const DAY = 86400000, MAX_OPEN = 3, MAX_DAY = 6;
const last4 = p => `••• ${String(p).slice(-4)}`;

// The only /api/ops routes a helper key can reach. Everything else answers 404, as if it didn't exist.
export const helperAllowed = path => path === '/api/ops/me' || path === '/api/ops/handoffs';

export class Handoffs {
  constructor(sms, env = process.env, normalize = v => v) {
    this.sms = sms; this.db = sms.db; this.base = env.PUBLIC_BASE_URL || 'https://rall-e.ai'; this.normalize = normalize; // sms.mjs's phone normalizer
    this.db.exec(`CREATE TABLE IF NOT EXISTS helpers (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, phone TEXT,
        active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, phone TEXT NOT NULL, name TEXT, kind TEXT NOT NULL, goal TEXT NOT NULL, details TEXT, tried TEXT,
        status TEXT NOT NULL DEFAULT 'open', helper TEXT, claimed_at INTEGER, result TEXT, note TEXT, told TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
        done_at INTEGER, log TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS handoffs_phone ON handoffs(phone, status);`);
  }

  // ---- Helper accounts (the operator adds and switches them off in /ops) ----
  helpers() {
    return this.db.prepare('SELECT * FROM helpers ORDER BY active DESC, created').all().map(h => ({ id: h.id, name: h.name, active: Boolean(h.active),
      phone: h.phone ? last4(h.phone) : null, created: h.created, lastSeen: h.last_seen,
      working: this.db.prepare("SELECT COUNT(*) n FROM handoffs WHERE helper=? AND status='claimed'").get(h.id).n }));
  }
  // Returns the new key once; only its hash is stored.
  addHelper({ name, phone = '' } = {}) {
    const n = clean(name, 40); if (!n) fail(400, 'Give the helper a name.');
    const p = phone ? this.normalize(phone) || null : null;
    if (phone && !p) fail(400, 'Use a phone number with its area code, or leave it empty.');
    const id = `hp_${randomBytes(5).toString('base64url')}`, key = `rh_${randomBytes(24).toString('base64url')}`;
    this.db.prepare('INSERT INTO helpers (id, name, key_hash, phone, created) VALUES (?,?,?,?,?)').run(id, n, hash(key), p, Date.now());
    return { id, name: n, key };
  }
  setHelper(id, { active }) {
    if (!this.db.prepare('SELECT 1 FROM helpers WHERE id=?').get(id)) fail(404, 'No such helper.');
    this.db.prepare('UPDATE helpers SET active=? WHERE id=?').run(active ? 1 : 0, id);
    // Their unfinished work goes back to the queue so it isn't stuck with someone who can't log in.
    if (!active) this.db.prepare("UPDATE handoffs SET status='open', helper=NULL, claimed_at=NULL, updated=? WHERE helper=? AND status='claimed'").run(Date.now(), id);
  }
  // The helper behind a key, or null. Constant-time compare against the stored hash.
  byKey(value) {
    if (!value || String(value).length < 24) return null;
    const h = hash(value), row = this.db.prepare('SELECT * FROM helpers WHERE key_hash=? AND active=1').get(h);
    if (!row || !timingSafeEqual(Buffer.from(row.key_hash), Buffer.from(h))) return null;
    if (!row.last_seen || Date.now() - row.last_seen > 60000) this.db.prepare('UPDATE helpers SET last_seen=? WHERE id=?').run(Date.now(), row.id);
    return { id: row.id, name: row.name };
  }
  available() { return Boolean(this.db.prepare('SELECT 1 FROM helpers WHERE active=1 LIMIT 1').get()); }

  // ---- Handoffs ----
  add(phone, { name = '', kind, goal, details = '', tried = '' } = {}) {
    if (!KINDS.includes(kind)) fail(400, `Kind must be one of: ${KINDS.join(', ')}.`);
    const g = clean(goal, 200); if (!g) fail(400, 'Say what needs doing.');
    if (this.db.prepare("SELECT COUNT(*) n FROM handoffs WHERE phone=? AND status IN ('open','claimed')").get(phone).n >= MAX_OPEN)
      fail(429, `They already have ${MAX_OPEN} things with the team. Let those finish first.`);
    if (this.db.prepare('SELECT COUNT(*) n FROM handoffs WHERE phone=? AND created>?').get(phone, Date.now() - DAY).n >= MAX_DAY) fail(429, 'That’s the most handoffs for one day.');
    const id = `ho_${randomBytes(5).toString('base64url')}`, now = Date.now();
    this.db.prepare('INSERT INTO handoffs (id, phone, name, kind, goal, details, tried, created, updated, log) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, phone, clean(name, 40) || null, kind, g, clean(details, 800) || null, clean(tried, 500) || null, now, now, JSON.stringify([{ at: now, who: 'Rall-e', what: 'Handed off' }]));
    stats.bump('handoffs_created', 1, phone);
    this.alert(this.get(id));
    return this.get(id);
  }
  get(id) { return this.db.prepare('SELECT * FROM handoffs WHERE id=?').get(id); }
  must(id) { const r = this.get(id); if (!r) fail(404, 'That handoff is gone.'); return r; }
  note_(r, who, what) { const log = JSON.parse(r.log || '[]'); log.push({ at: Date.now(), who: who.name, what }); return JSON.stringify(log.slice(-40)); }
  // For the agent's situation: what this person is waiting on, so it doesn't hand the same thing off twice.
  openFor(phone) {
    const rows = this.db.prepare("SELECT goal, status, created FROM handoffs WHERE phone=? AND status IN ('open','claimed') ORDER BY created").all(phone);
    return rows.length ? `Handed to the Rall-e team, waiting on a person (don't hand these off again; if they ask, say someone is on it): ${rows.map(r => `${r.goal} (${r.status === 'claimed' ? 'someone is working on it' : 'not picked up yet'})`).join('; ')}` : '';
  }
  // What /ops shows for one handoff. The full number only through reveal (logged).
  view(r, helpers = new Map()) {
    // Their latest texts with Rall-e (including anything they added after the handoff), never the helper alerts.
    const convo = this.db.prepare("SELECT direction, body, created FROM sms_log WHERE phone=? AND status != 'blocked' AND kind != 'helper' ORDER BY rowid DESC LIMIT 14")
      .all(r.phone).reverse().map(m => ({ from: m.direction === 'in' ? 'them' : 'rall-e', text: m.body, at: m.created }));
    return { id: r.id, kind: r.kind, goal: r.goal, details: r.details, tried: r.tried, status: r.status, name: r.name, phone: last4(r.phone),
      helper: r.helper ? { id: r.helper, name: helpers.get(r.helper) || (r.helper === 'operator' ? 'Operator' : 'A helper') } : null,
      claimedAt: r.claimed_at, result: r.result, note: r.note, told: r.told, created: r.created, updated: r.updated, doneAt: r.done_at, log: JSON.parse(r.log || '[]'), convo };
  }
  // Open first (oldest first), then in progress, then finished in the last two weeks (newest first).
  list() {
    const names = new Map(this.db.prepare('SELECT id, name FROM helpers').all().map(h => [h.id, h.name]));
    const rows = this.db.prepare(`SELECT * FROM handoffs WHERE status IN ('open','claimed') OR updated>? ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END,
      CASE WHEN status IN ('open','claimed') THEN created ELSE -updated END LIMIT 200`).all(Date.now() - 14 * DAY);
    return rows.map(r => this.view(r, names));
  }
  canTouch(r, who) { return who.id === 'operator' || r.helper === who.id; }
  claim(id, who) {
    const r = this.must(id);
    if (r.status !== 'open') fail(409, r.status === 'claimed' ? 'Someone already took this one.' : 'This one is finished.');
    this.db.prepare("UPDATE handoffs SET status='claimed', helper=?, claimed_at=?, updated=?, log=? WHERE id=? AND status='open'").run(who.id, Date.now(), Date.now(), this.note_(r, who, 'Took it'), id);
    return this.get(id);
  }
  release(id, who) {
    const r = this.must(id);
    if (r.status !== 'claimed' || !this.canTouch(r, who)) fail(409, 'Only the person working on it can put it back.');
    this.db.prepare("UPDATE handoffs SET status='open', helper=NULL, claimed_at=NULL, updated=?, log=? WHERE id=?").run(Date.now(), this.note_(r, who, 'Put it back in the queue'), id);
    return this.get(id);
  }
  // The full number, for a booking that needs it. Every look is logged on the handoff.
  reveal(id, who) {
    const r = this.must(id);
    if (!['open', 'claimed'].includes(r.status)) fail(409, 'This one is finished.');
    if (r.status === 'claimed' && !this.canTouch(r, who)) fail(409, 'Someone else is working on this one.');
    this.db.prepare('UPDATE handoffs SET log=?, updated=? WHERE id=?').run(this.note_(r, who, 'Looked at their phone number'), Date.now(), id);
    console.log(`Handoff ${id}: ${who.name} viewed the number (••• ${r.phone.slice(-4)})`);
    return { phone: r.phone };
  }
  // Finish it and have Rall-e tell them. outcome: done | failed. result: what to tell the member (facts, numbers, times).
  resolve(id, who, { outcome, result, note = '' } = {}) {
    let r = this.must(id);
    if (!['done', 'failed'].includes(outcome)) fail(400, 'Say whether it worked.');
    const res = clean(result, 600); if (res.length < 3) fail(400, 'Write what Rall-e should tell them.');
    if (r.status === 'open') r = this.claim(id, who);
    if (r.status !== 'claimed') fail(409, 'This one is already finished.');
    if (!this.canTouch(r, who)) fail(409, 'Someone else is working on this one.');
    const told = this.tell(r, outcome, res), now = Date.now();
    this.db.prepare('UPDATE handoffs SET status=?, result=?, note=?, told=?, done_at=?, updated=?, log=? WHERE id=?')
      .run(outcome, res, clean(note, 600) || null, told, now, now, this.note_(r, who, outcome === 'done' ? 'Done' : 'Couldn’t do it'), id);
    stats.bump(outcome === 'done' ? 'handoffs_done' : 'handoffs_failed', 1, r.phone);
    return this.get(id);
  }
  cancel(id, who, reason = '') {
    const r = this.must(id);
    if (!['open', 'claimed'].includes(r.status)) fail(409, 'This one is already finished.');
    this.db.prepare("UPDATE handoffs SET status='cancelled', note=?, done_at=?, updated=?, log=? WHERE id=?").run(clean(reason, 300) || null, Date.now(), Date.now(), this.note_(r, who, 'Cancelled'), id);
    return this.get(id);
  }
  // Rall-e texts the member in its own voice. Returns how they were told (shown in /ops).
  tell(r, outcome, result) {
    const sms = this.sms;
    if (!sms.allowed?.has(r.phone)) return 'Not texted: they aren’t opted in.';
    if (sms.isStopped?.(r.phone)) return 'Not texted: they opted out (STOP).';
    const what = `Behind the scenes: a person on the Rall-e team finished something you handed off for them earlier: "${r.goal}". ${outcome === 'done' ? 'It worked.' : 'It didn’t work out.'} What happened (pass on names, times and confirmation numbers exactly): ${result}. Text them now in your own voice, say someone on the team took care of it${outcome === 'done' ? '' : ', and offer a next step'}.`;
    try {
      if (sms.flow?.agent?.enabled) { sms.flow.operatorNudge(r.phone, what); return 'Rall-e is texting them the result.'; }
      sms.deliver(r.phone, `Update from the Rall-e team on "${r.goal}": ${result}`, { kind: 'reply' });
      return 'Texted them the result (the AI was off, so word for word).';
    } catch (e) { return `Not texted: ${e.message}`; }
  }
  // A new handoff: text every active helper who has a phone (deliver applies opt-in and caps).
  alert(r) {
    for (const h of this.db.prepare('SELECT phone FROM helpers WHERE active=1 AND phone IS NOT NULL').all()) {
      try { this.sms.deliver(h.phone, `New Rall-e handoff (${r.kind}): ${r.goal}\n${this.base}/ops`, { kind: 'helper' }); } catch (e) { console.error('Handoff alert:', e.message); }
    }
  }
}
