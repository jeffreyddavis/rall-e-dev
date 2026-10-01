import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Sms } from '../server/sms.mjs';

const geo = (lat, lng, label) => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ results: [{ geometry: { location: { lat, lng } }, address_components: [], formatted_address: label }], places: [] }) });
function setup() {
  const store = new Store(':memory:');
  const fetchImpl = async url => String(url).includes('places:searchText') ? { ok: true, status: 200, headers: new Map(), json: async () => ({ places: [] }) } : geo(41.82, -71.41, 'Providence, RI');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', GOOGLE_MAPS_API_KEY: 'gk' }, { messages: { create: async () => ({}) } }, fetchImpl);
  return { store, sms };
}
const [A, B] = ['+13107770941', '+13107770942'];

test('tips go to the Ideas inbox; only approved gems reach the agent', async () => {
  const { store, sms } = setup();
  const gem = sms.ideas.add(A, { kind: 'gem', title: 'Nick-A-Nees', city: 'Providence, RI', note: 'best free bluegrass on Tuesdays' });
  sms.ideas.add(A, { kind: 'feedback', title: 'It suggested a closed farm' });
  assert.equal(sms.ideas.list().length, 2); assert.equal(sms.ideas.list()[0].status, 'new');
  assert.deepEqual(sms.ideas.gemsNear({ lat: 41.82, lng: -71.41 }), []); // not approved yet
  await sms.ideas.update(gem.id, { status: 'approved', teamNote: 'Love it' });
  assert.match(sms.ideas.gemsNear({ lat: 41.82, lng: -71.41 })[0], /Nick-A-Nees \(best free bluegrass on Tuesdays\), recommended by/);
  await assert.rejects(sms.ideas.update(gem.id, { status: 'maybe' }), /Unknown status/);
  store.close();
});

test('favorites: a top-5 list with a public page, visible to connected friends near that city', async () => {
  const { store, sms } = setup(), db = store.db;
  db.prepare("INSERT INTO sms_threads (phone, digest, plan, participant, role, muted, updated) VALUES (?, 'd1', 'p1', '', 'host', 0, ?), (?, 'd1', 'p1', ?, 'guest', 0, ?)").run(A, Date.now(), B, B, Date.now());
  const v = await sms.favorites.set(A, { category: 'Coffee', city: 'Providence, RI', places: [{ name: 'Bolt Coffee', note: 'the cortado' }, 'Dave’s Coffee'] });
  assert.equal(v.category, 'coffee'); assert.equal(v.items.length, 2); assert.match(v.url, /\/f\/[\w-]+$/);
  assert.deepEqual(sms.favorites.view(v.url.split('/').pop()).items.map(i => i.name), ['Bolt Coffee', 'Dave’s Coffee']);
  assert.match(sms.favorites.friendsNear(B, { lat: 41.82, lng: -71.41 })[0], /#1 coffee in Providence: Bolt Coffee \(the cortado\)/);
  assert.deepEqual(sms.favorites.friendsNear(B, { lat: 34.05, lng: -118.24 }), []); // other city
  assert.equal(sms.favorites.remove(A, 'coffee'), 1);
  assert.throws(() => sms.favorites.view(v.url.split('/').pop()), /isn’t available/);
  store.close();
});
