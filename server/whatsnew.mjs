// "What's new" texts: when a release note (server/releases.mjs) goes live, every member who hasn't opted out gets a
// short text about it. Everyone is opted in by default; "no updates" turns it off, "updates on" turns it back on.
// Kind to people: only 9 AM to 8 PM their time, never in the middle of a conversation, at most one update text every
// few hours (several releases are combined), and people who joined after a release never get it.
// Notes marked `team: true` are dev updates for the Rall-e team (the core testers) only; members never see them.
import { RELEASES } from './releases.mjs';
import { localNow } from './timeline.mjs';
import { stats } from './stats.mjs';

const LAB = /^\+1\d{3}555\d{4}$/, MINUTE = 60000, MAX_ITEMS = 5;
export const OFF_WORDS = /^\s*(no|stop|pause|mute|unsubscribe from) (the )?(rall-?e )?updates?[.!]?\s*$|^\s*updates? off[.!]?\s*$/i;
export const ON_WORDS = /^\s*(updates? on|(turn on|resume|start) (the )?updates?)[.!]?\s*$/i;

export class WhatsNew {
  constructor(sms, { releases = RELEASES, env = process.env } = {}) {
    this.sms = sms; this.db = sms.db; this.releases = releases;
    this.gapHours = Number(env.UPDATES_MIN_GAP_HOURS ?? 3); this.window = [9, 20];
    this.db.exec(`CREATE TABLE IF NOT EXISTS update_prefs (phone TEXT PRIMARY KEY, updates INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS update_sent (phone TEXT NOT NULL, release TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (phone, release));
      CREATE TABLE IF NOT EXISTS update_live (release TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS update_approved (release TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
  }
  // A release counts as live from the first time this server saw it without a hold. A held note goes live once Jeff
  // approves it in /ops (Release notes), same as removing hold in releases.mjs.
  approved(id) { return Boolean(this.db.prepare('SELECT 1 FROM update_approved WHERE release=?').get(id)); }
  approve(id) {
    const r = this.releases.find(x => x.id === id);
    if (!r?.hold) { const e = new Error(r ? 'That note is already live.' : 'No such release note.'); e.status = r ? 409 : 404; throw e; }
    this.db.prepare('INSERT OR IGNORE INTO update_approved VALUES (?, ?)').run(id, Date.now());
  }
  live() {
    const out = [];
    for (const r of this.releases) {
      if ((r.hold && !this.approved(r.id)) || !r.id || !r.text) continue;
      this.db.prepare('INSERT OR IGNORE INTO update_live VALUES (?, ?)').run(r.id, Date.now());
      out.push({ ...r, at: this.db.prepare('SELECT at FROM update_live WHERE release=?').get(r.id).at });
    }
    return out;
  }
  wants(phone) { return this.db.prepare('SELECT updates FROM update_prefs WHERE phone=?').get(phone)?.updates !== 0; }
  set(phone, on) {
    this.db.prepare('INSERT OR REPLACE INTO update_prefs VALUES (?, ?, ?)').run(phone, on ? 1 : 0, Date.now());
    stats.bump(on ? 'updates_on' : 'updates_off', 1, phone);
  }
  // When they joined: testers on the allowlist count from the start; others from their opt-in or first text.
  joined(phone) {
    if (this.sms.testers?.has(phone)) return 0;
    const a = this.db.prepare('SELECT at FROM sms_optins WHERE phone=?').get(phone)?.at, b = this.db.prepare('SELECT MIN(created) AS m FROM sms_log WHERE phone=?').get(phone)?.m;
    return Math.min(a ?? Infinity, b ?? Infinity) === Infinity ? Date.now() : Math.min(a ?? Infinity, b ?? Infinity);
  }
  forTeam(phone) { return Boolean(this.sms.testers?.has(phone)); }
  pending(phone, live = this.live()) {
    const joined = this.joined(phone), team = this.forTeam(phone);
    return live.filter(r => (!r.team || team) && r.at >= joined &&!this.db.prepare('SELECT 1 FROM update_sent WHERE phone=? AND release=?').get(phone, r.id));
  }
  // How to turn these off: on someone's first update text, then on every 5th after it (1st, 6th, 11th…).
  footerDue(phone) { return this.db.prepare("SELECT COUNT(*) AS n FROM sms_log WHERE phone=? AND direction='out' AND kind='update'").get(phone).n % 5 === 0; }
  message(items, footer = true) {
    const part = (title, list) => {
      const shown = list.slice(-MAX_ITEMS), more = list.length - shown.length;
      return list.length ? [title, ...shown.map(r => `• ${r.text}`), ...(more ? [`• …plus ${more} more improvements`] : [])] : [];
    };
    return [...part(`What's new on Rall-e:`, items.filter(r => !r.team)), ...part('For the Rall-e team:', items.filter(r => r.team)), ...(footer ? ['(Text "no updates" to turn these off.)'] : [])].join('\n');
  }
  // Who gets them: every member (testers + opted-in people), not STOPped, not opted out, not a lab number.
  audience() { return [...this.sms.allowed].filter(p => !LAB.test(p) && !this.sms.isStopped(p) && this.wants(p)); }
  ready(phone, now = Date.now()) {
    const tz = this.sms.flow.agent?.tzFor?.(phone) || 'America/New_York', h = localNow(tz, now).hour;
    if (h < this.window[0] || h >= this.window[1]) return false;
    const lastIn = this.db.prepare("SELECT MAX(created) AS m FROM sms_log WHERE phone=? AND direction='in'").get(phone)?.m || 0;
    if (now - lastIn < 15 * MINUTE) return false; // mid-conversation: wait
    const lastUpdate = this.db.prepare('SELECT MAX(at) AS m FROM update_sent WHERE phone=?').get(phone)?.m || 0;
    return now - lastUpdate >= this.gapHours * 60 * MINUTE;
  }
  tick(now = Date.now()) {
    const live = this.live(); if (!live.length) return [];
    const sent = [];
    for (const phone of this.audience()) {
      // Team-only dev updates skip the timing rules (daytime, mid-conversation, the gap): they're for us, so they go now.
      const items = this.pending(phone, live); if (!items.length || (!items.some(r => r.team) && !this.ready(phone, now))) continue;
      const status = this.sms.deliver(phone, this.message(items, this.footerDue(phone)), { kind: 'update' });
      if (status === 'blocked') continue;
      for (const r of items) this.db.prepare('INSERT OR IGNORE INTO update_sent VALUES (?, ?, ?)').run(phone, r.id, now);
      stats.bump('updates_sent', 1, phone); sent.push(phone);
    }
    return sent;
  }
  // For the agent ("what's new?") and ops.
  recent(n = 5, phone = '') { const team = this.forTeam(phone); return this.live().filter(r => !r.team || team).slice(-n).map(r => `${r.date}: ${r.team ? '(team) ' : ''}${r.text}`); }
  // For /ops Release notes, newest first: what went out (and to how many) and what is waiting for approval.
  summary() {
    const released = this.live().map(r => ({ id: r.id, date: r.date, text: r.text, team: Boolean(r.team), at: r.at, sent: this.db.prepare('SELECT COUNT(*) AS n FROM update_sent WHERE release=?').get(r.id).n })).reverse();
    const held = this.releases.filter(r => r.hold && !this.approved(r.id)).map(r => ({ id: r.id, date: r.date, text: r.text, team: Boolean(r.team) })).reverse();
    return { released, held, members: this.audience().length };
  }
}
