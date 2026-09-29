// API usage meter for the demo console (/ops "Usage"): how much of each outside service Rall-e is using, and how
// close each is to running out, so nothing goes dead in the middle of a VC demo.
// Counts come from three places: our own call log (every service), provider headers (rate limits), and provider
// account APIs where one exists (Twilio balance, SerpApi searches left, Anthropic cost with an Admin key).
import { statfsSync } from 'node:fs';
import { freemem, totalmem, uptime } from 'node:os';

const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);
const level = (used, limit) => !limit ? 'ok' : used / limit >= 0.9 ? 'critical' : used / limit >= 0.75 ? 'warn' : 'ok';
const PROVIDERS = { 'app.ticketmaster.com': 'ticketmaster', 'api.seatgeek.com': 'seatgeek', 'maps.googleapis.com': 'google', 'places.googleapis.com': 'google', 'serpapi.com': 'serpapi', 'data.tmsapi.com': 'gracenote', 'demo.tmsimg.com': 'gracenote' };
const skuOf = url => {
  const u = new URL(url);
  if (u.host === 'maps.googleapis.com') return u.pathname.includes('geocode') ? 'geocoding' : 'maps';
  if (u.host === 'places.googleapis.com') return u.pathname.includes('/media') ? 'place_photos' : 'text_search';
  return 'calls';
};

