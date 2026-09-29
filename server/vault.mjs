// Rall-e vault: a person's sensitive details, keyed by their verified phone number.
// - Personal fields are encrypted at rest (AES-256-GCM) with VAULT_KEY, which lives only in server config.
// - Card numbers never reach Rall-e: Stripe's own form collects them and we keep only Stripe IDs plus brand/last4/expiry.
// - People reach the vault through one-time links texted to their phone (15 minutes). The AI only ever sees masked summaries.
// - Every read/write is recorded in vault_audit (field names only, never values).
import { stats } from './stats.mjs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fail } from './store.mjs';

const hash = v => createHash('sha256').update(String(v)).digest('hex');
const LINK_MS = 15 * 60000;
export const FIELDS = {
  firstName: 40, lastName: 60, email: 120, addressLine1: 120, addressLine2: 120, city: 60, state: 30, zip: 12,
  dietary: 200, allergies: 200, openTable: 120, resy: 120, otherLoyalty: 200
};
const TEXTABLE = ['email', 'dietary', 'allergies']; // low-risk fields people may also send by text

// Luhn check for 13-19 digit numbers (possibly spaced/dashed), used to scrub card numbers out of texts.
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const luhn = digits => { let sum = 0; for (let i = 0; i < digits.length; i++) { let d = +digits[digits.length - 1 - i]; if (i % 2) { d *= 2; if (d > 9) d -= 9; } sum += d; } return sum % 10 === 0; };
export function scrubCards(text) {
  let found = false;
  const clean = String(text).replace(CARD, m => { const d = m.replace(/\D/g, ''); if (d.length >= 13 && luhn(d)) { found = true; return '[card number removed]'; } return m; });
  return { clean, found };
}
const maskEmail = e => e ? e.replace(/^(.)[^@]*(@.*)$/, '$1***$2') : '';

export class Vault {
  constructor(store, sms, env = process.env, fetchImpl = globalThis.fetch) {
    this.store = store; this.sms = sms; this.db = store.db; this.fetch = fetchImpl;
    const key = Buffer.from(env.VAULT_KEY || '', 'base64');
    this.key = key.length === 32 ? key : null;
    this.stripeSecret = /^sk_(test|live)_/.test(env.STRIPE_SECRET_KEY || '') ? env.STRIPE_SECRET_KEY : '';
    this.stripePublishable = /^pk_(test|live)_/.test(env.STRIPE_PUBLISHABLE_KEY || '') ? env.STRIPE_PUBLISHABLE_KEY : '';
    this.base = (env.PUBLIC_BASE_URL || 'https://rall-e.ai').replace(/\/$/, '');
    this.db.exec(`CREATE TABLE IF NOT EXISTS vault_profiles (phone TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vault_links (token TEXT PRIMARY KEY, phone TEXT NOT NULL, purpose TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vault_audit (at INTEGER NOT NULL, phone TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, fields TEXT);`);
  }
  get enabled() { return Boolean(this.key); }
  get cards() { return Boolean(this.stripeSecret && this.stripePublishable); }

  // ---------- encryption ----------
  seal(obj) {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
  }
  open(sealed) {
    const [v, iv, tag, body] = sealed.split('.');
    if (v !== 'v1') throw new Error('Unknown vault format');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8'));
  }
  load(phone) { const row = this.db.prepare('SELECT data FROM vault_profiles WHERE phone=?').get(phone); return row ? this.open(row.data) : {}; }
  write(phone, data) { this.db.prepare('INSERT OR REPLACE INTO vault_profiles VALUES (?,?,?)').run(phone, this.seal(data), Date.now()); }
  audit(phone, actor, action, fields = []) { this.db.prepare('INSERT INTO vault_audit VALUES (?,?,?,?,?)').run(Date.now(), phone, actor, action, fields.join(',')); }
  require() { if (!this.enabled) fail(503, 'The vault is not set up on this server yet.'); }

