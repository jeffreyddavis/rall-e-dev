// Phone-first signup: phone number -> 6-digit code texted from the Rall-e number -> account.
// A verified phone is linked to the account, so the same person can plan on the web or by text.
import { createHash, randomInt, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail, clean } from './store.mjs';
import { normalize } from './sms.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const TEN_MIN = 600000;
export const CONSENT = 'I agree to get texts from Rall-e about plans I make or join. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.';

export class Signup {
  constructor(store, sms) {
    this.store = store; this.sms = sms; this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS signup_codes (phone TEXT PRIMARY KEY, code TEXT NOT NULL, expires INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL, requested TEXT NOT NULL DEFAULT '[]', token TEXT, token_expires INTEGER);`);
    try { this.db.exec('ALTER TABLE signup_codes ADD COLUMN join_src TEXT'); } catch {} // added later; no-op once present
  }
  sendCode(input, source = 'local') {
    const now = Date.now(), ip = (this.byIp ||= new Map()), hits = (ip.get(source) || []).filter(t => t > now - 3600000);
    if (hits.length >= 10) fail(429, 'Too many code requests. Try again later.');
    ip.set(source, [...hits, now]); if (ip.size > 5000) ip.clear();
    const phone = normalize(input.phone);
    if (!phone || !/^\+1\d{10}$/.test(phone)) fail(400, 'Enter a US mobile number, like (555) 123-4567.');
    if (this.sms.isStopped(phone)) fail(403, 'This number opted out of Rall-e texts. Text START to our number to opt back in.');
    const row = this.db.prepare('SELECT * FROM signup_codes WHERE phone=?').get(phone);
    const recent = JSON.parse(row?.requested || '[]').filter(t => t > Date.now() - 3600000);
    if (recent.some(t => t > Date.now() - 30000)) fail(429, 'We just sent a code. Give it 30 seconds before asking again.');
    if (recent.length >= 5) fail(429, 'Too many codes for this number. Try again in an hour.');
    // Joining from a shared page: someone new can get a code only after ticking the consent box (double opt-in).
    const joining = Boolean(input.join) && !this.sms.allowed.has(phone);
    if (joining) { if (input.consent !== true) fail(400, 'Tick the box to agree to texts from Rall-e.'); this.sms.canOptIn(); }
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const status = this.sms.deliver(phone, `Your Rall-e code is ${code}. It expires in 10 minutes. Don't share it with anyone.`, { kind: 'otp', optInCode: joining });
    if (status === 'blocked') fail(403, 'This demo can only text approved testers right now. Use “Skip for now” to look around.');
    this.db.prepare('INSERT OR REPLACE INTO signup_codes(phone,code,expires,attempts,sent,requested,join_src) VALUES(?,?,?,0,?,?,?)')
      .run(phone, hash(code), Date.now() + TEN_MIN, status === 'preview' ? 0 : 1, JSON.stringify([...recent, Date.now()]), joining ? String(input.join).slice(0, 60) : null);
    // Preview mode sends nothing, so the page shows the code instead. A preview-verified phone is never linked for texting.
    return status === 'preview' ? { sent: false, demoCode: code } : { sent: true };
  }
  verify(input) {
    const phone = normalize(input.phone), code = String(input.code || '');
    const row = phone && this.db.prepare('SELECT * FROM signup_codes WHERE phone=?').get(phone);
    if (!row || row.expires < Date.now()) fail(410, 'That code expired. Ask for a new one.');
    if (row.attempts >= 5) fail(429, 'Too many tries. Ask for a new code.');
    this.db.prepare('UPDATE signup_codes SET attempts=attempts+1 WHERE phone=?').run(phone);
    if (!/^\d{6}$/.test(code) || !same(hash(code), row.code)) fail(400, 'That code doesn’t match. Check the text and try again.');
    if (row.join_src && row.sent) this.sms.optIn(phone, row.join_src, CONSENT); // the code proves they own the number they consented for
    // Returning member: sign into the account already tied to this phone.
    const host = row.sent ? this.sms.flow.threadsFor(phone).find(t => t.role === 'host') : null;
    this.db.prepare('UPDATE signup_codes SET code=?, expires=0 WHERE phone=?').run(hash(randomBytes(16)), phone);
    if (host) return { existing: true, session: this.store.alias(host.digest), name: host.s.name };
    const token = randomBytes(24).toString('base64url');
    this.db.prepare('UPDATE signup_codes SET token=?, token_expires=? WHERE phone=?').run(hash(token), Date.now() + 3 * TEN_MIN, phone);
    return { existing: false, verification: token };
  }
  // Creates the account for a phone verified by verify(). Returns { id, state } like Store.create().
  create(token, name) {
    const row = this.db.prepare('SELECT * FROM signup_codes WHERE token=?').get(hash(clean(token, 100)));
    if (!row || row.token_expires < Date.now()) fail(410, 'Your verification expired. Start again with your phone number.');
    const created = this.store.create(name ? clean(name, 40) : undefined), { id, state } = created;
    this.db.prepare('UPDATE signup_codes SET token=NULL WHERE phone=?').run(row.phone);
    if (!row.sent) return created; // preview-mode verification: not linked for texting
    const flow = this.sms.flow, digest = this.store.digestOf(id);
    flow.link(row.phone, digest, state, 'host');
    flow.reply(row.phone, `Welcome to Rall-e, ${state.name}! This is my number — text me anytime to plan something with friends. (Rall-e demo. Reply STOP to opt out.)`, 'welcome');
    flow.sendCard(row.phone);
    return created;
  }
}
