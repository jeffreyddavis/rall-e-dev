import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, fail, clean } from './store.mjs';
import { conversationReply } from './ai.mjs';
import { Sms } from './sms.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const store = new Store(process.env.DB_PATH || resolve(root, 'data/rally.sqlite'));
const sms = new Sms(store);
const production = process.env.NODE_ENV === 'production';
const vite = !production ? await (await import('vite')).createServer({ root, server: { middlewareMode: true }, appType: 'spa' }) : null;
const locks = new Set();
const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Use JSON requests.');
  let value = ''; for await (const chunk of req) { value += chunk; if (value.length > 16000) fail(413, 'Request is too large.'); }
  try { return JSON.parse(value || '{}'); } catch { fail(400, 'Invalid JSON.'); }
}
const cookie = req => req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('rally_session='))?.slice(14);
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') return json(res, 200, { status: 'ok' });
    if (['/api/twilio/inbound', '/api/twilio/status'].includes(url.pathname)) {
      if (req.method !== 'POST') fail(405, 'Method not allowed.');
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) fail(415, 'Use form requests.');
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16000) fail(413, 'Request is too large.'); }
      const params = Object.fromEntries(new URLSearchParams(raw));
      sms.validate(req.url, req.headers['x-twilio-signature'], params);
      if (url.pathname.endsWith('/status')) { sms.callback(url.searchParams.get('id'), params); res.writeHead(204); return res.end(); }
      const xml = sms.inbound(params); res.writeHead(200, { 'content-type': 'text/xml', 'cache-control': 'no-store' }); return res.end(xml);
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403, 'Use the app’s own origin.');
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const input = await body(req); const { id, state } = store.create(input.name);
        res.setHeader('Set-Cookie', `rally_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${production ? '; Secure' : ''}`);
        return json(res, 200, store.view(state));
      }
      const match = /^\/api\/guest\/([\w-]+)$/.exec(url.pathname);
      if (match) {
        if (req.method === 'GET') { const { s, person } = store.guest(match[1]); return json(res, 200, store.view(s, person.id)); }
        if (req.method === 'POST') { const { action, ...data } = await body(req); if (action === 'smsReply') fail(403, 'Use the signed SMS webhook.'); return json(res, 200, store.guestAction(match[1], action, data)); }
        fail(405, 'Method not allowed.');
      }
      const session = cookie(req); store.get(session);
      if (url.pathname.startsWith('/api/sms/')) {
        sms.authorize(req.headers.authorization?.replace(/^Bearer /, ''), req.socket.remoteAddress);
        if (url.pathname === '/api/sms/status' && req.method === 'GET') return json(res, 200, sms.status(session));
        if (req.method !== 'POST') fail(405, 'Method not allowed.');
        const input = await body(req);
        if (url.pathname === '/api/sms/preview') return json(res, 200, sms.preview(session, input));
        if (url.pathname === '/api/sms/send') return json(res, 200, await sms.send(session, input));
        fail(404, 'Not found.');
      }
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, store.view(store.get(session)));
      if (req.method !== 'POST') fail(404, 'Not found.');
      if (locks.has(session)) fail(409, 'Your last message is still being processed.');
      const input = await body(req);
      if (url.pathname === '/api/reset') return json(res, 200, store.view(store.reset(session)));
      if (url.pathname === '/api/action') return json(res, 200, store.view(store.hostAction(session, input.action, input)));
      if (url.pathname === '/api/chat') {
        locks.add(session);
        try {
          const text = clean(input.text); let state = store.chat(session, text);
          if (!state.stopped && !/^(stop|help)[.!]?$/i.test(text)) {
            const answer = await conversationReply(store.view(state), text);
            if (answer) {
              // Reload after async I/O so a guest response arriving during inference is preserved.
              const messageId = state.messages.at(-1).id; state = store.get(session);
              const message = state.messages.find(m => m.id === messageId); if (message) message.text = answer;
              state.aiMode = 'bedrock'; store.save(session, state);
            } else { state = store.get(session); state.aiMode = process.env.BEDROCK_MODEL_ID ? 'fallback' : 'curated'; store.save(session, state); }
          }
          return json(res, 200, store.view(state));
        } finally { locks.delete(session); }
      }
      fail(404, 'Not found.');
    }
    if (vite) return vite.middlewares(req, res, () => { res.statusCode = 404; res.end('Not found'); });
    const dist = resolve(root, 'dist'); let path = resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (path !== dist && !path.startsWith(dist + sep)) fail(403, 'Not allowed.');
    if (!existsSync(path) || (await stat(path)).isDirectory()) path = resolve(dist, 'index.html');
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'content-type': mime[extname(path)] || 'application/octet-stream', 'cache-control': path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(await readFile(path));
  } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' }); }
});
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log(`Rall-e is ready at http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { server.close(); store.close(); vite?.close(); process.exit(0); });