  // ---------- what the AI sees ----------
  summary(phone) {
    if (!this.enabled) return 'Vault: not available on this server.';
    const v = this.load(phone), bits = [];
    if (v.firstName) bits.push(`name: ${v.firstName}${v.lastName ? ` ${v.lastName[0]}.` : ''}`);
    if (v.email) bits.push(`email: ${maskEmail(v.email)}`);
    if (v.addressLine1) bits.push(`address: on file (${v.city || 'city not set'})`);
    if (v.dietary) bits.push(`dietary: ${v.dietary}`);
    if (v.allergies) bits.push(`allergies: ${v.allergies}`);
    if (v.openTable || v.resy || v.otherLoyalty) bits.push(`reservation accounts: ${[v.openTable && 'OpenTable', v.resy && 'Resy', v.otherLoyalty && 'other'].filter(Boolean).join(', ')}`);
    if (v.card) bits.push(`card: ${v.card.brand} ending ${v.card.last4} (exp ${v.card.expMonth}/${String(v.card.expYear).slice(-2)})`);
    return `Vault (masked; you never see full values): ${bits.length ? bits.join('; ') : 'empty'}. Card on file possible: ${this.cards ? 'yes' : 'not yet configured'}.`;
  }
  // Low-risk fields sent by text (email, dietary, allergies). Everything else only through the secure link.
  saveFromText(phone, fields) {
    stats.bump('vault_saves_text', 1, phone);
    this.require();
    const v = this.load(phone), changed = [];
    for (const [k, value] of Object.entries(fields || {})) {
      if (!TEXTABLE.includes(k) || typeof value !== 'string' || !value.trim()) continue;
      const clean = value.trim().slice(0, FIELDS[k]);
      if (k === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) fail(400, 'That email address does not look right.');
      v[k] = clean; changed.push(k);
    }
    if (!changed.length) fail(400, 'Only email, dietary needs and allergies can be saved by text. Use the secure link for the rest.');
    this.write(phone, v); this.audit(phone, 'agent', 'save-by-text', changed);
    return changed;
  }

