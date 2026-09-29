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
