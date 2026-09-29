import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';
import { eventById } from '../server/catalog.mjs';

const ME = '+13105550101', MIKE = '+13105550102';
const TM = { _embedded: { events: [{ id: 'G5vYZ9', name: 'Jazz Night', url: 'https://tm.example/jazz', dates: { start: { localDate: '2026-10-03', localTime: '20:00:00', dateTime: '2026-10-04T00:00:00Z' } },
  priceRanges: [{ min: 25, max: 60 }], classifications: [{ segment: { name: 'Music' }, genre: { name: 'Jazz' } }], _embedded: { venues: [{ name: 'Blue Room', city: { name: 'Akron' }, state: { stateCode: 'OH' }, address: { line1: '1 Main St' } }] } }] } };
const SG = { events: [{ id: 99, short_title: 'Jazz Night', title: 'Jazz Night', datetime_local: '2026-10-03T20:00:00', datetime_utc: '2026-10-04T00:00:00', type: 'concert', url: 'https://sg.example/jazz', stats: { lowest_price: 30 }, venue: { name: 'Blue Room', city: 'Akron', state: 'OH' } },
  { id: 100, short_title: 'Rubber Ducks vs. Seawolves', datetime_local: '2026-10-04T13:05:00', datetime_utc: '2026-10-04T17:05:00', type: 'minor_league_baseball', url: 'https://sg.example/ducks', stats: { lowest_price: 12 }, venue: { name: 'Canal Park', city: 'Akron', state: 'OH' } }] };
const GP = { places: [{ id: 'ChIJabc', displayName: { text: 'Luigi’s' }, formattedAddress: '105 N Main St, Akron, OH', shortFormattedAddress: '105 N Main St', rating: 4.6, userRatingCount: 2100, priceLevel: 'PRICE_LEVEL_MODERATE', primaryTypeDisplayName: { text: 'Italian Restaurant' }, googleMapsUri: 'https://maps.example/luigis', editorialSummary: { text: 'Classic Italian since 1949.' } }] };
const GEO = { results: [{ geometry: { location: { lat: 41.0814, lng: -81.519 } }, formatted_address: 'Akron, OH, USA', address_components: [{ long_name: 'Akron', types: ['locality'] }, { short_name: 'OH', long_name: 'Ohio', types: ['administrative_area_level_1'] }] }] };

function setup(env = {}, extra = {}) {
  const store = new Store(':memory:'), calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const reply = url.includes('ticketmaster') ? TM : url.includes('seatgeek') ? SG : url.includes('places.googleapis') ? GP : url.includes('geocode') ? GEO : extra.anthropic?.(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => reply };
  };
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0',
    TICKETMASTER_API_KEY: 'tm', SEATGEEK_CLIENT_ID: 'sg', GOOGLE_MAPS_API_KEY: 'gk', ...env }, { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, fetchImpl);
  return { store, sms, d: sms.discovery, calls };
}

test('search merges Ticketmaster, SeatGeek and Google Places near a geocoded location, de-duplicating the same event', async () => {
  const t = setup();
  const loc = t.d.saveLocation(ME, await t.d.geocode('44308'));
  assert.equal(loc.label, 'Akron, OH'); assert.equal(loc.lat, 41.0814);
  const found = await t.d.search(loc, { what: 'fun', days: 7 });
  assert.deepEqual(found.map(e => e.short), ['Jazz Night', 'Rubber Ducks vs. Seawolves', 'Luigi’s']);
  const [jazz, ducks, luigi] = found;
  assert.equal(jazz.source, 'Ticketmaster'); assert.equal(jazz.time, 'Sat, Oct 3 · 8:00 PM'); assert.equal(jazz.priceText, '$25–$60'); assert.equal(jazz.area, 'Akron, OH');
  assert.equal(ducks.priceText, 'from $12'); assert.equal(luigi.priceText, '$$'); assert.equal(luigi.category, 'dinner'); assert.equal(luigi.color, 'dinner');
  const tm = new URL(t.calls.find(c => c.url.includes('ticketmaster')).url);
  assert.equal(tm.searchParams.get('latlong'), '41.0814,-81.519'); assert.equal(tm.searchParams.get('radius'), '25');
  const gp = t.calls.find(c => c.url.includes('places.googleapis')); assert.equal(gp.init.headers['X-Goog-Api-Key'], 'gk'); assert.match(JSON.parse(gp.init.body).textQuery, /near Akron, OH/);
  assert.equal(eventById(jazz.id).short, 'Jazz Night'); // registered so plans can use it
  t.store.close();
});