  // ---------- secure links ----------
  sendLink(phone, purpose = 'details') {
    this.require();
    const recent = this.db.prepare('SELECT COUNT(*) n FROM vault_links WHERE phone=? AND created>?').get(phone, Date.now() - 3600000).n;
    if (recent >= 5) fail(429, 'Several secure links were sent in the last hour; use the most recent one.');
    const token = randomBytes(24).toString('base64url');
    this.db.prepare('DELETE FROM vault_links WHERE expires<?').run(Date.now());
    this.db.prepare('INSERT INTO vault_links VALUES (?,?,?,?,?)').run(hash(token), phone, String(purpose).slice(0, 40), Date.now(), Date.now() + LINK_MS);
    this.audit(phone, 'agent', 'link-sent', [String(purpose).slice(0, 40)]);
    const why = purpose === 'card' ? 'add a card for future bookings' : 'add your details';
    return this.sms.deliver(phone, `Rall-e: here's your private link to ${why}: ${this.base}/v/${token}\nIt works for 15 minutes. Never text card numbers — this page keeps them safe.`, { kind: 'vault' });
  }
  phoneFor(token) {
    this.require();
    const row = typeof token === 'string' && this.db.prepare('SELECT * FROM vault_links WHERE token=?').get(hash(token));
    if (!row || row.expires < Date.now()) fail(410, 'This secure link has expired. Text Rall-e for a new one.');
    return row.phone;
  }
  // The web page only ever receives the person's own values, through a valid link.
  view(token) {
    const phone = this.phoneFor(token), v = this.load(phone);
    this.audit(phone, 'owner', 'view');
    const { card, stripeCustomer, ...fields } = v;
    return { phone: `••• ••• ${phone.slice(-4)}`, fields, card: card ? { brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear } : null, cards: this.cards, stripeKey: this.stripePublishable || null, expiresInSec: Math.round((this.db.prepare('SELECT expires FROM vault_links WHERE token=?').get(hash(token)).expires - Date.now()) / 1000) };
  }
  save(token, input) {
    const phone = this.phoneFor(token), v = this.load(phone), changed = []; stats.bump('vault_saves_web', 1, phone);
    for (const [k, max] of Object.entries(FIELDS)) {
      if (!(k in (input || {}))) continue;
      const value = typeof input[k] === 'string' ? input[k].trim().slice(0, max) : '';
      if (scrubCards(value).found) fail(400, 'Please don’t put card numbers in these fields. Use the card section.');
      if (k === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(400, 'That email address does not look right.');
      if ((v[k] || '') !== value) { if (value) v[k] = value; else delete v[k]; changed.push(k); }
    }
    this.write(phone, v); this.audit(phone, 'owner', 'save', changed);
    return this.view(token);
  }
  async wipe(token) {
    const phone = this.phoneFor(token), v = this.load(phone);
    if (v.stripeCustomer && this.stripeSecret) { try { await this.stripe('DELETE', `customers/${v.stripeCustomer}`); } catch (e) { console.error('Stripe customer delete failed:', e.message); } }
    this.db.prepare('DELETE FROM vault_profiles WHERE phone=?').run(phone);
    this.db.prepare('DELETE FROM vault_links WHERE phone=?').run(phone);
    this.audit(phone, 'owner', 'delete-all');
    return { deleted: true };
  }

  // ---------- cards via Stripe (card data goes browser -> Stripe directly) ----------
  async stripe(method, path, form) {
    const response = await this.fetch(`https://api.stripe.com/v1/${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.stripeSecret}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result?.error?.message || 'Stripe error'), { status: 502 });
    return result;
  }
  async startCard(token) {
    const phone = this.phoneFor(token);
    if (!this.cards) fail(503, 'Card storage is not set up yet.');
    const v = this.load(phone);
    if (!v.stripeCustomer) {
      const customer = await this.stripe('POST', 'customers', { 'metadata[rall_e_phone_hash]': hash(phone).slice(0, 16), description: 'Rall-e member' });
      v.stripeCustomer = customer.id; this.write(phone, v);
    }
    const intent = await this.stripe('POST', 'setup_intents', { customer: v.stripeCustomer, usage: 'off_session', 'payment_method_types[]': 'card', 'metadata[source]': 'rall-e-vault' });
    this.audit(phone, 'owner', 'card-start');
    return { clientSecret: intent.client_secret };
  }
  async finishCard(token, setupIntentId) {
    const phone = this.phoneFor(token), v = this.load(phone);
    if (!/^seti_\w+$/.test(setupIntentId || '')) fail(400, 'Missing card setup.');
    const intent = await this.stripe('GET', `setup_intents/${setupIntentId}`);
    if (intent.customer !== v.stripeCustomer || intent.status !== 'succeeded') fail(400, 'The card was not saved. Please try again.');
    const pm = await this.stripe('GET', `payment_methods/${intent.payment_method}`);
    if (v.card?.paymentMethod && v.card.paymentMethod !== pm.id) { try { await this.stripe('POST', `payment_methods/${v.card.paymentMethod}/detach`, {}); } catch {} }
    v.card = { paymentMethod: pm.id, brand: (pm.card?.brand || 'card').replace(/^\w/, c => c.toUpperCase()), last4: pm.card?.last4, expMonth: pm.card?.exp_month, expYear: pm.card?.exp_year };
    this.write(phone, v); this.audit(phone, 'owner', 'card-saved');
    return this.view(token);
  }
  async removeCard(token) {
    const phone = this.phoneFor(token), v = this.load(phone);
    if (v.card?.paymentMethod && this.stripeSecret) { try { await this.stripe('POST', `payment_methods/${v.card.paymentMethod}/detach`, {}); } catch (e) { console.error('Stripe detach failed:', e.message); } }
    delete v.card; this.write(phone, v); this.audit(phone, 'owner', 'card-removed');
    return this.view(token);
  }
}
