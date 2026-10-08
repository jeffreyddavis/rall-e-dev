// API usage meter for the demo console (/ops "Usage"): how much of each outside service Rall-e is using, and how
// close each is to running out, so nothing goes dead in the middle of a VC demo.
// Counts come from three places: our own call log (every service), provider headers (rate limits), and provider
// account APIs where one exists (Twilio balance, SerpApi searches left, Anthropic cost with an Admin key).
import { statfsSync } from 'node:fs';
import { freemem, totalmem, uptime } from 'node:os';

const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);
// "jambase=2026-12-31, vapi=2027-01-15" → Map(id → YYYY-MM-DD); anything malformed is skipped.
export const parseTrials = v => new Map(String(v || '').split(/[,;]/).map(x => x.trim().split('=').map(y => y.trim())).filter(([id, d]) => id && /^\d{4}-\d{2}-\d{2}$/.test(d || '')).map(([id, d]) => [id.toLowerCase(), d]));
const level = (used, limit) => !limit ? 'ok' : used / limit >= 0.9 ? 'critical' : used / limit >= 0.75 ? 'warn' : 'ok';
const PROVIDERS = { 'app.ticketmaster.com': 'ticketmaster', 'api.seatgeek.com': 'seatgeek', 'maps.googleapis.com': 'google', 'places.googleapis.com': 'google', 'routes.googleapis.com': 'google', 'serpapi.com': 'serpapi', 'data.tmsapi.com': 'gracenote', 'api.weather.gov': 'weather', 'api.data.jambase.com': 'jambase', 'demo.tmsimg.com': 'gracenote' };
const skuOf = url => {
  const u = new URL(url);
  if (u.host === 'maps.googleapis.com') return u.pathname.includes('geocode') ? 'geocoding' : 'maps';
  if (u.host === 'routes.googleapis.com') return 'routes';
  if (u.host === 'places.googleapis.com') return u.pathname.includes('/media') ? 'place_photos' : 'text_search';
  return 'calls';
};

