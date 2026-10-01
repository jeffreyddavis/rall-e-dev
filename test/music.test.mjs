import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIG_VENUE } from '../server/discovery.mjs';

test('big venues are told apart from local music spots', () => {
  for (const v of ['Hollywood Bowl', 'Amica Mutual Pavilion', 'Crypto.com Arena', 'Providence Performing Arts Center', 'Bally\'s Twin River Casino']) assert.ok(BIG_VENUE.test(v), v);
  for (const v of ['The Parlour', 'AS220', 'Nick-A-Nees', 'The Met', 'Alchemy', 'The Newport Blues Cafe', 'Knickerbocker Music Center']) assert.ok(!BIG_VENUE.test(v), v);
});

test('JamBase concerts: local gigs ranked above arena shows, cached, and attributed', async () => {
  const { Store } = await import('../server/store.mjs');
  const { Discovery } = await import('../server/discovery.mjs');
  const store = new Store(':memory:'); let calls = 0;
  const venue = (name, cap) => ({ name, maximumAttendeeCapacity: cap, address: { addressLocality: 'Providence', addressRegion: { alternateName: 'RI' } }, geo: { latitude: 41.82, longitude: -71.41 } });
  const events = [
    { identifier: 'jambase:1', name: 'Kelly Clarkson at Amica Mutual Pavilion', startDate: '2026-10-03T20:00:00', location: venue('Amica Mutual Pavilion', 14000), offers: [] },
    { identifier: 'jambase:2', name: 'Shubh Saran at The Parlour', startDate: '2026-10-03T20:00:00', location: venue('The Parlour', 85), offers: [{ url: 'https://tix.example/2', priceSpecification: { price: '15.00' } }], performer: [{ name: 'Shubh Saran' }, { name: 'Snooze' }] }
  ];
  const fetchImpl = async url => { if (String(url).includes('jambase')) calls++; return { ok: true, status: 200, headers: new Headers(), json: async () => String(url).includes('jambase') ? { events } : {} }; };
  const d = new Discovery(store, { JAMBASE_KEY: 'k' }, fetchImpl);
  const loc = { lat: 41.824, lng: -71.4128, label: 'Providence, RI' };
  const r = await d.search(loc, { what: 'live music', category: 'music', date: '2026-10-02', end_date: '2026-10-04' });
  assert.deepEqual(r.map(e => e.short), ['Shubh Saran', 'Kelly Clarkson']);
  assert.equal(r[0].venue, 'The Parlour'); assert.equal(r[0].priceText, '$15'); assert.match(r[0].description, /via JamBase/);
  await d.search(loc, { what: 'live music', category: 'music', date: '2026-10-02', end_date: '2026-10-04' });
  assert.equal(calls, 1); // second search served from cache
  store.close();
});
