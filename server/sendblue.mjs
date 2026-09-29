// Sendblue channel: real iMessage (blue bubbles), tapback reactions, typing indicators, with automatic
// RCS/SMS fallback for Android. Used instead of Twilio when MESSAGING_PROVIDER=sendblue.
// Webhooks are authenticated with our own secret (SENDBLUE_WEBHOOK_SECRET) in the webhook URL, compared in constant time.
import { createHash, timingSafeEqual } from 'node:crypto';
import { fail } from './store.mjs';

const STATUS = { QUEUED: 'queued', PENDING: 'queued', ACCEPTED: 'accepted', REGISTERED: 'accepted', SENT: 'sent', DELIVERED: 'delivered', ERROR: 'failed', DECLINED: 'failed' };
const digest = v => createHash('sha256').update(String(v || '')).digest();

export class Sendblue {
  constructor(env = process.env, fetchImpl = globalThis.fetch, base = '') {
    this.key = env.SENDBLUE_API_KEY || ''; this.secret = env.SENDBLUE_API_SECRET || '';
    this.number = /^\+[1-9]\d{7,14}$/.test(env.SENDBLUE_NUMBER || '') ? env.SENDBLUE_NUMBER : '';
    this.hook = env.SENDBLUE_WEBHOOK_SECRET || ''; this.fetch = fetchImpl; this.base = base;
  }
  get configured() { return Boolean(this.key && this.secret && this.number && this.hook.length >= 24 && this.base); }
  async call(path, body) {
    const response = await this.fetch(`https://api.sendblue.com${path}`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'sb-api-key-id': this.key, 'sb-api-secret-key': this.secret }, body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status === 'ERROR') throw Object.assign(new Error(result.error_message || result.message || `Sendblue ${response.status}`), { status: response.status });
    return result;
  }
  webhookUrl(path, extra = '') { return `${this.base}/api/sendblue/${path}?key=${encodeURIComponent(this.hook)}${extra}`; }
  verify(key) { if (!this.configured || !key || !timingSafeEqual(digest(key), digest(this.hook))) fail(403, 'Invalid webhook.'); }
  async send(row) {
    const body = { number: row.phone, from_number: this.number, status_callback: this.webhookUrl('status', `&log=${row.id}`) };
    if (row.body) body.content = row.body; if (row.media) body.media_url = row.media;
    const r = await this.call('/api/send-message', body);
    return { sid: r.message_handle, status: STATUS[r.status] || 'accepted' };
  }
  // Recent incoming messages on our line (used to catch any whose webhook never reached us).
  async recentInbound(limit = 20) {
    const response = await this.fetch(`https://api.sendblue.co/api/v2/messages?limit=${limit}`, { signal: AbortSignal.timeout(10000), headers: { 'sb-api-key-id': this.key, 'sb-api-secret-key': this.secret } });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`Sendblue ${response.status}`), { status: response.status });
    return (result.data || []).filter(m => !m.is_outbound && !m.group_id && (m.sendblue_number || m.to_number) === this.number);
  }
  status(value) { return STATUS[String(value || '').toUpperCase()] || null; }
  react(handle, reaction) { return this.call('/api/send-reaction', { from_number: this.number, message_handle: handle, reaction }); }
  // Free lookup (not a message, no seat): does this number use iMessage? Returns 'iMessage', 'SMS' (includes RCS) or null (inconclusive).
  async lookup(number) {
    const response = await this.fetch(`https://api.sendblue.com/api/evaluate-service?number=${encodeURIComponent(number)}`, { signal: AbortSignal.timeout(8000), headers: { 'sb-api-key-id': this.key, 'sb-api-secret-key': this.secret } });
    const result = await response.json().catch(() => ({}));
    // RCS means an Android phone: no tapbacks, and not worth a Sendblue seat, so it counts as SMS.
    return response.ok && ['iMessage', 'SMS', 'RCS'].includes(result.service) ? (result.service === 'iMessage' ? 'iMessage' : 'SMS') : null;
  }
  addContact(number, firstName = '') { return this.call('/api/v2/contacts', { number, first_name: firstName, sendblue_number: this.number, update_if_exists: true }); }
  pretty() { return this.number.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3'); }
  typing(to) { return this.call('/api/send-typing-indicator', { number: to, from_number: this.number }).catch(() => {}); }
}
