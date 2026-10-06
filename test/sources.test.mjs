import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { parseIcs, parseJsonLd } from '../server/sources.mjs';

const soon = (days, hm = '19:30') => { const d = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); return { d, compact: d.replace(/-/g, ''), hm }; };

test('calendar feeds and schema.org event pages are parsed into events', () => {
  const a = soon(3), b = soon(5);
  const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=America/Los_Angeles:${a.compact}T193000\r\nSUMMARY:Sunset Run Club\\, 5K\r\nLOCATION:Griffith Observatory\\, Los Angeles\r\nURL:https://lu.ma/x\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${b.compact}\r\nSUMMARY:Art Walk\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  assert.deepEqual(parseIcs(ics).map(e => [e.title, e.date, e.time, e.address]), [['Sunset Run Club, 5K', a.d, '19:30', 'Griffith Observatory, Los Angeles'], ['Art Walk', b.d, '', undefined]]);
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"MusicEvent","name":"Jazz at the Lake","startDate":"${a.d}T20:00:00-07:00","location":{"@type":"Place","name":"Lake Hall","address":{"streetAddress":"1 Lake St","addressLocality":"Austin","addressRegion":"TX"}},"offers":{"price":"15"}}]}</script>`;
  assert.deepEqual(parseJsonLd(html).map(e => [e.title, e.date, e.time, e.venue, e.address, e.price]), [['Jazz at the Lake', a.d, '20:00', 'Lake Hall', '1 Lake St, Austin, TX', '$15']]);
});

test('a curated source is fetched (honoring robots.txt) and its events show up in searches near that city', async () => {
  const a = soon(2);
  const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:${a.compact}T190000\r\nSUMMARY:Rooftop Salsa Night\r\nLOCATION:The Deck\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const fetchImpl = async (url) => {
    if (url.includes('robots.txt')) return { ok: true, text: async () => 'User-agent: *\nDisallow: /private' };
    if (url.includes('geocode')) return { ok: true, status: 200, headers: new Map(), json: async () => ({ results: [{ geometry: { location: { lat: 30.27, lng: -97.74 } }, address_components: [{ long_name: 'Austin', short_name: 'Austin', types: ['locality'] }, { short_name: 'TX', types: ['administrative_area_level_1'] }] }] }) };
    return { ok: true, headers: new Map([['content-type', 'text/calendar']]), text: async () => ics };
  };
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', GOOGLE_MAPS_API_KEY: 'gk' }, { messages: { create: async () => ({}) } }, fetchImpl);
  const src = await sms.sources.add({ url: 'https://calendar.example.com/feed.ics', city: 'Austin, TX' });
  assert.equal(src.found, 1); assert.equal(src.kind, 'calendar feed'); assert.equal(src.error, null);
  const hits = sms.sources.near({ lat: 30.3, lng: -97.7 }, { what: 'salsa dancing', start: Date.now(), end: Date.now() + 7 * 86400000 });
  assert.equal(hits.length, 1); assert.equal(hits[0].short, 'Rooftop Salsa Night'); assert.match(hits[0].time, /7:00 PM/);
  assert.equal(sms.sources.near({ lat: 34.05, lng: -118.24 }, {}).length, 0); // not near LA
  await assert.rejects(sms.sources.add({ url: 'https://calendar.example.com/feed.ics', city: 'Austin, TX' }), /already/);
  const blocked = await sms.sources.add({ url: 'https://calendar.example.com/private/feed.ics', city: 'Austin, TX' });
  assert.match(blocked.error, /robots/);
  store.close();
});

test('robots.txt wildcards and Allow rules are honored', async () => {
  const { Sources } = await import('../server/sources.mjs');
  const s = Object.create(Sources.prototype); s.fetch = async () => ({ ok: true, text: async () => 'User-agent: *\nDisallow: */events/atom/*\nDisallow: /members/\nAllow: /members/public$\n' });
  const ok = p => s.allowed(new URL(`https://x.com${p}`));
  assert.equal(await ok('/la-hike/events/ical'), true); assert.equal(await ok('/la-hike/events/atom/x'), false);
  assert.equal(await ok('/members/1'), false); assert.equal(await ok('/members/public'), true);
});

