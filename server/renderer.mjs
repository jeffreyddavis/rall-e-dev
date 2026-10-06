// Page renderer (its own systemd service, ops/rally-render.service): opens a page in headless Chromium the way a
// visitor's browser would, waits for it to finish loading, and returns the page as rendered plus the API responses it
// loaded. Event sources whose events appear only after JavaScript runs (server/sources.mjs, sourcedebug.mjs) use it.
// Kept out of the app's process: Chromium needs far more memory than the app's 384 MB cap allows.
//   - Localhost only (127.0.0.1:3108). One page at a time. Images, media and fonts are not loaded.
//   - Public sites only: every request the page makes to a private or internal address is blocked.
//   - The caller checks robots.txt first; this only renders what it's asked to.
import http from 'node:http';
import { chromium } from 'playwright-core';
import { isPublicUrl, botsForbidden } from './publicurl.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PORT = Number(process.env.RENDER_PORT || 3108), UA = 'Mozilla/5.0 (compatible; Rall-e event finder; +https://rall-e.ai)';
const MAX_HTML = 3_000_000, PAGES_PER_BROWSER = 40;
let browser = null, used = 0, chain = Promise.resolve();

async function getBrowser() {
  if (browser && used < PAGES_PER_BROWSER && browser.isConnected()) return browser;
  await browser?.close().catch(() => {}); used = 0; // a fresh browser now and then keeps memory down
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--disable-dev-shm-usage', '--no-zygote', '--disable-gpu', '--disable-extensions', '--mute-audio'] });
  return browser;
}

export async function render(url, { waitMs = 1500 } = {}) {
  if (!isPublicUrl(url)) throw Object.assign(new Error('Only public web links.'), { status: 400 });
  if (botsForbidden(url)) throw Object.assign(new Error('That site forbids automated access.'), { status: 403 });
  const b = await getBrowser(); used++;
  const context = await b.newContext({ userAgent: UA, javaScriptEnabled: true, serviceWorkers: 'block', viewport: { width: 1280, height: 1600 } });
  const page = await context.newPage(), responses = [];
  try {
    await page.route('**/*', route => {
      const r = route.request();
      if (['image', 'media', 'font'].includes(r.resourceType()) || !isPublicUrl(r.url()) || botsForbidden(r.url())) return route.abort(); // a page's Bookeo/DICE widget never loads
      return route.continue();
    });
    page.on('response', async res => {
      const type = res.headers()['content-type'] || '';
      if (responses.length >= 30 || !/json|calendar/i.test(type) || !['xhr', 'fetch', 'script', 'document'].includes(res.request().resourceType())) return;
      const body = await res.text().catch(() => '');
      responses.push({ url: res.url(), status: res.status(), type, length: body.length, sample: body.slice(0, 2000) });
    });
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {}); // most calendars settle in a second or two
    await page.waitForTimeout(waitMs);
    const html = (await page.content()).slice(0, MAX_HTML);
    return { status: res?.status() || 0, url: page.url(), html, responses };
  } finally { await context.close().catch(() => {}); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) { // run as the service, not imported
  http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, browser: Boolean(browser?.isConnected()), used });
    if (req.method !== 'POST' || req.url !== '/render') return send(404, { error: 'Not found.' });
    let raw = ''; req.on('data', c => { raw += c; if (raw.length > 10000) req.destroy(); });
    req.on('end', () => {
      let input; try { input = JSON.parse(raw); } catch { return send(400, { error: 'Send JSON.' }); }
      // One page at a time: queue behind whatever is rendering now.
      chain = chain.then(() => render(String(input.url || ''), { waitMs: Math.min(Number(input.waitMs) || 1500, 8000) }))
        .then(r => send(200, r), e => send(e.status || 502, { error: String(e.message).slice(0, 300) }));
    });
  }).listen(PORT, '127.0.0.1', () => console.log(`Rall-e renderer on 127.0.0.1:${PORT}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await browser?.close().catch(() => {}); process.exit(0); });
}
