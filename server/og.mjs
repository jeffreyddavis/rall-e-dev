// Link-preview images (Open Graph) for events: the event photo with a frosted-glass caption band baked in.
// iMessage / Google Messages draw the preview bubble themselves, so the frosted look has to live in the image.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';

const fontDir = fileURLToPath(new URL('./fonts/', import.meta.url));
const fontFiles = readdirSync(fontDir).filter(f => f.endsWith('.ttf')).map(f => resolve(fontDir, f));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
// Rough wrap by character budget (DM Sans averages ~0.52em per character).
function wrap(text, size, width, lines = 2) {
  const max = Math.floor(width / (size * 0.52)), words = String(text).split(/\s+/), out = [''];
  for (const w of words) { const next = out.at(-1) ? `${out.at(-1)} ${w}` : w; if (next.length <= max) out[out.length - 1] = next; else if (out.length < lines) out.push(w); else { out[out.length - 1] = out.at(-1).replace(/\s*\S*$/, '') + '…'; break; } }
  return out;
}
const PALETTE = { dinner: ['#f0a36b', '#c2512f'], comedy: ['#4b3f72', '#1c1a33'], rooftop: ['#51b3f5', '#1d5fa3'], trail: ['#7fb77e', '#2f6b4f'], museum: ['#d9b48f', '#8a5a3c'] };

export class OgImages {
  constructor(fetchImpl = globalThis.fetch, base = '', placePhoto = null) { this.fetch = fetchImpl; this.base = base; this.cache = new Map(); this.placePhoto = placePhoto; }
  async photo(e) {
    if (e.photoRef && this.placePhoto) { const p = await this.placePhoto(e).catch(() => null); return p ? `data:${p.type.split(';')[0]};base64,${p.bytes.toString('base64')}` : null; }
    if (!/^https:\/\//.test(e.image || '')) return null;
    try {
      const r = await this.fetch(e.image, { signal: AbortSignal.timeout(6000) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\/(jpeg|png|webp)/.test(type)) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length < 6e6 ? `data:${type.split(';')[0]};base64,${buf.toString('base64')}` : null;
    } catch { return null; }
  }
  async render(e, W = 1200, H = 900) {
    const key = `${e.id}:${e.time}:${e.image || ''}`;
    if (this.cache.has(key)) return this.cache.get(key);
    // Concurrent requests for the same card (prewarm + iMessage fetching it) share one render.
    if (this.pending?.has(key)) return this.pending.get(key);
    (this.pending ||= new Map()).set(key, this.draw(e, W, H, key).finally(() => this.pending.delete(key)));
    return this.pending.get(key);
  }
  async draw(e, W, H, key) {
    const img = await this.photo(e), [c1, c2] = PALETTE[e.color] || PALETTE.rooftop;
    const bandX = 36, bandW = W - 72, title = wrap(e.short || e.title, 56, bandW - 80), sub = [e.time, e.venue].filter(Boolean).join(' · ');
    const bandH = title.length > 1 ? 250 : 190, bandY = H - bandH - 36;
    const bg = img ? `<image href="${img}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`
      : `<rect width="${W}" height="${H}" fill="url(#g)"/><circle cx="${W * 0.78}" cy="${H * 0.28}" r="220" fill="#ffffff" opacity=".14"/><circle cx="${W * 0.18}" cy="${H * 0.12}" r="140" fill="#ffffff" opacity=".10"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
    <filter id="blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="26"/></filter>
    <clipPath id="band"><rect x="${bandX}" y="${bandY}" width="${bandW}" height="${bandH}" rx="44"/></clipPath>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></linearGradient>
  </defs>
  ${bg}
  <rect width="${W}" height="${H}" fill="url(#shade)"/>
  <g clip-path="url(#band)"><g filter="url(#blur)">${bg}</g><rect x="${bandX}" y="${bandY}" width="${bandW}" height="${bandH}" fill="#ffffff" opacity=".42"/></g>
  <rect x="${bandX + 1}" y="${bandY + 1}" width="${bandW - 2}" height="${bandH - 2}" rx="43" fill="none" stroke="#ffffff" stroke-opacity=".7" stroke-width="2"/>
  ${title.map((line, i) => `<text x="${bandX + 40}" y="${bandY + 78 + i * 64}" font-family="DM Sans" font-weight="700" font-size="56" fill="#1d2127">${esc(line)}</text>`).join('')}
  <text x="${bandX + 40}" y="${bandY + (title.length > 1 ? 210 : 146)}" font-family="DM Sans" font-weight="600" font-size="36" fill="#39414a">${esc(wrap(sub, 36, bandW - 80, 1)[0])}</text>
  <g transform="translate(36 36)"><rect width="190" height="64" rx="32" fill="#ffffff" fill-opacity=".86"/><circle cx="32" cy="32" r="22" fill="#51b3f5"/><text x="32" y="44" text-anchor="middle" font-family="DM Sans" font-weight="700" font-style="italic" font-size="32" fill="#fff">R</text><text x="66" y="43" font-family="DM Sans" font-weight="700" font-size="30" fill="#1d2127">Rall-e</text></g>
</svg>`;
    // JPEG, not PNG: a photo preview as PNG was 1–2 MB and iMessage gave up drawing the card. JPEG is ~10x smaller.
    const out = new Resvg(svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'DM Sans' }, fitTo: { mode: 'width', value: 1000 } }).render();
    const jpg = jpeg.encode({ data: out.pixels, width: out.width, height: out.height }, 78).data;
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, jpg);
    return jpg;
  }
}