test('pages without event data: linked calendar feeds, CivicPlus feeds and Localist APIs are used instead of AI', async () => {
  const a = soon(3), b = soon(4);
  const ics = t => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:${a.compact}T180000\r\nSUMMARY:${t}\r\nLOCATION:Town Hall\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const geo = { ok: true, status: 200, headers: new Map(), json: async () => ({ results: [{ geometry: { location: { lat: 41.82, lng: -71.41 } }, address_components: [], formatted_address: 'Providence, RI' }] }) };
  const pages = {
    'https://venue.example/events': { type: 'text/html', body: '<html><link rel="alternate" type="text/calendar" href="/cal/feed.ics"><p>Our shows</p></html>' },
    'https://venue.example/cal/feed.ics': { type: 'text/calendar', body: ics('Open Mic Night') },
    'https://city.example/calendar': { type: 'text/html', body: '<a href="/iCalendar.aspx">Subscribe</a>' },
    'https://city.example/iCalendar.aspx': { type: 'text/html', body: '<a href="/common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar">Parks</a>' },
    'https://city.example/common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar': { type: 'text/calendar', body: ics('Parks Movie Night') },
    'https://campus.example/': { type: 'text/html', body: '<script src="https://localist.example/x.js"></script>localist' },
    'https://campus.example/api/2/events?days=90&pp=100&page=1': { type: 'application/json', body: JSON.stringify({ events: [{ event: { title: 'Planetarium Show', location_name: 'Science Hall', address: '1 College St', free: true, localist_url: 'https://campus.example/event/x', geo: { latitude: '41.83', longitude: '-71.40', city: 'Providence', state: 'RI' }, description_text: 'Stars.', event_instances: [{ event_instance: { start: `${b.d}T19:30:00-04:00`, all_day: false } }] } }], page: { next_page: null } }) }
  };
  const fetchImpl = async url => {
    if (String(url).includes('robots.txt')) return { ok: false, text: async () => '' };
    if (String(url).includes('geocode')) return geo;
    const p = pages[url]; if (!p) return { ok: false, status: 404, headers: new Map(), text: async () => '', json: async () => ({}) };
    return { ok: true, status: 200, headers: new Map([['content-type', p.type]]), text: async () => p.body, json: async () => JSON.parse(p.body) };
  };
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', GOOGLE_MAPS_API_KEY: 'gk' }, { messages: { create: async () => ({}) } }, fetchImpl);
  const v = await sms.sources.add({ url: 'https://venue.example/events', city: 'Providence, RI' });
  assert.equal(v.found, 1); assert.equal(v.kind, 'calendar feed (found on page)');
  const c = await sms.sources.add({ url: 'https://city.example/calendar', city: 'Providence, RI' });
  assert.equal(c.found, 1);
  const l = await sms.sources.add({ url: 'https://campus.example/', city: 'Providence, RI' });
  assert.equal(l.found, 1); assert.equal(l.kind, 'Localist calendar');
  const titles = sms.sources.near({ lat: 41.82, lng: -71.41 }, { start: Date.now(), end: Date.now() + 7 * 86400000 }).map(e => e.short).sort();
  assert.deepEqual(titles, ['Open Mic Night', 'Parks Movie Night', 'Planetarium Show']);
  store.close();
});

