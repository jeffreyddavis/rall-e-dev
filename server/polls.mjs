// Group polls (Donovan's "Pick one / Rank these / Your call" design): a host asks Rall-e to let the group choose between
// options. Everyone on the plan gets a personal link (rall-e.ai/q/<token>) where they pick one, rank them, or leave it to
// the host. The host is texted as answers come in, and Rall-e sees the tally so it can lock in the winner.
import { randomBytes } from 'node:crypto';
import { fail, clean } from './store.mjs';
import { eventById } from './catalog.mjs';
import { distance } from './discovery.mjs';
import { stats } from './stats.mjs';

const token = () => randomBytes(12).toString('base64url');

export class Polls {
  constructor(sms) {
    this.sms = sms; this.db = sms.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, digest TEXT NOT NULL, plan TEXT NOT NULL, title TEXT NOT NULL, asker TEXT NOT NULL, ids TEXT NOT NULL, created INTEGER NOT NULL, closed INTEGER);
      CREATE TABLE IF NOT EXISTS poll_people (token TEXT PRIMARY KEY, poll TEXT NOT NULL, participant TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS poll_answers (poll TEXT NOT NULL, participant TEXT NOT NULL, mode TEXT NOT NULL, pick TEXT, ranking TEXT, at INTEGER NOT NULL, PRIMARY KEY (poll, participant));`);
  }
  get base() { return this.sms.base || 'https://rall-e.ai'; }
  url(t) { return `${this.base}/q/${t}`; }
  // Host asks the group. Friends who get Rall-e texts are texted their link; the rest are listed for the host to forward.
  create(t, { title, eventIds }) {
    const s = t.s, p = s.plan, flow = this.sms.flow;
    const ids = [...new Set(eventIds || [])].filter(id => eventById(id)).slice(0, 8);
    if (ids.length < 2) fail(400, 'Error: a poll needs at least 2 options (ids from find_things).');
    if (!p.participants.length) fail(409, 'Error: nobody is on the plan yet. Invite friends first, then start the poll.');
    const id = token(), name = clean(title || '', 60) || p.title;
    this.db.prepare('UPDATE polls SET closed=? WHERE plan=? AND closed IS NULL').run(Date.now(), s.id); // one open poll per plan
    this.db.prepare('INSERT INTO polls VALUES (?,?,?,?,?,?,?,NULL)').run(id, t.digest, s.id, name, s.name, JSON.stringify(ids), Date.now());
    const add = (participant, who) => { const tk = token(); this.db.prepare('INSERT INTO poll_people VALUES (?,?,?,?)').run(tk, id, participant, who); return tk; };
    const host = add('', s.name), texted = [], forward = [];
    const live = new Set(flow.recipients(t.digest, s).filter(r => r.role === 'guest').map(r => r.participant));
    for (const person of p.participants.filter(x => x.response !== 'no')) {
      const link = this.url(add(person.id, person.name));
      const row = live.has(person.id) && flow.db.prepare('SELECT phone FROM sms_threads WHERE digest=? AND plan=? AND participant=?').get(t.digest, s.id, person.id);
      if (row && this.sms.allowed.has(row.phone)) { flow.reply(row.phone, `Rall-e: ${s.name} wants the group’s take on ${name}. Pick your favorite, rank them, or leave it to ${s.name}: ${link}`, 'poll'); texted.push(person.name); }
      else forward.push({ name: person.name, link });
    }
    stats.bump('polls_created', 1, t.phone);
    return { id, title: name, hostLink: this.url(host), texted, forward, options: ids.length };
  }
  who(tk) {
    const row = /^[\w-]{16}$/.test(String(tk || '')) && this.db.prepare('SELECT p.*, q.* FROM poll_people p JOIN polls q ON q.id = p.poll WHERE p.token=?').get(tk);
    if (!row) fail(404, 'This link isn’t working. Ask Rall-e for a fresh one.');
    return row;
  }
  people(poll) { return this.db.prepare('SELECT participant, name FROM poll_people WHERE poll=? ORDER BY rowid').all(poll); }
  answers(poll) { return Object.fromEntries(this.db.prepare('SELECT * FROM poll_answers WHERE poll=?').all(poll).map(a => [a.participant, { ...a, ranking: a.ranking ? JSON.parse(a.ranking) : null }])); }
  // Points: a pick is worth the most; rankings count by position; "your call" leaves it to the host.
  tally(poll) {
    const ids = JSON.parse(this.db.prepare('SELECT ids FROM polls WHERE id=?').get(poll).ids), score = Object.fromEntries(ids.map(id => [id, 0])), picks = Object.fromEntries(ids.map(id => [id, 0]));
    for (const a of Object.values(this.answers(poll))) {
      if (a.mode === 'pick' && a.pick in score) { score[a.pick] += ids.length; picks[a.pick]++; }
      if (a.mode === 'rank') a.ranking.filter(id => id in score).forEach((id, i) => { score[id] += ids.length - 1 - i; });
    }
    const order = ids.slice().sort((a, b) => score[b] - score[a]);
    return { order, score, picks };
  }
  view(tk) {
    const me = this.who(tk), people = this.people(me.poll), answers = this.answers(me.poll), ids = JSON.parse(me.ids);
    const s = this.sms.store.load(me.digest), hostPhone = this.sms.flow.hostPhone?.(me.digest), from = hostPhone && this.sms.discovery.location(hostPhone);
    const photo = pid => { try { return this.sms.store.photoOf?.(s, pid) || null; } catch { return null; } };
    const miles = e => from?.lat != null && e.lat != null ? Math.round(distance(from, e) / 1609.34 * 10) / 10 : null;
    return { title: me.title, asker: me.asker, closed: Boolean(me.closed), isHost: me.participant === '', me: me.name,
      answered: people.filter(x => answers[x.participant]).length, total: people.length,
      mine: answers[me.participant] ? { mode: answers[me.participant].mode, pick: answers[me.participant].pick, ranking: answers[me.participant].ranking } : null,
      people: people.map(x => ({ id: x.participant || 'host', name: x.name, you: x.participant === me.participant, photo: photo(x.participant), answer: answers[x.participant] ? { mode: answers[x.participant].mode, pick: answers[x.participant].pick, rank: answers[x.participant].ranking } : null })),
      options: ids.map(id => eventById(id)).filter(Boolean).map(e => ({ id: e.id, short: e.short, kind: e.typeLabel || (e.category ? e.category[0].toUpperCase() + e.category.slice(1) : 'Event'), priceText: e.priceText, time: e.time, venue: e.venue, address: e.address,
        area: e.area, image: e.image, description: e.description, rating: e.rating, url: e.url, miles: miles(e), color: e.color })),
      tally: me.participant === '' || me.closed ? this.tally(me.poll) : null };
  }
  answer(tk, { mode, pick, ranking }) {
    const me = this.who(tk), ids = JSON.parse(me.ids);
    if (me.closed) fail(409, 'This poll is closed. The plan has been decided.');
    if (!['pick', 'rank', 'defer'].includes(mode)) fail(400, 'Pick one, rank them, or leave it to the host.');
    if (mode === 'pick' && !ids.includes(pick)) fail(400, 'Pick one of the options.');
    const order = mode === 'rank' ? [...new Set(ranking || [])].filter(id => ids.includes(id)) : null;
    if (mode === 'rank' && order.length !== ids.length) fail(400, 'Rank all of the options.');
    const first = !this.db.prepare('SELECT 1 FROM poll_answers WHERE poll=? AND participant=?').get(me.poll, me.participant);
    this.db.prepare('INSERT OR REPLACE INTO poll_answers VALUES (?,?,?,?,?,?)').run(me.poll, me.participant, mode, mode === 'pick' ? pick : null, order ? JSON.stringify(order) : null, Date.now());
    stats.bump(`poll_${mode}`, 1, me.participant || 'host');
    if (me.participant !== '') this.tellHost(me, mode === 'pick' ? `picked ${eventById(pick).short}` : mode === 'rank' ? `ranked them (#1: ${eventById(order[0]).short})` : `is happy with whatever you pick`, first);
    return this.view(tk);
  }
  tellHost(me, what, first) {
    const phone = this.sms.flow.hostPhone?.(me.digest); if (!phone) return;
    const people = this.people(me.poll), answers = this.answers(me.poll), done = people.filter(x => answers[x.participant]).length, guests = people.filter(x => x.participant);
    const guestsDone = guests.filter(x => answers[x.participant]).length, t = this.tally(me.poll), lead = eventById(t.order[0]);
    const all = guestsDone === guests.length;
    this.sms.flow.reply(phone, all
      ? `Rall-e: everyone has weighed in on ${me.title}. ${lead.short} comes out on top. Want me to lock it in? Results: ${this.url(this.db.prepare("SELECT token FROM poll_people WHERE poll=? AND participant=''").get(me.poll).token)}`
      : `Rall-e: ${me.name} ${what}${first ? '' : ' (changed their answer)'} for ${me.title}. ${done} of ${people.length} answered; ${lead.short} leads.`, 'poll');
  }
  // For the agent's situation line.
  openFor(planId) {
    const p = this.db.prepare('SELECT * FROM polls WHERE plan=? AND closed IS NULL ORDER BY created DESC LIMIT 1').get(planId); if (!p) return '';
    const people = this.people(p.id), answers = this.answers(p.id), t = this.tally(p.id);
    return `Open poll "${p.title}": ${people.filter(x => answers[x.participant]).length} of ${people.length} answered. Standing: ${t.order.map(id => `${eventById(id)?.short} (${t.score[id]} pts, ${t.picks[id]} picks)`).join(', ')}. Waiting on: ${people.filter(x => !answers[x.participant]).map(x => x.name).join(', ') || 'nobody'}.`;
  }
  close(planId) { this.db.prepare('UPDATE polls SET closed=? WHERE plan=? AND closed IS NULL').run(Date.now(), planId); }
}
