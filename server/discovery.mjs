// Discovery: real things to do near a person, from Ticketmaster (events), SeatGeek (events) and
// Google Places (restaurants, bars, museums, parks, activities). Results are normalized into the same
// shape as the sample catalogue so plans, the web page and texts work unchanged.
// A "local" provider (Craigslist / Facebook / local papers) is stubbed for a later integration.
import { createHash, randomBytes } from 'node:crypto';
import { registerEvent, eventById } from './catalog.mjs';
import { fail } from './store.mjs';
import { meter } from './usage.mjs';

const short = s => createHash('sha1').update(String(s)).digest('base64url').slice(0, 10);
const DAY = 86400000;
const iso = d => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const art = category => ({ dinner: 'dinner', food: 'dinner', comedy: 'comedy', music: 'rooftop', 'live shows': 'rooftop', nightlife: 'rooftop', nature: 'trail', outdoors: 'trail', museums: 'museum', arts: 'museum', theatre: 'comedy', sports: 'rooftop' })[category] || 'rooftop';
function when(localDate, localTime) {
  if (!localDate) return 'See listing for times';
  const d = new Date(`${localDate}T${localTime || '12:00:00'}`);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (!localTime) return day;
  const [h, m] = localTime.split(':').map(Number);
  return `${day} · ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
// Generic asks ("live music", "something fun this weekend") are better served by category filters than
// literal keyword matching, which drops most listings. Keep only specific words (artists, teams, genres like "jazz").
const GENERIC = /\b(live|music|concerts?|shows?|events?|fun|something|anything|things?|to|do|stuff|this|next|weekend|tonight|today|tomorrow|night|comedy|comedians?|stand ?up|sports?|games?|good|cool|great|and|or|a|the|some|in|near|me|us|with|friends)\b/gi;
const specific = (what = '', category = '') => String(what).replace(GENERIC, ' ').replace(/\s+/g, ' ').trim();
const TM_SEGMENTS = { music: 'Music', 'live shows': 'Music', comedy: 'Comedy', sports: 'Sports', theatre: 'Arts & Theatre', arts: 'Arts & Theatre' };
const PLACE_QUERIES = { dinner: 'restaurants', food: 'restaurants', nightlife: 'bars and lounges', museums: 'museums and galleries', arts: 'museums and galleries', nature: 'parks and hiking trails', outdoors: 'parks and outdoor activities' };

export class Discovery {
  constructor(store, env = process.env, fetchImpl = globalThis.fetch) {
    this.store = store; this.db = store.db; this.fetch = fetchImpl;
    this.keys = { ticketmaster: env.TICKETMASTER_API_KEY || '', seatgeek: env.SEATGEEK_CLIENT_ID || '', google: env.GOOGLE_MAPS_API_KEY || '', gracenote: env.GRACENOTE_API_KEY || '', serp: env.SERP_API_KEY || '' };
    this.base = (env.PUBLIC_BASE_URL || 'https://rall-e.ai').replace(/\/$/, '');
    this.db.exec(`CREATE TABLE IF NOT EXISTS discovered_events (id TEXT PRIMARY KEY, data TEXT NOT NULL, fetched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS profiles (phone TEXT PRIMARY KEY, location TEXT, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS location_links (token TEXT PRIMARY KEY, phone TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recent_finds (phone TEXT PRIMARY KEY, ids TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS serp_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL);`);
    // Plans keep referencing outings found earlier, including after a restart.
    for (const row of this.db.prepare('SELECT data FROM discovered_events WHERE fetched > ?').all(Date.now() - 60 * DAY)) registerEvent(JSON.parse(row.data));
  }
  get enabled() { return Boolean(this.keys.ticketmaster || this.keys.seatgeek || this.keys.google || this.keys.gracenote || this.keys.serp); }
  get sources() { return ['ticketmaster', 'seatgeek', 'google', 'gracenote', 'serp'].filter(k => this.keys[k]).map(k => ({ ticketmaster: 'Ticketmaster', seatgeek: 'SeatGeek', google: 'Google Places', gracenote: 'Gracenote showtimes', serp: 'Google showtimes (SerpApi)' })[k]); }
  async get(url, init = {}, timeout = 8000) {
    const response = await this.fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    meter.call(url, response.headers);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${new URL(url).host} ${response.status}: ${result?.error?.message || result?.fault?.faultstring || 'error'}`);
    return result;
  }

  // ---------- location ----------
  location(phone) { const row = this.db.prepare('SELECT location FROM profiles WHERE phone=?').get(phone); return row?.location ? JSON.parse(row.location) : null; }
  saveLocation(phone, loc) { this.db.prepare('INSERT OR REPLACE INTO profiles VALUES (?,?,?)').run(phone, JSON.stringify({ ...loc, at: Date.now() }), Date.now()); return loc; }
  async geocode(place) {
    const text = String(place || '').trim().slice(0, 120);
    if (!text) fail(400, 'Tell me a neighborhood, city or ZIP.');
    if (!this.keys.google) return { label: text, source: 'typed' }; // no coordinates without Google; providers fall back to city search
    const r = await this.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(text)}&components=country:US&key=${this.keys.google}`);
    const hit = r.results?.[0]; if (!hit) fail(404, `I couldn't find "${text}". Try a city or ZIP.`);
    return { label: this.label(hit, text), lat: hit.geometry.location.lat, lng: hit.geometry.location.lng, source: 'typed' };
  }
  async reverse(lat, lng) {
    if (!this.keys.google) return { label: 'your current location', lat, lng, source: 'gps' };
    const r = await this.get(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=neighborhood|locality|postal_code&key=${this.keys.google}`).catch(() => ({}));
    return { label: r.results?.[0] ? this.label(r.results[0]) : 'your current location', lat, lng, source: 'gps' };
  }
  label(hit, fallback = '') {
    const part = type => hit.address_components?.find(c => c.types.includes(type));
    const area = part('neighborhood') || part('sublocality') || part('locality'), city = part('locality'), state = part('administrative_area_level_1');
    return [area?.long_name, city && city !== area ? city.long_name : null, state?.short_name].filter(Boolean).join(', ') || hit.formatted_address || fallback;
  }
  // One-tap GPS sharing: a 15-minute link to a page that asks the phone for its location.
  locationLink(phone) {
    const token = randomBytes(18).toString('base64url');
    this.db.prepare('DELETE FROM location_links WHERE expires<?').run(Date.now());
    this.db.prepare('INSERT INTO location_links VALUES (?,?,?)').run(createHash('sha256').update(token).digest('hex'), phone, Date.now() + 15 * 60000);
    return `${this.base}/l/${token}`;
  }
  async shareLocation(token, lat, lng) {
    const row = this.db.prepare('SELECT * FROM location_links WHERE token=?').get(createHash('sha256').update(String(token)).digest('hex'));
    if (!row || row.expires < Date.now()) fail(410, 'This location link expired. Text Rall-e for a new one.');
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) fail(400, 'That location did not come through.');
    const loc = await this.reverse(Math.round(lat * 1000) / 1000, Math.round(lng * 1000) / 1000); // ~100 m precision is plenty
    this.db.prepare('DELETE FROM location_links WHERE token=?').run(row.token);
    return { phone: row.phone, location: this.saveLocation(row.phone, loc) };
  }

  // ---------- search ----------
  async search(loc, { what = '', category = '', days = 7, date = '' } = {}) {
    if (!loc) fail(400, 'I need to know where they are first.');
    const start = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`).getTime() : Date.now();
    const end = date ? start + DAY : Date.now() + Math.min(Math.max(Number(days) || 7, 1), 30) * DAY;
    const tasks = [];
    // Movies: real showtimes from Gracenote (theaters near them, what's playing, when). Without it, Places only finds theaters.
    const movie = category === 'movies' || /\b(movies?|films?|cinema|showtimes?|imax|matinee)\b/i.test(what);
    if (movie && loc.lat != null && (this.keys.gracenote || (this.keys.serp && this.keys.google))) {
      const day = date || '';
      const found = await (this.keys.gracenote ? this.movies(loc, what, day || new Date(start).toISOString().slice(0, 10)) : this.serpMovies(loc, what, day))
        .catch(e => { console.error('Movies:', e.message); return null; });
      if (found?.length) { const now = Date.now(); for (const e of found) { registerEvent(e); this.db.prepare('INSERT OR REPLACE INTO discovered_events VALUES (?,?,?)').run(e.id, JSON.stringify(e), now); } return found.slice(0, 12); }
    }
    const eventy = !category || ['music', 'live shows', 'comedy', 'sports', 'theatre', 'arts', 'nightlife'].includes(category) || /show|concert|game|comedy|music|theat|festival|event/i.test(what);
    const placey = !category || PLACE_QUERIES[category] || /eat|dinner|brunch|lunch|drink|bar|restaurant|museum|park|hike|coffee|bowling|golf|spa|climb/i.test(what) || !eventy;
    if (this.keys.ticketmaster && eventy) tasks.push(this.ticketmaster(loc, what, category, start, end).catch(e => { console.error('Ticketmaster:', e.message); return []; }));
    if (this.keys.seatgeek && eventy) tasks.push(this.seatgeek(loc, what, category, start, end).catch(e => { console.error('SeatGeek:', e.message); return []; }));
    if (this.keys.google && placey && loc.lat != null) tasks.push(this.places(loc, what, category).catch(e => { console.error('Places:', e.message); return []; }));
    tasks.push(this.local(loc, what)); // stub
    const seen = new Set(), out = [];
    for (const e of (await Promise.all(tasks)).flat()) {
      const key = `${e.short.toLowerCase().replace(/\W/g, '')}|${e.startsAt || ''}`;
      if (seen.has(key)) continue; seen.add(key); out.push(e);
    }
    const now = Date.now();
    for (const e of out) { registerEvent(e); this.db.prepare('INSERT OR REPLACE INTO discovered_events VALUES (?,?,?)').run(e.id, JSON.stringify(e), now); }
    return out.slice(0, 12);
  }
  async ticketmaster(loc, what, category, start, end) {
    const q = new URLSearchParams({ apikey: this.keys.ticketmaster, radius: '25', unit: 'miles', size: '10', sort: 'date,asc', startDateTime: iso(start), endDateTime: iso(end) });
    const zip = /\b(\d{5})\b/.exec(loc.label)?.[1];
    if (loc.lat != null) q.set('latlong', `${loc.lat},${loc.lng}`);
    else if (zip) q.set('postalCode', zip);
    else { const [city, state] = loc.label.split(',').map(x => x.trim()); q.set('city', city); if (/^[A-Z]{2}$/i.test(state || '')) q.set('stateCode', state.toUpperCase()); }
    const keyword = specific(what, category);
    if (keyword) q.set('keyword', keyword); if (TM_SEGMENTS[category]) q.set('classificationName', TM_SEGMENTS[category]);
    else if (!keyword && /music|concert|band|gig/i.test(what)) q.set('classificationName', 'Music');
    else if (!keyword && /comed|stand.?up/i.test(what)) q.set('classificationName', 'Comedy');
    const r = await this.get(`https://app.ticketmaster.com/discovery/v2/events.json?${q}`);
    return (r._embedded?.events || []).map(ev => {
      const v = ev._embedded?.venues?.[0] || {}, c = ev.classifications?.[0] || {}, cat = (c.segment?.name || '').toLowerCase().includes('music') ? 'music' : (c.genre?.name || c.segment?.name || 'event').toLowerCase();
      const price = ev.priceRanges?.[0];
      return this.shape({ id: `tm_${short(ev.id)}`, source: 'Ticketmaster', category: cat, short: ev.name, venue: v.name || 'Venue TBA', area: [v.city?.name, v.state?.stateCode].filter(Boolean).join(', '),
        address: v.address?.line1, time: when(ev.dates?.start?.localDate, ev.dates?.start?.localTime), startsAt: ev.dates?.start?.dateTime,
        price: price ? Math.round(price.min) : null, priceText: price ? `$${Math.round(price.min)}${price.max > price.min ? `–$${Math.round(price.max)}` : ''}` : 'See listing',
        age: ev.ageRestrictions?.legalAgeEnforced ? '21+' : 'See listing', url: ev.url, image: ev.images?.find(i => i.ratio === '16_9')?.url, description: `${c.genre?.name || c.segment?.name || 'Live event'} at ${v.name || 'a local venue'}.` });
    });
  }
  async seatgeek(loc, what, category, start, end) {
    const q = new URLSearchParams({ client_id: this.keys.seatgeek, per_page: '10', range: '25mi', 'datetime_utc.gte': iso(start).slice(0, 19), 'datetime_utc.lte': iso(end).slice(0, 19), sort: 'datetime_utc.asc' });
    if (loc.lat != null) { q.set('lat', loc.lat); q.set('lon', loc.lng); }
    const keyword = specific(what, category); if (keyword) q.set('q', keyword); if (category === 'comedy') q.set('taxonomies.name', 'comedy'); if (category === 'sports') q.set('taxonomies.name', 'sports');
    const r = await this.get(`https://api.seatgeek.com/2/events?${q}`);
    return (r.events || []).map(ev => {
      const [d, t] = String(ev.datetime_local || '').split('T'), v = ev.venue || {};
      return this.shape({ id: `sg_${short(ev.id)}`, source: 'SeatGeek', category: (ev.type || 'event').replace(/_/g, ' '), short: ev.short_title || ev.title, venue: v.name || 'Venue TBA', area: [v.city, v.state].filter(Boolean).join(', '),
        address: v.address, time: ev.time_tbd ? when(d) : when(d, t), startsAt: ev.datetime_utc ? `${ev.datetime_utc}Z` : null,
        price: ev.stats?.lowest_price ?? null, priceText: ev.stats?.lowest_price ? `from $${ev.stats.lowest_price}` : 'See listing', age: 'See listing', url: ev.url, image: ev.performers?.[0]?.image, description: `${(ev.type || 'Event').replace(/_/g, ' ')} at ${v.name || 'a local venue'}.` });
    });
  }
  async places(loc, what, category) {
    const text = `${what || PLACE_QUERIES[category] || 'fun things to do'} near ${loc.label}`;
    const r = await this.get('https://places.googleapis.com/v1/places:searchText', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.keys.google, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.primaryTypeDisplayName,places.googleMapsUri,places.editorialSummary,places.currentOpeningHours.weekdayDescriptions,places.currentOpeningHours.openNow,places.photos' },
      body: JSON.stringify({ textQuery: text, maxResultCount: 8, locationBias: { circle: { center: { latitude: loc.lat, longitude: loc.lng }, radius: 15000 } } }) });
    const levels = { PRICE_LEVEL_INEXPENSIVE: '$', PRICE_LEVEL_MODERATE: '$$', PRICE_LEVEL_EXPENSIVE: '$$$', PRICE_LEVEL_VERY_EXPENSIVE: '$$$$' };
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    return (r.places || []).map(p => {
      const type = p.primaryTypeDisplayName?.text || 'Place', hours = p.currentOpeningHours?.weekdayDescriptions?.find(h => h.startsWith(today));
      return this.shape({ id: `gp_${short(p.id)}`, source: 'Google Places', kind: 'place', category: /restaurant|food|cafe|bakery|bistro|grill|pizz|sushi|taco/i.test(type) ? 'dinner' : /bar|pub|lounge|night/i.test(type) ? 'nightlife' : /museum|gallery|art/i.test(type) ? 'museums' : /park|trail|garden|beach|hik/i.test(type) ? 'nature' : type.toLowerCase(),
        short: p.displayName?.text || 'A local spot', venue: p.displayName?.text || 'A local spot', area: p.shortFormattedAddress || p.formattedAddress || loc.label, address: p.formattedAddress,
        time: hours ? `Open ${hours.replace(`${today}: `, 'today ')}` : 'Check hours', price: null, priceText: levels[p.priceLevel] || 'See listing',
        rating: p.rating ? `${p.rating}★ (${p.userRatingCount || 0})` : null, photoRef: p.photos?.[0]?.name || null, image: p.photos?.[0]?.name ? `${this.base}/img/p/gp_${short(p.id)}` : null, age: 'See listing', url: p.googleMapsUri, description: p.editorialSummary?.text || `${type}${p.rating ? `, rated ${p.rating}★` : ''}.` });
    });
  }
  async movies(loc, what, day) {
    const q = new URLSearchParams({ startDate: day, numDays: '1', lat: String(loc.lat), lng: String(loc.lng), radius: '10', units: 'mi', imageSize: 'Md', api_key: this.keys.gracenote });
    const list = await this.get(`https://data.tmsapi.com/v1.1/movies/showings?${q}`);
    const wanted = specific(String(what).replace(/\b(movies?|films?|cinema|showtimes?|playing|what'?s|at|the|theaters?|theatres?|near|me|by)\b/gi, ' '));
    const clock = t => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
    // Showtimes are theater-local ("2026-10-02T19:30"). Approximate local time from longitude (±1h for DST) to drop past shows.
    const localNow = new Date(Date.now() + (Math.round(loc.lng / 15) - 1) * 3600000).toISOString().slice(0, 16);
    const out = [], all = Array.isArray(list) ? list : [];
    // Narrow to a title or genre they named ("the new Batman", "horror"), but never down to nothing.
    const words = wanted.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const hit = m => words.some(w => m.title?.toLowerCase().includes(w) || (m.genres || []).some(g => g.toLowerCase().includes(w)));
    const pool = all.some(hit) ? all.filter(hit) : all;
    for (const m of pool) {
      const shows = (m.showtimes || []).filter(x => x.dateTime && x.dateTime >= localNow);
      if (!shows.length) continue;
      const theatre = shows[0].theatre || {}, here = shows.filter(x => x.theatre?.id === theatre.id).slice(0, 5);
      const [d, t] = here[0].dateTime.split('T'), rating = (m.ratings || []).find(r => r.body?.includes('Motion Picture'))?.code;
      const run = /PT(\d+)H(\d+)M/.exec(m.runTime || ''), length = run ? `${Number(run[1])}h ${Number(run[2])}m` : '';
      out.push(this.shape({ id: `mv_${short(`${m.tmsId}|${theatre.id}|${d}`)}`, source: 'Gracenote', category: 'movies', short: m.title, venue: theatre.name || 'A theater near you', area: loc.label,
        time: when(d, `${t}:00`), startsAt: null, price: null, priceText: 'See showtimes', rating: [rating, length].filter(Boolean).join(' · ') || null,
        showtimes: here.map(x => clock(x.dateTime.split('T')[1])), posterRef: m.preferredImage?.uri || null, image: m.preferredImage?.uri ? `${this.base}/img/p/mv_${short(`${m.tmsId}|${theatre.id}|${d}`)}` : null,
        url: here[0].ticketURI || `https://www.fandango.com/search?q=${encodeURIComponent(m.title)}`, age: rating || 'See listing',
        description: `${[rating, length, (m.genres || []).slice(0, 2).join('/')].filter(Boolean).join(' · ')}. Showtimes at ${theatre.name}: ${here.map(x => clock(x.dateTime.split('T')[1])).join(', ')}. ${m.shortDescription || ''}`.trim() }));
      if (out.length >= 12) break;
    }
    return out;
  }
  // Showtimes via SerpApi (Google's showtimes box), until Gracenote is approved. Free plan = 250 searches/month, so:
  // nearby theaters come from Google Places, and each theater's 7-day schedule is cached for 12 hours (one search).
  async serp(q, ttl) {
    const key = q.toLowerCase(), hit = this.db.prepare('SELECT data FROM serp_cache WHERE key=? AND at>?').get(key, Date.now() - ttl);
    if (hit) return JSON.parse(hit.data);
    const r = await this.get(`https://serpapi.com/search.json?${new URLSearchParams({ engine: 'google', q, hl: 'en', gl: 'us', api_key: this.keys.serp })}`, {}, 25000);
    const data = { showtimes: r.showtimes || [], posters: (r.knowledge_graph?.movies_playing || []).map(m => ({ name: m.name, image: m.image })) };
    this.db.prepare('INSERT OR REPLACE INTO serp_cache VALUES (?,?,?)').run(key, JSON.stringify(data), Date.now());
    return data;
  }
  async serpMovies(loc, what, date) {
    // Busiest theaters first (most Google reviews): they're the ones with full schedules. Three searches, cached 12h each.
    const reviews = t => Number(/\((\d+)\)/.exec(t.rating || '')?.[1] || 0);
    const theaters = (await this.places(loc, 'movie theaters', null)).filter(t => /cinema|theat|movie|imax|amc|regal|cinemark|laemmle|arclight|alamo/i.test(`${t.short} ${t.description}`))
      .sort((a, b) => reviews(b) - reviews(a)).slice(0, 3);
    if (!theaters.length) return [];
    const city = (theaters[0].address || loc.label).split(',').slice(-3, -1).join(',').replace(/\d{5}/, '').trim();
    const [posters, ...schedules] = await Promise.all([
      this.serp(`movies playing near ${city}`, DAY).then(r => r.posters).catch(() => []),
      ...theaters.map(t => this.serp(`${t.short} ${city} showtimes`, 12 * 3600000).then(r => r.showtimes).catch(e => { console.error('SerpApi:', e.message); return []; }))]);
    // Which day: the date they asked for, else today (plus tomorrow if tonight is nearly over). Times are theater-local.
    const local = new Date(Date.now() + Math.round(loc.lng / 15) * 3600000), today = local.toISOString().slice(0, 10);
    const plus = n => new Date(Date.parse(`${today}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
    // Google labels blocks "Today", "Tomorrow", or "Wed" + "Sep 30": turn each into a YYYY-MM-DD date.
    const isoOf = b => {
      if (b.day === 'Today') return today; if (b.day === 'Tomorrow') return plus(1);
      for (let n = 0; n < 14; n++) { const d = new Date(`${plus(n)}T12:00:00Z`);
        const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
        if (b.date ? b.date === md : b.day === wd) return plus(n); }
      return '';
    };
    const nice = d => d === today ? 'today' : d === plus(1) ? 'tomorrow' : new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const days = date && date >= today ? [date] : [today, plus(1)];
    const minutes = t => { const m = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(t); return m ? (Number(m[1]) % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0)) * 60 + Number(m[2]) : 0; };
    const nowMin = local.getUTCHours() * 60 + local.getUTCMinutes() - 60; // ~1h slack for DST
    const words = String(what).toLowerCase().replace(/\b(movies?|films?|cinema|showtimes?|playing|what'?s|are|is|at|the|this|weekend|tonight|today|near|me|any|good|new)\b/g, ' ').split(/\s+/).filter(w => w.length > 3);
    const out = [];
    for (const dayName of days) {
      theaters.forEach((t, i) => {
        const block = (schedules[i] || []).find(b => isoOf(b) === dayName); if (!block) return;
        for (const m of block.movies || []) {
          let slots = (m.showing || []).flatMap(sh => (sh.time || []).map(time => ({ time, type: sh.type })));
          if (dayName === today) slots = slots.filter(x => minutes(x.time) >= nowMin);
          if (!slots.length) continue;
          slots.sort((a, b) => minutes(a.time) - minutes(b.time));
          const times = slots.slice(0, 6).map(x => `${x.time}${x.type && x.type !== 'Standard' ? ` (${x.type})` : ''}`);
          // Google's posters are thumbnails: fine for list rows (thumb), too small for previews (image = theater photo).
          const id = `mv_${short(`${m.name}|${t.id}|${dayName}`)}`, poster = posters.find(p => p.name?.toLowerCase() === m.name.toLowerCase())?.image;
          out.push(this.shape({ id, source: 'Google showtimes', kind: 'event', category: 'movies', short: m.name, venue: t.short, area: t.area, address: t.address,
            time: `${nice(dayName).replace(/^./, c => c.toUpperCase())} · ${slots[0].time}`, startsAt: null, price: null, priceText: 'See showtimes',
            rating: null, image: t.photoRef ? `${this.base}/img/p/${id}` : poster || null, photoRef: t.photoRef || null, thumb: poster || null, url: m.link || t.url, age: 'See listing', showtimes: times,
            description: `Showtimes at ${t.short} ${/^(today|tomorrow)$/.test(nice(dayName)) ? nice(dayName) : `on ${nice(dayName)}`}: ${times.join(', ')}.` }));
        }
      });
      if (out.length >= 4) break; // today had plenty; skip tomorrow
    }
    const wanted = out.filter(e => words.some(w => e.short.toLowerCase().includes(w)));
    return (wanted.length ? wanted : out).slice(0, 12);
  }
  // Google photo bytes, fetched server-side so the API key never leaves the server.
  async placePhoto(e) {
    if (e?.posterRef && this.keys.gracenote && /^[\w/.-]+$/.test(e.posterRef)) {
      const r = await this.fetch(`https://demo.tmsimg.com/${e.posterRef}?api_key=${this.keys.gracenote}`, { signal: AbortSignal.timeout(8000) }).catch(() => null); meter.call('https://demo.tmsimg.com/x');
      const type = r?.headers.get('content-type') || '';
      return r?.ok && type.startsWith('image/') ? { type, bytes: Buffer.from(await r.arrayBuffer()) } : null;
    }
    if (!e?.photoRef || !this.keys.google || !/^places\/[\w-]+\/photos\/[\w-]+$/.test(e.photoRef)) return null;
    meter.call(`https://places.googleapis.com/v1/${e.photoRef}/media`);
    const r = await this.fetch(`https://places.googleapis.com/v1/${e.photoRef}/media?maxWidthPx=1200&key=${this.keys.google}`, { signal: AbortSignal.timeout(8000) });
    const type = r.headers.get('content-type') || '';
    return r.ok && type.startsWith('image/') ? { type, bytes: Buffer.from(await r.arrayBuffer()) } : null;
  }
  // Later: Craigslist events, Facebook events, local newspaper calendars. Returns nothing for now.
  async local() { return []; }
  shape(e) {
    return { title: e.short, doors: e.kind === 'place' ? e.time : 'See listing', duration: e.kind === 'place' ? 'Up to you' : 'See listing', accessibility: 'Check with the venue.', tag: [e.priceText, e.rating].filter(Boolean).join(' · '),
      color: art(e.category), fictional: false, kind: 'event', ...e };
  }
  // What the agent found for this person recently, so "yes, the jazz one" works in a later text.
  // Keeps everything found for them in the last day (newest first), so a follow-up search doesn't wipe out the options
  // they're still asking about ("how much are tickets?" after "what about Saturday?").
  remember(phone, found) {
    if (!found.length) return;
    const fresh = found.map(e => e.id), older = this.recent(phone).map(e => e.id).filter(id => !fresh.includes(id));
    this.db.prepare('INSERT OR REPLACE INTO recent_finds VALUES (?,?,?)').run(phone, JSON.stringify([...fresh, ...older].slice(0, 20)), Date.now());
  }
  recent(phone) {
    const row = this.db.prepare('SELECT * FROM recent_finds WHERE phone=? AND at>?').get(phone, Date.now() - DAY);
    return row ? JSON.parse(row.ids).map(id => eventById(id)).filter(Boolean) : [];
  }
  describe(e) { return `${e.id}: ${e.short} — ${e.venue}${e.area ? `, ${e.area}` : ''}. ${e.time}. ${e.priceText || ''}${e.rating ? `, ${e.rating}` : ''}. ${e.description} (${e.source}${e.url ? `; link ${e.url}` : ''})`; }
}