test('the team can add and remove one-off events by hand', async () => {
  const a = soon(2);
  const geo = { ok: true, status: 200, headers: new Map(), json: async () => ({ results: [{ geometry: { location: { lat: 41.82, lng: -71.41 } }, address_components: [], formatted_address: 'Providence, RI' }] }) };
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', GOOGLE_MAPS_API_KEY: 'gk' }, { messages: { create: async () => ({}) } }, async () => geo);
  const list = await sms.sources.addEvent({ title: 'Secret Supper Club', date: a.d, time: '19:00', venue: 'A loft on Wickenden St', city: 'Providence, RI', price: '$65' });
  assert.equal(list.length, 1); assert.equal(list[0].title, 'Secret Supper Club');
  const hit = sms.sources.near({ lat: 41.82, lng: -71.41 }, { what: 'supper club', start: Date.now(), end: Date.now() + 7 * 86400000 });
  assert.equal(hit[0].source, 'Added by the team');
  assert.ok(!sms.sources.list().some(s => s.url.startsWith('rall-e:'))); // not shown as a feed
  assert.deepEqual(sms.sources.removeEvent(list[0].id), []);
  await assert.rejects(sms.sources.addEvent({ title: 'x', date: 'soon', city: 'Providence, RI' }), /Pick a date/);
  store.close();
});

test('rules: JSON events are mapped by path, dates read in any common form, and only public links are allowed', async () => {
  const { jsonEvents, whenOf, isPublicUrl, ruleUrl } = await import('../server/sources.mjs');
  const a = soon(4);
  assert.deepEqual(whenOf(`${a.d}T20:00:00-07:00`), { date: a.d, time: '20:00' });
  assert.deepEqual(whenOf(`${a.d} 19:15:00`), { date: a.d, time: '19:15' });
  assert.deepEqual(whenOf(`${a.d}T03:00:00Z`, -118.2), { date: new Date(Date.parse(`${a.d}T03:00:00Z`) - 7 * 3600000).toISOString().slice(0, 10), time: '20:00' }); // UTC moves to local
  assert.equal(whenOf(Date.parse(`${a.d}T03:00:00Z`), -118.2).time, '20:00'); // epoch ms
  assert.equal(whenOf(''), null); assert.equal(whenOf('soon'), null);
  const data = { upcoming: [{ title: 'Open <b>Mic</b>', startDate: `${a.d}T19:00:00-04:00`, location: { addressTitle: 'The Parlour' }, fullUrl: '/events/open-mic', assetUrl: 'https://img.example/x.jpg' }, { title: '', startDate: a.d }] };
  const rule = { type: 'json', url: '/events?format=json', items: 'upcoming', fields: { title: 'title', start: 'startDate', venue: 'location.addressTitle', url: 'fullUrl', image: 'assetUrl' } };
  assert.deepEqual(jsonEvents(data, rule, 'https://venue.example/events?format=json', -71).map(e => [e.title, e.date, e.time, e.venue, e.url]), [['Open Mic', a.d, '19:00', 'The Parlour', 'https://venue.example/events/open-mic']]);
  assert.throws(() => jsonEvents(data, { ...rule, items: 'nope' }, 'https://x.example', -71), /No list at "nope"/);
  for (const bad of ['http://localhost/x', 'http://169.254.169.254/latest', 'http://10.0.0.5/', 'http://192.168.1.1', 'http://172.20.0.1', 'http://[::1]/', 'file:///etc/passwd', 'http://intranet/', 'http://db.internal/']) assert.equal(isPublicUrl(bad), false, bad);
  assert.equal(isPublicUrl('https://www.lapl.org/whats-on/events'), true);
  assert.match(ruleUrl('/wp-json/tribe/events/v1/events?start_date={today}&end_date={end}', 'https://venue.example/events/'), /^https:\/\/venue\.example\/wp-json\/tribe\/events\/v1\/events\?start_date=\d{4}-\d{2}-\d{2}&end_date=\d{4}-\d{2}-\d{2}$/);
});

