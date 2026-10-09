import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';

const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const json = (d, status = 200) => ({ ok: status < 300, status, headers: new Map(), json: async () => d, text: async () => JSON.stringify(d) });

function setup({ exaRejectsDomains = false } = {}) {
  const store = new Store(':memory:'), calls = [];
  const state = { exaRuns: [], parallelEvents: [], parsed: [] };
  const fetchImpl = async (url, init = {}) => {
    url = String(url); calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    if (url === 'https://api.exa.ai/monitors' && init.method === 'POST') {
      if (exaRejectsDomains && JSON.parse(init.body).search.includeDomains) return json({ error: 'Unrecognized key: includeDomains' }, 400);
      return json({ id: 'mon_exa_1', webhookSecret: 'whsec_x' });
    }
    if (url.startsWith('https://api.exa.ai/monitors/mon_exa_1/runs')) return json({ data: state.exaRuns });
    if (url === 'https://api.parallel.ai/v1/monitors' && init.method === 'POST') return json({ monitor_id: 'mon_par_1' });
    if (url.startsWith('https://api.parallel.ai/v1/monitors/mon_par_1/events')) return json({ events: state.parallelEvents, next_cursor: null });
    if (url.includes('api.anthropic.com')) return json({ content: [{ type: 'tool_use', id: 't', name: 'events', input: { events: state.parsed } }], usage: {} });
    throw new Error(`unexpected fetch ${url}`);
  };
  const env = { SMS_MODE: 'preview', ANTHROPIC_API_KEY: 'k', SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0',
    EXA_API_KEY: 'exa-key', PARALLEL_API_KEY: 'par-key' };
  const sms = new Sms(store, env, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, fetchImpl);
  store.db.prepare('INSERT INTO event_sources (id, url, name, city, lat, lng, created, found) VALUES (?,?,?,?,?,?,?,?)').run('src1', 'https://www.calendar.example.org/events', 'Example Calendar', 'Portsmouth, NH', 43.07, -70.76, Date.now(), 2);
  const scraped = (title, date) => sms.sources.store('src1', { id: `cs_${title.replace(/\W/g, '')}`, short: title, localDate: date, lat: 43.07, lng: -70.76, curated: true });
  scraped('Jazz Night at the Press Room', day(3));
  return { store, sms, p: sms.pipelines, calls, state, scraped };
}

test('setup: one daily monitor per service per source, limited to that site, with our webhook', async () => {
  const t = setup();
  const r = await t.p.setup(['src1']);
  assert.deepEqual(r.map(x => [x.provider, x.monitor]), [['exa', 'mon_exa_1'], ['parallel', 'mon_par_1']]);
  const exa = t.calls.find(c => c.url === 'https://api.exa.ai/monitors').body, par = t.calls.find(c => c.url === 'https://api.parallel.ai/v1/monitors').body;
  assert.deepEqual(exa.trigger, { type: 'interval', period: '1d' });
  assert.deepEqual(exa.search.includeDomains, ['calendar.example.org']);
  assert.equal(exa.webhook.url, 'https://rall-e.ai/api/pipelines/hook/exa');
  assert.ok(exa.outputSchema.properties.events);
  assert.equal(par.frequency, '1d'); assert.equal(par.type, 'event_stream');
  assert.deepEqual(par.settings.advanced_settings.source_policy.include_domains, ['calendar.example.org']);
  assert.equal(t.calls.find(c => c.url.includes('parallel')).headers['x-api-key'], 'par-key');
  // Running setup again doesn't make duplicates.
  assert.ok((await t.p.setup(['src1'])).every(x => x.existing));
  assert.equal(t.calls.filter(c => c.method === 'POST').length, 2);
  // Exa without domain filtering on monitors: falls back to the query alone.
  const u = setup({ exaRejectsDomains: true });
  assert.equal((await u.p.setup(['src1']))[0].monitor, 'mon_exa_1');
  t.store.close(); u.store.close();
});

test('times in any common format become 24-hour', () => {
  const t = setup(), c = time => t.p.clean({ title: 'Show', date: day(2), time }, { url: 'https://x.example' })?.time;
  assert.deepEqual(['7:00 PM', '7pm', '19:30', '12:00 PM', '12 AM', '9:15 a.m.', '', 'TBA'].map(c), ['19:00', '19:00', '19:30', '12:00', '00:00', '09:15', '', '']);
  t.store.close();
});

test('results are cleaned, added only when we don\'t have them, and scored against the scraper', async () => {
  const t = setup();
  await t.p.setup(['src1']);
  t.scraped('Trivia Tuesday', day(5)); // the scraper's own new event after the trial started
  t.state.exaRuns = [{ id: 'run1', status: 'completed', output: { content: { events: [
    { title: 'Jazz Night at the Press Room', date: day(3), time: '20:00', venue: 'Press Room' }, // we have it
    { title: 'Trivia Tuesday', date: day(5), time: '7:00 PM' }, // the scraper's new one
    { title: 'Harbor Lights Parade', date: day(10), time: '18:30', venue: 'Market Square', price: 'Free', url: 'https://www.calendar.example.org/e/parade' }, // extra
    { title: 'Old Show', date: day(-2) }, { title: 'x', date: day(4) }, { title: 'No date' } // dropped
  ] } } }, { id: 'run2', status: 'running', output: null }];
  t.state.parallelEvents = [{ event_id: 'e1', event_group_id: 'g1', event_type: 'event_stream', event_date: day(0), output: { type: 'text', content: 'New: Harbor Lights Parade and a Craft Fair', basis: [{ citations: [{ url: 'https://calendar.example.org/x' }] }] } },
    { event_id: 'e0', event_group_id: 'g0', event_type: 'completion' }];
  t.state.parsed = [{ title: 'Harbor Lights Parade', date: day(10), time: '18:30' }, { title: 'Craft Fair on the Green', date: day(12) }];
  const added = await t.p.poll();
  assert.equal(added, 2); // Exa's parade + Parallel's craft fair (Parallel's parade was already added by Exa)
  const ours = t.store.db.prepare("SELECT source, data FROM curated_events WHERE source LIKE 'pl_%'").all();
  assert.deepEqual(ours.map(r => [r.source, JSON.parse(r.data).short]).sort(), [['pl_exa_src1', 'Harbor Lights Parade'], ['pl_parallel_src1', 'Craft Fair on the Green']]);
  assert.match(JSON.parse(ours.find(r => r.source === 'pl_exa_src1').data).source, /Example Calendar \(via Exa\)/);
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM curated_events WHERE source='src1'").get().n, 2); // ours untouched

  const r = t.p.report(), exa = r.sources[0].providers.exa, par = r.sources[0].providers.parallel;
  assert.equal(r.sources[0].scraperNew, 1);
  assert.deepEqual([exa.runs, exa.events, exa.alsoScraper, exa.extra, exa.added, exa.caught, exa.first], [1, 3, 2, 1, 1, 1, 0]);
  assert.deepEqual([par.runs, par.events, par.extra, par.added, par.caught], [2, 2, 2, 1, 0]); // g0 (no changes) still counts as a check
  assert.equal(exa.cost, 0.03); assert.equal(par.cost, 0.02);
  // The same runs aren't read twice.
  assert.equal(await t.p.poll(), 0);
  assert.equal(t.p.report().sources[0].providers.exa.runs, 1);
  t.store.close();
});
