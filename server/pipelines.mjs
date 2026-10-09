// Exa vs Parallel trial (10-09, from Jeff's consulting call): both services watch the same few sources once a day and
// report new events. Their events SUPPLEMENT the scraper (stored as their own curated_events sources, never replacing
// ours), and /ops → Sources shows a scoreboard: how many real upcoming events each returned, how many our scraper also
// has (agreement), how many extras, how many of the scraper's new events each caught, and who had them first.
//
// We poll both APIs hourly; their webhooks only nudge an early poll (the payload is never trusted: we re-read the API
// with our key). Exa: Monitors API (search + structured output). Parallel: Monitor API (event_stream), whose plain-text
// change reports are turned into events by the background model (Haiku).
import { createHash } from 'node:crypto';
import { fail } from './store.mjs';
import { isPublicUrl } from './publicurl.mjs';

const DAY = 86400000;
export const PROVIDERS = ['exa', 'parallel'];
export const PROVIDER_NAMES = { exa: 'Exa', parallel: 'Parallel' };
// Estimated price per scheduled check (Oct 2026 list prices): Exa monitors $15/1k + $1/1k per result over 10 (we ask
// for 25); Parallel monitor "base" $10/1k executions.
const RUN_COST = { exa: 0.015 + 15 * 0.001, parallel: 0.01 };
const NUM_RESULTS = 25;
export const norm = t => String(t || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 2).slice(0, 3).join(' ');
// A Parallel execution: its event group, or for a "no changes" completion (which has no ids) its timestamp.
const runOf = ev => String(ev.event_group_id || ev.event_id || `done:${ev.timestamp || ''}`);
const keyOf = e => `${e.date}|${norm(e.title)}`;
const short = v => createHash('sha256').update(String(v)).digest('base64url').slice(0, 10);
const EVENT_FIELDS = {
  title: { type: 'string', description: 'Event name' },
  date: { type: 'string', description: 'Start date, YYYY-MM-DD' },
  time: { type: 'string', description: 'Start time, 24-hour HH:MM, or empty if not listed' },
  venue: { type: 'string', description: 'Venue name' },
  price: { type: 'string', description: 'Price as listed (e.g. "$20", "Free"), or empty' },
  url: { type: 'string', description: 'Link to the event page' }
};
export const EVENTS_SCHEMA = { type: 'object', properties: { events: { type: 'array', items: { type: 'object', properties: EVENT_FIELDS, required: ['title', 'date'] } } }, required: ['events'] };