test('a source that reads 0 or 1 events gets a debugging run (twice at most) that saves a rule the next refresh uses', async () => {
  const a = soon(3), b = soon(6);
  const api = { events: [{ name: 'Trivia Night', start: `${a.d} 19:00:00` }, { name: 'Vinyl Swap', start: `${b.d} 12:00:00` }] };
  const pages = { 'https://venue.example/events': '<html><body><div id="app">Loading…</div><script src="/app.js"></script></body></html>', 'https://venue.example/app.js': 'fetch("/api/events.json").then(r=>r.json())', 'https://venue.example/api/events.json': JSON.stringify(api) };
  const fetchImpl = async (url) => {
    if (url.includes('robots.txt')) return { ok: false, text: async () => '' };
    if (url.includes('geocode')) return { ok: true, status: 200, headers: new Map(), json: async () => ({ results: [{ geometry: { location: { lat: 42.36, lng: -71.06 } }, address_components: [{ long_name: 'Boston', short_name: 'Boston', types: ['locality'] }, { long_name: 'Massachusetts', short_name: 'MA', types: ['administrative_area_level_1'] }] }] }) };
    if (url in pages) return { ok: true, status: 200, url, headers: new Map([['content-type', url.endsWith('.json') ? 'application/json' : url.endsWith('.js') ? 'application/javascript' : 'text/html']]), text: async () => pages[url] };
    return { ok: false, status: 404, headers: new Map(), text: async () => '' };
  };
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', GOOGLE_MAPS_API_KEY: 'gk' }, { messages: { create: async () => ({}) } }, fetchImpl);
  // A scripted "smarter agent": inspect the page, then the script, then save the API as a rule.
  const agent = sms.flow.agent, script = [
    { type: 'tool_use', id: 't1', name: 'inspect', input: { url: 'https://venue.example/events' } },
    { type: 'tool_use', id: 't2', name: 'find', input: { url: '/app.js', text: 'fetch(' } },
    { type: 'tool_use', id: 't3', name: 'save_rule', input: { rule: { type: 'json', url: '/api/events.json', items: 'events', fields: { title: 'name', start: 'start' } }, note: 'Events load from /api/events.json after the page opens.' } }];
  const seen = [];
  agent.key = 'test-key';
  agent.fetch = async (url, init) => { const body = JSON.parse(init.body); seen.push(body); const step = script[seen.length - 1]; return { ok: true, headers: new Map(), json: async () => ({ content: [step], usage: {} }) }; };
  sms.sources.extract = async () => []; // the page text itself has no events (AI reading finds none)
  const src = await sms.sources.add({ url: 'https://venue.example/events', city: 'Boston, MA' });
  assert.equal(src.found, 0);
  await sms.sources.debugChain;
  assert.equal(seen[0].model, 'claude-opus-5-5');
  assert.match(JSON.stringify(seen[1].messages.at(-1)), /Scripts: \/app\.js/); // inspect showed the script
  assert.match(JSON.stringify(seen[2].messages.at(-1)), /fetch\(\\"\/api\/events\.json\\"\)/);
  const fixed = sms.sources.list()[0];
  assert.equal(fixed.found, 2); assert.equal(fixed.rule, 'JSON API'); assert.equal(fixed.kind, 'JSON API (saved rule)'); assert.match(fixed.debug_note, /api\/events\.json/);
  assert.equal(fixed.debug_tries, 1);
  // Never on a loop: twice at most, unless someone asks again from /ops.
  store.db.prepare('UPDATE event_sources SET found=0, debug_tries=2').run();
  assert.equal(sms.sources.debugLater(fixed.id), false);
  seen.length = 0; script.splice(0, 3, { type: 'tool_use', id: 'g1', name: 'give_up', input: { reason: 'Only shows events in a real browser.' } });
  assert.equal(sms.sources.debugLater(fixed.id, { force: true }), true);
  await sms.sources.debugChain;
  assert.match(sms.sources.list()[0].debug_note, /real browser/);
  store.close();
});

