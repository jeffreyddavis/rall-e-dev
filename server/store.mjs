import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EVENTS, MAX_STOPS, eventById, categoryFrom } from './catalog.mjs';

export const token = () => randomBytes(24).toString('base64url');
const token_ = token;
// Plans are named after their stops and renamed on every change ("Te'Kila + Casa Vega").
export const titleFor = p => { const n = p.stops.map(id => eventById(id)?.short).filter(Boolean); return !n.length ? p.title : n.length === 1 ? n[0] : `${n.slice(0, -1).join(', ')} + ${n.at(-1)}`; };
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export const clean = (value, max = 1000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `Please enter between 1 and ${max} characters.`);
  return value.trim();
};
function say(s, role, text, eventId) {
  s.messages.push({ id: randomUUID(), role, text, eventId, at: now() });
  s.messages = s.messages.slice(-100);
}
function note(s, text) { s.activity.unshift({ id: randomUUID(), text, at: now() }); s.activity = s.activity.slice(0, 40); }
function preference(s, category, delta) { s.preferences[category] = (s.preferences[category] || 0) + delta; }
function recommend(s, category, exclude) {
  const candidates = category === 'comedy' ? EVENTS.filter(e => e.id === 'comedy') : EVENTS.filter(e => !category || e.category === category);
  const event = candidates.find(e => e.id !== exclude) || EVENTS.find(e => e.id !== exclude) || EVENTS[0];
  s.recommendation = event.id; s.stage = 'discover';
  say(s, 'assistant', `${event.description} Is this your kind of thing?`, event.id);
}
function initial(name = 'Alex') {
  return { id: randomUUID(), name, revision: 0, stage: 'location', city: 'Hollywood, Los Angeles', recommendation: null, preferences: {}, recurring: false, stopped: false,
    plan: { title: 'A little Saturday adventure', status: 'proposed', mode: 'loose', stops: [], participants: [], suggestions: [] },
    messages: [], activity: [], nudges: [], createdAt: now(), aiMode: 'curated' };
}
export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file); this.listeners = [];
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS invites (digest TEXT PRIMARY KEY, session TEXT NOT NULL, participant TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS night_links (digest_hash TEXT PRIMARY KEY, session TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS share_links (token TEXT PRIMARY KEY, plan TEXT NOT NULL UNIQUE, session TEXT NOT NULL); CREATE TABLE IF NOT EXISTS session_alias (alias TEXT PRIMARY KEY, digest TEXT NOT NULL);');
  }
  create(name) {
    const id = token(), state = initial(name ? clean(name, 40) : 'Alex');
    say(state, 'assistant', `Hey ${state.name}, I’m Rall-e. I find things worth doing near you and help bring your people together. Let’s start in Hollywood — sound right?`);
    this.db.prepare('INSERT INTO sessions VALUES (?, ?)').run(hash(id), JSON.stringify(state));
    return { id, state };
  }
  // Session tokens are stored hashed. An alias lets a second token (e.g. a phone sign-in) open an existing account.
  resolve(id) { const d = hash(id); return this.db.prepare('SELECT digest FROM session_alias WHERE alias=?').get(d)?.digest || d; }
  alias(digest) { const id = token(); this.db.prepare('INSERT INTO session_alias VALUES (?, ?)').run(hash(id), digest); return id; }
  digestOf(id) { return this.resolve(id); }
  // Listeners receive every committed plan change ({ digest, s, action, actor, via, data }). Used for group texts.
  listen(fn) { this.listeners.push(fn); }
  emit(event) { for (const fn of this.listeners) { try { fn(event); } catch (error) { console.error('Plan listener failed:', error.message); } } }
  get(id) { return this.load(id && this.resolve(id)); }
  load(digest) {
    const row = digest && this.db.prepare('SELECT state FROM sessions WHERE id=?').get(digest);
    if (!row) fail(401, 'Start your own demo to continue.');
    return JSON.parse(row.state);
  }
  save(id, state) { return this.persist(this.resolve(id), state); }
  persist(digest, state) { state.revision++; this.db.prepare('UPDATE sessions SET state=? WHERE id=?').run(JSON.stringify(state), digest); return state; }
  reset(id) { return this.resetAt(this.resolve(id)); }
  resetAt(digest, meta = {}) {
    const old = this.load(digest), state = initial(old.name);
    this.db.prepare('DELETE FROM invites WHERE session=?').run(digest);
    say(state, 'assistant', `Hey ${state.name}, I’m Rall-e. I find things worth doing near you and help bring your people together. Let’s start in Hollywood — sound right?`);
    this.persist(digest, state); this.emit({ digest, s: state, action: 'reset', actor: 'host', via: meta.via || 'web', data: {} });
    return state;
  }
  // Public, read-only "share this night" link (Mike's viral loop): stops and a head count, no names, no actions.
  shareToken(s, digest) {
    const row = this.db.prepare('SELECT token FROM share_links WHERE plan=?').get(s.id); if (row) return row.token;
    const token = randomBytes(9).toString('base64url'); this.db.prepare('INSERT INTO share_links VALUES (?,?,?)').run(token, s.id, digest); return token;
  }
  shared(token) {
    const row = /^[\w-]{12}$/.test(token || '') && this.db.prepare('SELECT * FROM share_links WHERE token=?').get(token);
    const s = row && this.load(row.session);
    if (!s || s.id !== row.plan || s.plan.status === 'dropped') fail(410, 'This plan isn’t available anymore.');
    return s;
  }
  sharedAt(token) { const s = this.shared(token); return { s, digest: this.db.prepare('SELECT session FROM share_links WHERE token=?').get(token).session }; }
  // Someone who opened a shared night and signed up joins it as a friend who's in. Works on confirmed plans too.
  joinShared(token, name) {
    const { s, digest } = this.sharedAt(token), p = s.plan;
    if (!['proposed', 'confirmed'].includes(p.status)) fail(409, 'This night is closed to new people.');
    if (p.participants.length >= 20) fail(409, 'This night is full.');
    let label = clean(name, 30) || 'Friend';
    for (let n = 2; [s.name, ...p.participants.map(x => x.name)].some(x => x.toLowerCase() === label.toLowerCase()); n++) label = `${clean(name, 30)} ${n}`;
    const person = { id: randomUUID(), name: label, response: 'yes', invite: token_(), consent: true, stopped: false, joined: 'share' };
    p.participants.push(person);
    this.db.prepare('INSERT INTO invites VALUES (?, ?, ?, ?)').run(hash(person.invite), digest, person.id, Date.now() + 7 * 86400000);
    note(s, `${label} joined from the shared link.`);
    this.persist(digest, s); this.emit({ digest, s, action: 'joined', actor: person.id, via: 'share', data: {} });
    return { digest, s, person };
  }
  // The host's evening-view link (/n/<token>): read the whole night and add ideas to it. Only a hash is stored.
  nightLink(digest) { const token = randomBytes(18).toString('base64url'); this.db.prepare('INSERT INTO night_links VALUES (?,?,?)').run(hash(token), digest, Date.now() + 7 * 86400000); return token; }
  night(token) {
    const row = /^[\w-]{20,40}$/.test(token || '') && this.db.prepare('SELECT * FROM night_links WHERE digest_hash=?').get(hash(token));
    if (!row || row.expires < Date.now()) fail(410, 'This link has expired. Text Rall-e for a fresh one.');
    return { digest: row.session, s: this.load(row.session) };
  }
  guest(invite) {
    const row = this.db.prepare('SELECT * FROM invites WHERE digest=?').get(hash(invite));
    if (!row || row.expires < Date.now()) fail(410, 'This invitation has expired or is no longer available. Ask your host for a fresh link.');
    const session = this.db.prepare('SELECT state FROM sessions WHERE id=?').get(row.session);
    if (!session) fail(410, 'This plan is no longer available.');
    const s = JSON.parse(session.state), person = s.plan.participants.find(p => p.id === row.participant);
    if (!person) fail(410, 'This invitation is no longer available.');
    return { row, s, person };
  }
  view(s, guestId = null) {
    // Real outings (from discovery) referenced by this plan travel with the view so the page can show them.
    const extra = [...new Set([...s.plan.stops, ...s.plan.suggestions.map(x => x.eventId), s.recommendation].filter(Boolean))].map(eventById).filter(e => e && !EVENTS.includes(e));
    const shared = { id: s.id, name: s.name, city: s.city, revision: s.revision, plan: s.plan, activity: s.activity, events: [...EVENTS, ...extra], guestId, limits: { stops: MAX_STOPS } };
    if (!guestId) return { ...s, ...shared };
    return { ...shared, plan: { ...s.plan, participants: s.plan.participants.map(({ invite, consent, stopped, ...p }) => ({ ...p, ...(p.id === guestId ? { consent, stopped } : {}) })) } };
  }
  hostAction(id, action, data = {}) { return this.hostActionAt(this.resolve(id), action, data); }
  hostActionAt(digest, action, data = {}, meta = {}) {
    const s = this.load(digest), p = s.plan, added = [];
    const active = () => { if (p.status !== 'proposed') fail(409, 'This plan is already closed for changes.'); };
    switch (action) {
      case 'location': s.stage = 'vibe'; say(s, 'user', 'Hollywood sounds right.'); say(s, 'assistant', 'Perfect. What are you feeling this weekend — dinner, live shows, museums, or a little time outside?'); break;
      case 'vibe': { const category = clean(data.category, 30); preference(s, category, 1); say(s, 'user', `I’m feeling ${category}.`); recommend(s, category); break; }
      case 'accept': {
        active(); const e = eventById(data.eventId || s.recommendation); if (!e) fail(400, 'Choose an outing first.');
        p.stops = [e.id]; p.title = e.short; s.recommendation = e.id; s.stage = 'invite'; preference(s, e.category, 1);
        say(s, 'user', 'Love it. Let’s make a plan.'); say(s, 'assistant', `Good call. ${e.short}, Saturday. Who should we loop in? Mike and Dave are in your demo circle, or you can add someone else.`); note(s, 'You started a plan.'); break;
      }
      case 'alternative': active(); if (s.recommendation) preference(s, eventById(s.recommendation).category, -1); say(s, 'user', 'Not my thing. What else is out there?'); recommend(s, data.category, s.recommendation); break;
      case 'invite': {
        active(); if (!p.stops.length) fail(400, 'Pick a plan before inviting friends.');
        if (!Array.isArray(data.names) || !data.names.length || data.names.length > 20) fail(400, 'Choose at least one friend.');
        for (const value of data.names) {
          const name = clean(value, 40); if (p.participants.some(person => person.name.toLowerCase() === name.toLowerCase())) continue;
          const person = { id: randomUUID(), name, response: 'pending', invite: token(), consent: false, stopped: false };
          p.participants.push(person); added.push(person.id);
          this.db.prepare('INSERT INTO invites VALUES (?, ?, ?, ?)').run(hash(person.invite), digest, person.id, Date.now() + 7 * 86400000);
        }
        s.stage = 'planning'; say(s, 'assistant', 'Your page is ready. Share a personal invite link with each friend — one tap to join, no app or account. I’ll keep the responses together here.'); note(s, 'Personal invite links created. No texts sent.'); break;
      }
      case 'mode': active(); if (!['locked', 'loose'].includes(data.mode)) fail(400, 'Choose locked or loose.'); p.mode = data.mode; note(s, data.mode === 'loose' ? 'Friends can suggest other ideas.' : 'The host locked the itinerary.'); break;
      case 'addStop': {
        active(); if (p.stops.length >= MAX_STOPS) fail(400, `Keep this demo to ${MAX_STOPS} stops.`);
        if (!eventById(data.eventId) || p.stops.includes(data.eventId)) fail(400, 'Choose a different stop.');
        if (data.suggestion) p.suggestions = p.suggestions.filter(x => x.id !== data.suggestion); // adopted from the ideas list
        p.stops.push(data.eventId); p.stops.sort((a,b) => ['museum','trail','dinner','comedy','rooftop'].indexOf(a) - ['museum','trail','dinner','comedy','rooftop'].indexOf(b));
        note(s, 'You added a stop to the plan.'); break;
      }
      case 'removeStop': active(); if (p.stops.length < 2) fail(400, 'Keep at least one stop.'); p.stops = p.stops.filter(x => x !== data.eventId); break;
      case 'selectSuggestion': {
        active(); const suggestion = p.suggestions.find(x => x.id === data.id); if (!suggestion) fail(404, 'Suggestion not found.');
        p.stops = [suggestion.eventId]; p.title = eventById(suggestion.eventId).short; p.suggestions = []; note(s, 'You chose the group’s new idea.'); break;
      }
      case 'confirm': active(); if (!p.stops.length) fail(400, 'Choose an outing first.'); p.status = 'confirmed'; say(s, 'assistant', 'It’s a plan. Your page now shows the confirmed details. You can preview an update for your friends below.'); note(s, 'You confirmed the plan.'); break;
      case 'happened': if (p.status !== 'confirmed') fail(409, 'Confirm the plan first.'); p.status = 'happened'; p.stops.forEach(x => preference(s, eventById(x).category, 2)); note(s, 'Marked as happened. Your preferences have been updated.'); say(s, 'assistant', 'That’s one for the memory bank. I’ll keep those interests in mind for next weekend.'); break;
      case 'reopen': if (p.status !== 'confirmed') fail(409, 'Only a confirmed plan can be reopened.'); p.status = 'proposed'; p.mode = 'loose'; note(s, 'You reopened the plan for changes.'); break;
      case 'drop': if (!['proposed','confirmed'].includes(p.status)) fail(409, 'This plan is already closed.'); p.status = 'dropped'; note(s, 'You dropped this plan.'); say(s, 'assistant', 'No worries. This plan is closed; your friends can see the update on the page.'); break;
      case 'recurring': s.recurring = Boolean(data.enabled); if (s.stopped && s.recurring) fail(409, 'Messaging is stopped. Start a new demo to opt in again.'); note(s, s.recurring ? 'Weekend nudges opted in (demo only).' : 'Weekend nudges turned off.'); break;
      case 'nudge': {
        if (!['weekend','followup'].includes(data.kind)) fail(400, 'Choose a nudge type.');
        if (s.stopped) fail(409, 'Messaging is stopped.');
        if (data.kind === 'weekend' && !s.recurring) fail(409, 'Opt in to weekend recommendations first.');
        if (data.kind === 'followup' && (!p.stops.length || p.status !== 'proposed')) fail(409, 'There is no unfinished plan to follow up.');
        if (s.nudges.includes(data.kind)) fail(409, 'This demo nudge has already been previewed.');
        s.nudges.push(data.kind);
        if (data.kind === 'weekend') { const category = Object.entries(s.preferences).sort((a,b) => b[1] - a[1])[0]?.[0]; say(s, 'assistant', 'A little weekend nudge: I picked this with your recent reactions in mind.'); recommend(s, category); }
        else say(s, 'assistant', `Your ${p.title.toLowerCase()} plan is still open. ${p.participants.filter(x => x.response === 'pending').length} friends haven’t replied. Want to give it a nudge or confirm what you have?`);
        note(s, 'Scheduled-message preview generated. Nothing sent.'); break;
      }
      case 'removeGuest': {
        const who = p.participants.find(x => x.id === data.id || x.name.toLowerCase() === String(data.name || '').trim().toLowerCase()); if (!who) fail(404, 'Nobody by that name on this plan.');
        p.participants = p.participants.filter(x => x !== who); p.suggestions = p.suggestions.filter(x => x.by !== who.id).map(x => ({ ...x, votes: x.votes.filter(v => v !== who.id) }));
        this.db.prepare('DELETE FROM invites WHERE session=? AND participant=?').run(digest, who.id); note(s, `You removed ${who.name}.`); break;
      }
      case 'rename': s.name = clean(data.name, 40); break;
      case 'chat': note(s, `${s.name}: ${clean(data.text, 320)}`); break;
      case 'city': s.city = clean(data.label, 80); if (s.stage === 'location') s.stage = 'vibe'; break;
      default: fail(400, 'Unknown action.');
    }
    p.title = titleFor(p);
    this.persist(digest, s);
    this.emit({ digest, s, action, actor: 'host', via: meta.via || 'web', data: { ...data, added } });
    return s;
  }
  chat(id, text) { return this.chatAt(this.resolve(id), text); }
  chatAt(digest, text) {
    const s = this.load(digest); text = clean(text); say(s, 'user', text);
    const t = text.toLowerCase(), e = eventById(s.recommendation || s.plan.stops[0]);
    if (/^stop[.!]?$/i.test(text)) { s.stopped = true; s.recurring = false; say(s, 'assistant', 'You’re opted out of demo messaging. No future message previews will be generated. You can still use your plan page.'); }
    else if (/^help[.!]?$/i.test(text)) say(s, 'assistant', 'Rall-e helps you discover outings and make plans with friends. This demo sends no real texts. Reply STOP to opt out of message previews, or use the page to manage your plan.');
    else if (s.stopped) say(s, 'assistant', 'Messaging is stopped. Your plan page is still available.');
    else if (s.stage === 'location' && /yes|yeah|hollywood|sounds|sure|right/.test(t)) { s.stage = 'vibe'; say(s, 'assistant', 'What are you feeling this weekend: dinner, live shows, museums, or nature?'); }
    else if (s.stage === 'location') say(s, 'assistant', 'This first demo explores Hollywood, Los Angeles. Other cities will come later. Shall we try Hollywood for now?');
    else if (/\bdoors\b|\bstart\b|what time|\bwhen\b/.test(t) && e) say(s, 'assistant', `${e.short}: ${e.time}. Doors / arrival: ${e.doors}. Plan on ${e.duration}. These are curated demo details.`);
    else if (/price|cost|much|free|budget|cheap/.test(t) && e && !categoryFrom(t)) say(s, 'assistant', `${e.short} is ${e.price ? `$${e.price} per person` : 'free'} in our sample listing. Nothing is booked or charged. The nature outing is a free alternative.`);
    else if (/21|age|kids|under/.test(t) && e) say(s, 'assistant', `The sample age policy for ${e.venue} is ${e.age}.`);
    else if (/access|wheelchair|steps/.test(t) && e) say(s, 'assistant', `${e.accessibility} This is sample venue information; verify it with a real venue before attending.`);
    else if (/where|address|location/.test(t) && e) say(s, 'assistant', `${e.venue} is a fictional demo venue in ${e.area}. There’s no real address or live availability to verify in this prototype.`);
    else if (/book|pay|split|reserv/.test(t)) say(s, 'assistant', 'I can help discover an outing and get the group together. Booking and payments aren’t part of this demo.');
    else if (categoryFrom(t)) { if (e && /not|instead|rather|no|hate/.test(t)) preference(s, e.category, -1); const category = categoryFrom(t); preference(s, category === 'comedy' ? 'live shows' : category, 1); recommend(s, category, e?.id); }
    else if (/god no|not my|something else|what else|different|no thanks/.test(t)) { if (e) preference(s, e.category, -1); recommend(s, null, e?.id); }
    else if (/friend|mike|dave|sarah|loop|invite/.test(t)) say(s, 'assistant', 'Choose your people below, then create their personal links. You control who gets the invitation; entering a name doesn’t send a text.');
    else if (/yes|love|let.?s|sounds good|\bin\b/.test(t) && e) say(s, 'assistant', 'I like it too. Tap “Make this the plan” on the recommendation to save it, then we’ll loop in your friends.');
    else say(s, 'assistant', 'Tell me the kind of outing you’re after — quieter dinner, comedy, art, or something outdoors. You can also ask about the time, price, age policy, or accessibility of this idea.');
    return this.persist(digest, s);
  }
  guestAction(invite, action, data = {}, meta = {}) {
    const { row, s, person } = this.guest(invite), p = s.plan;
    if (action === 'consent') { if (person.stopped && data.enabled) fail(409, 'This guest has opted out. Ask the host for a new invitation.'); person.consent = Boolean(data.enabled); person.consentAt = now(); }
    else if (action === 'text' && /^stop$/i.test(data.text || '')) { person.stopped = true; person.consent = false; note(s, `${person.name} stopped demo plan messages.`); }
    else if (action === 'text' && /^help$/i.test(data.text || '')) { /* read-only informational response shown in UI */ }
    else if (['rsvp','text','smsReply'].includes(action)) {
      if (['happened','dropped'].includes(p.status)) fail(409, 'This plan is closed.');
      if (action !== 'rsvp' && person.stopped) fail(409, 'Messaging is stopped. You can still respond on the page.');
      const response = action !== 'rsvp' ? ({yes:'yes',maybe:'maybe',no:'no'})[(data.text || '').toLowerCase()] : data.response;
      if (!['yes','maybe','no'].includes(response)) fail(400, 'Try YES, MAYBE, NO, STOP, or HELP.');
      person.response = response; note(s, `${person.name} ${response === 'yes' ? 'is in' : response === 'maybe' ? 'is a maybe' : 'can’t make it'}${action === 'text' ? ' (text simulation)' : action === 'smsReply' ? ' (SMS)' : ''}.`);
      say(s, 'assistant', `${person.name} ${response === 'yes' ? 'is in!' : response === 'maybe' ? 'might join.' : 'can’t make it this time.'} Your page is up to date.`);
    } else if (action === 'suggest') {
      if (p.mode !== 'loose' || p.status !== 'proposed') fail(403, 'This plan is closed to suggestions.');
      if (!eventById(data.eventId)) fail(400, 'Choose an available outing.');
      if (p.stops.includes(data.eventId)) fail(400, 'That outing is already on the plan.');
      p.suggestions = p.suggestions.filter(x => x.by !== person.id);
      p.suggestions.push({ id: randomUUID(), by: person.id, name: person.name, eventId: data.eventId, reason: data.reason ? clean(data.reason, 200) : '', votes: [person.id] });
      note(s, `${person.name} suggested another idea.`);
    } else if (action === 'vote') {
      if (p.mode !== 'loose' || p.status !== 'proposed') fail(403, 'Voting is closed.');
      const suggestion = p.suggestions.find(x => x.id === data.id); if (!suggestion) fail(404, 'That idea is no longer available.');
      suggestion.votes = suggestion.votes.includes(person.id) ? suggestion.votes.filter(x => x !== person.id) : [...suggestion.votes, person.id];
    } else if (action === 'chat') {
      // A group message from a guest (SMS relay). Recorded on the shared activity feed.
      if (person.stopped) fail(409, 'Messaging is stopped. You can still respond on the page.');
      note(s, `${person.name}: ${clean(data.text, 320)}`);
    } else fail(400, 'Unknown guest action.');
    s.revision++; this.db.prepare('UPDATE sessions SET state=? WHERE id=?').run(JSON.stringify(s), row.session);
    const via = meta.via || (action === 'smsReply' ? 'sms' : 'web');
    this.emit({ digest: row.session, s, action, actor: person.id, via, data });
    return this.view(s, person.id);
  }
  close() { this.db.close(); }
}