export class Pipelines {
  constructor(sms, env = process.env, fetchImpl = globalThis.fetch) {
    this.sms = sms; this.db = sms.db; this.fetch = fetchImpl;
    this.keys = { exa: env.EXA_API_KEY || '', parallel: env.PARALLEL_API_KEY || '' };
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_monitors (provider TEXT NOT NULL, source TEXT NOT NULL, monitor_id TEXT NOT NULL, secret TEXT, created INTEGER NOT NULL,
        polled INTEGER, error TEXT, stopped INTEGER, PRIMARY KEY (provider, source));
      CREATE TABLE IF NOT EXISTS pipeline_runs (provider TEXT NOT NULL, run_id TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, returned INTEGER NOT NULL DEFAULT 0,
        kept INTEGER NOT NULL DEFAULT 0, executions INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (provider, run_id));
      CREATE TABLE IF NOT EXISTS pipeline_events (provider TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, first_seen INTEGER NOT NULL,
        added INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, source, key));
      CREATE TABLE IF NOT EXISTS pipeline_scraper_seen (source TEXT NOT NULL, key TEXT NOT NULL, first_seen INTEGER NOT NULL, baseline INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source, key));`);
  }
  enabled(p) { return Boolean(this.keys[p]); }
  get base() { return this.sms.base || 'https://rall-e.ai'; }
  source(id) { return this.db.prepare('SELECT * FROM event_sources WHERE id=?').get(id); }
  trial() { return [...new Set(this.db.prepare('SELECT source FROM pipeline_monitors WHERE stopped IS NULL').all().map(r => r.source))]; }

  // ---------- API calls ----------
  async api(p, method, path, data) {
    const url = p === 'exa' ? `https://api.exa.ai${path}` : `https://api.parallel.ai${path}`;
    const headers = { 'content-type': 'application/json', 'x-api-key': this.keys[p], ...(p === 'exa' ? { Authorization: `Bearer ${this.keys[p]}` } : {}) };
    const r = await this.fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(30000) });
    const text = await r.text(), json = (() => { try { return JSON.parse(text); } catch { return null; } })();
    if (!r.ok) throw Object.assign(new Error(`${PROVIDER_NAMES[p]} ${r.status}: ${String(json?.error?.message || json?.message || json?.error || text).slice(0, 200)}`), { status: r.status });
    return json || {};
  }
  query(src) {
    return `New upcoming events listed on ${src.name} (${src.url}) in ${src.city}: event name, date, start time, venue, price and the link to each event.`;
  }
  async createMonitor(p, src) {
    const host = new URL(src.url).hostname.replace(/^www\./, ''), meta = { rall_e_source: src.id };
    if (p === 'exa') {
      const body = { name: `Rall-e: ${src.name}`.slice(0, 80), search: { query: this.query(src), numResults: NUM_RESULTS, includeDomains: [host] },
        trigger: { type: 'interval', period: '1d' }, outputSchema: EVENTS_SCHEMA, metadata: meta,
        webhook: { url: `${this.base}/api/pipelines/hook/exa`, events: ['monitor.run.completed'] } };
      let m;
      try { m = await this.api(p, 'POST', '/monitors', body); }
      catch (e) { if (e.status !== 400 || !/includeDomains/i.test(e.message)) throw e; delete body.search.includeDomains; m = await this.api(p, 'POST', '/monitors', body); }
      return { id: m.id || m.monitorId, secret: m.webhookSecret || null };
    }
    const m = await this.api(p, 'POST', '/v1/monitors', { type: 'event_stream', frequency: '1d', processor: 'base',
      settings: { query: this.query(src), advanced_settings: { source_policy: { include_domains: [host] }, location: 'US' } },
      webhook: { url: `${this.base}/api/pipelines/hook/parallel`, event_types: ['monitor.event.detected'] }, metadata: meta });
    return { id: m.monitor_id || m.id, secret: null };
  }

  // ---------- setup / stop ----------
  async setup(sourceIds) {
    const ids = [...new Set((sourceIds || []).map(String))];
    if (!ids.length || ids.length > 10) fail(400, 'Pick 1 to 10 sources.');
    if (!PROVIDERS.some(p => this.enabled(p))) fail(400, 'Add EXA_API_KEY and/or PARALLEL_API_KEY to .env and deploy first.');
    const out = [];
    for (const id of ids) {
      const src = this.source(id); if (!src) fail(404, `No source ${id}.`);
      if (!isPublicUrl(src.url)) fail(400, `${src.name} isn't a public page.`);
      this.snapshot([id], true); // the scraper's events at the start don't count as "new"
      for (const p of PROVIDERS.filter(x => this.enabled(x))) {
        const have = this.db.prepare('SELECT * FROM pipeline_monitors WHERE provider=? AND source=? AND stopped IS NULL').get(p, id);
        if (have) { out.push({ provider: p, source: src.name, monitor: have.monitor_id, existing: true }); continue; }
        try {
          const m = await this.createMonitor(p, src);
          this.db.prepare('INSERT OR REPLACE INTO pipeline_monitors (provider, source, monitor_id, secret, created) VALUES (?,?,?,?,?)').run(p, id, m.id, m.secret, Date.now());
          out.push({ provider: p, source: src.name, monitor: m.id });
        } catch (e) { out.push({ provider: p, source: src.name, error: e.message }); }
      }
    }
    return out;
  }
  async stop(provider = null) {
    const rows = this.db.prepare('SELECT * FROM pipeline_monitors WHERE stopped IS NULL' + (provider ? ' AND provider=?' : '')).all(...(provider ? [provider] : []));
    for (const m of rows) {
      try {
        if (m.provider === 'exa') await this.api('exa', 'DELETE', `/monitors/${m.monitor_id}`);
        else await this.api('parallel', 'POST', `/v1/monitors/${m.monitor_id}/cancel`).catch(() => this.api('parallel', 'DELETE', `/v1/monitors/${m.monitor_id}`));
      } catch (e) { console.error('Pipeline stop:', e.message); }
      this.db.prepare('UPDATE pipeline_monitors SET stopped=? WHERE provider=? AND source=?').run(Date.now(), m.provider, m.source);
    }
    return rows.length;
  }

  // ---------- reading results ----------
  // What our scraper has for the trial sources right now, with when we first saw each event.
  snapshot(ids = this.trial(), baseline = false) {
    const put = this.db.prepare('INSERT OR IGNORE INTO pipeline_scraper_seen VALUES (?,?,?,?)'), now = Date.now();
    for (const id of ids) for (const r of this.db.prepare('SELECT data FROM curated_events WHERE source=?').all(id)) {
      const e = JSON.parse(r.data); put.run(id, keyOf({ date: e.localDate, title: e.short }), now, baseline ? 1 : 0);
    }
  }
  clean(e, src = { url: '' }) {
    const today = new Date().toISOString().slice(0, 10), last = new Date(Date.now() + 120 * DAY).toISOString().slice(0, 10);
    const title = String(e?.title || '').replace(/\s+/g, ' ').trim(), date = String(e?.date || '').slice(0, 10);
    if (title.length < 3 || title.length > 160 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > last) return null;
    const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?/i.exec(String(e.time || '').trim()), pm = /p/i.test(m?.[3] || ''), am = /a/i.test(m?.[3] || '');
    const h = m ? (+m[1] % 12) + (pm ? 12 : 0) + (!pm && !am && +m[1] === 12 ? 12 : 0) : NaN;
    const time = m && (m[2] || m[3]) && +m[1] < 24 ? `${String(pm || am ? h : +m[1]).padStart(2, '0')}:${m[2] || '00'}` : '';
    const url = /^https?:\/\//.test(e.url || '') && isPublicUrl(e.url) ? String(e.url).slice(0, 500) : src.url;
    return { title, date, time, venue: String(e.venue || '').slice(0, 80), price: String(e.price || '').slice(0, 40), url };
  }
  // Model-free for Exa (structured output); Parallel's change reports are read by the background model.
  async parseText(text, src) {
    const out = await this.sms.alerts?.ask(`You turn a short report about new events on a website into a list of events. Today is ${new Date().toISOString().slice(0, 10)}. The events are in or near ${src.city}. Use only what the report says; skip anything that isn't a specific upcoming event with a date.`,
      String(text).slice(0, 12000), { name: 'events', description: 'The events in the report.', input_schema: EVENTS_SCHEMA });
    return out?.events || [];
  }
  async ingest(p, src, runId, raw, executions = 1) {
    const seenRun = this.db.prepare('SELECT 1 FROM pipeline_runs WHERE provider=? AND run_id=?').get(p, runId);
    if (seenRun) return 0;
    const kept = [];
    for (const r of raw) { const e = this.clean(r, src); if (e && !kept.some(k => keyOf(k) === keyOf(e))) kept.push(e); }
    this.db.prepare('INSERT INTO pipeline_runs VALUES (?,?,?,?,?,?,?)').run(p, runId, src.id, Date.now(), raw.length, kept.length, executions);
    const scraper = new Set(this.db.prepare('SELECT key FROM pipeline_scraper_seen WHERE source=?').all(src.id).map(r => r.key));
    let added = 0;
    for (const e of kept) {
      const k = keyOf(e);
      if (!this.db.prepare('INSERT OR IGNORE INTO pipeline_events (provider, source, key, data, first_seen) VALUES (?,?,?,?,?)').run(p, src.id, k, JSON.stringify(e), Date.now()).changes) continue;
      // Supplement only: events our scraper doesn't have, and that the other service hasn't already added.
      if (scraper.has(k) || this.db.prepare('SELECT 1 FROM pipeline_events WHERE source=? AND key=? AND added=1').get(src.id, k)) continue;
      const tag = `pl_${p}_${src.id}`, shaped = await this.sms.sources.shape(e, { ...src, id: tag, name: `${src.name} (via ${PROVIDER_NAMES[p]})` });
      this.sms.sources.store(tag, shaped);
      this.db.prepare('UPDATE pipeline_events SET added=1 WHERE provider=? AND source=? AND key=?').run(p, src.id, k);
      added++;
    }
    return added;
  }
  async pollExa(m, src) {
    const r = await this.api('exa', 'GET', `/monitors/${m.monitor_id}/runs`), runs = r.data || r.runs || r.results || [];
    let n = 0;
    for (const run of runs.filter(x => x.status === 'completed')) {
      if (this.db.prepare('SELECT 1 FROM pipeline_runs WHERE provider=? AND run_id=?').get('exa', run.id)) continue;
      let content = run.output?.content;
      if (typeof content === 'string') { try { content = JSON.parse(content); } catch { content = null; } }
      let raw = Array.isArray(content?.events) ? content.events : null;
      if (!raw) {
        // Limited to one site, Exa watches that site's pages instead of searching: content is { changeCount, changes,
        // targets } (the first run is a baseline with no changes). Otherwise read the search results.
        const changes = Array.isArray(content?.changes) ? content.changes : [], results = run.output?.results || [];
        const text = [...changes.map(c => typeof c === 'string' ? c : JSON.stringify(c).slice(0, 3000)),
          ...results.map(x => `${x.title || ''} | ${x.url || ''} | ${x.publishedDate || ''}\n${String(x.text || x.summary || (x.highlights || []).join(' ')).slice(0, 1500)}`)].join('\n\n');
        raw = text ? await this.parseText(text, src) : [];
      }
      n += await this.ingest('exa', src, run.id, raw);
    }
    return n;
  }
  async pollParallel(m, src) {
    let cursor = null, n = 0, pages = 0;
    const fresh = [], groups = new Set();
    do {
      const r = await this.api('parallel', 'GET', `/v1/monitors/${m.monitor_id}/events?include_completions=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const events = r.events || [];
      let known = false;
      for (const ev of events) {
        const id = runOf(ev);
        if (this.db.prepare('SELECT 1 FROM pipeline_runs WHERE provider=? AND run_id=?').get('parallel', id)) { known = true; continue; }
        groups.add(id); fresh.push(ev);
      }
      cursor = known ? null : r.next_cursor; pages++;
    } while (cursor && pages < 5);
    for (const id of groups) {
      const evs = fresh.filter(ev => runOf(ev) === id && ev.event_type === 'event_stream');
      const text = evs.map(ev => [ev.event_date && `Date: ${ev.event_date}`, typeof ev.output?.content === 'string' ? ev.output.content : JSON.stringify(ev.output?.content || ''),
        ...(ev.output?.basis || []).flatMap(b => (b.citations || []).map(c => `Source: ${c.title || ''} ${c.url || ''}\n${(c.excerpts || []).join(' | ').slice(0, 800)}`))].filter(Boolean).join('\n')).join('\n\n');
      n += await this.ingest('parallel', src, id, text ? await this.parseText(text, src) : []);
    }
    return n;
  }
  async poll(provider = null) {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      this.snapshot();
      let added = 0;
      for (const m of this.db.prepare('SELECT * FROM pipeline_monitors WHERE stopped IS NULL' + (provider ? ' AND provider=?' : '')).all(...(provider ? [provider] : []))) {
        const src = this.source(m.source); if (!src || !this.enabled(m.provider)) continue;
        try {
          added += m.provider === 'exa' ? await this.pollExa(m, src) : await this.pollParallel(m, src);
          this.db.prepare('UPDATE pipeline_monitors SET polled=?, error=NULL WHERE provider=? AND source=?').run(Date.now(), m.provider, m.source);
        } catch (e) { this.db.prepare('UPDATE pipeline_monitors SET polled=?, error=? WHERE provider=? AND source=?').run(Date.now(), String(e.message).slice(0, 300), m.provider, m.source); }
      }
      return added;
    })().finally(() => { this.polling = null; });
    return this.polling;
  }
  // A webhook says a run finished: poll soon (at most once a minute). The payload itself is ignored.
  nudge(provider) {
    if (!PROVIDERS.includes(provider) || this.nudged) return;
    this.nudged = setTimeout(() => { this.nudged = null; this.poll(provider).catch(e => console.error('Pipelines:', e.message)); }, 60000); this.nudged.unref?.();
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll().catch(e => console.error('Pipelines:', e.message)), 3600000); this.timer.unref?.();
    setTimeout(() => this.poll().catch(() => {}), 120000).unref?.();
  }

  // ---------- scoreboard ----------
  report() {
    const monitors = this.db.prepare('SELECT * FROM pipeline_monitors').all();
    const ids = [...new Set(monitors.map(m => m.source))], today = new Date().toISOString().slice(0, 10);
    const sources = ids.map(id => {
      const src = this.source(id) || { name: id, city: '' };
      const seen = this.db.prepare('SELECT key, first_seen, baseline FROM pipeline_scraper_seen WHERE source=?').all(id), scraperKeys = new Map(seen.map(s => [s.key, s]));
      const fresh = seen.filter(s => !s.baseline && s.key.slice(0, 10) >= today);
      const row = { id, name: src.name, city: src.city, url: src.url, scraperNew: fresh.length, providers: {} };
      for (const p of PROVIDERS) {
        const m = monitors.find(x => x.provider === p && x.source === id); if (!m) continue;
        const runs = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(executions),0) AS ex, COALESCE(SUM(returned),0) AS returned, COALESCE(SUM(kept),0) AS kept FROM pipeline_runs WHERE provider=? AND source=?').get(p, id);
        const evs = this.db.prepare('SELECT key, first_seen, added FROM pipeline_events WHERE provider=? AND source=?').all(p, id), mine = new Map(evs.map(e => [e.key, e]));
        const caught = fresh.filter(s => mine.has(s.key));
        row.providers[p] = { monitor: m.monitor_id, since: m.created, polled: m.polled, error: m.error, stopped: m.stopped, runs: runs.n, returned: runs.returned, events: evs.length,
          upcoming: evs.filter(e => e.key.slice(0, 10) >= today).length, alsoScraper: evs.filter(e => scraperKeys.has(e.key)).length, extra: evs.filter(e => !scraperKeys.has(e.key)).length,
          added: evs.filter(e => e.added).length, caught: caught.length, first: caught.filter(s => mine.get(s.key).first_seen < s.first_seen).length,
          cost: Math.round(runs.ex * RUN_COST[p] * 100) / 100 };
      }
      return row;
    });
    const totals = Object.fromEntries(PROVIDERS.map(p => [p, ['runs', 'events', 'alsoScraper', 'extra', 'added', 'caught', 'first', 'cost'].reduce((t, k) => ({ ...t, [k]: Math.round(sources.reduce((s, r) => s + (r.providers[p]?.[k] || 0), 0) * 100) / 100 }), {})]));
    return { enabled: Object.fromEntries(PROVIDERS.map(p => [p, this.enabled(p)])), sources, totals, scraperNew: sources.reduce((s, r) => s + r.scraperNew, 0) };
  }
}