test('a "browser" rule reads the page as rendered; with no renderer installed it fails cleanly', async () => {
  const a = soon(5), store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai' }, { messages: { create: async () => ({}) } },
    async url => url.includes('robots.txt') ? { ok: false, text: async () => '' } : Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3108')));
  const src = { id: null, url: 'https://venue.example/', lng: -118, city: 'Los Angeles, CA' }, rule = { type: 'browser', url: 'https://venue.example/' };
  await assert.rejects(sms.sources.ruleEvents(rule, src), /page browser isn't running/);
  assert.equal(await sms.sources.renderAvailable(), false);
  sms.sources.render = async url => ({ status: 200, url, responses: [], html: `<script type="application/ld+json">{"@type":"MusicEvent","name":"Late Show","startDate":"${a.d}T21:00:00-07:00"}</script>` });
  assert.deepEqual((await sms.sources.ruleEvents(rule, src)).map(e => [e.title, e.date, e.time]), [['Late Show', a.d, '21:00']]);
  sms.sources.render = async () => ({ status: 403, url: 'https://venue.example/', responses: [], html: '' });
  await assert.rejects(sms.sources.ruleEvents(rule, src), /answered 403/);
  store.close();
});

test('once the page browser is installed, sources whose debugging runs never had it get one more run', async () => {
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai' }, { messages: { create: async () => ({}) } }, async () => ({ ok: false, status: 404, text: async () => '' }));
  const add = (id, found, tries, browser, error = null) => store.db.prepare('INSERT INTO event_sources (id, url, name, city, created, found, debug_tries, debug_browser, error) VALUES (?,?,?,?,?,?,?,?,?)').run(id, `https://${id}.example/`, id, 'LA', 1, found, tries, browser, error);
  add('needsbrowser', 0, 2, 0); add('hadbrowser', 0, 2, 1); add('fine', 12, 2, 0); add('blocked', 0, 2, 0, 'This site asks bots not to read that page (robots.txt).'); add('fresh', 1, 0, 0);
  const queued = []; sms.sources.debugLater = (id, opts) => queued.push([id, Boolean(opts?.force)]);
  sms.sources.renderAvailable = async () => false;
  await sms.sources.sweepDebug();
  assert.deepEqual(queued, [['fresh', false]]); // without a browser: only the usual tries
  queued.length = 0; sms.sources.renderAvailable = async () => true;
  await sms.sources.sweepDebug();
  assert.deepEqual(queued.sort(), [['fresh', false], ['needsbrowser', true]]);
  store.close();
});

test('sites that forbid bots (Bookeo, DICE, Resident Advisor) are never read, added, rendered or used in a rule', async () => {
  const { botsForbidden } = await import('../server/publicurl.mjs');
  for (const u of ['https://bookeo.com/escaperoomla', 'https://www-1568p.bookeo.com/bookeo/b_x_start.html', 'https://dice.fm/venue/zebulon', 'https://partners-endpoint.dice.fm/api/v2/events', 'https://ra.co/events/us/losangeles']) assert.equal(botsForbidden(u), true, u);
  for (const u of ['https://www.escaperoomla.com/book-now', 'https://www.zebulon.la/', 'https://notbookeo.com/']) assert.equal(botsForbidden(u), false, u);
  const store = new Store(':memory:'), seen = [];
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', GOOGLE_MAPS_API_KEY: 'gk' }, { messages: { create: async () => ({}) } }, async url => { seen.push(url); return { ok: false, status: 404, text: async () => '' }; });
  await assert.rejects(sms.sources.add({ url: 'https://bookeo.com/escaperoomla', city: 'Los Angeles, CA' }), /forbids automated access/);
  await assert.rejects(sms.sources.ruleEvents({ type: 'browser', url: 'https://bookeo.com/escaperoomla' }, { url: 'https://www.escaperoomla.com/', city: 'LA' }), /forbids automated access/);
  const { SourceDebugger } = await import('../server/sourcedebug.mjs'), dbg = new SourceDebugger(sms.sources);
  assert.match(await dbg.inspect('https://www-1568p.bookeo.com/bookeo/b_x_start.html', { fetches: 0 }), /forbids automated access/);
  assert.match(await dbg.find('https://widgets.dice.fm/x.js', 'fetch(', { fetches: 0 }), /forbids bots/);
  assert.ok(!seen.some(u => /bookeo|dice\.fm/.test(u)), 'nothing was fetched from those sites');
  store.close();
});

test('Try to fix says what it is doing, and each run records an outcome /ops can explain', async () => {
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', SOURCE_DEBUG_DAILY: '1', SOURCE_DEBUG_MANUAL: '2' }, { messages: { create: async () => ({}) } }, async () => ({ ok: false, status: 404, text: async () => '' }));
  const add = id => store.db.prepare('INSERT INTO event_sources (id, url, name, city, created, found, debug_tries) VALUES (?,?,?,?,?,0,2)').run(id, `https://${id}.example/`, id, 'LA', 1);
  add('escape'); add('other'); add('third');
  sms.sources.refresh = async () => ({}); // only the debugging outcome matters here
  assert.match(sms.sources.tryToFix('escape').message, /AI isn't set up/); // no AI key yet
  sms.flow.agent.key = 'k';
  const outcomes = { escape: { note: 'Its schedule is a Bookeo widget; Bookeo forbids bots.', cause: 'forbidden_site' }, other: { saved: true, note: 'Events come from /api/events.json.' } };
  sms.sources.debugger = { run: async id => outcomes[id] };
  // Background runs use up their own allowance, never the button's.
  store.db.prepare("INSERT INTO source_debug_runs (source, at, manual) VALUES ('x', ?, 0)").run(Date.now() - 3600000);
  assert.equal(sms.sources.debugLater('escape', { force: true }), false);
  assert.match(sms.sources.debugBlocker({ id: 'escape', url: 'https://e.example/' }, true), /automatic checks used their 1 for the last 24 hours \(more in about 23 hours\)/);
  const first = sms.sources.tryToFix('escape');
  assert.deepEqual(first, { queued: true, message: 'Trying now. It takes about a minute. (1 Try to fix left in the last 24 hours.)' });
  assert.match(sms.sources.tryToFix('escape').message, /already being checked/);
  assert.match(sms.sources.tryToFix('other').message, /Queued behind 1 other check/);
  assert.match(sms.sources.tryToFix('third').message, /Try to fix has been used 2 times in the last 24 hours. Another one frees up in about 24 hours./);
  await sms.sources.debugChain;
  const row = id => sms.sources.list().find(s => s.id === id);
  assert.equal(row('escape').debug_cause, 'forbidden_site'); assert.match(row('escape').debug_note, /Bookeo/); assert.ok(row('escape').debug_done > 0); assert.equal(row('escape').debugging, false);
  assert.equal(row('other').debug_cause, 'fixed');
  store.close();
});

test('a failure on our side (AI reader, page browser) keeps the events, says it is ours, and retries within the hour', async () => {
  const store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai' }, { messages: { create: async () => ({}) } },
    async url => url.includes('robots.txt') ? { ok: false, text: async () => '' } : { ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => '<p>Shows every Friday</p>' });
  store.db.prepare("INSERT INTO event_sources (id, url, name, city, created, found) VALUES ('viper', 'https://viper.example/', 'The Viper Room', 'LA', 1, 7)").run();
  sms.flow.agent.key = 'k'; let debugged = 0; sms.sources.debugLater = () => { debugged++; return true; };
  sms.sources.extract = async () => { throw new Error('AI reader: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.'); };
  const before = Date.now(), r = await sms.sources.refresh('viper');
  const row = store.db.prepare("SELECT * FROM event_sources WHERE id='viper'").get();
  assert.equal(r.found, 7); assert.equal(row.found, 7); // events kept
  assert.match(row.error, /^Rall-e had a problem reading this, on our side \(not the site's\)\. It retries within the hour\. Details: AI reader: .*workspace to use\.$/); // whole message, not cut off
  assert.ok(row.fetched <= before - 11 * 3600000 + 5000); // due again at the next hourly check
  assert.equal(debugged, 0);
  store.close();
});
