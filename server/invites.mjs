// Invite-only growth: every member gets a number of invites (10 by default, INVITES_PER_USER). They share reusable
// links (rall-e.ai/i/<code>); an invite counts when someone joins through one. Members manage links, see who joined
// and (later) their profile on a private page, rall-e.ai/me/<token>, which Rall-e texts them.
// People without an invite can join the waitlist on the website.
import { createHash, randomBytes } from 'node:crypto';
import { fail, clean } from './store.mjs';
import { stats } from './stats.mjs';

const hash = v => createHash('sha256').update(String(v)).digest('hex');
const SLUG = /^[a-z0-9-]{8,64}$/;
const PAGE_DAYS = 30, MAX_LINKS = 10;

export class Invites {
  constructor(sms, env = process.env) {
    this.sms = sms; this.db = sms.db; this.quotaDefault = Math.max(0, Number(env.INVITES_PER_USER ?? 10));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invite_links (code TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT, created INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS invite_links_owner ON invite_links(owner);
      CREATE TABLE IF NOT EXISTS invite_uses (invitee TEXT PRIMARY KEY, code TEXT NOT NULL, owner TEXT NOT NULL, name TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invite_quota (phone TEXT PRIMARY KEY, quota INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS me_links (token TEXT PRIMARY KEY, phone TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS waitlist (phone TEXT PRIMARY KEY, name TEXT, at INTEGER NOT NULL, source TEXT, joined INTEGER);`);
  }
  get base() { return this.sms.base || 'https://rall-e.ai'; }
  member(phone) { return Boolean(phone && this.sms.allowed.has(phone) && !this.sms.isStopped(phone)); }
  // First name we know them by: their own plan, a plan they're on, or the name they joined with.
  nameOf(phone) {
    for (const t of this.sms.flow.threadsFor(phone)) { const n = t.role === 'host' ? t.s.name : t.person?.name; if (n) return n; }
    return this.db.prepare('SELECT name FROM invite_uses WHERE invitee=?').get(phone)?.name
      || this.db.prepare('SELECT name FROM waitlist WHERE phone=?').get(phone)?.name || '';
  }
  quota(phone) { return this.db.prepare('SELECT quota FROM invite_quota WHERE phone=?').get(phone)?.quota ?? this.quotaDefault; }
  used(phone) { return this.db.prepare('SELECT COUNT(*) AS n FROM invite_uses WHERE owner=?').get(phone).n; }
  url(code) { return `${this.base}/i/${code}`; }

  // ---------- links ----------
  links(phone) { return this.db.prepare('SELECT code, label, created FROM invite_links WHERE owner=? AND disabled=0 ORDER BY created').all(phone); }
  defaultLink(phone) {
    const first = this.links(phone)[0]; if (first) return first.code;
    return this.create(phone).code;
  }
  create(phone, wanted = '') {
    if (!this.member(phone)) fail(403, 'Only Rall-e members can invite people.');
    if (this.links(phone).length >= MAX_LINKS) fail(409, `You can have up to ${MAX_LINKS} links. Reuse one of them; the same link works for more than one friend.`);
    let code = String(wanted || '').trim().toLowerCase();
    if (code) {
      if (!SLUG.test(code)) fail(400, 'Use 8–64 lowercase letters, numbers, or hyphens.');
      if (this.db.prepare('SELECT 1 FROM invite_links WHERE code=?').get(code)) fail(409, 'That link name is taken. Try another.');
    } else {
      const stem = (this.nameOf(phone) || 'friend').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '').slice(0, 20) || 'friend';
      do code = `${stem}-${randomBytes(4).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5).padEnd(5, '0')}`; while (this.db.prepare('SELECT 1 FROM invite_links WHERE code=?').get(code));
      if (code.length < 8) code = `${code}-rall-e`;
    }
    this.db.prepare('INSERT INTO invite_links (code, owner, label, created) VALUES (?,?,?,?)').run(code, phone, wanted ? code : null, Date.now());
    stats.bump('invite_links_created', 1, phone);
    return { code, url: this.url(code) };
  }
  // Public view of an invite link: who is inviting and whether it still works.
  lookup(code) {
    const row = SLUG.test(String(code || '')) && this.db.prepare('SELECT * FROM invite_links WHERE code=? AND disabled=0').get(code);
    if (!row || !this.member(row.owner)) fail(404, 'This invite link isn’t working anymore. Ask your friend for a new one, or join the waitlist.');
    const remaining = Math.max(0, this.quota(row.owner) - this.used(row.owner));
    return { code: row.code, owner: row.owner, inviter: this.nameOf(row.owner) || 'A friend', remaining };
  }
  check(code) { const l = this.lookup(code); if (!l.remaining) fail(409, `${l.inviter}’s invites are all used up. Join the waitlist and we’ll save you a spot.`); return l; }
  // Called once someone has verified their phone and joined through a link. Tells the inviter.
  recordJoin(code, invitee, name) {
    const l = this.lookup(code);
    if (l.owner === invitee || this.db.prepare('SELECT 1 FROM invite_uses WHERE invitee=?').get(invitee)) return false;
    this.db.prepare('INSERT INTO invite_uses VALUES (?,?,?,?,?)').run(invitee, code, l.owner, (String(name || '').trim().slice(0, 40) || null), Date.now());
    this.db.prepare('UPDATE waitlist SET joined=? WHERE phone=?').run(Date.now(), invitee);
    stats.bump('invite_joins', 1, invitee);
    const used = this.used(l.owner), quota = this.quota(l.owner);
    this.sms.flow.reply(l.owner, `Rall-e: ${String(name || '').trim().slice(0, 40) || 'Someone'} just joined Rall-e with your invite! ${used} of ${quota} invites used.`, 'invite_joined');
    return true;
  }

  // ---------- private "me" page ----------
  pageLink(phone) {
    if (!this.member(phone)) fail(403, 'Only Rall-e members have a page.');
    const token = randomBytes(18).toString('base64url');
    this.db.prepare('INSERT INTO me_links VALUES (?,?,?)').run(hash(token), phone, Date.now() + PAGE_DAYS * 86400000);
    this.db.prepare('DELETE FROM me_links WHERE expires<?').run(Date.now());
    return `${this.base}/me/${token}`;
  }
  phoneFor(token) {
    const row = /^[\w-]{20,40}$/.test(String(token || '')) && this.db.prepare('SELECT phone, expires FROM me_links WHERE token=?').get(hash(token));
    if (!row || row.expires < Date.now() || !this.member(row.phone)) fail(410, 'This page link has expired. Text Rall-e “my invites” for a fresh one.');
    return row.phone;
  }
  view(phone) {
    const joins = this.db.prepare('SELECT code, name, at FROM invite_uses WHERE owner=? ORDER BY at DESC').all(phone);
    if (!this.links(phone).length) this.create(phone);
    return { name: this.nameOf(phone), photo: this.sms.photos?.urlFor(phone) || null, memory: this.sms.memory?.list(phone) || [], alerts: this.sms.alerts?.forPage(phone) || null, quota: this.quota(phone), used: joins.length,
      links: this.links(phone).map(l => ({ code: l.code, url: this.url(l.code), label: l.label, joins: joins.filter(j => j.code === l.code).length })),
      joined: joins.map(j => ({ name: j.name || 'A friend', at: j.at })) };
  }

  // ---------- waitlist ----------
  joinWaitlist(phone, name, source = 'web') {
    if (!phone || !/^\+1\d{10}$/.test(phone)) fail(400, 'Enter a US mobile number, like (555) 123-4567.');
    const first = String(name || '').trim().slice(0, 40); if (!first) fail(400, 'Please enter your first name.');
    if (this.member(phone)) return { member: true };
    const fresh = this.db.prepare('INSERT OR IGNORE INTO waitlist (phone, name, at, source) VALUES (?,?,?,?)').run(phone, first, Date.now(), clean(source, 40)).changes;
    if (fresh) stats.bump('waitlist_joins', 1, phone);
    return { waitlisted: true, position: this.db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE joined IS NULL AND at <= (SELECT at FROM waitlist WHERE phone=?)').get(phone).n };
  }
  // For the operator dashboard: invites per member.
  summary(phone) { return { used: this.used(phone), quota: this.quota(phone) }; }
  waitlistCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM waitlist WHERE joined IS NULL').get().n; }
}