test('a real listing can become the plan, show on the web view, and survive a restart', async () => {
  const t = setup();
  const [jazz] = await t.d.search(t.d.saveLocation(ME, await t.d.geocode('Akron')), {});
  const { id } = t.store.create('Jeff');
  t.store.hostAction(id, 'city', { label: 'Akron, OH' }); t.store.hostAction(id, 'accept', { eventId: jazz.id });
  const view = t.store.view(t.store.get(id));
  assert.equal(view.city, 'Akron, OH'); assert.equal(view.plan.title, 'Jazz Night'); assert.ok(view.events.some(e => e.id === jazz.id && e.url === 'https://tm.example/jazz'));
  t.store.close();
});

test('one-tap location links save a rounded location once, then expire', async () => {
  const t = setup();
  const token = t.d.locationLink(ME).split('/l/')[1];
  const { phone, location } = await t.d.shareLocation(token, 41.08143219, -81.51901234);
  assert.equal(phone, ME); assert.equal(location.lat, 41.081); assert.equal(location.lng, -81.519); assert.equal(location.source, 'gps');
  assert.equal(t.d.location(ME).label, 'Akron, OH');
  await assert.rejects(t.d.shareLocation(token, 41, -81), /expired/);
  t.store.close();
});

test('the agent asks for location, saves it, searches real listings and plans one', async () => {
  let step = 0;
  const say = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
  const use = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu${step}`, name, input }] });
  const script = [
    use('start_account', { first_name: 'Jeff' }), body => { assert.match(body.system, /Location: unknown/); assert.ok(body.tools.some(x => x.name === 'find_things')); assert.ok(!body.tools.some(x => x.name === 'recommend')); assert.ok(!/Casa Vera/.test(body.system)); return say('Hi Jeff! Where are you based?'); },
    use('set_location', { place: '44308' }), use('find_things', { what: 'live music', days: 7 }), body => { const r = body.messages.at(-1).content[0].content; assert.match(r, /Jazz Night — Blue Room, Akron, OH\. Sat, Oct 3 · 8:00 PM\. \$25–\$60/); return say('Jazz Night at the Blue Room Sat 8 PM ($25–60) — want it?'); },
    body => { assert.doesNotMatch(JSON.stringify(body.messages), /tm_/); return use('make_plan', { event_id: /(tm_[\w-]+): Jazz/.exec(body.system)[1] }); }, say('Done! Who should I invite?')
  ];
  const t = setup({ ANTHROPIC_API_KEY: 'k' }, { anthropic: body => { step++; const next = script.shift(); return typeof next === 'function' ? next(body) : next; } });
  await t.sms.simulate(ME, "hi I'm Jeff");
  await t.sms.simulate(ME, "I'm in 44308, anything fun with live music this week?");
  await t.sms.simulate(ME, 'yes the jazz one');
  const thread = t.sms.flow.threadsFor(ME)[0];
  assert.equal(thread.s.plan.title, 'Jazz Night'); assert.equal(thread.s.city, 'Akron, OH');
  assert.equal(t.d.location(ME).label, 'Akron, OH');
  t.store.close();
});

test('link-preview images render with the frosted caption, and page tags point at them', async () => {
  const { OgImages } = await import('../server/og.mjs').catch(() => ({}));
  if (!OgImages) return; // renderer not installed in this environment (Windows dev copy); deploy runs it on Linux
  const og = new OgImages(async () => ({ ok: false, headers: new Map() }));
  const png = await og.render({ id: 'x1', short: 'Jazz Night at the Blue Room with a Very Long Title That Wraps', time: 'Sat, Oct 3 · 8:00 PM', venue: 'Blue Room', color: 'rooftop' });
  assert.deepEqual([...png.subarray(0, 3)], [0xff, 0xd8, 0xff]); assert.ok(png.length > 10000 && png.length < 400000); // JPEG, small enough for iMessage
  assert.equal(await og.render({ id: 'x1', short: 'Jazz Night at the Blue Room with a Very Long Title That Wraps', time: 'Sat, Oct 3 · 8:00 PM', venue: 'Blue Room', color: 'rooftop' }), png); // cached
});

test('movies come from Gracenote showtimes: what is playing, at which nearby theater, and when', async () => {
  const { Discovery } = await import('../server/discovery.mjs');
  const later = new Date(Date.now() + 3 * 3600000), day = later.toISOString().slice(0, 10), hh = n => String(n).padStart(2, '0');
  const at = h => `${day}T${hh(h)}:15`, calls = [];
  const GN = [{ tmsId: 'MV1', title: 'Big Space Movie', genres: ['Sci-Fi'], runTime: 'PT02H10M', ratings: [{ body: 'Motion Picture Association', code: 'PG-13' }], shortDescription: 'Astronauts, feelings.', preferredImage: { uri: 'assets/p1_v_v5_aa.jpg' },
    showtimes: [{ theatre: { id: 't1', name: 'AMC The Grove 14' }, dateTime: at(22), ticketURI: 'https://tickets.example/1' }, { theatre: { id: 't1', name: 'AMC The Grove 14' }, dateTime: at(23) }, { theatre: { id: 't2', name: 'Far Away Cinema' }, dateTime: at(22) }] }];
  const store = new Store(':memory:');
  const d = new Discovery(store, { GRACENOTE_API_KEY: 'gn-key', PUBLIC_BASE_URL: 'https://rall-e.ai' }, async url => { calls.push(url); return { ok: true, status: 200, json: async () => GN }; });
  const found = await d.search({ label: 'Los Angeles, CA', lat: 34.07, lng: -118.36 }, { what: 'what movies are playing this weekend' });
  assert.equal(found.length, 1); const e = found[0];
  assert.equal(e.short, 'Big Space Movie'); assert.equal(e.venue, 'AMC The Grove 14'); assert.equal(e.source, 'Gracenote');
  assert.match(e.description, /PG-13 · 2h 10m.*Showtimes at AMC The Grove 14: 10:15pm, 11:15pm/); assert.equal(e.url, 'https://tickets.example/1');
  assert.match(calls[0], /data\.tmsapi\.com\/v1\.1\/movies\/showings\?.*lat=34\.07/); assert.equal(e.image, `https://rall-e.ai/img/p/${e.id}`); assert.ok(!e.image.includes('gn-key'));
  store.close();
});

