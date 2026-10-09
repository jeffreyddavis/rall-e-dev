// QR codes for sharing Rall-e in person: a member's invite link as a portrait card (texted as a picture, and shown
// full-screen on their /me page). The code itself stays black on white with a wide quiet zone so any phone camera reads it.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Resvg } from '@resvg/resvg-js';

const fontDir = fileURLToPath(new URL('./fonts/', import.meta.url));
const fontFiles = readdirSync(fontDir).filter(f => f.endsWith('.ttf')).map(f => resolve(fontDir, f));
// "QR", "my QR code", "send me my invite qr code": the member's invite as a scannable picture.
export const QR_WORDS = /^(?:(?:send|text|show|get|give)\s+(?:me\s+)?)?(?:my\s+|a\s+|the\s+)?(?:rall-?e\s+)?(?:invite\s+)?qr(?:\s*code)?(?:\s+please)?[.!?]*$/i;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// The dark modules as one SVG path, in module units.
export function qrPath(text) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' }), n = modules.size;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (modules.get(y, x)) d += `M${x} ${y}h1v1h-1z`;
  return { d, size: n };
}

export function qrCardSvg({ url, name = '' }) {
  const W = 1080, H = 1350, box = 780, x0 = (W - box) / 2, y0 = 300, { d, size } = qrPath(url), quiet = 4;
  const scale = box / (size + quiet * 2), who = name ? `${name.slice(0, 30)}’s invite` : 'Your invite';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#51b3f5"/><stop offset="1" stop-color="#1d5fa3"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <circle cx="${W * 0.97}" cy="40" r="190" fill="#fff" opacity=".12"/><circle cx="90" cy="${H - 90}" r="160" fill="#fff" opacity=".10"/>
  <g transform="translate(${W / 2 - 95} 56)"><rect width="190" height="64" rx="32" fill="#fff" fill-opacity=".9"/><circle cx="32" cy="32" r="22" fill="#51b3f5"/><text x="32" y="44" text-anchor="middle" font-family="DM Sans" font-weight="700" font-style="italic" font-size="32" fill="#fff">R</text><text x="66" y="43" font-family="DM Sans" font-weight="700" font-size="30" fill="#1d2127">Rall-e</text></g>
  <text x="${W / 2}" y="200" text-anchor="middle" font-family="DM Sans" font-weight="700" font-size="64" fill="#fff">Join me on Rall-e</text>
  <text x="${W / 2}" y="256" text-anchor="middle" font-family="DM Sans" font-weight="600" font-size="34" fill="#fff" fill-opacity=".9">Point your phone’s camera here</text>
  <rect x="${x0 - 24}" y="${y0 - 24}" width="${box + 48}" height="${box + 48}" rx="48" fill="#fff"/>
  <g transform="translate(${x0} ${y0}) scale(${scale}) translate(${quiet} ${quiet})"><path d="${d}" fill="#000" shape-rendering="crispEdges"/></g>
  <text x="${W / 2}" y="${y0 + box + 110}" text-anchor="middle" font-family="DM Sans" font-weight="700" font-size="44" fill="#fff">${esc(who)}</text>
  <text x="${W / 2}" y="${y0 + box + 166}" text-anchor="middle" font-family="DM Sans" font-weight="600" font-size="32" fill="#fff" fill-opacity=".85">${esc(url.replace(/^https?:\/\//, ''))}</text>
</svg>`;
}

const cache = new Map();
export function qrCardPng({ url, name = '' }) {
  const key = `${url}|${name}`;
  if (cache.has(key)) return cache.get(key);
  const png = new Resvg(qrCardSvg({ url, name }), { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'DM Sans' } }).render().asPng();
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(key, png);
  return png;
}
