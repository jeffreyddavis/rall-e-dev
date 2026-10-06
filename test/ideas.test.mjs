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

test('the core team can add sources and ideas by text, straight in; other members can\'t', async () => {
  const { Store } = await import('../server/store.mjs'), { Sms } = await import('../server/sms.mjs');
  const TEAM = '+13107770931', MEMBER = '+13107770932', store = new Store(':memory:');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'a-test-presenter-password-over-24', PUBLIC_BASE_URL: 'https://rall-e.ai', SMS_SEND_SPACING_MS: '0', SMS_ALLOWED_RECIPIENTS: TEAM },
    { messages: { create: async () => ({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }) } }, async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) }));
  sms.allowed.add(MEMBER); // opted in later: a member, not the team
  const agent = sms.flow.agent, names = phone => agent.tools({ role: 'host', threads: [], phone }).map(t => t.name);
  assert.ok(names(TEAM).includes('add_source') && names(TEAM).includes('add_idea'));
  assert.ok(!names(MEMBER).includes('add_source') && !names(MEMBER).includes('add_idea'));
  assert.match(await agent.run(MEMBER, 'add_idea', { kind: 'feature', title: 'x' }, { t: null }, 'idea: x'), /only the Rall-e team/);
  assert.match(await agent.run(TEAM, 'add_idea', { kind: 'feature', title: 'Dark mode for plan pages', note: 'Marc asked' }, { t: null }, 'idea: dark mode'), /Added to the team list/);
  const idea = sms.ideas.list().find(i => i.title === 'Dark mode for plan pages');
  assert.equal(idea.status, 'new'); assert.equal(store.db.prepare('SELECT source FROM ideas WHERE id=?').get(idea.id).source, 'team');
  sms.sources.add = async ({ url, city }) => { store.db.prepare("INSERT INTO event_sources (id, url, name, city, lat, lng, created) VALUES ('s1', ?, 'Akron Library', ?, 41, -81, 1)").run(url, city); return { name: 'Akron Library', city, found: 12 }; };
  assert.match(await agent.run(TEAM, 'add_source', { url: 'https://akronlibrary.example/events', city: 'Akron, OH' }, { t: null }, 'add source'), /Added "Akron Library" \(Akron, OH\) as an event source: 12 upcoming events found/);
  store.close();
});

test('favorites still find a place on Google when it has no hours listed or is closed today', async () => {
  const store = new Store(':memory:');
  const place = { id: 'P1', displayName: { text: 'Bolt Coffee' }, formattedAddress: '61 Washington St, Providence, RI', shortFormattedAddress: '61 Washington St', primaryTypeDisplayName: { text: 'Coffee shop' }, location: { latitude: 41.82, longitude: -71.41 },
    regularOpeningHours: { weekdayDescriptions: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(d => `${d}: Closed`) } };
  const fetchImpl = async url => String(url).includes('places:searchText') ? { ok: true, status: 200, headers: new Map(), json: async () => ({ places: [place] }) } : geo(41.82, -71.41, 'Providence, RI');
  const sms = new Sms(store, { SMS_MODE: 'preview', SMS_OPERATOR_KEY: 'x'.repeat(30), PUBLIC_BASE_URL: 'https://rall-e.ai', GOOGLE_MAPS_API_KEY: 'gk' }, { messages: { create: async () => ({}) } }, fetchImpl);
  const v = await sms.favorites.set(A, { category: 'coffee', city: 'Providence, RI', places: ['Bolt Coffee'] });
  assert.equal(v.items[0].address, '61 Washington St, Providence, RI');
  store.close();
});

test('"where do my friends go in Providence?": friends\' picks near a city, a 30-day page, and the agent tool', async () => {
  const { store, sms } = setup(), db = store.db, C = '+13107770943';
  db.prepare("INSERT INTO sms_threads (phone, digest, plan, participant, role, muted, updated) VALUES (?, 'd1', 'p1', '', 'host', 0, ?), (?, 'd1', 'p1', ?, 'guest', 0, ?)").run(A, Date.now(), B, B, Date.now());
  sms.invites.nameOf = p => ({ [A]: 'Marc', [B]: 'Jeff' })[p] || '';
  await sms.favorites.set(A, { category: 'coffee', city: 'Providence, RI', places: [{ name: 'Bolt Coffee', note: 'the cortado' }, 'Dave’s Coffee'] });
  await sms.favorites.set(A, { category: 'bars', city: 'Providence, RI', places: ['The Eddy'] });
  await sms.favorites.set(C, { category: 'coffee', city: 'Providence, RI', places: ['Not a friend’s pick'] }); // not connected to B
  const near = sms.favorites.friendsPlaces(B, { lat: 41.82, lng: -71.41 });
  assert.deepEqual(near.map(r => [r.who, r.category, r.rank, r.name]), [['Marc', 'bars', 1, 'The Eddy'], ['Marc', 'coffee', 1, 'Bolt Coffee'], ['Marc', 'coffee', 2, 'Dave’s Coffee']]);
  assert.deepEqual(sms.favorites.friendsPlaces(B, { lat: 34.05, lng: -118.24 }), []);
  const link = sms.favorites.friendsPage(B, { lat: 41.82, lng: -71.41, label: 'Providence, RI' });
  assert.equal(sms.favorites.friendsPage(B, { lat: 41.82, lng: -71.41, label: 'Providence, RI' }), link); // same page for the same city
  const page = sms.favorites.friendsView(link.split('/').pop());
  assert.equal(page.for, 'Jeff'); assert.deepEqual(page.friends, ['Marc']); assert.deepEqual(page.groups.map(g => [g.category, g.items.length]), [['bars', 1], ['coffee', 2]]);
  assert.ok(!JSON.stringify(page).includes('+1310')); // never phone numbers
  db.prepare('UPDATE fav_friend_pages SET created=0').run();
  assert.throws(() => sms.favorites.friendsView(link.split('/').pop()), /isn’t available anymore/);
  const out = await sms.flow.agent.run(B, 'friends_places', { city: 'Providence, RI' }, { t: null }, 'where do my friends go in providence');
  assert.match(out, /3 places from 1 friends/); assert.match(out, /Marc's #1 coffee: Bolt Coffee \("the cortado"\)/); assert.match(out, /\/fp\/[\w-]+/);
  assert.match(await sms.flow.agent.run(C, 'friends_places', { city: 'Providence, RI' }, { t: null }, 'x'), /None of their friends/);
  store.close();
});
