import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeEvents, mixMusic, sameEvent, overlap } from '../server/merge.mjs';

const ev = (id, source, short, venue, extra = {}) => ({ id, source, short, venue, kind: 'event', localDate: '2026-10-09', priceText: 'See listing', price: null, ...extra });

test('the same show from several sources becomes one event with the best of each', () => {
  assert.equal(overlap('Khruangbin', 'Khruangbin with Men I Trust'), 1);
  const jb = ev('jb_1', 'JamBase', 'Khruangbin', 'The Wiltern', { capacity: 1850, image: 'https://jb/img.jpg', url: 'https://jambase/x', lat: 34.0616, lng: -118.3087 });
  const tm = ev('tm_1', 'Ticketmaster', 'Khruangbin with Men I Trust', 'Wiltern', { price: 55, priceText: '$55–$95', url: 'https://ticketmaster/k', startsAt: '2026-10-10T03:00:00Z' });
  const other = ev('tm_2', 'Ticketmaster', 'Khruangbin', 'The Wiltern', { localDate: '2026-10-10' }); // next night: a different show
  const elsewhere = ev('jb_2', 'JamBase', 'Khruangbin', 'Hollywood Bowl'); // same day, other venue
  const [k, ...rest] = mergeEvents([jb, tm, other, elsewhere]);
  assert.equal(rest.length, 2);
  assert.equal(k.id, 'tm_1'); assert.deepEqual(k.sources, ['JamBase', 'Ticketmaster']); assert.equal(k.source, 'Ticketmaster (also JamBase)');
  assert.equal(k.priceText, '$55–$95'); assert.equal(k.url, 'https://ticketmaster/k'); // tickets and price from Ticketmaster
  assert.equal(k.capacity, 1850); assert.equal(k.image, 'https://jb/img.jpg'); assert.equal(k.lat, 34.0616); // venue size and image from JamBase
  assert.equal(k.localDate, '2026-10-09'); // local day, not the UTC date of the start time
  assert.equal(sameEvent({ ...jb, kind: 'place' }, tm), false);
});

test('live music mixes small and big shows from every source instead of one source\'s list', () => {
  const big = e => (e.capacity || 0) >= 3000;
  const jam = Array.from({ length: 10 }, (_, i) => ev(`jb${i}`, 'JamBase', `Local Band ${i}`, `Club ${i}`, { capacity: 300 }));
  const tm = [ev('tm1', 'Ticketmaster', 'Big Name', 'Arena', { capacity: 18000, price: 80, priceText: '$80' }), ev('tm2', 'Ticketmaster', 'Indie Act', 'Small Room', { capacity: 500, price: 25, priceText: '$25' })];
  const cur = [ev('cs1', 'Echo Park Library', 'Jazz Trio', 'Library')];
  const top = mixMusic([...jam, ...tm, ...cur], { big }).slice(0, 6);
  assert.deepEqual(new Set(top.map(e => e.source)), new Set(['JamBase', 'Ticketmaster', 'Echo Park Library']));
  assert.ok(top.some(e => e.id === 'tm1'), 'a big name makes the top'); assert.equal(top[0].priceText, '$25'); // priced listings lead their source
  assert.equal(top.filter(e => e.source === 'JamBase').length <= 3, true);
});
