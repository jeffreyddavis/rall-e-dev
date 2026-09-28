import twilio from 'twilio';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { fail } from './store.mjs';

const digest = value => createHash('sha256').update(value || '').digest('hex');
const phone = value => typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);
const mask = value => `••• ${value.slice(-4)}`;
const planVersion = s => JSON.stringify([s.id, s.plan.title, s.plan.status, s.plan.stops]);
const ranks = { submitting: 0, accepted: 1, queued: 2, sending: 3, sent: 4, delivered: 5, undelivered: 5, failed: 5, unknown: 0 };

export class Sms {
  constructor(store, env = process.env, client) {
    this.store = store; this.db = store.db; this.env = env;
    this.allowed = new Set((env.SMS_ALLOWED_RECIPIENTS || '').split(',').map(x => x.trim()).filter(phone));
    this.base = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    this.configured = Boolean(/^AC[\da-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID || '') && env.TWILIO_AUTH_TOKEN && phone(env.TWILIO_FROM_NUMBER) && /^https:\/\/[^/?#]+$/.test(this.base));
    this.live = env.SMS_MODE === 'live' && this.configured && this.allowed.size > 0 && (env.SMS_OPERATOR_KEY || '').length >= 24;
    this.limit = Math.max(1, Math.min(100, Number(env.SMS_DAILY_LIMIT) || 20));
    this.client = client || (this.configured ? twilio(env.TWILIO_API_KEY_SID || env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN, { accountSid: env.TWILIO_ACCOUNT_SID, autoRetry: false, timeout: 15000 }) : null);
    this.failedAuth = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS sms_messages (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, plan TEXT NOT NULL, participant TEXT NOT NULL,
      invitation TEXT NOT NULL, recipient TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
      version TEXT NOT NULL, created INTEGER NOT NULL, attempted INTEGER, status TEXT NOT NULL,
      sid TEXT UNIQUE, error TEXT);
      CREATE TABLE IF NOT EXISTS sms_stopped (phone TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sms_inbound (sid TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
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
  publicRow(row) { return { id: row.id, participant: row.participant, kind: row.kind, recipient: mask(row.recipient), body: row.body, status: row.status, error: row.error, created: row.created }; }
  status(session) {
    const s = this.store.get(session);
    return { mode: this.live ? 'live' : 'preview', configured: this.configured, sender: phone(this.env.TWILIO_FROM_NUMBER) ? mask(this.env.TWILIO_FROM_NUMBER) : null,
      recipients: this.allowed.size, dailyLimit: this.limit,
      messages: this.db.prepare('SELECT * FROM sms_messages WHERE owner=? AND plan=? AND attempted IS NOT NULL ORDER BY created DESC LIMIT 30').all(digest(session), s.id).map(x => this.publicRow(x)) };
  }
  preview(session, input) {
    const s = this.store.get(session), p = s.plan.participants.find(x => x.id === input.participant);
    if (!p) fail(404, 'Choose a guest from this plan.');
    this.store.guest(p.invite);
    if (!phone(input.to)) fail(400, 'Use a phone number with its country code, such as +15551234567.');
    if (!['invite', 'update'].includes(input.kind)) fail(400, 'Choose an invitation or confirmation.');
    if (['happened', 'dropped'].includes(s.plan.status)) fail(409, 'This plan is closed.');
    if (input.kind === 'update' && s.plan.status !== 'confirmed') fail(409, 'Confirm the plan before sending an update.');
    const url = `${this.base || 'https://rall-e.joinfitapp.com'}/p/${p.invite}`;
    const body = input.kind === 'invite'
      ? `Rall-e demo: ${s.name} invited you to ${s.plan.title} (sample outing). Details: ${url}\nReply YES, MAYBE or NO to RSVP. STOP to opt out; HELP for help.`
      : `Rall-e demo: ${s.name} confirmed ${s.plan.title} (sample outing). Your updated plan: ${url}\nReply YES, MAYBE or NO. STOP to opt out; HELP for help.`;
    const id = randomUUID();
    this.db.prepare('DELETE FROM sms_messages WHERE status=? AND created<?').run('draft', Date.now() - 600000);
    if (this.db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE owner=? AND status=?').get(digest(session), 'draft').n >= 20) fail(429, 'You have enough previews open. Use one or wait ten minutes.');
    this.db.prepare('INSERT INTO sms_messages(id,owner,plan,participant,invitation,recipient,kind,body,version,created,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, digest(session), s.id, p.id, p.invite, input.to, input.kind, body, planVersion(s), Date.now(), 'draft');
    return { ...this.publicRow(this.db.prepare('SELECT * FROM sms_messages WHERE id=?').get(id)), mode: this.live ? 'live' : 'preview', allowed: this.allowed.has(input.to) };
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
      const sent = await this.client.messages.create({ from: this.env.TWILIO_FROM_NUMBER, to: row.recipient, body: row.body,
        statusCallback: `${this.base}/api/twilio/status?id=${row.id}` });
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
    return this.publicRow(this.db.prepare('SELECT * FROM sms_messages WHERE id=?').get(row.id));
  }
  validate(path, signature, params) {
    if (!this.configured || !signature || !twilio.validateRequest(this.env.TWILIO_AUTH_TOKEN, signature, this.base + path, params) || params.AccountSid !== this.env.TWILIO_ACCOUNT_SID) fail(403, 'Invalid webhook signature.');
  }
  callback(id, params) {
    const row = this.db.prepare('SELECT * FROM sms_messages WHERE id=? AND attempted IS NOT NULL').get(id);
    if (!row || !/^SM[\da-f]{32}$/i.test(params.MessageSid || '') || (row.sid && row.sid !== params.MessageSid)) fail(404, 'Unknown message.');
    const status = params.MessageStatus;
    if (status in ranks && status !== 'unknown' && status !== 'submitting' && (ranks[status] > ranks[row.status] || status === row.status)) {
      this.db.prepare('UPDATE sms_messages SET sid=?,status=?,error=? WHERE id=?').run(params.MessageSid, status, /^\d{3,6}$/.test(params.ErrorCode || '') ? params.ErrorCode : null, row.id);
    }
    if (params.ErrorCode === '21610') this.stop(row.recipient);
  }
  stop(number) { this.db.prepare('INSERT OR REPLACE INTO sms_stopped VALUES(?,?)').run(number, Date.now()); }
  inbound(params) {
    if (!/^SM[\da-f]{32}$/i.test(params.MessageSid || '') || !phone(params.From) || params.To !== this.env.TWILIO_FROM_NUMBER) fail(400, 'Invalid incoming message.');
    const reply = new twilio.twiml.MessagingResponse();
    if (!this.live) return reply.toString();
    if (this.db.prepare('SELECT sid FROM sms_inbound WHERE sid=?').get(params.MessageSid)) return reply.toString();
    const text = (params.Body || '').trim().toUpperCase();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO sms_inbound VALUES(?,?)').run(params.MessageSid, Date.now());
      if (['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT'].includes(text) || params.OptOutType === 'STOP') {
        this.stop(params.From); // Twilio sends its own STOP acknowledgement; do not send another.
      } else if (!this.db.prepare('SELECT phone FROM sms_stopped WHERE phone=?').get(params.From)) {
        const rows = this.db.prepare("SELECT DISTINCT invitation FROM sms_messages WHERE recipient=? AND attempted IS NOT NULL AND status NOT IN ('failed','undelivered')").all(params.From);
        const guests = rows.flatMap(row => { try { const g = this.store.guest(row.invitation); return ['happened','dropped'].includes(g.s.plan.status) ? [] : [{ ...g, invitation: row.invitation }]; } catch { return []; } });
        if (guests.length && ['YES','MAYBE','NO'].includes(text) && guests.length === 1) {
          this.store.guestAction(guests[0].invitation, 'smsReply', { text });
          reply.message('Rall-e: your RSVP is updated. Use your personal plan link for the latest details. Reply STOP to opt out.');
        } else if (guests.length && params.OptOutType !== 'HELP') {
          reply.message(guests.length > 1 ? 'Rall-e: you have more than one active invitation. Please RSVP using the personal link for the plan you want. Reply STOP to opt out.' : 'Rall-e demo helps friends make plans. Reply YES, MAYBE or NO to RSVP, or use your personal plan link. For help, contact your host. Reply STOP to opt out.');
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return reply.toString();
  }
}