test('movies via SerpApi: nearby theaters from Places, each theater’s showtimes cached, past shows dropped', async () => {
  const { Discovery } = await import('../server/discovery.mjs');
  const calls = [];
  const PL = { places: [{ id: 'T1', displayName: { text: 'AMC Century City 15' }, formattedAddress: '10250 Santa Monica Blvd, Los Angeles, CA 90067, USA', primaryTypeDisplayName: { text: 'Movie theater' }, photos: [{ name: 'places/T1/photos/P1' }], googleMapsUri: 'https://maps.example/t1' }] };
  const SHOW = { showtimes: [{ day: 'Today', movies: [{ name: 'Primetime', link: 'https://g.example/p', showing: [{ time: ['12:01am'], type: 'Standard' }] }] },
    { day: 'Tomorrow', movies: [{ name: 'Primetime', link: 'https://g.example/p', showing: [{ time: ['7:00pm', '9:40pm'], type: 'Standard' }, { time: ['8:00pm'], type: 'IMAX' }] }, { name: 'Other Film', showing: [{ time: ['6:00pm'] }] }] }] };
  const POSTERS = { knowledge_graph: { movies_playing: [{ name: 'Primetime', image: 'https://serpapi.example/p.jpg' }] } };
  const fetchImpl = async (url, init) => { calls.push(String(url)); const body = String(url).includes('places.googleapis') ? PL : String(url).includes('movies+playing') ? POSTERS : SHOW; return { ok: true, status: 200, json: async () => body }; };
  const store = new Store(':memory:'), d = new Discovery(store, { SERP_API_KEY: 'sk', GOOGLE_MAPS_API_KEY: 'gk', PUBLIC_BASE_URL: 'https://rall-e.ai' }, fetchImpl);
  const loc = { label: 'Beverly Hills, CA', lat: 34.07, lng: -118.4 };
  const found = await d.search(loc, { what: 'primetime movie' });
  assert.ok(found.length >= 1); const e = found[0];
  assert.equal(e.short, 'Primetime'); assert.equal(e.venue, 'AMC Century City 15'); assert.equal(e.thumb, 'https://serpapi.example/p.jpg'); assert.equal(e.image, `https://rall-e.ai/img/p/${e.id}`);
  assert.ok(found.every(x => x.short === 'Primetime')); // narrowed to the film they named
  assert.match(e.description, /^Showtimes at AMC Century City 15 .*7:00pm, 8:00pm \(IMAX\), 9:40pm\.$/); assert.equal(e.url, 'https://g.example/p'); assert.deepEqual(e.showtimes, ['7:00pm', '8:00pm (IMAX)', '9:40pm']);
  const serpCalls = calls.filter(u => u.includes('serpapi.com')).length;
  await d.search(loc, { what: 'primetime movie' }); assert.equal(calls.filter(u => u.includes('serpapi.com')).length, serpCalls); // cached
  store.close();
});

test('a second search keeps the first search’s options available (newest first)', async () => {
  const { Discovery } = await import('../server/discovery.mjs');
  const { registerEvent } = await import('../server/catalog.mjs');
  const store = new Store(':memory:'), d = new Discovery(store, {}, async () => ({ ok: true, json: async () => ({}) }));
  const ev = id => registerEvent({ id, short: id, venue: 'V', time: 'Tonight', priceText: '$34', description: 'x', source: 'Ticketmaster' });
  d.remember(ME, [ev('tm_a'), ev('tm_b')]); d.remember(ME, [ev('tm_c')]);
  assert.deepEqual(d.recent(ME).map(e => e.id), ['tm_c', 'tm_a', 'tm_b']);
  store.close();
});
