// One show, many listings: Ticketmaster, SeatGeek, JamBase, venue calendars and curated sources often list the same
// event. Merge them into one entity (Mike: "multiple data partners for different parts of the story") and keep the
// best part of each: tickets and prices from Ticketmaster/SeatGeek, venue size from JamBase, an image from anyone.
const STOP = new Set(['the', 'a', 'an', 'and', 'with', 'w', 'at', 'live', 'in', 'concert', 'presents', 'present', 'tour', 'tickets', 'show', 'night', 'feat', 'ft', 'featuring', 'special', 'guest', 'guests', 'plus', 'of', 'for', 'evening', 'an', 'los', 'angeles']);
const words = s => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w)));
// How much two names share, relative to the shorter one ("Khruangbin" vs "Khruangbin with Men I Trust" = 1).
export function overlap(a, b) {
  const x = words(a), y = words(b); if (!x.size || !y.size) return 0;
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}
const km = (a, b) => {
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return Infinity;
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  return 12742 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2));
};
export const dayOf = e => e.localDate || (e.startsAt && !/Z$/.test(e.startsAt) ? String(e.startsAt).slice(0, 10) : '') || '';
// Same event: same local day, same place (venue names overlap or within ~200 m), and the names overlap.
export function sameEvent(a, b) {
  if (a.kind === 'place' || b.kind === 'place' || !dayOf(a) || dayOf(a) !== dayOf(b)) return false;
  const place = overlap(a.venue, b.venue) >= 0.6 || km(a, b) < 0.2;
  return place && overlap(a.short, b.short) >= 0.6;
}
const TICKETS = ['Ticketmaster', 'SeatGeek'];
const priced = e => e.price != null || /\$\d/.test(e.priceText || '');
// Merge a group into one event: the listing with tickets and a price leads; the others fill in what it lacks.
function combine(group) {
  const lead = [...group].sort((a, b) => (priced(b) - priced(a)) || (TICKETS.includes(b.source) - TICKETS.includes(a.source)))[0];
  const pick = f => group.map(f).find(v => v != null && v !== '' && v !== 'See listing');
  const sources = [...new Set(group.map(e => e.source))];
  return { ...lead, image: lead.image || pick(e => e.image) || null, capacity: lead.capacity || pick(e => e.capacity) || null,
    lat: lead.lat ?? pick(e => e.lat) ?? null, lng: lead.lng ?? pick(e => e.lng) ?? null, address: lead.address || pick(e => e.address) || null,
    localDate: dayOf(lead) || pick(dayOf) || lead.localDate, priceText: priced(lead) ? lead.priceText : pick(e => priced(e) ? e.priceText : null) || lead.priceText,
    price: lead.price ?? pick(e => e.price) ?? null, url: TICKETS.includes(lead.source) ? lead.url : pick(e => TICKETS.includes(e.source) ? e.url : null) || lead.url,
    sources, mergedIds: group.map(e => e.id), source: sources.length > 1 ? `${lead.source} (also ${sources.filter(s => s !== lead.source).join(', ')})` : lead.source };
}
export function mergeEvents(list) {
  const groups = [];
  for (const e of list) { const g = groups.find(g => g.some(x => sameEvent(x, e))); if (g) g.push(e); else groups.push([e]); }
  return groups.map(g => g.length > 1 ? combine(g) : g[0]);
}
// Live music: a mix, not one source's list. About two local or small-venue shows for each big-venue show, and no
// single source holding every slot, so smaller names and bigger names both come through (Mike, 10-05).
export function mixMusic(list, { big, n = 12 }) {
  const shows = list.filter(e => e.kind !== 'place'), places = list.filter(e => e.kind === 'place');
  const small = shows.filter(e => !big(e)), large = shows.filter(big), out = [], used = new Set();
  // Within a pool, alternate between sources (in each source's own order) and favor listings with a price.
  const rotate = pool => {
    const by = new Map(); for (const e of [...pool].sort((a, b) => priced(b) - priced(a))) { const s = e.sources?.[0] || e.source; if (!by.has(s)) by.set(s, []); by.get(s).push(e); }
    const lists = [...by.values()], r = [];
    for (let i = 0; r.length < pool.length; i++) for (const l of lists) if (l[i]) r.push(l[i]);
    return r;
  };
  const a = rotate(small), b = rotate(large);
  while (out.length < n && (a.length || b.length)) {
    for (const take of [a, a, b]) { const e = take.shift(); if (e && !used.has(e.id)) { used.add(e.id); out.push(e); } }
  }
  return [...out, ...a, ...b, ...places];
}