// One shared meter; the Sms constructor gives it the database.
export const meter = {
  db: null, headers: {},
  attach(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS api_calls (day TEXT NOT NULL, provider TEXT NOT NULL, sku TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, provider, sku));
      CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS openai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_usage_models (day TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, PRIMARY KEY (day, model));`);
  },
  call(url, headers) {
    try {
      const provider = PROVIDERS[new URL(url).host]; if (!provider || !this.db) return;
      this.db.prepare('INSERT INTO api_calls VALUES (?,?,?,1) ON CONFLICT(day, provider, sku) DO UPDATE SET n=n+1').run(today(), provider, skuOf(url));
      if (provider === 'ticketmaster' && headers?.get?.('rate-limit-available')) this.headers.ticketmaster = { available: Number(headers.get('rate-limit-available')), limit: Number(headers.get('rate-limit')), reset: Number(headers.get('rate-limit-reset')), at: Date.now() };
    } catch {}
  },
  ai(usage = {}, headers, model = '') {
    if (!this.db) return;
    const n = [usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0];
    this.db.prepare('INSERT INTO ai_usage VALUES (?,1,?,?,?,?) ON CONFLICT(day) DO UPDATE SET calls=calls+1, input=input+excluded.input, output=output+excluded.output, cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write')
      .run(today(), ...n);
    if (model) this.db.prepare('INSERT INTO ai_usage_models VALUES (?,?,1,?,?,?,?) ON CONFLICT(day, model) DO UPDATE SET calls=calls+1, input=input+excluded.input, output=output+excluded.output, cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write')
      .run(today(), String(model).slice(0, 60), ...n);
    const h = k => headers?.get?.(`anthropic-ratelimit-${k}`);
    if (h('requests-limit')) this.headers.anthropic = { requests: [Number(h('requests-remaining')), Number(h('requests-limit'))], input: [Number(h('input-tokens-remaining')), Number(h('input-tokens-limit'))], output: [Number(h('output-tokens-remaining')), Number(h('output-tokens-limit'))], at: Date.now() };
  },
  openai(usage = {}) {
    if (!this.db) return;
    this.db.prepare('INSERT INTO openai_usage VALUES (?,1,?,?) ON CONFLICT(day) DO UPDATE SET calls=calls+1, input=input+excluded.input, output=output+excluded.output').run(today(), usage.prompt_tokens || 0, usage.completion_tokens || 0);
  },
  calls(provider, sku, since) { return this.db.prepare(`SELECT COALESCE(SUM(n),0) AS n FROM api_calls WHERE provider=? ${sku ? 'AND sku=?' : ''} AND day>=?`).get(...[provider, ...(sku ? [sku] : []), since]).n; }
};

// Anthropic list prices per million tokens (input, output, cache hits, 5-minute cache writes), from the pricing page 10-08.
// Usage logged before per-model tracking (10-08) has no model and is priced as Sonnet 5.5, the texting agent's model.
const PRICES = { 'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 }, 'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } };
const priceOf = model => PRICES[model] || PRICES[Object.keys(PRICES).find(k => String(model).startsWith(k))] || PRICES['claude-sonnet-5-5'];
const cost = (r, p) => (r.input * p.input + r.output * p.output + r.cache_read * p.cache_read + r.cache_write * p.cache_write) / 1e6;

export async function usageReport(sms, env = process.env, fetchImpl = globalThis.fetch) {
  const m = month(), start = `${m}-01`, db = sms.db, cards = [];
  const get = async (url, init = {}) => { const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000) }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error?.message || d?.message || d?.error || `HTTP ${r.status}`); return d; };
  const safe = async fn => { try { return await fn(); } catch (e) { return { error: String(e.message).slice(0, 120) }; } };

  // Claude (the app's API key, not anyone's chat account)
  const ai = db.prepare('SELECT COALESCE(SUM(calls),0) calls, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write FROM ai_usage WHERE day>=?').get(start);
  const aiToday = db.prepare('SELECT calls, input, output FROM ai_usage WHERE day=?').get(today()) || { calls: 0, input: 0, output: 0 };
  const byModel = db.prepare('SELECT model, SUM(calls) calls, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write FROM ai_usage_models WHERE day>=? GROUP BY model').all(start);
  const rest = ['input', 'output', 'cache_read', 'cache_write'].reduce((o, k) => ({ ...o, [k]: Math.max(0, ai[k] - byModel.reduce((s, r) => s + r[k], 0)) }), {});
  const est = byModel.reduce((s, r) => s + cost(r, priceOf(r.model)), cost(rest, PRICES['claude-sonnet-5-5']));
  const allIn = ai.input + ai.cache_read + ai.cache_write, cachedPct = allIn ? Math.round(ai.cache_read / allIn * 100) : 0;
  const modelLine = byModel.length ? `By model this month: ${byModel.sort((a, b) => cost(b, priceOf(b.model)) - cost(a, priceOf(a.model))).map(r => `${r.model.replace('claude-', '')} ${r.calls} calls ~$${cost(r, priceOf(r.model)).toFixed(2)}`).join(', ')}` : null;
  const budget = Number(env.ANTHROPIC_MONTHLY_BUDGET_USD) || 0, rl = meter.headers.anthropic;
  const official = env.ANTHROPIC_ADMIN_KEY ? await safe(async () => {
    const d = await get(`https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start}T00:00:00Z&ending_at=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}T00:00:00Z`, { headers: { 'x-api-key': env.ANTHROPIC_ADMIN_KEY, 'anthropic-version': '2023-06-01' } });
    return { usd: (d.data || []).flatMap(b => b.results || [b]).reduce((s, x) => s + Number(x.amount || 0), 0) / 100 };
  }) : null;
  const spent = official?.usd ?? est;
  cards.push({ id: 'anthropic', name: 'Claude API (Rall-e’s brain)', status: budget ? level(spent, budget) : 'ok',
    meter: budget ? { used: Math.round(spent * 100) / 100, limit: budget, unit: 'USD this month' } : null,
    facts: [`${ai.calls} AI calls this month (${aiToday.calls} today)`, `${official?.usd != null ? 'Spend this month' : 'Estimated spend this month'}: $${spent.toFixed(2)}${official?.usd != null ? ' (Anthropic cost report)' : ` (${allIn.toLocaleString()} input + ${ai.output.toLocaleString()} output tokens at list prices)`}`,
      allIn ? `Cached input: ${cachedPct}% of input tokens this month (cache hits cost a twentieth of normal input on Sonnet)` : null, modelLine,
      rl ? `Rate limit right now: ${rl.requests[0]}/${rl.requests[1]} requests per minute left` : 'Rate limits: shown after the next AI reply',
      official?.error ? `Cost report error: ${official.error}` : !env.ANTHROPIC_ADMIN_KEY ? 'Prepaid credit balance isn’t available by API. Check the Claude Console, and turn on auto-reload so credits can’t run out mid-demo.' : null].filter(Boolean),
    link: 'https://platform.claude.com/settings/billing' });

  // OpenAI: the backup brain when Claude is down.
  const oa = db.prepare('SELECT COALESCE(SUM(calls),0) calls, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output FROM openai_usage WHERE day>=?').get(start);
  const down = sms.flow.agent.claudeDownUntil > Date.now();
  cards.push({ id: 'openai', name: 'OpenAI (backup brain)', status: env.OPENAI_API_KEY ? (down ? 'warn' : 'ok') : 'off', meter: null,
    facts: env.OPENAI_API_KEY ? [down ? 'Claude is down: replies are coming from the backup right now' : 'Standing by: takes over automatically if Claude is down', `${oa.calls} backup calls this month (~$${((oa.input * 2 + oa.output * 10) / 1e6).toFixed(2)} at ${sms.flow.agent.openaiModel} list prices)`]
      : ['Not set up: add OPENAI_API_KEY to .env so Rall-e keeps answering if Claude is down.'], link: 'https://platform.openai.com/usage' });
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
  // JamBase (live music)
  let jambaseTrial = null;
  if (env.JAMBASE_KEY) {
    const q = await safe(() => get('https://api.data.jambase.com/v3/quota', { headers: { Authorization: `Bearer ${env.JAMBASE_KEY}` } }));
    const used = q.usedCalls ?? 0, limit = q.quota ?? 0;
    if (/trial/i.test(q.plan || '') && /^\d{4}-\d{2}-\d{2}/.test(String(q.periodEnd || ''))) jambaseTrial = String(q.periodEnd).slice(0, 10);
    cards.push({ id: 'jambase', name: 'JamBase (live music)', status: q.error ? 'unknown' : level(used, limit), meter: q.error ? null : { used, limit, unit: 'calls this period' },
      facts: [q.error ? `Quota check failed: ${q.error}` : `${q.remainingCalls ?? limit - used} calls left (${q.plan || 'plan'}${q.periodEnd ? `, resets ${String(q.periodEnd).slice(0, 10)}` : ''}${q.blocksAtQuota ? ', hard stop at the limit' : ''})`, 'Used for live-music searches; cached 6 hours per area and dates.', 'Developer plan is free for non-commercial use (attribution required); Startup is $500/mo.'],
      link: 'https://data.jambase.com/' });
  }
  // Ticketmaster (events)
  if (sms.discovery.keys.ticketmaster) {
    const day = meter.calls('ticketmaster', null, today()), h = meter.headers.ticketmaster;
    cards.push({ id: 'ticketmaster', name: 'Ticketmaster (events)', status: level(day, 5000), meter: { used: day, limit: 5000, unit: 'calls today' },
      facts: [h ? `Ticketmaster reports ${h.available.toLocaleString()} of ${h.limit.toLocaleString()} calls left today` : 'Daily quota: 5,000 calls (resets daily)', `${meter.calls('ticketmaster', null, start)} calls this month`], link: 'https://developer.ticketmaster.com/user' });
  }
  // Google Maps Platform (places, photos, geocoding). No usage API on a plain key: our own counts vs free monthly caps.
  if (sms.discovery.keys.google) {
    const caps = { text_search: Number(env.GOOGLE_FREE_TEXT_SEARCH) || 1000, place_photos: Number(env.GOOGLE_FREE_PLACE_PHOTOS) || 1000, geocoding: Number(env.GOOGLE_FREE_GEOCODING) || 10000, routes: Number(env.GOOGLE_FREE_ROUTES) || 10000 };
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
  // Trials: when each service's free trial ends. SERVICE_TRIALS in .env ("jambase=2026-12-31, vapi=2027-01-15", ids as
  // on the cards; editable without code). JamBase's quota check adds its own trial end when it reports one.
  const trials = parseTrials(env.SERVICE_TRIALS);
  if (jambaseTrial && !trials.has('jambase')) trials.set('jambase', jambaseTrial);
  if (trials.size) {
    const rows = [...trials].map(([id, end]) => {
      const days = Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${today()}T12:00:00Z`)) / 86400000), when = new Date(`${end}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      const status = days <= 2 ? 'critical' : days <= 7 ? 'warn' : 'ok', card = cards.find(c => c.id === id);
      const line = days < 0 ? `Trial ended ${when}` : `Trial ends ${when} (${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`})`;
      if (card) { card.facts = [line, ...(card.facts || [])]; if (rank[status] < rank[card.status]) card.status = status; }
      return { name: card?.name.split(' (')[0] || id, line, status, days };
    }).sort((a, b) => a.days - b.days);
    cards.push({ id: 'trials', name: 'Trials', status: rows.reduce((s, r) => rank[r.status] < rank[s] ? r.status : s, 'ok'), meter: null,
      facts: [...rows.map(r => `${r.name}: ${r.line}`), 'Dates come from SERVICE_TRIALS in .env (redeploy after changing).'] });
  }
  return { at: Date.now(), cards: cards.sort((a, b) => rank[a.status] - rank[b.status]) };
}
