import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, fail, clean } from './store.mjs';
import { conversationReply } from './ai.mjs';
import { Sms, normalize as normalizePhone } from './sms.mjs';
import { Signup } from './signup.mjs';
import { FEATURES, featureById } from './features.mjs';
import { usageReport } from './usage.mjs';
import { wipeTexts, removePerson } from './wipe.mjs';
import { stats } from './stats.mjs';
import { OgImages } from './og.mjs';
import { eventById } from './catalog.mjs';
import { legText } from './discovery.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const store = new Store(process.env.DB_PATH || resolve(root, 'data/rally.sqlite'));
const sms = new Sms(store);
const signup = new Signup(store, sms);
const og = new OgImages(globalThis.fetch, '', e => sms.discovery.placePhoto(e));
sms.og = og; // lets the text flow render preview images before it sends the links
const photoCache = new Map();
const publicBase = (process.env.PUBLIC_BASE_URL || 'https://rall-e.ai').replace(/\/$/, '');
const attr = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Link previews (iMessage, Google Messages, Slack…) read these Open Graph tags.
// Link previews (iMessage, Slack) break lines at a plain hyphen, which split the name as "Rall-" / "e". A non-breaking hyphen keeps it whole.
const nb = v => String(v ?? '').replace(/Rall-e/g, 'Rall\u2011e');
const previewTags = ({ title: t0, description: d0, image, url }, title = nb(t0), description = nb(d0)) => [['og:type', 'website'], ['og:site_name', nb('Rall-e')], ['og:title', title], ['og:description', description], ['og:url', url], ['og:image', image], ['og:image:type', 'image/jpeg'], ['og:image:width', '1000'], ['og:image:height', '750'], ['twitter:card', 'summary_large_image']].map(([k, v]) => `<meta property="${k}" content="${attr(v)}">`).join('') + `<title>${attr(title)} · ${nb('Rall-e')}</title>`;
const publicEvent = e => ({ id: e.id, short: e.short, title: e.title, tag: e.tag, venue: e.venue, area: e.area, address: e.address, time: e.time, doors: e.doors, priceText: e.priceText || (e.price ? `$${e.price}/person (sample)` : 'Free'), rating: e.rating, description: e.description, url: e.url, source: e.source || 'Rall-e sample', color: e.color, image: e.image, thumb: e.thumb, fictional: e.fictional !== false, accessibility: e.accessibility, age: e.age });
const production = process.env.NODE_ENV === 'production';
// "Plan this with friends" opens Messages to Rall-e: iPhones get the iMessage line, everything else the SMS line.
const icsText = v => String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsTime = at => { const utc = /Z$/.test(at), d = String(at).replace(/\.\d+/, '').replace(/Z$/, ''); const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(d); return m ? `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00${utc ? 'Z' : ''}` : null; };
function planCalendar(s, link) {
  const stops = s.plan.stops.map(id => eventById(id)).filter(e => e?.startsAt && icsTime(e.startsAt));
  if (!stops.length) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ev = stops.map(e => { const start = new Date(/Z$/.test(e.startsAt) ? e.startsAt : `${e.startsAt}Z`), end = new Date(start.getTime() + 2 * 3600000).toISOString();
    const endTime = /Z$/.test(e.startsAt) ? icsTime(end) : icsTime(end.replace('Z', ''));
    return ['BEGIN:VEVENT', `UID:${s.id}-${e.id}@rall-e.ai`, `DTSTAMP:${stamp}`, `DTSTART:${icsTime(e.startsAt)}`, `DTEND:${endTime}`, `SUMMARY:${icsText(e.short)}`,
      `LOCATION:${icsText([e.venue, e.address].filter(Boolean).join(', '))}`, `DESCRIPTION:${icsText(`${s.plan.title} (planned with Rall-e): ${link}`)}`, `URL:${link}`, 'END:VEVENT'].join('\r\n'); });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rall-e//Plans//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...ev, 'END:VCALENDAR', ''].join('\r\n');
}
const textNumbers = () => ({ imessage: sms.provider === 'sendblue' ? sms.sendblue.number : sms.from, sms: sms.from });
const vite = !production ? await (await import('vite')).createServer({ root, server: { middlewareMode: true }, appType: 'spa' }) : null;
const locks = new Set();
const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req, limit = 16000) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Use JSON requests.');
  let value = ''; for await (const chunk of req) { value += chunk; if (value.length > limit) fail(413, 'Request is too large.'); }
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
      if (url.pathname.endsWith('/status')) { if (url.searchParams.has('log')) sms.logCallback(url.searchParams.get('log'), params); else sms.callback(url.searchParams.get('id'), params); res.writeHead(204); return res.end(); }
      const xml = sms.inbound(params); res.writeHead(200, { 'content-type': 'text/xml', 'cache-control': 'no-store' }); return res.end(xml);
    }
    if (['/api/sendblue/inbound', '/api/sendblue/status'].includes(url.pathname)) {
      if (req.method !== 'POST') fail(405, 'Method not allowed.');
      const input = await body(req), key = url.searchParams.get('key');
      return json(res, 200, url.pathname.endsWith('/inbound') ? sms.sendblueInbound(key, input) : sms.sendblueStatus(key, url.searchParams.get('log'), input));
    }
    if (url.pathname === '/api/inbound/email') {
      // Inbound newsletters (events@rall-e.ai) from the Cloudflare Email Worker (raw message) or Postmark-style JSON, with
      // INBOUND_EMAIL_SECRET as basic auth. Answered at once; read in the background (server/newsletters.mjs).
      if (req.method !== 'POST') fail(405, 'Method not allowed.');
      if (!sms.newsletters.authorized(req.headers.authorization)) fail(401, 'Not authorized.');
      const mail = await body(req, 15_000_000);
      return json(res, 200, mail.raw ? await sms.newsletters.receiveRaw(mail) : sms.newsletters.receive(mail));
    }
    if (url.pathname === '/api/vapi/webhook') {
      if (req.method !== 'POST') fail(405, 'Method not allowed.');
      // Each call has a separate random secret supplied as a Vapi server header.
      return json(res, 200, sms.voice.webhook(url.searchParams.get('id'), req.headers['x-rally-voice-secret'], await body(req, 256000)));
    }
    if (url.pathname.startsWith('/api/')) {
      if (['POST','DELETE'].includes(req.method) && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403, 'Use the app’s own origin.');
      const setSession = id => res.setHeader('Set-Cookie', `rally_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${production ? '; Secure' : ''}`);
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const input = await body(req);
        const ip = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
        const { id, state } = input.verification ? signup.create(input.verification, input.name, ip) : store.create(input.name);
        setSession(id); return json(res, 200, store.view(state));
      }
      if (url.pathname === '/api/signup/code' && req.method === 'POST') {
        const input = await body(req);
        // Opt-in only from a real shared page (a night or a list of ideas someone shared).
        if (input.join) { const src = String(input.join); let ok = false; try { store.shared(src); ok = true; } catch {} if (!ok && !sms.flow.sharedOptions(src)) fail(400, 'This link has expired.'); }
        const ip = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
        return json(res, 200, signup.sendCode(input, ip));
      }
      if (url.pathname === '/api/signup/verify' && req.method === 'POST') {
        const result = signup.verify(await body(req));
        if (!result.existing) return json(res, 200, result);
        setSession(result.session); return json(res, 200, { existing: true, state: store.view(store.get(result.session)) });
      }
      const favMatch = /^\/api\/fav\/([\w-]{8,20})$/.exec(url.pathname);
      if (favMatch && req.method === 'GET') return json(res, 200, { ...sms.favorites.view(favMatch[1]), textNumbers: textNumbers() });
      // "Where my friends go" page (/fp/<token>): friends' first names and places only.
      const friendsMatch = /^\/api\/friends-places\/([\w-]{8,20})$/.exec(url.pathname);
      if (friendsMatch && req.method === 'GET') return json(res, 200, sms.favorites.friendsView(friendsMatch[1]));
      const eventMatch = /^\/api\/event\/([\w-]{1,40})$/.exec(url.pathname);
      if (eventMatch && req.method === 'GET') { const e = eventById(eventMatch[1]); if (!e) fail(404, 'That listing is no longer available.'); return json(res, 200, { event: publicEvent(e), textNumbers: textNumbers() }); }
      // ---------- invite-only: invite links, the private "me" page, the waitlist ----------
      const clientIp = () => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
      const inv = /^\/api\/invite\/([a-z0-9-]{8,64})(\/code|\/verify)?$/.exec(url.pathname);
      if (inv && req.method === 'GET' && !inv[2]) { const l = sms.invites.lookup(inv[1]); stats.bump('invite_link_views'); return json(res, 200, { inviter: l.inviter, open: l.remaining > 0 }); }
      if (inv && req.method === 'POST' && inv[2] === '/code') {
        sms.invites.check(inv[1]); const input = await body(req);
        return json(res, 200, signup.sendCode({ phone: input.phone, join: `invite:${inv[1]}`, consent: input.consent === true }, clientIp()));
      }
      if (inv && req.method === 'POST' && inv[2] === '/verify') {
        const input = await body(req), phone = normalizePhone(input.phone || ''), name = clean(input.name || '', 40);
        if (!name) fail(400, 'Please enter your first name.');
        sms.invites.check(inv[1]);
        const v = signup.verify({ phone, code: input.code });
        if (v.existing) return json(res, 200, { existing: true, name: v.name, textNumbers: textNumbers() });
        signup.create(v.verification, name, clientIp());
        sms.invites.recordJoin(inv[1], phone, name);
        return json(res, 200, { joined: true, name: clean(name, 40), textNumbers: textNumbers() });
      }
      if (url.pathname === '/api/waitlist' && req.method === 'POST') {
        const input = await body(req); return json(res, 200, sms.invites.joinWaitlist(normalizePhone(input.phone || ''), input.name, 'web'));
      }
      const me = /^\/api\/me\/([\w-]{20,40})(\/links)?$/.exec(url.pathname);
      if (me && req.method === 'GET' && !me[2]) { const phone = sms.invites.phoneFor(me[1]); stats.bump('me_page_views', 1, phone); return json(res, 200, { ...sms.invites.view(phone), textNumbers: textNumbers() }); }
      const mePhoto = /^\/api\/me\/([\w-]{20,40})\/photo$/.exec(url.pathname);
      if (mePhoto && req.method === 'POST') {
        const phone = sms.invites.phoneFor(mePhoto[1]), chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 4 * 1024 * 1024) fail(413, 'That photo is too big.'); chunks.push(c); }
        await sms.photos.save(phone, Buffer.concat(chunks), 'page'); return json(res, 200, sms.invites.view(phone));
      }
      if (mePhoto && req.method === 'DELETE') { const phone = sms.invites.phoneFor(mePhoto[1]); sms.photos.remove(phone); return json(res, 200, sms.invites.view(phone)); }
      const meMem = /^\/api\/me\/([\w-]{20,40})\/memory\/([\w-]{8})$/.exec(url.pathname);
      if (meMem && req.method === 'DELETE') { const phone = sms.invites.phoneFor(meMem[1]); sms.memory.remove(phone, meMem[2]); stats.bump('memory_deleted_page', 1, phone); return json(res, 200, sms.invites.view(phone)); }
      if (me && req.method === 'POST' && me[2]) { const phone = sms.invites.phoneFor(me[1]); sms.invites.create(phone, (await body(req)).name || ''); return json(res, 200, sms.invites.view(phone)); }
      const poll = /^\/api\/poll\/([\w-]{16})$/.exec(url.pathname);
      if (poll && req.method === 'GET') return json(res, 200, { ...sms.polls.view(poll[1]), textNumbers: textNumbers() });
      if (poll && req.method === 'POST') return json(res, 200, sms.polls.answer(poll[1], await body(req)));
      if (url.pathname === '/api/travel' && req.method === 'GET') {
        const ids = String(url.searchParams.get('ids') || '').split(',').filter(id => /^[\w-]{1,40}$/.test(id) && eventById(id)).slice(0, 8);
        const d = sms.discovery, legs = ids.length > 1 ? await Promise.race([d.legs(ids), new Promise(r => setTimeout(() => r(d.cachedLegs(ids)), 6000))]) : [];
        return json(res, 200, { legs: legs.map((l, i) => {
          if (!l) return null;
          const a = d.coords(eventById(ids[i])), b = d.coords(eventById(ids[i + 1]));
          const maps = a && b ? `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${b.lat},${b.lng}&travelmode=${l.mode === 'drive' ? 'driving' : 'walking'}` : null;
          return { mode: l.mode, text: legText(l), maps };
        }) });
      }
      if (url.pathname === '/api/stats/share' && req.method === 'POST') { const kind = String((await body(req)).kind || ''); if (['night', 'ideas', 'spot'].includes(kind)) stats.bump(`share_taps_${kind}`); res.writeHead(204); return res.end(); }
      const joinMatch = /^\/api\/share\/([\w-]{12})\/join$/.exec(url.pathname);
      if (joinMatch && req.method === 'POST') {
        // The person just signed up (or signed back in) with a verified phone; their session says who they are.
        const session = cookie(req); if (!session) fail(401, 'Sign up with your number first.');
        const digest = store.resolve(session), me = store.load(digest), phone = sms.flow.hostPhone(digest);
        if (!phone) fail(403, 'Sign up with your number first.');
        return json(res, 200, sms.flow.joinShared(phone, me.name, joinMatch[1]));
      }
      const shareMatch = /^\/api\/share\/([\w-]{12})$/.exec(url.pathname);
      if (shareMatch && req.method === 'GET') { const s = store.shared(shareMatch[1]); stats.bump('shared_night_views'); return json(res, 200, { name: s.name, plan: { title: s.plan.title, status: s.plan.status, stops: s.plan.stops, going: 1 + s.plan.participants.filter(p => p.response === 'yes').length }, events: s.plan.stops.map(eventById).filter(Boolean).map(publicEvent), textNumbers: textNumbers() }); }
      const nightMatch = /^\/api\/night\/([\w-]{20,40})$/.exec(url.pathname);
      if (nightMatch) {
        const { digest, s } = store.night(nightMatch[1]);
        if (req.method === 'POST') {
          const input = await body(req); if (input.action !== 'addStop') fail(400, 'Unknown action.');
          const next = store.hostActionAt(digest, 'addStop', { eventId: String(input.eventId || ''), suggestion: String(input.suggestion || '') }, { via: 'web' });
          return json(res, 200, { ...store.view(next, 'host'), shareUrl: `${publicBase}/s/${store.shareToken(next, digest)}`, textNumbers: textNumbers() });
        }
        return json(res, 200, { ...store.view(s, 'host'), shareUrl: `${publicBase}/s/${store.shareToken(s, digest)}`, textNumbers: textNumbers() });
      }
      const optMatch = /^\/api\/options\/([\w-]{12})(\/pick)?$/.exec(url.pathname);
      if (optMatch && req.method === 'GET' && !optMatch[2]) { const o = sms.flow.options(optMatch[1]); if (!o) fail(410, 'These options have expired. Text Rall-e for fresh ones.'); return json(res, 200, { events: o.ids.map(id => publicEvent(eventById(id))), pick: o.pick || '', textNumbers: textNumbers(), shareUrl: `${publicBase}/e/${o.ids[0]}?o=${sms.flow.optionShare(optMatch[1])}` }); }
      const pubOpt = /^\/api\/options\/public\/([\w-]{12})$/.exec(url.pathname);
      if (pubOpt && req.method === 'GET') { const ids = sms.flow.sharedOptions(pubOpt[1]); if (ids) stats.bump('shared_list_views'); if (!ids) fail(410, 'These options have expired.'); return json(res, 200, { events: ids.map(id => publicEvent(eventById(id))), textNumbers: textNumbers(), shared: true }); }
      if (optMatch && req.method === 'POST' && optMatch[2]) { const input = await body(req); return json(res, 200, sms.flow.pick(optMatch[1], String(input.eventId || ''))); }
      // One-tap location sharing from a texted link (phone GPS, rounded to ~100 m).
      const locMatch = /^\/api\/location\/([\w-]{20,40})$/.exec(url.pathname);
      if (locMatch && req.method === 'POST') {
        const input = await body(req), { phone, location } = await sms.discovery.shareLocation(locMatch[1], Number(input.lat), Number(input.lng));
        for (const t of sms.flow.threadsFor(phone)) if (t.role === 'host') store.hostActionAt(t.digest, 'city', { label: location.label }, { via: 'web' });
        sms.deliver(phone, `Rall-e: got it, you're near ${location.label}. What are you in the mood for? Dinner, a show, something outdoors…`, { kind: 'location' });
        return json(res, 200, { label: location.label });
      }
      // Vault: only reachable with a one-time link texted to the owner's phone. Never cached, never logged.
      const vaultMatch = /^\/api\/vault\/([\w-]{20,64})(\/card(?:\/start|\/finish)?)?$/.exec(url.pathname);
      if (vaultMatch) {
        const [, token, sub] = vaultMatch, vault = sms.vault;
        if (!sub && req.method === 'GET') return json(res, 200, vault.view(token));
        if (!sub && req.method === 'POST') return json(res, 200, vault.save(token, await body(req)));
        if (!sub && req.method === 'DELETE') return json(res, 200, await vault.wipe(token));
        if (sub === '/card/start' && req.method === 'POST') return json(res, 200, await vault.startCard(token));
        if (sub === '/card/finish' && req.method === 'POST') return json(res, 200, await vault.finishCard(token, (await body(req)).setupIntent));
        if (sub === '/card' && req.method === 'DELETE') return json(res, 200, await vault.removeCard(token));
        fail(405, 'Method not allowed.');
      }
      // A friend with an invite link turns on texts: consent box, then a code texted to their phone (double opt-in).
      const guestTexts = /^\/api\/guest\/([\w-]+)\/texts(\/verify)?$/.exec(url.pathname);
      if (guestTexts && req.method === 'POST') {
        store.guest(guestTexts[1]); // must be a live invite
        const input = await body(req), ip = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
        if (!guestTexts[2]) return json(res, 200, signup.sendCode({ phone: input.phone, join: 'guest-invite', consent: input.consent === true }, ip));
        const v = signup.verify({ phone: input.phone, code: input.code });
        return json(res, 200, sms.flow.guestTexts(guestTexts[1], normalizePhone(input.phone)));
      }
      const match = /^\/api\/guest\/([\w-]+)$/.exec(url.pathname);
      if (match) {
        const shareOf = () => { const { s, row } = store.guest(match[1]); return `${publicBase}/s/${store.shareToken(s, row.session)}`; };
        const texting = () => { const { row, person } = store.guest(match[1]); const r = sms.db.prepare('SELECT phone FROM sms_threads WHERE digest=? AND participant=?').get(row.session, person.id); return Boolean(r && (!sms.live || sms.allowed.has(r.phone)) && !sms.isStopped(r.phone)); }; // "on" only once they can really get texts
        if (req.method === 'GET') { const { s, person } = store.guest(match[1]); return json(res, 200, { ...store.view(s, person.id), shareUrl: shareOf(), textNumbers: textNumbers(), texting: texting() }); }
        if (req.method === 'POST') { const { action, ...data } = await body(req); if (['smsReply', 'chat'].includes(action)) fail(403, 'Use the signed SMS webhook.'); return json(res, 200, { ...store.guestAction(match[1], action, data), shareUrl: shareOf(), textNumbers: textNumbers() }); }
        fail(405, 'Method not allowed.');
      }
      if (url.pathname.startsWith('/api/ops/')) {
        // Demo operator console: see real conversations and have Rall-e show off a feature to someone. Operator key only.
        // Behind the proxy every request comes from 127.0.0.1, so lockouts are per real client IP.
        const opsIp = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
        const role = sms.opsRole(req.headers.authorization?.replace(/^Bearer /, ''), opsIp);
        // Both keys can have Rall-e show someone a feature (Mike and Marc demo with it); the rest stays operator-only.
        const features = FEATURES.map(({ id, label, pitch }) => ({ id, label, pitch }));
        if (url.pathname === '/api/ops/people' && req.method === 'GET') return json(res, 200, role === 'operator' ? { role, people: sms.opsPeople(), features, live: sms.live } : { people: sms.opsPeople(), features }); // the dashboard key sees no hint of operator-only controls
        // Release notes ("what's new" texts): both keys see what went out; only the operator sees and approves held notes.
        if (url.pathname === '/api/ops/releases' && req.method === 'GET') { const r = sms.whatsNew.summary(); return json(res, 200, role === 'operator' ? { ...r, canApprove: true } : { released: r.released, members: r.members }); }
        if (url.pathname === '/api/ops/insights' && req.method === 'GET') return json(res, 200, { ...stats.report(), ...(role === 'operator' ? { canEdit: true } : {}) });
        if (url.pathname === '/api/ops/usage' && req.method === 'GET') return json(res, 200, await usageReport(sms));
        if (url.pathname === '/api/ops/thread' && req.method === 'GET') return json(res, 200, sms.opsThread(url.searchParams.get('phone') || ''));
        // Sources (curated event calendars) are open to both keys, so Mike and Marc can manage them from the dashboard.
        if (url.pathname === '/api/ops/sources' && req.method === 'GET') return json(res, 200, { sources: sms.sources.list(), manual: sms.sources.manualEvents() });
        if (url.pathname === '/api/ops/transactions' && req.method === 'GET') return json(res, 200, sms.bookings.report());
        // Ideas inbox (tips, gems, feedback): both keys can read and review it.
        if (url.pathname === '/api/ops/ideas' && req.method === 'GET') return json(res, 200, { ideas: sms.ideas.list() });
        if (url.pathname === '/api/ops/ideas' && req.method === 'POST') { const input = await body(req); if (input.add) sms.ideas.add(null, { ...input.add, source: 'team' }); const r = input.id ? await sms.ideas.update(String(input.id), { status: input.status, teamNote: input.teamNote }) : {}; return json(res, 200, { ideas: sms.ideas.list(), result: r.result || '' }); }
        if (req.method !== 'POST') fail(405, 'Method not allowed.');
        if (url.pathname.startsWith('/api/ops/sources')) {
          const input = await body(req), op = url.pathname.slice('/api/ops/sources'.length);
          if (op === '') await sms.sources.add(input); else if (op === '/refresh') await sms.sources.refresh(String(input.id || '')); else if (op === '/remove') sms.sources.remove(String(input.id || ''));
          else if (op === '/debug') return json(res, 200, { result: sms.sources.tryToFix(String(input.id || '')), sources: sms.sources.list(), manual: sms.sources.manualEvents() });
          else if (op === '/event') await sms.sources.addEvent(input); else if (op === '/event/remove') sms.sources.removeEvent(input.id); else fail(404, 'Not found.');
          return json(res, 200, { sources: sms.sources.list(), manual: sms.sources.manualEvents() });
        }
        if (url.pathname === '/api/ops/nudge') {
          const input = await body(req), phone = normalizePhone(input.phone || '');
          if (!phone || !sms.allowed.has(phone)) fail(404, 'Not a Rall-e number.');
          if (sms.isStopped(phone)) fail(409, 'They opted out (STOP).');
          const f = input.feature ? featureById(input.feature) : null, note = String(input.note || '').trim().slice(0, 600);
          if (role !== 'operator' && !f) fail(400, 'Pick a feature to show them.'); // free-form instructions stay with the operator
          const instruction = [f?.operator, note && (f ? `Extra context from the team: ${note}` : note)].filter(Boolean).join(' ');
          if (!instruction) fail(400, 'Pick a feature or write an instruction.');
          console.log(`${role === 'operator' ? 'Operator' : 'Team'} nudge -> ••• ${phone.slice(-4)}: ${f?.id || 'custom'}`);
          sms.flow.operatorNudge(phone, instruction);
          return json(res, 200, { queued: true });
        }
        if (role !== 'operator') fail(404, 'Not found.'); // the server enforces it, and doesn't advertise that more exists
        if (url.pathname === '/api/ops/releases/approve') { const input = await body(req); sms.whatsNew.approve(String(input.id || '')); console.log(`Release note approved: ${input.id}`); try { sms.whatsNew.tick(); } catch (e) { console.error('Updates:', e.message); } return json(res, 200, { ...sms.whatsNew.summary(), canApprove: true }); }
        if (url.pathname === '/api/ops/gap') { const input = await body(req); stats.setGap(String(input.category || ''), input); return json(res, 200, { ok: true }); }
        const input = await body(req), phone = normalizePhone(input.phone || '');
        if (!phone || !(sms.allowed.has(phone) || (url.pathname === '/api/ops/wipe' && sms.db.prepare("SELECT 1 FROM sms_log WHERE phone=? LIMIT 1").get(phone)))) fail(404, 'Not a Rall-e number.');
        if (sms.isStopped(phone) && url.pathname !== '/api/ops/wipe') fail(409, 'They opted out (STOP).');
        if (url.pathname === '/api/ops/wipe') {
          // Permanent. The operator types the last 4 digits to confirm.
          if (String(input.confirm || '') !== phone.slice(-4)) fail(400, 'Type the last 4 digits of their number to confirm.');
          if (sms.flow.chains.has(phone)) fail(409, 'Rall-e is replying to them right now. Try again in a few seconds.');
          const result = input.mode === 'person' ? removePerson(sms, phone) : wipeTexts(sms, phone);
          console.log(`Operator wipe (${input.mode === 'person' ? 'person' : 'texts'}) -> ••• ${phone.slice(-4)}`);
          return json(res, 200, result);
        }
        if (url.pathname === '/api/ops/say') {
          const text = String(input.text || '').trim().slice(0, 1000); if (!text) fail(400, 'Write the text to send.');
          return json(res, 200, { status: sms.deliver(phone, text, { kind: 'reply' }) });
        }
        fail(404, 'Not found.');
      }
      if (url.pathname.startsWith('/api/sms-lab/')) {
        // Presenter-only text simulator. Senders are restricted to fictional 555 numbers.
        sms.authorize(req.headers.authorization?.replace(/^Bearer /, ''), req.socket.remoteAddress);
        if (url.pathname === '/api/sms-lab/transcript' && req.method === 'GET') return json(res, 200, sms.transcript((url.searchParams.get('phones') || '').split(',').filter(Boolean)));
        if (req.method !== 'POST') fail(405, 'Method not allowed.');
        const input = await body(req);
        if (url.pathname === '/api/sms-lab/text') return json(res, 200, await sms.simulate(input.from, input.body));
        if (url.pathname === '/api/sms-lab/clear') return json(res, 200, sms.clearLab(Array.isArray(input.phones) ? input.phones : []));
        fail(404, 'Not found.');
      }
      const session = cookie(req); store.get(session);
      if (url.pathname.startsWith('/api/sms/')) {
        sms.authorize(req.headers.authorization?.replace(/^Bearer /, ''), req.socket.remoteAddress);
        if (url.pathname === '/api/sms/status' && req.method === 'GET') return json(res, 200, sms.status(session));
        if (req.method !== 'POST') fail(405, 'Method not allowed.');
        const input = await body(req);
        if (url.pathname === '/api/sms/preview') return json(res, 200, sms.preview(session, input));
        if (url.pathname === '/api/sms/send') return json(res, 200, await sms.send(session, input));
        if (url.pathname === '/api/sms/link-host') return json(res, 200, sms.linkHost(session, input));
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
    if (url.pathname.startsWith('/v/') || url.pathname.startsWith('/l/')) {
      // Vault page: only our own code plus Stripe's card form may run; the page can't be framed or leak its URL.
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://js.stripe.com; frame-src https://js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; img-src 'self' data: https://*.stripe.com; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader('Cache-Control', 'no-store');
    }
    const photoMatch = /^\/img\/p\/([\w-]{1,40})$/.exec(url.pathname);
    if (photoMatch) {
      let photo = photoCache.get(photoMatch[1]);
      if (!photo) { photo = await sms.discovery.placePhoto(eventById(photoMatch[1])); if (!photo) fail(404, 'Not found.'); if (photoCache.size > 200) photoCache.delete(photoCache.keys().next().value); photoCache.set(photoMatch[1], photo); }
      res.writeHead(200, { 'content-type': photo.type, 'cache-control': 'public, max-age=86400' }); return res.end(photo.bytes);
    }
    const ogMatch = /^\/og\/e\/([\w-]{1,40})\.(?:png|jpg)$/.exec(url.pathname);
    if (ogMatch) {
      const e = eventById(ogMatch[1]); if (!e) fail(404, 'Not found.');
      const jpg = await og.render(e);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpg.length, 'cache-control': 'public, max-age=86400' }); return res.end(jpg);
    }
    // Event and invite pages carry preview tags so a texted link shows the frosted-glass card.
    const pageMatch = production && (/^\/e\/([\w-]{1,40})$/.exec(url.pathname) || /^\/p\/([\w-]+)$/.exec(url.pathname) || /^\/n\/([\w-]{20,40})$/.exec(url.pathname) || /^\/s\/([\w-]{12})$/.exec(url.pathname) || /^\/i\/([a-z0-9-]{8,64})$/.exec(url.pathname) || /^\/q\/([\w-]{16})$/.exec(url.pathname) || /^\/f\/([\w-]{8,20})$/.exec(url.pathname));
    if (pageMatch && req.method === 'GET') {
      let tags = '';
      try {
        if (url.pathname.startsWith('/e/')) { const e = eventById(pageMatch[1]); if (e) tags = previewTags({ title: e.short, description: [e.time, e.venue, e.area].filter(Boolean).join(' · '), image: `${publicBase}/og/e/${e.id}.jpg`, url: `${publicBase}/e/${e.id}` }); }
        else if (url.pathname.startsWith('/q/')) { const v = sms.polls.view(pageMatch[1]), e = eventById(JSON.parse(sms.polls.who(pageMatch[1]).ids)[0]); tags = previewTags({ title: `${v.asker} wants your pick: ${v.title}`, description: `${v.options.length} options · ${v.answered} of ${v.total} answered`, image: e ? `${publicBase}/og/e/${e.id}.jpg` : `${publicBase}/rall-e-icon.png`, url: `${publicBase}${url.pathname}` }); }
        else if (url.pathname.startsWith('/f/')) { const v = sms.favorites.view(pageMatch[1]); tags = previewTags({ title: `${v.who}'s top ${v.items.length} ${v.category} in ${v.city.split(',')[0]}`, description: v.items.map(i => `${i.rank}. ${i.name}`).join(' · '), image: `${publicBase}/rall-e-icon.png`, url: `${publicBase}${url.pathname}` }); }
        else if (url.pathname.startsWith('/i/')) { const l = sms.invites.lookup(pageMatch[1]); tags = previewTags({ title: `${l.inviter} invited you to Rall-e`, description: 'Rall-e plans your social life so you can focus on the fun stuff. Invite-only for now.', image: `${publicBase}/rall-e-icon.png`, url: `${publicBase}${url.pathname}` }); }
        else if (url.pathname.startsWith('/s/')) { const s = store.shared(pageMatch[1]); const e = eventById(s.plan.stops[0]); if (e) tags = previewTags({ title: `${s.name}'s plan: ${s.plan.title}`, description: `${s.plan.stops.length} ${s.plan.stops.length === 1 ? 'stop' : 'stops'}, planned with Rall-e`, image: `${publicBase}/og/e/${e.id}.jpg`, url: `${publicBase}${url.pathname}` }); }
        else if (url.pathname.startsWith('/n/')) { const { s } = store.night(pageMatch[1]); const e = eventById(s.plan.stops[0]); if (e) tags = previewTags({ title: `Your plan: ${s.plan.title}`, description: `${s.plan.stops.length} ${s.plan.stops.length === 1 ? 'stop' : 'stops'} · ${s.plan.participants.filter(p => p.response === 'yes').length + 1} going`, image: `${publicBase}/og/e/${e.id}.jpg`, url: `${publicBase}${url.pathname}` }); }
        else { const { s } = store.guest(pageMatch[1]); const e = eventById(s.plan.stops[0]); if (e) tags = previewTags({ title: `${s.name} invited you: ${s.plan.title}`, description: [e.time, e.venue].filter(Boolean).join(' · '), image: `${publicBase}/og/e/${e.id}.jpg`, url: `${publicBase}${url.pathname}` }); }
      } catch {}
      const html = (await readFile(resolve(root, 'dist', 'index.html'), 'utf8')).replace(/<title>[^<]*<\/title>/, tags ? '' : '$&').replace('</head>', `${tags}</head>`);
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' }); return res.end(html);
    }
    // "Add to calendar": the plan's timed stops as an .ics file (opens in Apple/Google/Outlook calendars; no account access needed).
    const cal = /^\/cal\/(p|n)\/([\w-]{10,60})\.ics$/.exec(url.pathname);
    if (cal && req.method === 'GET') {
      let s; try { s = cal[1] === 'p' ? store.guest(cal[2]).s : store.night(cal[2]).s; } catch { res.writeHead(404); return res.end(); }
      const ics = planCalendar(s, `${publicBase}${cal[1] === 'p' ? '/p/' : '/n/'}${cal[2]}`);
      if (!ics) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('No timed stops on this plan yet.'); }
      stats.bump('calendar_downloads');
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="rall-e-plan.ics"', 'cache-control': 'no-store' }); return res.end(ics);
    }
    const userPhoto = /^\/img\/u\/([\w-]{12})\.jpg$/.exec(url.pathname);
    if (userPhoto && req.method === 'GET') {
      const data = sms.photos.image(userPhoto[1]); if (!data) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' }); return res.end(data);
    }
    if (url.pathname === '/imessage') {
      // One tap from a text or web page opens Messages to the Rall-e iMessage line with "Hi Rall-e" filled in.
      const to = sms.provider === 'sendblue' ? sms.sendblue.number : sms.from, target = `sms:${to}&body=${encodeURIComponent('Hi Rall-e')}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Text Rall-e</title><style>body{font-family:system-ui,sans-serif;background:#f6f7f5;color:#2f3230;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}a{display:inline-block;background:#51b3f5;color:#fff;text-decoration:none;font-weight:700;padding:16px 28px;border-radius:30px;font-size:18px}p{color:#707571}</style><main><h1>Chat with Rall-e in iMessage</h1><p>Tap below, then hit send.</p><a href="${target}">Open Messages</a><p>${to.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3')}</p></main><script>location.href=${JSON.stringify(target)}</script>`);
    }
    if (url.pathname === '/rall-e.vcf') {
      // Contact card always carries the number Rall-e currently texts from (Twilio or the iMessage line).
      // With the iMessage line on, the card carries both numbers so the blue and green threads both show the Rall-e icon.
      const smsOnly = url.searchParams.get('line') === 'sms' || sms.provider !== 'sendblue';
      const tel = smsOnly ? `TEL;TYPE=CELL,VOICE,pref:${sms.twilioFrom || '+14157924712'}` : `TEL;TYPE=IPHONE,CELL,VOICE,pref:${sms.sendblue.number}\r\nTEL;TYPE=CELL,VOICE:${sms.twilioFrom || '+14157924712'}`;
      const card = (await readFile(resolve(root, production ? 'dist' : 'public', 'rall-e.vcf'), 'utf8')).replace(/TEL;[^\r\n]*/, tel);
      res.writeHead(200, { 'content-type': 'text/vcard', 'cache-control': 'no-cache', 'content-disposition': 'inline; filename="Rall-e.vcf"' }); return res.end(card);
    }
    if (vite) return vite.middlewares(req, res, () => { res.statusCode = 404; res.end('Not found'); });
    const dist = resolve(root, 'dist'); let path = resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (path !== dist && !path.startsWith(dist + sep)) fail(403, 'Not allowed.');
    if (!existsSync(path) || (await stat(path)).isDirectory()) path = resolve(dist, 'index.html');
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.vcf': 'text/vcard', '.jpg': 'image/jpeg' };
    res.writeHead(200, { 'content-type': mime[extname(path)] || 'application/octet-stream', 'cache-control': /^\/(v|l)\//.test(url.pathname) ? 'no-store' : path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(await readFile(path));
  } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' }); }
});
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => { console.log(`Rall-e is ready at http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`); sms.startCatchUp(); setInterval(() => { try { sms.whatsNew.tick(); } catch (e) { console.error('Updates:', e.message); } }, 10 * 60000).unref(); setTimeout(() => { try { sms.whatsNew.tick(); } catch (e) { console.error('Updates:', e.message); } }, 60000).unref(); sms.sources.schedule(); setInterval(() => sms.flow.closeFinished(), 3600000).unref(); setTimeout(() => sms.flow.closeFinished(), 20000).unref(); setTimeout(() => sms.catchUp().catch(() => {}), 5000).unref(); if (sms.voice.enabled) { setTimeout(() => sms.voice.reconcile().catch(() => {}), 30000).unref(); setInterval(() => sms.voice.reconcile().catch(() => {}), 120000).unref(); } });
// Deploys restart the service: stop taking requests, finish texts already being handled (up to 25 s), then exit.
let stopping = false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => {
  if (stopping) return; stopping = true; server.close();
  await Promise.race([Promise.all([sms.flow.idle(), sms.idle()]), new Promise(r => setTimeout(r, 25000))]).catch(() => {});
  store.close(); vite?.close(); process.exit(0);
});