// One shared meter; the Sms constructor gives it the database.
export const meter = {
  db: null, headers: {},
  attach(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS api_calls (day TEXT NOT NULL, provider TEXT NOT NULL, sku TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, provider, sku));
      CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL);`);
  },
  call(url, headers) {
    try {
      const provider = PROVIDERS[new URL(url).host]; if (!provider || !this.db) return;
      this.db.prepare('INSERT INTO api_calls VALUES (?,?,?,1) ON CONFLICT(day, provider, sku) DO UPDATE SET n=n+1').run(today(), provider, skuOf(url));
      if (provider === 'ticketmaster' && headers?.get?.('rate-limit-available')) this.headers.ticketmaster = { available: Number(headers.get('rate-limit-available')), limit: Number(headers.get('rate-limit')), reset: Number(headers.get('rate-limit-reset')), at: Date.now() };
    } catch {}
  },
  ai(usage = {}, headers) {
    if (!this.db) return;
    this.db.prepare('INSERT INTO ai_usage VALUES (?,1,?,?,?,?) ON CONFLICT(day) DO UPDATE SET calls=calls+1, input=input+excluded.input, output=output+excluded.output, cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write')
      .run(today(), usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0);
    const h = k => headers?.get?.(`anthropic-ratelimit-${k}`);
    if (h('requests-limit')) this.headers.anthropic = { requests: [Number(h('requests-remaining')), Number(h('requests-limit'))], input: [Number(h('input-tokens-remaining')), Number(h('input-tokens-limit'))], output: [Number(h('output-tokens-remaining')), Number(h('output-tokens-limit'))], at: Date.now() };
  },
  calls(provider, sku, since) { return this.db.prepare(`SELECT COALESCE(SUM(n),0) AS n FROM api_calls WHERE provider=? ${sku ? 'AND sku=?' : ''} AND day>=?`).get(...[provider, ...(sku ? [sku] : []), since]).n; }
};

// Anthropic list prices per million tokens for the app's model (Sonnet 5.5: $2 in, $10 out, cache hits $0.20, 5-min writes $2.50).
const PRICE = { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 };

export async function usageReport(sms, env = process.env, fetchImpl = globalThis.fetch) {
  const m = month(), start = `${m}-01`, db = sms.db, cards = [];
  const get = async (url, init = {}) => { const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000) }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error?.message || d?.message || d?.error || `HTTP ${r.status}`); return d; };
  const safe = async fn => { try { return await fn(); } catch (e) { return { error: String(e.message).slice(0, 120) }; } };

  // Claude (the app's API key, not anyone's chat account)
  const ai = db.prepare('SELECT COALESCE(SUM(calls),0) calls, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write FROM ai_usage WHERE day>=?').get(start);
  const aiToday = db.prepare('SELECT calls, input, output FROM ai_usage WHERE day=?').get(today()) || { calls: 0, input: 0, output: 0 };
  const est = (ai.input * PRICE.input + ai.output * PRICE.output + ai.cache_read * PRICE.cache_read + ai.cache_write * PRICE.cache_write) / 1e6;
  const budget = Number(env.ANTHROPIC_MONTHLY_BUDGET_USD) || 0, rl = meter.headers.anthropic;
  const official = env.ANTHROPIC_ADMIN_KEY ? await safe(async () => {
    const d = await get(`https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start}T00:00:00Z&ending_at=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}T00:00:00Z`, { headers: { 'x-api-key': env.ANTHROPIC_ADMIN_KEY, 'anthropic-version': '2023-06-01' } });
    return { usd: (d.data || []).flatMap(b => b.results || [b]).reduce((s, x) => s + Number(x.amount || 0), 0) / 100 };
  }) : null;
  const spent = official?.usd ?? est;
  cards.push({ id: 'anthropic', name: 'Claude API (Rall-e’s brain)', status: budget ? level(spent, budget) : 'ok',
    meter: budget ? { used: Math.round(spent * 100) / 100, limit: budget, unit: 'USD this month' } : null,
    facts: [`${ai.calls} AI calls this month (${aiToday.calls} today)`, `${official?.usd != null ? 'Spend this month' : 'Estimated spend this month'}: $${spent.toFixed(2)}${official?.usd != null ? ' (Anthropic cost report)' : ` (${ai.input.toLocaleString()} input + ${ai.output.toLocaleString()} output tokens at Sonnet 5.5 list prices)`}`,
      rl ? `Rate limit right now: ${rl.requests[0]}/${rl.requests[1]} requests per minute left` : 'Rate limits: shown after the next AI reply',
      official?.error ? `Cost report error: ${official.error}` : !env.ANTHROPIC_ADMIN_KEY ? 'Prepaid credit balance isn’t available by API. Check the Claude Console, and turn on auto-reload so credits can’t run out mid-demo.' : null].filter(Boolean),
    link: 'https://platform.claude.com/settings/billing' });

  // Twilio (SMS for Android and anyone not on iMessage)
  if (sms.twilioReady) {
    const sid = env.TWILIO_ACCOUNT_SID, auth = 'Basic ' + Buffer.from(`${env.TWILIO_API_KEY_SID || sid}:${env.TWILIO_API_KEY_SECRET || env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const bal = await safe(() => get(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, { headers: { Authorization: auth } }));
    const sent = db.prepare("SELECT COUNT(*) n FROM sms_log WHERE direction='out' AND (sid LIKE 'SM%' OR sid LIKE 'MM%') AND created>=?").get(Date.parse(`${start}T00:00:00Z`)).n;
    const day = db.prepare("SELECT COUNT(*) n FROM sms_log WHERE direction='out' AND (sid LIKE 'SM%' OR sid LIKE 'MM%') AND created>=?").get(Date.parse(`${today()}T00:00:00Z`)).n;
    const balance = bal.error ? null : Number(bal.balance);
    cards.push({ id: 'twilio', name: 'Twilio (regular texts)', status: balance == null ? 'unknown' : balance < 5 ? 'critical' : balance < 15 ? 'warn' : 'ok',
      meter: null, facts: [balance == null ? `Balance unavailable: ${bal.error}` : `Account balance: $${balance.toFixed(2)} ${bal.currency || ''}`.trim(), `${sent} texts sent this month, ${day} today`,
        'Sole-proprietor 10DLC registration: roughly 1,000 texts/day to T-Mobile users. Fine for demos.'], link: 'https://console.twilio.com/us1/billing/manage-billing/billing-overview' });
  }
  // Sendblue (iMessage)
  if (sms.sendblue.configured) {
    const q = since => db.prepare("SELECT COUNT(*) n FROM sms_log WHERE direction='out' AND sid IS NOT NULL AND sid NOT LIKE 'SM%' AND sid NOT LIKE 'MM%' AND created>=?").get(since).n;
    const lines = await safe(() => get('https://api.sendblue.com/api/lines', { headers: { 'sb-api-key-id': env.SENDBLUE_API_KEY, 'sb-api-secret-key': env.SENDBLUE_API_SECRET } }));
    cards.push({ id: 'sendblue', name: 'Sendblue (iMessage)', status: lines.error ? 'critical' : 'ok', meter: null,
      facts: [lines.error ? `Account check failed: ${lines.error}` : `Line active: ${(lines.numbers || []).join(', ') || 'none'}`, `${q(Date.parse(`${start}T00:00:00Z`))} iMessages sent this month, ${q(Date.parse(`${today()}T00:00:00Z`))} today`, 'Dedicated line plan ($100/mo). Sendblue has no usage API; watch for billing emails.'],
      link: 'https://app.sendblue.co' });
  }
  // SerpApi (movie showtimes)
  if (env.SERP_API_KEY) {
    const a = await safe(() => get(`https://serpapi.com/account.json?api_key=${env.SERP_API_KEY}`));
    const used = a.this_month_usage ?? 0, limit = a.searches_per_month ?? 0;
    cards.push({ id: 'serpapi', name: 'SerpApi (movie showtimes)', status: a.error ? 'unknown' : level(used, limit), meter: a.error ? null : { used, limit, unit: 'searches this month' },
      facts: [a.error ? `Account check failed: ${a.error}` : `${a.plan_searches_left ?? limit - used} searches left (${a.plan_name || 'current plan'})`, 'Each new area costs ~4 searches; theater schedules are cached 12 hours.', 'Starter: $25/mo for 1,000 searches.'],
      link: 'https://serpapi.com/manage-api-key' });
  }
  // Ticketmaster (events)
  if (sms.discovery.keys.ticketmaster) {
    const day = meter.calls('ticketmaster', null, today()), h = meter.headers.ticketmaster;
    cards.push({ id: 'ticketmaster', name: 'Ticketmaster (events)', status: level(day, 5000), meter: { used: day, limit: 5000, unit: 'calls today' },
      facts: [h ? `Ticketmaster reports ${h.available.toLocaleString()} of ${h.limit.toLocaleString()} calls left today` : 'Daily quota: 5,000 calls (resets daily)', `${meter.calls('ticketmaster', null, start)} calls this month`], link: 'https://developer.ticketmaster.com/user' });
  }
  // Google Maps Platform (places, photos, geocoding). No usage API on a plain key: our own counts vs free monthly caps.
  if (sms.discovery.keys.google) {
    const caps = { text_search: Number(env.GOOGLE_FREE_TEXT_SEARCH) || 1000, place_photos: Number(env.GOOGLE_FREE_PLACE_PHOTOS) || 1000, geocoding: Number(env.GOOGLE_FREE_GEOCODING) || 10000 };
    const rows = Object.entries(caps).map(([sku, cap]) => ({ sku, used: meter.calls('google', sku, start), cap }));
    const worst = rows.reduce((a, b) => b.used / b.cap > a.used / a.cap ? b : a);
    cards.push({ id: 'google', name: 'Google Maps Platform (places & photos)', status: level(worst.used, worst.cap), meter: { used: worst.used, limit: worst.cap, unit: `${worst.sku.replace('_', ' ')} this month (free tier)` },
      facts: [...rows.map(r => `${r.sku.replace('_', ' ')}: ${r.used.toLocaleString()} of ~${r.cap.toLocaleString()} free/month`), 'Free caps are conservative estimates; past them Google bills the card on file. Confirm in Cloud Console and set a budget alert there.'],
      link: 'https://console.cloud.google.com/google/maps-apis/metrics' });
  }
  for (const [id, name, key] of [['seatgeek', 'SeatGeek (events)', 'seatgeek'], ['gracenote', 'Gracenote (showtimes)', 'gracenote']])
    cards.push(sms.discovery.keys[key] ? { id, name, status: 'ok', meter: null, facts: [`${meter.calls(id, null, today())} calls today, ${meter.calls(id, null, start)} this month`] } : { id, name, status: 'off', meter: null, facts: ['Not connected yet (waiting on approval).'] });
  // Our own safety caps, and the server itself
  const sentToday = db.prepare("SELECT COUNT(*) n FROM sms_log WHERE direction='out' AND sid IS NOT NULL AND created>?").get(Date.now() - 86400000).n;
  cards.push({ id: 'caps', name: 'Rall-e’s own texting cap', status: level(sentToday, sms.conversationLimit), meter: { used: sentToday, limit: sms.conversationLimit, unit: 'texts in the last 24h' },
    facts: [`Per-person cap: ${sms.perRecipientLimit}/day (SMS_PER_RECIPIENT_DAILY_LIMIT)`, 'Raise SMS_CONVERSATION_DAILY_LIMIT in .env and redeploy if a demo day needs more.'] });
  const disk = (() => { try { const s = statfsSync(process.env.DB_PATH ? process.env.DB_PATH.replace(/[^/]+$/, '') : '/'); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return null; } })();
  cards.push({ id: 'server', name: 'Server (rall-e.ai)', status: disk ? level(disk.total - disk.free, disk.total) : 'ok', meter: disk ? { used: Math.round((disk.total - disk.free) / 1e9 * 10) / 10, limit: Math.round(disk.total / 1e9 * 10) / 10, unit: 'GB disk used' } : null,
    facts: [`Memory free: ${Math.round(freemem() / 1e6)} MB of ${Math.round(totalmem() / 1e6)} MB`, `Up ${Math.round(uptime() / 3600)} hours`] });
  const rank = { critical: 0, warn: 1, unknown: 2, ok: 3, off: 4 };
  return { at: Date.now(), cards: cards.sort((a, b) => rank[a.status] - rank[b.status]) };
}
