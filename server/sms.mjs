import { Invites } from './invites.mjs';
import { Photos } from './photos.mjs';
import { Sources } from './sources.mjs';
import { Polls } from './polls.mjs';
import twilio from 'twilio';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { fail } from './store.mjs';
import { TextFlow } from './textflow.mjs';
import { Vault } from './vault.mjs';
import { Discovery } from './discovery.mjs';
import { Sendblue } from './sendblue.mjs';
import { meter } from './usage.mjs';
import { stats } from './stats.mjs';

const digest = value => createHash('sha256').update(value || '').digest('hex');
export const normalize = value => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
};
const mask = value => `••• ${value.slice(-4)}`;
const planVersion = s => JSON.stringify([s.id, s.plan.title, s.plan.status, s.plan.stops]);
const ranks = { submitting: 0, accepted: 1, queued: 2, sending: 3, sent: 4, delivered: 5, undelivered: 5, failed: 5, unknown: 0 };

export class Sms {
  constructor(store, env = process.env, client, fetchImpl) {
    this.store = store; this.db = store.db; this.env = env; this.fetchImpl = fetchImpl;
    this.allowed = new Set((env.SMS_ALLOWED_RECIPIENTS || '').split(',').map(x => normalize(x)).filter(Boolean));
    this.testers = new Set(this.allowed); // the original testers (announcements go only to them)
    // People who opted in themselves from a shared page (double opt-in: consent box + texted code) can be texted too.
    this.db.exec('CREATE TABLE IF NOT EXISTS sms_optins (phone TEXT PRIMARY KEY, at INTEGER NOT NULL, source TEXT NOT NULL, consent TEXT NOT NULL)');
    for (const r of this.db.prepare('SELECT phone FROM sms_optins').all()) this.allowed.add(r.phone);
    this.optinDaily = Math.max(0, Number(env.SMS_OPTIN_DAILY_LIMIT ?? 60)); this.optinMax = Math.max(0, Number(env.SMS_OPTIN_MAX ?? 1000));
    this.base = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    this.from = normalize(env.TWILIO_FROM_NUMBER || '');
    this.service = /^MG[\da-f]{32}$/i.test(env.TWILIO_MESSAGING_SERVICE_SID || '') ? env.TWILIO_MESSAGING_SERVICE_SID : '';
    this.configured = Boolean(/^AC[\da-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID || '') && env.TWILIO_AUTH_TOKEN && this.from && /^https:\/\/[^/?#]+$/.test(this.base));
    this.twilioFrom = this.from;
    // iMessage via Sendblue replaces Twilio for sending and receiving when selected and configured.
    this.sendblue = new Sendblue(env, fetchImpl, this.base);
    this.provider = env.MESSAGING_PROVIDER === 'sendblue' && this.sendblue.configured ? 'sendblue' : 'twilio';
    this.twilioReady = this.configured; this.sendblueRefused = new Set();
    if (this.provider === 'sendblue') { this.from = this.sendblue.number; this.configured = true; }
    this.live = env.SMS_MODE === 'live' && this.configured && this.allowed.size > 0 && (env.SMS_OPERATOR_KEY || '').length >= 24;
    this.limit = Math.max(1, Math.min(100, Number(env.SMS_DAILY_LIMIT) || 20));
    this.client = client || (this.configured ? twilio(env.TWILIO_API_KEY_SID || env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN, { accountSid: env.TWILIO_ACCOUNT_SID, autoRetry: false, timeout: 15000 }) : null);
    this.failedAuth = new Map(); this.lastIn = new Map();
    // Conversational texting (group updates, replies) has its own caps and a 1 msg/sec send queue (Sole Proprietor A2P throughput).
    this.conversationLimit = Math.max(1, Math.min(1000, Number(env.SMS_CONVERSATION_DAILY_LIMIT) || 150));
    this.perRecipientLimit = Math.max(1, Math.min(200, Number(env.SMS_PER_RECIPIENT_DAILY_LIMIT) || 40));
    this.spacing = env.SMS_SEND_SPACING_MS === undefined ? 1100 : Math.max(0, Number(env.SMS_SEND_SPACING_MS) || 0);
    this.queue = Promise.resolve();
    this.db.exec(`CREATE TABLE IF NOT EXISTS sms_messages (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, plan TEXT NOT NULL, participant TEXT NOT NULL,
      invitation TEXT NOT NULL, recipient TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
      version TEXT NOT NULL, created INTEGER NOT NULL, attempted INTEGER, status TEXT NOT NULL,
      sid TEXT UNIQUE, error TEXT);
      CREATE TABLE IF NOT EXISTS sms_stopped (phone TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sms_inbound (sid TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sms_log (id TEXT PRIMARY KEY, phone TEXT NOT NULL, direction TEXT NOT NULL, body TEXT NOT NULL,
        kind TEXT NOT NULL, created INTEGER NOT NULL, status TEXT NOT NULL, sid TEXT UNIQUE, error TEXT);
      CREATE INDEX IF NOT EXISTS sms_log_phone ON sms_log(phone, created);
      CREATE TABLE IF NOT EXISTS imessage_nudges (phone TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS phone_services (phone TEXT PRIMARY KEY, service TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL);`);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('sms_log') WHERE name='media'").get()) this.db.exec('ALTER TABLE sms_log ADD COLUMN media TEXT');
    this.vault = new Vault(store, this, env, fetchImpl);
    meter.attach(this.db); stats.attach(this.db); stats.backfill(); store.listen(event => stats.planEvent(event));
    this.discovery = new Discovery(store, env, fetchImpl);
    this.flow = new TextFlow(store, this);
    this.invites = new Invites(this, env);
    this.photos = new Photos(this, env, fetchImpl);
    this.polls = new Polls(this);
    this.sources = new Sources(this, env, fetchImpl); this.discovery.curated = this.sources;
    this.lastMedia = new Map();
    this.labPhones = new Set(); // fictional 555 phones the presenter is playing in /lab (replies are recorded, never sent) // phone -> the latest photo they texted { url, type, at }
    // Plan pages show people's profile photos: find the phone behind a host (participant '') or a friend on a plan.
    store.photoOf = (s, participant = '') => { const r = this.db.prepare("SELECT phone FROM sms_threads WHERE plan=? AND " + (participant ? 'participant=?' : "role='host'") + ' LIMIT 1').get(...(participant ? [s.id, participant] : [s.id])); return r ? this.photos.urlFor(r.phone) : null; };
  }
  authorize(value, source = 'local') {
    const key = this.env.SMS_OPERATOR_KEY || '', previous = this.failedAuth.get(source);
    if (previous?.until > Date.now()) fail(429, 'Wait a minute before trying the presenter password again.');
    if (key.length < 24 || !timingSafeEqual(Buffer.from(digest(value)), Buffer.from(digest(key)))) {
      if (this.failedAuth.size > 1000) this.failedAuth.clear();
      const count = (previous?.count || 0) + 1;
      this.failedAuth.set(source, { count, until: count >= 5 ? Date.now() + 60000 : 0 });
      fail(403, 'Enter the private SMS presenter password from your Rall-e configuration.');
    }
    this.failedAuth.delete(source);
  }
  // Demo console roles: the operator key can do everything; the viewer key (OPS_VIEWER_KEY, for the business side)
  // can only look (conversations and usage). Returns 'operator' | 'viewer'.
  opsRole(value, source = 'local') {
    const viewer = this.env.OPS_VIEWER_KEY || '';
    if (viewer.length >= 24 && value && timingSafeEqual(Buffer.from(digest(value)), Buffer.from(digest(viewer)))) {
      if (this.failedAuth.get(source)?.until > Date.now()) fail(429, 'Wait a minute before trying again.');
      this.failedAuth.delete(source); return 'viewer';
    }
    try { this.authorize(value, source); } catch (e) { if (e.status === 403) fail(403, 'That key didn’t work.'); throw e; }
    return 'operator';
  }
  publicRow(row) { return { id: row.id, participant: row.participant, kind: row.kind, recipient: mask(row.recipient), body: row.body, status: row.status, error: row.error, created: row.created }; }
  status(session) {
    const s = this.store.get(session);
    return { mode: this.live ? 'live' : 'preview', configured: this.configured, sender: this.from ? mask(this.from) : null,
      messagingService: Boolean(this.service), recipients: this.allowed.size, dailyLimit: this.limit,
      messages: this.db.prepare('SELECT * FROM sms_messages WHERE owner=? AND plan=? AND attempted IS NOT NULL ORDER BY created DESC LIMIT 30').all(digest(session), s.id).map(x => this.publicRow(x)) };
  }
  preview(session, input) {
    const s = this.store.get(session), p = s.plan.participants.find(x => x.id === input.participant);
    if (!p) fail(404, 'Choose a guest from this plan.');
    this.store.guest(p.invite);
    const to = normalize(input.to);
    if (!to) fail(400, 'Use a phone number with its country code, such as +15551234567.');
    if (!['invite', 'update'].includes(input.kind)) fail(400, 'Choose an invitation or confirmation.');
    if (['happened', 'dropped'].includes(s.plan.status)) fail(409, 'This plan is closed.');
    if (input.kind === 'update' && s.plan.status !== 'confirmed') fail(409, 'Confirm the plan before sending an update.');
    const url = `${this.base || 'https://rall-e.joinfitapp.com'}/p/${p.invite}`;
    const body = input.kind === 'invite'
      ? `Rall-e demo: ${s.name} invited you to ${s.plan.title} (sample outing). Details: ${url}\nReply YES, MAYBE or NO to RSVP, or text questions and ideas for the group. STOP to opt out; HELP for help.`
      : `Rall-e demo: ${s.name} confirmed ${s.plan.title} (sample outing). Your updated plan: ${url}\nReply YES, MAYBE or NO. STOP to opt out; HELP for help.`;
    const id = randomUUID();
    this.db.prepare('DELETE FROM sms_messages WHERE status=? AND created<?').run('draft', Date.now() - 600000);
    if (this.db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE owner=? AND status=?').get(digest(session), 'draft').n >= 20) fail(429, 'You have enough previews open. Use one or wait ten minutes.');
    this.db.prepare('INSERT INTO sms_messages(id,owner,plan,participant,invitation,recipient,kind,body,version,created,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, digest(session), s.id, p.id, p.invite, to, input.kind, body, planVersion(s), Date.now(), 'draft');
    return { ...this.publicRow(this.db.prepare('SELECT * FROM sms_messages WHERE id=?').get(id)), mode: this.live ? 'live' : 'preview', allowed: this.allowed.has(to) };
  }
  async send(session, input) {
    const row = this.db.prepare('SELECT * FROM sms_messages WHERE id=? AND owner=?').get(input.id, digest(session));
    if (!row) fail(404, 'Preview the text first.');
    // Claim the draft synchronously before provider I/O. Repeated clicks cannot send twice.
    if (row.status !== 'draft') return this.publicRow(row);
    if (!this.live) fail(409, 'Live texting is disabled. This is only a preview.');
    if (input.consent !== true) fail(400, 'Confirm that this tester agreed to receive this Rall-e text.');
    if (!this.allowed.has(row.recipient)) fail(403, 'This number is not on the approved tester list.');
    const { s, person } = this.store.guest(row.invitation);
    if (person.stopped || this.db.prepare('SELECT phone FROM sms_stopped WHERE phone=?').get(row.recipient)) fail(403, 'This recipient has opted out of texts.');
    if (row.version !== planVersion(s) || Date.now() - row.created > 600000) fail(409, 'The plan or preview has changed. Make a fresh preview.');
    const prior = this.db.prepare('SELECT id FROM sms_messages WHERE plan=? AND participant=? AND kind=? AND attempted IS NOT NULL').get(row.plan, row.participant, row.kind);
    if (prior) fail(409, 'This guest already has a send attempt for this message. Check its delivery status before trying anything else.');
    if (this.db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE attempted>?').get(Date.now() - 86400000).n >= this.limit) fail(429, 'The demo’s daily text limit has been reached.');
    this.db.prepare('UPDATE sms_messages SET status=?,attempted=? WHERE id=?').run('submitting', Date.now(), row.id);
    try {
      const payload = { to: row.recipient, body: row.body, statusCallback: `${this.base}/api/twilio/status?id=${row.id}` };
      if (this.service) payload.messagingServiceSid = this.service; else payload.from = this.from;
      const sent = await this.client.messages.create(payload);
      const current = this.db.prepare('SELECT * FROM sms_messages WHERE id=?').get(row.id);
      if (ranks[current.status] <= (ranks[sent.status] ?? 1)) this.db.prepare('UPDATE sms_messages SET sid=?,status=? WHERE id=?').run(sent.sid, sent.status in ranks ? sent.status : 'accepted', row.id);
      else this.db.prepare('UPDATE sms_messages SET sid=? WHERE id=?').run(sent.sid, row.id);
    } catch (error) {
      // A transport timeout may happen after acceptance. Never automatically retry it.
      const rejected = Number(error.status) >= 400 && Number(error.status) < 500;
      const code = /^\d{3,6}$/.test(String(error.code)) ? String(error.code) : null;
      this.db.prepare('UPDATE sms_messages SET status=?,error=? WHERE id=? AND status=?').run(rejected ? 'failed' : 'unknown', code, row.id, 'submitting');
      if (code === '21610') this.stop(row.recipient);
    }
    const result = this.db.prepare('SELECT * FROM sms_messages WHERE id=?').get(row.id);
    if (!['failed', 'undelivered'].includes(result.status)) this.flow.linkGuest(this.store.digestOf(session), s, row.participant, row.recipient);
    return this.publicRow(result);
  }
  validate(path, signature, params) {
    if (!this.configured || !signature || !twilio.validateRequest(this.env.TWILIO_AUTH_TOKEN, signature, this.base + path, params) || params.AccountSid !== this.env.TWILIO_ACCOUNT_SID) fail(403, 'Invalid webhook signature.');
  }
  callback(id, params) {
    const row = this.db.prepare('SELECT * FROM sms_messages WHERE id=? AND attempted IS NOT NULL').get(id);
    if (!row || !/^(SM|MM)[\da-f]{32}$/i.test(params.MessageSid || '') || (row.sid && row.sid !== params.MessageSid)) fail(404, 'Unknown message.');
    const status = params.MessageStatus;
    if (status in ranks && status !== 'unknown' && status !== 'submitting' && (ranks[status] > ranks[row.status] || status === row.status)) {
      this.db.prepare('UPDATE sms_messages SET sid=?,status=?,error=? WHERE id=?').run(params.MessageSid, status, /^\d{3,6}$/.test(params.ErrorCode || '') ? params.ErrorCode : null, row.id);
    }
    if (params.ErrorCode === '21610') this.stop(row.recipient);
  }
  stop(number) { this.db.prepare('INSERT OR REPLACE INTO sms_stopped VALUES(?,?)').run(number, Date.now()); }
  unstop(number) { this.db.prepare('DELETE FROM sms_stopped WHERE phone=?').run(number); }
  isStopped(number) { return Boolean(this.db.prepare('SELECT phone FROM sms_stopped WHERE phone=?').get(number)); }
  normalize(value) { return normalize(value); }
  // In live mode only approved testers may start a plan by texting in; preview/lab mode is unrestricted (nothing is sent).
  canStart(phone) { return !this.live || this.allowed.has(phone) || this.labPhones.has(phone); } // the presenter lab works in live mode too (nothing is sent)
  log(phone, direction, body, { sid = null, kind = 'reply', status = 'received' } = {}) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO sms_log(id,phone,direction,body,kind,created,status,sid) VALUES(?,?,?,?,?,?,?,?)').run(id, phone, direction, body, kind, Date.now(), status, sid);
    if (direction === 'in') { stats.bump('texts_in', 1, phone); stats.active(phone); }
    return id;
  }
  // Every conversational text goes through here. Returns 'preview' | 'blocked' | 'queued-local'.
  // Self opt-in guardrails: a daily and an overall cap keep a public page from turning into a texting firehose.
  canOptIn() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM sms_optins').get().n, today = this.db.prepare('SELECT COUNT(*) AS n FROM sms_optins WHERE at>?').get(Date.now() - 86400000).n;
    if (!this.live || total >= this.optinMax || today >= this.optinDaily) fail(429, 'Rall-e is full for today. Try again tomorrow!');
  }
  optIn(phone, source, consent) {
    this.db.prepare('INSERT OR IGNORE INTO sms_optins VALUES (?,?,?,?)').run(phone, Date.now(), String(source).slice(0, 60), consent);
    stats.bump('signups_from_share', 1, phone);
    this.allowed.add(phone);
  }
  deliver(phone, body, { kind = 'reply', media = null, optInCode = false, inboundReply = false } = {}) {
    // A single reply to someone who just texted us (e.g. "Rall-e is invite-only") is allowed even if they aren't a member.
    if (inboundReply) optInCode = Boolean(this.db.prepare("SELECT 1 FROM sms_log WHERE phone=? AND direction='in' AND created>?").get(phone, Date.now() - 3600000));
    body = body.length > 1200 ? body.slice(0, 1197) + '…' : body;
    const since = Date.now() - 86400000;
    let status = 'queued-local', error = null;
    if (this.isStopped(phone)) { status = 'blocked'; error = 'opted-out'; }
    else if (!this.live || this.labPhones.has(phone)) status = 'preview'; // phones played in the presenter lab are never really texted
    else if (!this.allowed.has(phone) && !optInCode) { status = 'blocked'; error = 'not-a-tester'; }
    else if (this.db.prepare("SELECT COUNT(*) AS n FROM sms_log WHERE direction='out' AND sid IS NOT NULL AND created>?").get(since).n + this.db.prepare("SELECT COUNT(*) AS n FROM sms_log WHERE status='queued-local'").get().n >= this.conversationLimit) { status = 'blocked'; error = 'daily-limit'; }
    else if (this.db.prepare("SELECT COUNT(*) AS n FROM sms_log WHERE direction='out' AND phone=? AND status NOT IN ('preview','blocked') AND created>?").get(phone, since).n >= this.perRecipientLimit) { status = 'blocked'; error = 'recipient-limit'; }
    const id = this.log(phone, 'out', body, { kind, status });
    if (error) this.db.prepare('UPDATE sms_log SET error=? WHERE id=?').run(error, id);
    if (media) this.db.prepare('UPDATE sms_log SET media=? WHERE id=?').run(media, id);
    if (status === 'queued-local') { stats.bump('texts_out', 1, phone); if (['option', 'group', 'card', 'invite'].includes(kind)) stats.bump(`texts_out_${kind}`, 1, phone); }
    if (status === 'queued-local') this.queue = this.queue.then(() => this.transmit(id)).catch(error => console.error('SMS send failed:', error.message)).then(() => new Promise(r => setTimeout(r, this.spacing)));
    return status;
  }
  idle() { return this.queue; }
  async transmit(id) {
    const row = this.db.prepare('SELECT * FROM sms_log WHERE id=?').get(id);
    if (!row || row.status !== 'queued-local') return;
    if (this.isStopped(row.phone)) { this.db.prepare("UPDATE sms_log SET status='blocked',error='opted-out' WHERE id=?").run(id); return; }
    this.db.prepare("UPDATE sms_log SET status='submitting' WHERE id=?").run(id);
    // Android / non-iMessage numbers go straight to Twilio SMS so they never use a Sendblue seat.
    // ...unless they texted Rall-e's Sendblue line themselves: then we answer on that same line, so they see one thread (and RCS link previews).
    if (this.provider === 'sendblue' && this.twilioReady && (await this.serviceFor(row.phone)) === 'SMS' && this.lastLine(row.phone) !== 'sendblue') return this.sendTwilio(row, id);
    if (this.provider === 'sendblue' && !(this.twilioReady && this.sendblueRefused.has(row.phone))) {
      try {
        const sent = await this.sendblue.send(row);
        this.db.prepare("UPDATE sms_log SET sid=?, status=CASE WHEN status='submitting' THEN ? ELSE status END WHERE id=?").run(sent.sid, sent.status, id);
      } catch (error) {
        // Recipients Sendblue won't take (e.g. unverified contacts on a sandbox line) still get the text via Twilio.
        if (this.twilioReady && /verif|not allowed|unsupported|invalid number|inbound[_ ]only/i.test(error.message)) {
          this.sendblueRefused.add(row.phone); await this.sendTwilio(row, id); await this.nudgeImessage(row.phone); return;
        }
        this.db.prepare("UPDATE sms_log SET status=?,error=? WHERE id=? AND status='submitting'").run(Number(error.status) >= 400 && Number(error.status) < 500 ? 'failed' : 'unknown', String(error.message).slice(0, 80), id);
        stats.gap('text_send_failed', `A text could not be delivered (${String(error.message).slice(0, 60)})`, 'auto', row.phone);
      }
      return;
    }
    return this.sendTwilio(row, id);
  }
  async sendTwilio(row, id) {
    try {
      const payload = { to: row.phone, body: row.body, statusCallback: `${this.base}/api/twilio/status?log=${id}` };
      if (row.media) payload.mediaUrl = [row.media];
      if (this.service) payload.messagingServiceSid = this.service; else payload.from = this.twilioFrom;
      const sent = await this.client.messages.create(payload);
      this.db.prepare("UPDATE sms_log SET sid=?, status=CASE WHEN status='submitting' THEN ? ELSE status END WHERE id=?").run(sent.sid, sent.status in ranks ? sent.status : 'accepted', id);
    } catch (error) {
      const rejected = Number(error.status) >= 400 && Number(error.status) < 500, code = /^\d{3,6}$/.test(String(error.code)) ? String(error.code) : null;
      this.db.prepare("UPDATE sms_log SET status=?,error=? WHERE id=? AND status='submitting'").run(rejected ? 'failed' : 'unknown', code, id);
      if (code === '21610') this.stop(row.phone);
    }
  }
  logCallback(id, params) {
    const row = this.db.prepare("SELECT * FROM sms_log WHERE id=? AND direction='out'").get(id);
    if (!row || !/^(SM|MM)[\da-f]{32}$/i.test(params.MessageSid || '') || (row.sid && row.sid !== params.MessageSid)) fail(404, 'Unknown message.');
    const status = params.MessageStatus;
    if (status in ranks && !['unknown', 'submitting'].includes(status) && (ranks[status] > (ranks[row.status] ?? 0) || status === row.status)) {
      this.db.prepare('UPDATE sms_log SET sid=?,status=?,error=? WHERE id=?').run(params.MessageSid, status, /^\d{3,6}$/.test(params.ErrorCode || '') ? params.ErrorCode : null, id);
    }
    if (params.ErrorCode === '21610') this.stop(row.phone);
  }
  // Presenter lab: simulate texts from fictional 555 numbers only, so a real person can never be impersonated.
  labPhone(value) { const phone = normalize(value); if (!/^\+1\d{3}555\d{4}$/.test(phone)) fail(400, 'Lab phones must be fictional 555 numbers, such as +13105550101.'); return phone; }
  async simulate(from, body) {
    const phone = this.labPhone(from), text = typeof body === 'string' ? body.trim() : '';
    this.labPhones.add(phone);
    if (!text || text.length > 640) fail(400, 'Type a text between 1 and 640 characters.');
    const before = Date.now();
    await this.flow.enqueue(phone, text);
    return { mode: this.live ? 'live' : 'preview', sent: this.db.prepare("SELECT phone, body, status, error FROM sms_log WHERE direction='out' AND created>=? ORDER BY created").all(before).map(r => ({ ...r, phone: /^\+1\d{3}555/.test(r.phone) ? r.phone : mask(r.phone) })) };
  }
  transcript(phones) {
    const list = [...new Set(phones.map(p => this.labPhone(p)))].slice(0, 8);
    const rows = list.length ? this.db.prepare(`SELECT id, phone, direction, body, kind, created, status, error FROM sms_log WHERE phone IN (${list.map(() => '?').join(',')}) ORDER BY created DESC LIMIT 400`).all(...list).reverse() : [];
    return { mode: this.live ? 'live' : 'preview', messages: rows, threads: Object.fromEntries(list.map(p => [p, this.flow.threadsFor(p).map(t => ({ role: t.role, title: t.s.plan.title, host: t.s.name, status: t.s.plan.status, stage: t.s.stage }))])) };
  }
  // ---------- demo operator console (/ops) ----------
  opsPeople() {
    // Everyone we can text, plus anyone who has texted us (even if we can't reply yet), so nobody is invisible here.
    const inbound = this.db.prepare("SELECT DISTINCT phone FROM sms_log WHERE direction='in'").all().map(r => r.phone);
    const phones = [...new Set([...this.allowed, ...inbound])].filter(p => !/^\+1\d{3}555\d{4}$/.test(p));
    return phones.map(phone => {
      const threads = this.flow.threadsFor(phone), t = threads[0];
      const last = this.db.prepare("SELECT direction, body, created FROM sms_log WHERE phone=? AND status!='blocked' ORDER BY rowid DESC LIMIT 1").get(phone);
      const name = t ? (t.role === 'host' ? t.s.name : t.person?.name) : '';
      return { phone, name: name || this.invites.nameOf(phone) || '', tester: this.testers.has(phone), optedIn: this.allowed.has(phone), invites: this.allowed.has(phone) ? this.invites.summary(phone) : null, channel: this.phoneService(phone)?.service || this.lastIn.get(phone)?.service || '', stopped: this.isStopped(phone),
        plans: threads.slice(0, 3).map(x => ({ role: x.role, title: x.s.plan.title, host: x.s.name, status: x.s.plan.status })),
        location: this.discovery.location(phone)?.label || '', last: last ? { from: last.direction === 'in' ? 'them' : 'rall-e', text: last.body.slice(0, 120), at: last.created } : null,
        busy: this.flow.chains.has(phone) };
    }).sort((a, b) => (b.last?.at || 0) - (a.last?.at || 0));
  }
  opsThread(phone) {
    phone = normalize(phone); if (!this.allowed.has(phone) && !this.db.prepare("SELECT 1 FROM sms_log WHERE phone=? AND direction='in' LIMIT 1").get(phone)) fail(404, 'Not a Rall-e number.');
    const messages = this.db.prepare("SELECT direction, body, kind, created, status, error FROM sms_log WHERE phone=? ORDER BY rowid DESC LIMIT 60").all(phone).reverse();
    return { phone, messages, features: this.flow.agent.features.seen(phone), busy: this.flow.chains.has(phone) };
  }
  clearLab(phones) {
    for (const phone of phones.map(p => this.labPhone(p))) {
      for (const table of ['sms_log', 'sms_threads', 'sms_pending', 'sms_stopped']) this.db.prepare(`DELETE FROM ${table} WHERE phone=?`).run(phone);
    }
    return { ok: true };
  }
  linkHost(session, input) {
    const phone = normalize(input.phone);
    if (!phone) fail(400, 'Use a phone number with its country code, such as +15551234567.');
    if (this.live && !this.allowed.has(phone)) fail(403, 'This number is not on the approved tester list.');
    if (this.live && input.consent !== true) fail(400, 'Confirm that you agreed to receive Rall-e texts at this number.');
    return this.flow.linkHost(session, phone);
  }
  // ---------- Sendblue (iMessage) ----------
  // Which of our lines this person last texted: Twilio message SIDs are SM/MM + 32 hex; Sendblue handles are UUIDs.
  lastLine(phone) {
    const r = this.db.prepare("SELECT sid FROM sms_log WHERE phone=? AND direction='in' AND sid IS NOT NULL AND sid NOT LIKE 'SIM%' ORDER BY rowid DESC LIMIT 1").get(phone);
    return !r ? '' : /^(SM|MM)[\da-f]{32}$/i.test(r.sid) ? 'twilio' : 'sendblue';
  }
  // Safety net for webhooks that never arrive (a timeout between the carrier and us drops the text silently):
  // every minute, look at the last few incoming messages on both lines and handle any we haven't seen.
  startCatchUp(ms = 60000) {
    if (!this.live || this.catchUpTimer) return;
    this.catchUpTimer = setInterval(() => this.catchUp().catch(e => console.log(`Inbound catch-up failed: ${e.message}`)), ms); this.catchUpTimer.unref?.();
  }
  async catchUp(windowMs = 60 * 60000) {
    const since = Date.now() - windowMs, seen = sid => this.db.prepare('SELECT 1 FROM sms_inbound WHERE sid=?').get(sid);
    let found = 0;
    if (this.twilioReady && this.client?.messages?.list) {
      for (const m of await this.client.messages.list({ to: this.twilioFrom, dateSentAfter: new Date(since), limit: 20 })) {
        if (m.direction !== 'inbound' || seen(m.sid) || new Date(m.dateSent || m.dateCreated).getTime() < since) continue;
        console.log(`Caught up a missed incoming text (Twilio) from ••• ${String(m.from).slice(-4)}`); found++;
        this.inbound({ From: m.from, To: m.to, Body: m.body, MessageSid: m.sid });
      }
    }
    if (this.provider === 'sendblue' && this.sendblue.configured) {
      for (const m of await this.sendblue.recentInbound()) {
        if (!m.message_handle || seen(m.message_handle) || new Date(m.date_sent || m.date_updated).getTime() < since) continue;
        console.log(`Caught up a missed incoming text (Sendblue) from ••• ${String(m.from_number).slice(-4)}`); found++;
        this.sendblueInbound(this.sendblue.hook, m);
      }
    }
    return found;
  }
  sendblueInbound(key, m) {
    this.sendblue.verify(key);
    if (m.is_outbound || m.group_id) return { ok: true }; // our own echoes; group chats not supported yet
    const from = normalize(m.from_number), handle = String(m.message_handle || '');
    if (!from || !handle || normalize(m.to_number || m.sendblue_number) !== this.sendblue.number) fail(400, 'Invalid incoming message.');
    if (this.db.prepare('SELECT sid FROM sms_inbound WHERE sid=?').get(handle)) return { ok: true };
    this.db.prepare('INSERT INTO sms_inbound VALUES(?,?)').run(handle, Date.now());
    this.lastIn.set(from, { handle, service: m.service || '' });
    if (m.service === 'iMessage') this.setPhoneService(from, 'iMessage', 'inbound'); else if (['SMS', 'RCS'].includes(m.service)) this.setPhoneService(from, 'SMS', 'inbound');
    this.sendblueRefused.delete(from);
    const text = String(m.content || '').trim();
    if (!text && !m.media_url) return { ok: true };
    if (!this.live) { if (/^stop$/i.test(text)) this.stop(from); return { ok: true }; }
    this.flow.enqueue(from, text, { sid: handle, media: m.media_url ? { url: m.media_url, type: '' } : null });
    return { ok: true };
  }
  sendblueStatus(key, id, m) {
    this.sendblue.verify(key);
    const row = this.db.prepare("SELECT * FROM sms_log WHERE id=? AND direction='out'").get(id), status = this.sendblue.status(m.status);
    if (!row || !status || (row.sid && m.message_handle && row.sid !== m.message_handle)) return { ok: true };
    if (ranks[status] > (ranks[row.status] ?? 0) || status === row.status) this.db.prepare('UPDATE sms_log SET status=?, error=? WHERE id=?').run(status, m.error_message ? String(m.error_message).slice(0, 80) : null, id);
    return { ok: true };
  }
  // ---------- iPhone vs Android ----------
  phoneService(phone) { const r = this.db.prepare('SELECT service, source FROM phone_services WHERE phone=?').get(phone); return r ? { service: r.service, source: r.source } : null; }
  setPhoneService(phone, service, source) {
    const current = this.phoneService(phone);
    if (current?.source === 'user' && source !== 'user') return current.service; // the person's own word wins
    this.db.prepare('INSERT OR REPLACE INTO phone_services VALUES (?,?,?,?)').run(phone, service, source, Date.now());
    if (service === 'iMessage') this.sendblueRefused.delete(phone);
    return service;
  }
  async serviceFor(phone) {
    const known = this.phoneService(phone);
    if (known) return known.service;
    if (this.provider !== 'sendblue') return null;
    try { const found = await this.sendblue.lookup(phone); if (found) return this.setPhoneService(phone, found, 'lookup'); }
    catch (e) { console.error('iMessage lookup failed:', e.message); }
    return null; // unknown: try iMessage, fall back to SMS
  }
  // Person told us their phone type ("I'm on Android", "ANDROID", "I have an iPhone").
  async setPhoneType(phone, type) {
    const service = this.setPhoneService(phone, type === 'android' ? 'SMS' : 'iMessage', 'user');
    if (service === 'iMessage' && this.provider === 'sendblue') await this.nudgeImessage(phone, true);
    return service;
  }
  // One-time invite to move to iMessage: add them as a Sendblue contact, then ask for one text to the iMessage line
  // (Sendblue needs people to text first). Sent over SMS, once per phone.
  async nudgeImessage(phone, force = false) {
    if (this.provider !== 'sendblue' || !this.twilioReady || (!force && this.db.prepare('SELECT 1 FROM imessage_nudges WHERE phone=?').get(phone))) return;
    if (!force && (await this.serviceFor(phone)) === 'SMS') return; // Android: nothing to switch to
    this.db.prepare('INSERT OR REPLACE INTO imessage_nudges VALUES (?,?)').run(phone, Date.now());
    try { await this.sendblue.addContact(phone); } catch (e) { console.error('Sendblue add contact failed:', e.message); }
    const id = this.log(phone, 'out', `Rall-e is on iMessage 💙 Tap ${this.base}/imessage and hit send (or text hi to ${this.sendblue.pretty()}). Your plans come with you. On Android? Reply ANDROID and I'll keep regular texts.`, { kind: 'nudge', status: 'submitting' });
    await this.sendTwilio(this.db.prepare('SELECT * FROM sms_log WHERE id=?').get(id), id);
  }
  // Tapback/emoji reaction to the person's latest iMessage. Only possible on iMessage via Sendblue.
  canReact(phone) { return this.provider === 'sendblue' && this.live && this.allowed.has(phone) && this.lastIn.get(phone)?.service === 'iMessage'; }
  async react(phone, reaction) {
    if (!this.canReact(phone)) fail(409, 'Reactions only work in iMessage.');
    await this.sendblue.react(this.lastIn.get(phone).handle, reaction);
  }
  typing(phone) { if (this.provider === 'sendblue' && this.live && this.allowed.has(phone)) this.sendblue.typing(phone); }
  inbound(params) {
    const from = normalize(params.From), to = normalize(params.To);
    if (!/^(SM|MM)[\da-f]{32}$/i.test(params.MessageSid || '') || !from || to !== this.twilioFrom) fail(400, 'Invalid incoming message.');
    const empty = new twilio.twiml.MessagingResponse().toString();
    if (this.db.prepare('SELECT sid FROM sms_inbound WHERE sid=?').get(params.MessageSid)) return empty;
    const text = (params.Body || '').trim().toUpperCase();
    const optOut = ['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT'].includes(text) || params.OptOutType === 'STOP';
    // Opt-outs are always honored, even in preview mode. Everything else is processed only in live mode.
    if (!this.live && !optOut) return empty;
    this.db.prepare('INSERT INTO sms_inbound VALUES(?,?)').run(params.MessageSid, Date.now());
    if (!this.live) this.stop(from);
    // Handled after the webhook returns (the agent may take a few seconds); replies go out through the send queue.
    else {
      this.lastIn.set(from, { handle: '', service: 'SMS' });
      const photo = Number(params.NumMedia) > 0 && /^image\/|vcard|directory/i.test(params.MediaContentType0 || '') ? { url: params.MediaUrl0, type: params.MediaContentType0 } : null;
      this.flow.enqueue(from, params.Body || '', { sid: params.MessageSid, optOutType: params.OptOutType || '', media: photo });
    }
    return empty;
  }
}
