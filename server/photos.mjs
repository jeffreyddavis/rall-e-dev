// Profile photos. People can text Rall-e a photo ("use this as my profile photo") or upload one on their private page.
// Every photo is re-encoded to a 320x320 JPEG (center/attention crop): that strips EXIF (including GPS) and keeps them small.
// Stored in SQLite with a random id that changes on every update, served at /img/u/<id>.jpg.
import { randomBytes } from 'node:crypto';
import { fail } from './store.mjs';
import { stats } from './stats.mjs';

const MAX_BYTES = 12 * 1024 * 1024;
let sharpLib = null;
const sharp = async () => (sharpLib ||= (await import('sharp')).default);

export class Photos {
  constructor(sms, env = process.env, fetchImpl = globalThis.fetch) {
    this.sms = sms; this.db = sms.db; this.env = env; this.fetch = fetchImpl;
    this.db.exec('CREATE TABLE IF NOT EXISTS profile_photos (phone TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, data BLOB NOT NULL, updated INTEGER NOT NULL)');
  }
  get base() { return this.sms.base || 'https://rall-e.ai'; }
  urlFor(phone) { const r = phone && this.db.prepare('SELECT id FROM profile_photos WHERE phone=?').get(phone); return r ? `/img/u/${r.id}.jpg` : null; }
  image(id) { return /^[\w-]{12}$/.test(id) ? this.db.prepare('SELECT data FROM profile_photos WHERE id=?').get(id)?.data || null : null; }
  remove(phone) { return this.db.prepare('DELETE FROM profile_photos WHERE phone=?').run(phone).changes > 0; }
  async save(phone, input, via = 'page') {
    if (!input?.length) fail(400, 'That photo didn’t come through.');
    if (input.length > MAX_BYTES) fail(413, 'That photo is too big. Try a smaller one.');
    let out;
    try { out = await (await sharp())(input, { limitInputPixels: 50e6 }).rotate().resize(320, 320, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer(); }
    catch { fail(415, 'I couldn’t open that photo. A regular photo or screenshot (JPG or PNG) works best.'); }
    const id = randomBytes(9).toString('base64url');
    this.db.prepare('INSERT INTO profile_photos VALUES (?,?,?,?) ON CONFLICT(phone) DO UPDATE SET id=excluded.id, data=excluded.data, updated=excluded.updated').run(phone, id, out, Date.now());
    stats.bump(`profile_photos_${via}`, 1, phone);
    return `/img/u/${id}.jpg`;
  }
  // A photo someone texted in. Twilio media needs our account credentials; Sendblue media URLs are public.
  async fromText(phone, media) {
    if (!media?.url || !/^https:\/\//.test(media.url)) fail(400, 'I don’t see a photo in your last text. Send one and I’ll use it.');
    return this.save(phone, await this.download(media), 'text');
  }
  // Media someone texted us (photos, contact cards).
  async download(media, limit = MAX_BYTES) {
    const headers = {};
    if (new URL(media.url).host === 'api.twilio.com') headers.authorization = 'Basic ' + Buffer.from(`${this.env.TWILIO_ACCOUNT_SID}:${this.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const r = await this.fetch(media.url, { headers, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!r?.ok) fail(502, 'I couldn’t download that. Try sending it again.');
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > limit) fail(413, 'That file is too big.');
    return buf;
  }
}

// Contact cards (vCard) texted to Rall-e: name + mobile number for each card in the file.
export function parseVcards(text) {
  const out = [];
  for (const card of String(text).replace(/\r?\n[ \t]/g, '').split(/BEGIN:VCARD/i).slice(1)) {
    const line = key => card.split(/\r?\n/).filter(l => new RegExp(`^(item\\d+\\.)?${key}[;:]`, 'i').test(l));
    const fn = line('FN')[0]?.split(':').slice(1).join(':').trim() || line('N')[0]?.split(':').slice(1).join(':').split(';').filter(Boolean).reverse().join(' ').trim();
    const tels = line('TEL').map(l => ({ type: l.split(':')[0].toLowerCase(), number: l.split(':').slice(1).join(':').replace(/[^\d+]/g, '') })).filter(t => t.number.length >= 10);
    const tel = tels.find(t => /cell|mobile|iphone/.test(t.type)) || tels[0];
    const d = tel?.number.replace(/\D/g, ''), e164 = d?.length === 10 ? `+1${d}` : d?.length === 11 && d.startsWith('1') ? `+${d}` : tel?.number.startsWith('+') ? `+${d}` : null;
    if (fn && e164) out.push({ name: fn.replace(/\\,/g, ',').slice(0, 60), phone: e164 });
  }
  return out;
}
