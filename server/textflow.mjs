// Two-way SMS collaboration: hosts plan by text, guests RSVP/suggest/vote/ask/chat by text,
// and every plan change fans out to the people on that plan who are reachable by text.
// All outbound goes through Sms.deliver(), which enforces preview mode, the tester allowlist,
// STOP, and daily caps. Nothing here talks to Twilio directly.
import { randomUUID, randomBytes } from 'node:crypto';
import { EVENTS, MAX_STOPS, eventById, categoryFrom } from './catalog.mjs';
import { Agent } from './agent.mjs';
import { scrubCards } from './vault.mjs';
import { stats } from './stats.mjs';
import { legText } from './discovery.mjs';
import { parseVcards } from './photos.mjs';
const isCard = m => /vcard|x-vcard|text\/directory/i.test(m?.type || '') || /\.vcf(\?|$)/i.test(m?.url || '');

const VIBES = [['1', 'dinner', 'Dinner'], ['2', 'live shows', 'Live shows'], ['3', 'museums', 'Museums & art'], ['4', 'nature', 'Outdoors']];
const YES = /^(y|yes|yep|yeah|yup|sure|ok|okay|i'?m in|im in|in|count me in|let'?s do it|let'?s go|sounds good|love it|absolutely|definitely)[.!]*$/i;
const MAYBE = /^(maybe|possibly|might|not sure|perhaps|tbd)[.!]*$/i;
const NO = /^(n|no|nope|nah|can'?t|cant|can'?t make it|i'?m out|im out|out|pass)[.!]*$/i;
const QUESTION = /\?\s*$|^(what|when|where|how|is|are|does|do|can|who|any|which|will)\b/i;
const pretty = response => ({ yes: 'is in', maybe: 'is a maybe', no: 'can’t make it', pending: 'hasn’t replied' })[response];
const firstWord = text => text.trim().split(/\s+/)[0].toUpperCase().replace(/[^A-Z]/g, '');
const rest = text => text.trim().replace(/^\S+\s*/, '');
const priceOf = e => e.price ? `$${e.price}/person (sample)` : 'free';
const list = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

// Reactions sent from phones that can't send tapbacks arrive as text, e.g. `Liked “See you at 6”` (iPhone → SMS)
// or `👍 to “See you at 6”` / `Reacted 😂 to “…”` (Android). Present them to the agent as reactions, not chat.
const VERBS = { Liked: '👍', Loved: '❤️', 'Laughed at': '😂', Emphasized: '‼️', Disliked: '👎', Questioned: '❓' };
export function reactionText(text) {
  let m = /^(Liked|Loved|Laughed at|Emphasized|Disliked|Questioned) [“"](.*)[”"]$/s.exec(text);
  if (m) return `[Reacted ${VERBS[m[1]]} to your message: "${m[2].slice(0, 120)}"]`;
  m = /^(?:Reacted )?(\p{Extended_Pictographic}[\p{Extended_Pictographic}\u200d\ufe0f\p{Emoji_Modifier}]*) (?:to|reacted to) [“"](.*)[”"]$/su.exec(text);
  if (m) return `[Reacted ${m[1]} to your message: "${m[2].slice(0, 120)}"]`;
  return text;
}
export function findEvent(text, exclude = []) {
  const t = text.toLowerCase();
  const named = EVENTS.find(e => !exclude.includes(e.id) && [e.short, e.venue, e.id].some(x => t.includes(x.toLowerCase())));
  if (named) return named;
  const category = categoryFrom(t);
  if (!category) return null;
  if (category === 'comedy') return exclude.includes('comedy') ? null : eventById('comedy');
  return EVENTS.find(e => e.category === category && !exclude.includes(e.id)) || null;
}

export function parseInvitees(text) {
  const out = [];
  for (const chunk of text.replace(/^invite\s*/i, '').split(/[,;\n&]|\band\b/i)) {
    const phoneMatch = chunk.match(/\+?\(?\d[\d\s().-]{8,}\d/);
    const name = chunk.replace(phoneMatch?.[0] || '', '').replace(/[^\p{L}\s'’-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 40 || name.split(' ').length > (phoneMatch ? 3 : 2) || YES.test(name) || NO.test(name)) continue;
    out.push({ name: name.replace(/\b\p{Ll}/gu, c => c.toUpperCase()), phone: phoneMatch?.[0] || '' });
  }
  return out;
}

const OPTIN_NOTE = 'Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.';
export class TextFlow {
  constructor(store, sms) {
    this.store = store; this.sms = sms; this.db = store.db; this.fanout = 0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS sms_threads (
        phone TEXT NOT NULL, digest TEXT NOT NULL, plan TEXT NOT NULL, participant TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL, muted INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL,
        PRIMARY KEY (phone, digest, plan, participant));
      CREATE TABLE IF NOT EXISTS sms_pending (phone TEXT PRIMARY KEY, stage TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sms_cards (phone TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS option_sets (id TEXT PRIMARY KEY, phone TEXT NOT NULL, ids TEXT NOT NULL, pick TEXT, changes INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS host_contacts (digest TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (digest, name_key));`);
    this.agent = new Agent(this, sms.env, sms.fetchImpl); this.chains = new Map();
    store.listen(event => { this.fanout = this.onPlanEvent(event); });
  }

  // ---------- threads ----------
  link(phone, digest, s, role, participant = '') {
    this.db.prepare('INSERT INTO sms_threads(phone,digest,plan,participant,role,muted,updated) VALUES(?,?,?,?,?,0,?) ON CONFLICT(phone,digest,plan,participant) DO UPDATE SET updated=excluded.updated, muted=0')
      .run(phone, digest, s.id, participant, role, Math.max(Date.now(), (this.db.prepare('SELECT MAX(updated) AS m FROM sms_threads').get().m || 0) + 1));
  }
  threadsFor(phone) {
    const rows = this.db.prepare('SELECT * FROM sms_threads WHERE phone=? ORDER BY updated DESC').all(phone);
    return rows.flatMap(row => {
      try {
        const s = this.store.load(row.digest); if (s.id !== row.plan) return [];
        if (row.role === 'host') return [{ ...row, s }];
        const person = s.plan.participants.find(p => p.id === row.participant);
        const invite = person && this.db.prepare('SELECT expires FROM invites WHERE session=? AND participant=?').get(row.digest, person.id);
        return invite && invite.expires > Date.now() ? [{ ...row, s, person }] : [];
      } catch { return []; }
    });
  }
  hadThreads(phone) { return Boolean(this.db.prepare('SELECT 1 FROM sms_threads WHERE phone=? LIMIT 1').get(phone)); }
  recipients(digest, s) {
    return this.db.prepare('SELECT * FROM sms_threads WHERE digest=? AND plan=? AND muted=0').all(digest, s.id).filter(row => {
      if (row.role === 'host') return !s.stopped;
      const person = s.plan.participants.find(p => p.id === row.participant);
      return person && !person.stopped;
    });
  }
  link_(s, person) { return `${this.sms.base || 'https://rall-e.ai'}/p/${person.invite}`; }

  // ---------- inbound ----------
  // Texts from one phone are handled in order. With ANTHROPIC_API_KEY set, Claude handles the conversation;
  // otherwise (or if the model call fails) the keyword engine below does.
  enqueue(phone, body, opts = {}) {
    if (!this.agent.enabled) return Promise.resolve(this.receive(phone, body, opts));
    const run = (this.chains.get(phone) || Promise.resolve()).then(() => this.handle(phone, body, opts)).catch(error => console.error('Text handling failed:', error.message));
    this.chains.set(phone, run); run.finally(() => { if (this.chains.get(phone) === run) this.chains.delete(phone); });
    return run;
  }
  idle() { return Promise.all([...this.chains.values()]); }
  async handle(phone, body, opts) {
    const said = reactionText(String(body || '').trim().slice(0, 640));
    let text = opts.media ? (said ? `${said}\n[sent a photo]` : '[sent a photo]') : said;
    if (opts.media && isCard(opts.media)) text = `${said ? `${said}\n` : ''}${await this.contactCard(phone, opts.media)}`;
    if (this.pre(phone, text, opts)) return;
    this.sms.typing(phone); // iMessage "…" bubble while the agent thinks
    let reply;
    for (let attempt = 1; attempt <= 2 && reply === undefined; attempt++) {
      try { reply = await this.agent.respond(phone, text); }
      catch (error) { console.error(`Agent attempt ${attempt} failed:`, error.message); if (attempt === 1) await new Promise(r => setTimeout(r, 800)); }
    }
    if (reply === undefined) {
      stats.gap('ai_reply_failed', 'Rall-e could not answer a text (the AI call failed twice)', 'auto', phone);
      // With live search on, the keyword engine would pitch fictional samples, so just ask again.
      if (this.sms.discovery.enabled) this.reply(phone, 'Sorry, I hit a snag on my end. Could you send that again?');
      else this.route(phone, text);
      return;
    }
    await this.finish(phone, reply);
  }
  // Sends an agent reply: the text (with any emoji reaction for SMS), then option cards, then the contact card once.
  async finish(phone, reply) {
    // Android/SMS can't show tapbacks: a reaction the agent chose rides along as an emoji in the text.
    const emoji = this.agent.pendingEmoji.get(phone); this.agent.pendingEmoji.delete(phone);
    const out = emoji ? `${emoji} ${reply || ''}`.trim() : reply;
    if (out) this.reply(phone, out);
    // Option cards: each link alone in its own message, so iMessage / Google Messages draw a rich preview card.
    const cards = this.agent.pendingCards.get(phone) || []; this.agent.pendingCards.delete(phone);
    // All cards in one reply share an option set, so each link opens a page listing every option with "My pick".
    const set = cards.length ? this.optionSet(phone, cards) : '';
    // Render the preview images first: iMessage builds the card as the link is sent, and a slow image leaves a grey box.
    if (cards.length && this.sms.og) await Promise.race([Promise.all(cards.slice(0, 3).map(id => this.sms.og.render(eventById(id)).catch(() => null))), new Promise(r => setTimeout(r, 8000))]);
    // At most 3 preview cards (more floods the thread); the set behind every card holds all the options.
    // Plain SMS (Android, or anyone on green bubbles) draws no link preview, so there the card goes as a picture message:
    // the same preview image attached, with a one-line title above the link.
    const base = this.sms.base || 'https://rall-e.ai', green = this.onSms(phone);
    for (const id of cards.slice(0, 3)) {
      const link = `${base}/e/${id}?s=${set}`, e = eventById(id);
      if (green && e) this.sms.deliver(phone, `${e.short}${e.time ? ` · ${e.time}` : ''}\n${link}`, { kind: 'option', media: `${base}/og/e/${id}.jpg` });
      else this.sms.deliver(phone, link, { kind: 'option' });
    }
    if (this.threadsFor(phone).length) this.sendCard(phone); // once per phone; no-op afterwards
  }
  onSms(phone) {
    if (this.sms.provider !== 'sendblue') return true;
    const service = this.sms.lastIn?.get(phone)?.service;
    if (this.sms.lastLine(phone) === 'sendblue') return service !== 'RCS' && service !== 'iMessage' && this.sms.phoneService(phone)?.service === 'SMS'; // RCS draws link previews itself
    return this.sms.phoneService(phone)?.service === 'SMS' || service === 'SMS' || this.sms.sendblueRefused?.has(phone);
  }
  // ---------- joining a shared night ----------
  hostPhone(digest) { return this.db.prepare("SELECT phone FROM sms_threads WHERE digest=? AND role='host' ORDER BY updated DESC").get(digest)?.phone || ''; }
  joinShared(phone, name, share) {
    const { s: before, digest } = this.store.sharedAt(share);
    if (this.hostPhone(digest) === phone) return { link: '', already: 'host' };
    const mine = this.threadsFor(phone).find(t => t.digest === digest && t.role === 'guest');
    if (mine) return { link: this.link_(mine.s, mine.person), already: 'guest' };
    const { s, person } = this.store.joinShared(share, name);
    this.link(phone, digest, s, 'guest', person.id);
    const first = eventById(s.plan.stops[0]);
    this.sms.deliver(phone, `You’re in for ${s.name}’s plan: ${s.plan.title}${first ? ` (starts at ${first.venue})` : ''}. Your page: ${this.link_(s, person)}\nText me here with questions or ideas. Texts to me are private; say “tell the group…” to share with everyone. Reply STOP to opt out.`, { kind: 'invite' });
    return { link: this.link_(s, person) };
  }
  // ---------- option sets (the /e/<id>?s=<set> page) ----------
  optionShare(set) {
    try { this.db.exec('ALTER TABLE option_sets ADD COLUMN share TEXT'); } catch {} // added after launch; no-op once it exists
    const row = this.db.prepare('SELECT share FROM option_sets WHERE id=?').get(set); if (row?.share) return row.share;
    const share = randomBytes(9).toString('base64url'); this.db.prepare('UPDATE option_sets SET share=? WHERE id=?').run(share, set); return share;
  }
  sharedOptions(share) {
    try { this.db.exec('ALTER TABLE option_sets ADD COLUMN share TEXT'); } catch {}
    const row = /^[\w-]{12}$/.test(share || '') && this.db.prepare('SELECT ids FROM option_sets WHERE share=? AND created>?').get(share, Date.now() - 14 * 86400000);
    return row ? JSON.parse(row.ids).filter(id => eventById(id)) : null;
  }
  optionSet(phone, ids) { const id = randomBytes(9).toString('base64url'); this.db.prepare('INSERT INTO option_sets(id,phone,ids,created) VALUES(?,?,?,?)').run(id, phone, JSON.stringify(ids), Date.now()); return id; }
  options(set) {
    const row = /^[\w-]{12}$/.test(set || '') && this.db.prepare('SELECT * FROM option_sets WHERE id=? AND created>?').get(set, Date.now() - 14 * 86400000);
    if (!row) return null;
    return { ...row, ids: JSON.parse(row.ids).filter(id => eventById(id)) };
  }
  // Tapping "My pick" tells Rall-e in the person's own thread, as if they'd texted it, so the conversation moves on.
  pick(set, eventId) {
    const row = this.options(set);
    if (!row) { const e = new Error('These options have expired. Text Rall-e for fresh ones.'); e.status = 410; throw e; }
    if (!row.ids.includes(eventId)) { const e = new Error('That option isn’t in this list.'); e.status = 400; throw e; }
    if (row.pick === eventId) return { pick: eventId };
    if (row.changes >= 6) { const e = new Error('Text Rall-e to change your pick again.'); e.status = 429; throw e; }
    this.db.prepare('UPDATE option_sets SET pick=?, changes=changes+1 WHERE id=?').run(eventId, set); stats.bump('my_picks', 1, row.phone);
    const e = eventById(eventId);
    if (this.agent.enabled && this.sms.live) this.enqueue(row.phone, `(Tapped "My pick" on ${e.short} [${e.id}] on the options page)`);
    return { pick: eventId };
  }
  // ---------- demo operator ----------
  // Rall-e texts first, following a behind-the-scenes instruction (e.g. "show off movie showtimes"). Queued in the
  // person's chain so it never overlaps a reply to them.
  operatorNudge(phone, instruction) {
    if (!this.agent.enabled) { const e = new Error('The texting agent is off.'); e.status = 409; throw e; }
    const run = (this.chains.get(phone) || Promise.resolve()).then(async () => {
      this.sms.typing(phone);
      stats.bump('operator_nudges', 1, phone);
      const reply = await this.agent.respond(phone, '', { operator: instruction });
      await this.finish(phone, reply);
    }).catch(error => console.error('Operator nudge failed:', error.message));
    this.chains.set(phone, run); run.finally(() => { if (this.chains.get(phone) === run) this.chains.delete(phone); });
    return run;
  }
  receive(phone, body, opts = {}) {
    const text = String(body || '').trim().slice(0, 640);
    if (this.pre(phone, text, opts)) return;
    return this.route(phone, text);
  }
  // Logging, opt-out and gatekeeping shared by both engines. Returns true when the text needs no further handling.
  pre(phone, text, { sid = `SIM${randomUUID()}`, optOutType = '', media = null } = {}) {
    // Card numbers never get stored or passed to the AI: scrub them and point the person to the secure vault page.
    const scrub = scrubCards(text);
    const logged = this.sms.log(phone, 'in', scrub.clean, { sid });
    // A photo they texted: kept briefly so "use this as my profile photo" works (only the link; nothing is downloaded yet).
    if (media?.url && !isCard(media)) { this.sms.lastMedia.set(phone, { ...media, at: Date.now() }); if (logged) this.db.prepare('UPDATE sms_log SET media=? WHERE id=?').run('photo', logged); }
    if (media?.url && isCard(media) && logged) this.db.prepare('UPDATE sms_log SET media=? WHERE id=?').run('contact', logged);
    if (scrub.found && !this.sms.isStopped(phone)) {
      this.reply(phone, 'For your safety I deleted that card number and didn’t save it. Please never text card details. I’ll send you a private link to add a card securely.', 'vault');
      if (this.sms.vault.enabled && this.threadsFor(phone).length) { try { this.sms.vault.sendLink(phone, 'card'); } catch (e) { if (!e.status) throw e; } }
      return true;
    }
    if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'].includes(text.toUpperCase()) || optOutType === 'STOP') {
      this.sms.stop(phone);
      for (const t of this.threadsFor(phone)) if (t.person) { try { this.store.guestAction(t.person.invite, 'text', { text: 'STOP' }, { via: 'sms' }); } catch {} }
      return true; // Twilio sends the carrier-required STOP confirmation.
    }
    if (['START', 'UNSTOP'].includes(text.toUpperCase()) || optOutType === 'START') { this.sms.unstop(phone); return true; }
    if (this.sms.isStopped(phone)) return true;
    const threads = this.threadsFor(phone);
    // Someone a host invited who texts Rall-e themselves has asked to talk to us: that text is their opt-in.
    // (Their very first reply still carries the opt-out and help wording.)
    if (this.sms.live && !this.sms.allowed.has(phone) && threads.some(t => t.role === 'guest')) {
      try {
        this.sms.canOptIn();
        this.sms.optIn(phone, 'texted-in-invited', `Texted Rall-e first after ${threads.find(t => t.role === 'guest').s.name} invited them. First reply included: ${OPTIN_NOTE}`);
        this.reply(phone, `Rall-e: you’re set up for texts about plans you’re invited to. ${OPTIN_NOTE}`, 'optin');
      } catch (e) { if (!e.status) throw e; }
    }
    if (/^help$/i.test(text) || optOutType === 'HELP') { this.reply(phone, this.help(threads[0])); return true; }
    if (/^(android|iphone)[.!]*$/i.test(text) && this.sms.provider === 'sendblue') {
      const android = /android/i.test(text);
      this.sms.setPhoneType(phone, android ? 'android' : 'iphone').catch(e => console.error(e.message));
      this.reply(phone, android ? 'Got it, regular texts it is. You can react with any emoji and I’ll get it.' : 'Great, I’ll switch you to iMessage.', 'reply');
      return true;
    }
    if (!threads.length && !this.db.prepare('SELECT 1 FROM sms_pending WHERE phone=?').get(phone) && !this.sms.canStart(phone)) {
      // Invite-only: someone who isn't a member gets one friendly answer (they texted us, so we may reply once), then quiet.
      if (!this.db.prepare("SELECT 1 FROM sms_log WHERE phone=? AND kind='waitlist' LIMIT 1").get(phone)) {
        this.sms.deliver(phone, `Hi! Rall-e is invite-only right now. If a friend is on Rall-e, ask them for their invite link, or join the waitlist at ${this.sms.base || 'https://rall-e.ai'} and we’ll save you a spot. Reply STOP to opt out.`, { kind: 'waitlist', inboundReply: true });
        stats.bump('waitlist_texts', 1, phone);
      }
      return true;
    }
    return false;
  }
  route(phone, text) {
    const word = firstWord(text);
    const threads = this.threadsFor(phone), current = threads[0];
    if (word === 'PLANS' && threads.length) return this.reply(phone, `Your plans:\n${threads.map((t, i) => `${i + 1}) ${t.s.plan.title}${t.role === 'host' ? ' (yours)' : ` (from ${t.s.name})`}`).join('\n')}\nReply SWITCH and a number to change which plan your texts go to.`);
    if (word === 'SWITCH' && threads.length) {
      const pick = threads[Number(rest(text)) - 1];
      if (!pick) return this.reply(phone, 'Reply PLANS to see your plans, then SWITCH 1, SWITCH 2…');
      this.link(phone, pick.digest, pick.s, pick.role, pick.participant);
      return this.reply(phone, `Now texting about ${pick.s.plan.title}. ${this.summary(pick.s, pick.person)}`);
    }
    if (!current) return this.onboard(phone, text);
    return current.role === 'host' ? this.host(phone, current, text) : this.guest(phone, current, text);
  }
  reply(phone, body, kind = 'reply') { return this.sms.deliver(phone, body, { kind }); }

  onboard(phone, text) {
    const pending = this.db.prepare('SELECT * FROM sms_pending WHERE phone=?').get(phone);
    if (pending?.stage === 'name') {
      const name = text.replace(/^(i'?m|it'?s|my name is|this is|call me)\s+/i, '').replace(/[^\p{L}\s'’-]/gu, '').trim().split(/\s+/)[0];
      if (!name || name.length > 30) return this.reply(phone, 'What first name should I use for your plans?');
      const nice = this.createHost(phone, name);
      const status = this.reply(phone, `Nice to meet you, ${nice}! I find things worth doing nearby and get your people together — all by text. This demo covers Hollywood, LA. Sound good? Reply YES.`);
      this.sendCard(phone); return status;
    }
    if (!this.sms.canStart(phone)) return; // Live mode: only approved testers can start a plan.
    this.db.prepare('INSERT OR REPLACE INTO sms_pending VALUES(?,?,?)').run(phone, 'name', Date.now());
    return this.reply(phone, `${this.hadThreads(phone) ? 'That plan has wrapped up. ' : ''}Hi, I’m Rall-e — I help friends make plans over text. What’s your first name? (Rall-e demo. Reply STOP to opt out.)`);
  }

  // ---------- host ----------
  host(phone, t, text) {
    const { digest } = t, word = firstWord(text);
    const act = (action, data = {}) => this.store.hostActionAt(digest, action, data, { via: 'sms' });
    let s = t.s, p = s.plan;
    const guard = fn => { try { return fn(); } catch (error) { if (!error.status) throw error; return this.reply(phone, `Rall-e: ${error.message}`); } };
    if (['NEW', 'RESTART'].includes(word)) {
      s = this.newPlan(phone, t).s;
      return this.reply(phone, 'Fresh start! Still planning around Hollywood, LA? Reply YES.');
    }
    if (['STATUS', 'PLAN', 'DETAILS'].includes(word) && p.stops.length) return this.reply(phone, this.summary(s));
    if (word === 'LINKS' && p.participants.length) return this.reply(phone, `Personal links (one per friend — don’t reuse):\n${p.participants.map(x => `${x.name}: ${this.link_(s, x)}`).join('\n')}`);

    if (s.stage === 'location') {
      if (YES.test(text) || /hollywood|sounds|right|yes/i.test(text)) { act('location'); return this.reply(phone, this.vibePrompt()); }
      return this.reply(phone, 'This first demo only covers Hollywood, Los Angeles. Want to plan something there? Reply YES.');
    }
    const vibe = VIBES.find(([n]) => text.trim() === n)?.[1] || (categoryFrom(text) === 'comedy' ? 'comedy' : categoryFrom(text));
    if (s.stage === 'vibe') {
      if (!vibe) return this.reply(phone, this.vibePrompt());
      s = act('vibe', { category: vibe }); return this.reply(phone, this.pitch(eventById(s.recommendation)));
    }
    if (s.stage === 'discover') {
      if (YES.test(text) || /^(make it the plan|let'?s plan|plan it|book it)/i.test(text)) {
        return guard(() => { act('accept'); return this.reply(phone, `Great pick. Who should we loop in? Text names and numbers, like “Mike 310-555-0101, Dave 310-555-0102”. Names without a number get a personal link you can forward.`); });
      }
      if (QUESTION.test(text) && this.answer(s, text, eventById(s.recommendation))) return this.reply(phone, this.answer(s, text, eventById(s.recommendation)));
      if (vibe) { s = act('vibe', { category: vibe }); return this.reply(phone, this.pitch(eventById(s.recommendation))); }
      if (NO.test(text) || /something else|what else|not (my|really)|other|different|another/i.test(text)) { s = act('alternative'); return this.reply(phone, this.pitch(eventById(s.recommendation))); }
      return this.reply(phone, 'Reply YES to make it the plan, NO for another idea, or tell me a vibe (dinner, comedy, art, outdoors).');
    }
    // A plan exists (invite / planning / confirmed / closed).
    if (word === 'INVITE' || (s.stage === 'invite' && !QUESTION.test(text))) {
      const invitees = parseInvitees(text);
      if (!invitees.length) return this.reply(phone, 'Text names and numbers, like “INVITE Sarah 310-555-0104”.');
      return guard(() => this.invite(phone, t, invitees));
    }
    const n = Number(rest(text)) - 1;
    if (word === 'CONFIRM') return guard(() => { act('confirm'); return this.reply(phone, `Locked in: ${p.title}. ${this.fanout ? `I let ${this.fanout} ${this.fanout === 1 ? 'person' : 'people'} know by text.` : 'Nobody on this plan is on text yet — reply LINKS to share their pages.'}`); });
    if (word === 'PICK') return guard(() => {
      const idea = p.suggestions[n]; if (!idea) return this.reply(phone, p.suggestions.length ? `Reply PICK 1${p.suggestions.length > 1 ? ` to PICK ${p.suggestions.length}` : ''}.` : 'There are no suggestions to pick yet.');
      act('selectSuggestion', { id: idea.id }); return this.reply(phone, `Switched to ${eventById(idea.eventId).short}. Everyone on text heard about it. Reply CONFIRM when you’re happy.`);
    });
    if (word === 'LOCK' || word === 'OPEN') return guard(() => { act('mode', { mode: word === 'LOCK' ? 'locked' : 'loose' }); return this.reply(phone, word === 'LOCK' ? 'Plan locked — friends can RSVP but not suggest changes.' : 'Plan open — friends can text ideas and vote.'); });
    if (word === 'ADD') return guard(() => {
      const e = findEvent(rest(text), p.stops); if (!e) return this.reply(phone, `Add what? Try ADD dinner, ADD comedy, ADD art or ADD trail (up to ${MAX_STOPS} stops).`);
      s = act('addStop', { eventId: e.id }); return this.reply(phone, `Added ${e.short}. ${this.itinerary(s)}`);
    });
    if (word === 'REMOVE') return guard(() => {
      const e = EVENTS.find(x => p.stops.includes(x.id) && findEvent(rest(text))?.id === x.id); if (!e) return this.reply(phone, `Remove which stop? ${this.itinerary(s)}`);
      s = act('removeStop', { eventId: e.id }); return this.reply(phone, `Removed ${e.short}. ${this.itinerary(s)}`);
    });
    if (['DROP', 'CALLOFF'].includes(word)) return guard(() => { act('drop'); return this.reply(phone, 'Plan called off. I told everyone on text. Reply NEW to start another.'); });
    if (['DONE', 'HAPPENED'].includes(word)) return guard(() => { act('happened'); return this.reply(phone, 'Hope it was a good one! I’ll use it to make better picks next time. Reply NEW to plan another.'); });
    if (QUESTION.test(text)) { const a = this.answer(s, text); if (a) return this.reply(phone, a); }
    if (['happened', 'dropped'].includes(p.status)) return this.reply(phone, 'That plan is closed. Reply NEW to start another.');
    // Anything else is a message for the group.
    this.store.hostActionAt(digest, 'chat', { text }, { via: 'sms' });
    if (!this.fanout) return this.reply(phone, 'None of your friends are on text for this plan yet, so I saved that to the plan page. Reply LINKS for their personal links.');
  }

  createHost(phone, raw) {
    const name = String(raw || '').replace(/[^\p{L}\s'’-]/gu, '').trim().split(/\s+/)[0];
    if (!name || name.length > 30) throw Object.assign(new Error('Please share a first name.'), { status: 400 });
    const nice = name[0].toUpperCase() + name.slice(1);
    stats.bump('signups_by_text', 1, phone);
    const { id, state } = this.store.create(nice);
    this.link(phone, this.store.digestOf(id), state, 'host');
    this.db.prepare('DELETE FROM sms_pending WHERE phone=?').run(phone);
    return nice;
  }
  // A new plan never pulls the rug out from friends on the current one. If anyone is on it, the host gets a fresh
  // plan next to it (the old one keeps its guests, links and texts; switch_plan moves between them). An empty
  // draft is simply reset in place so hosts don't pile up blank plans.
  newPlan(phone, t) {
    const old = t.s;
    if (!old.plan.participants.length) { const s = this.store.resetAt(t.digest, { via: 'sms' }); this.link(phone, t.digest, s, 'host'); return { s, digest: t.digest, kept: false }; }
    const { id, state } = this.store.create(old.name), digest = this.store.digestOf(id);
    this.db.prepare('INSERT OR IGNORE INTO host_contacts SELECT ?, name_key, name, phone, updated FROM host_contacts WHERE digest=?').run(digest, t.digest);
    this.link(phone, digest, state, 'host');
    return { s: state, digest, kept: true, previous: old.plan.title };
  }
  // A contact card texted to Rall-e ("share contact" in Messages): saved to the host's contacts so "invite Tori" works.
  // Saving a number never means texting it: invites still follow the opt-in rules.
  async contactCard(phone, media) {
    try {
      const cards = parseVcards((await this.sms.photos.download(media, 512 * 1024)).toString('utf8'));
      if (!cards.length) return '[sent a contact card, but it had no name and phone number]';
      const host = this.threadsFor(phone).find(t => t.role === 'host');
      if (host) for (const c of cards) this.remember(host.digest, c.name.split(' ')[0], c.phone);
      stats.bump('contacts_shared', cards.length, phone);
      return `[shared ${cards.length === 1 ? 'a contact card' : `${cards.length} contact cards`}: ${cards.map(c => c.name).join(', ')}${host ? ' (saved to their contacts, so they can be invited by first name)' : ''}]`;
    } catch (error) { return `[sent a contact card that couldn't be read: ${error.message}]`; }
  }
  // Each host's address book: names they've invited with a number, reused across plans ("invite Mike and Marc").
  remember(digest, name, phone) { this.db.prepare('INSERT OR REPLACE INTO host_contacts VALUES (?,?,?,?,?)').run(digest, name.trim().toLowerCase(), name.trim(), phone, Date.now()); }
  contactFor(digest, name) { return this.db.prepare('SELECT phone FROM host_contacts WHERE digest=? AND name_key=?').get(digest, String(name).trim().toLowerCase())?.phone || ''; }
  contacts(digest) { return this.db.prepare('SELECT name FROM host_contacts WHERE digest=? ORDER BY updated DESC LIMIT 20').all(digest).map(r => r.name); }
  // One-time contact card (vCard with the Rall-e icon) so people can save Rall-e like any contact.
  sendCard(phone, force = false) {
    // Counts only cards that actually went out (or are on their way); a failed card is sent again next time.
    if (!force && this.db.prepare("SELECT 1 FROM sms_log WHERE phone=? AND kind='card' AND direction='out' AND status NOT IN ('failed','blocked','unknown','undelivered') LIMIT 1").get(phone)) return;
    const status = this.sms.deliver(phone, 'Save Rall-e to your contacts so you always know it’s us.', { kind: 'card', media: `${this.sms.base || 'https://rall-e.ai'}/rall-e.vcf${this.sms.provider === 'sendblue' && this.sms.phoneService(phone)?.service === 'SMS' ? '?line=sms' : ''}` });
    if (status !== 'blocked') this.db.prepare('INSERT OR REPLACE INTO sms_cards VALUES(?,?)').run(phone, Date.now());
  }
  invite(phone, t, invitees) { return this.reply(phone, this.inviteReport(phone, t, invitees)); }
  inviteReport(phone, t, invitees) {
    const s = this.store.hostActionAt(t.digest, 'invite', { names: invitees.map(x => x.name) }, { via: 'sms' });
    const texted = [], linkOnly = [], blocked = [];
    for (const { name, phone: raw } of invitees) {
      const person = s.plan.participants.find(x => x.name.toLowerCase() === name.toLowerCase());
      const typed = raw && this.sms.normalize(raw), saved = !typed && this.contactFor(t.digest, name), to = typed || saved;
      if (!person) continue;
      if (typed && typed !== phone) this.remember(t.digest, person.name, typed);
      if (!to || to === phone) { linkOnly.push(person); continue; }
      this.link(to, t.digest, s, 'guest', person.id);
      const others = this.threadsFor(to).length > 1;
      const e = eventById(s.plan.stops[0]);
      const status = this.sms.deliver(to, `Rall-e: ${s.name} invited you to ${s.plan.title} — ${e.time} at ${e.venue} (sample outing). Details: ${this.link_(s, person)}\n${this.agent.enabled ? 'Just reply here to tell me if you’re in, ask anything, or suggest something else. Texts to me are private; say “tell the group…” to share with everyone.' : `Reply YES, MAYBE or NO. Text questions, ideas or messages for the group anytime.${others ? ' Reply PLANS to switch between plans.' : ''}`} Reply STOP to opt out.`, { kind: 'invite' });
      (status === 'blocked' ? blocked : texted).push(person);
      if (status !== 'blocked') this.sendCard(to);
    }
    const parts = [];
    if (texted.length) parts.push(`Invited ${list(texted.map(x => x.name))} by text.`);
    if (blocked.length) parts.push(`${list(blocked.map(x => x.name))} ${blocked.length === 1 ? 'hasn’t' : 'haven’t'} turned on Rall-e texts yet, so I can’t text ${blocked.length === 1 ? 'them' : 'them'} first. Forward ${blocked.length === 1 ? 'this personal link' : 'these personal links'}; ${blocked.length === 1 ? 'they' : 'each'} can turn on texts from the page in one step:\n${blocked.map(x => `${x.name}: ${this.link_(s, x)}`).join('\n')}`);
    if (linkOnly.length) parts.push(`Forward these personal links:\n${linkOnly.map(x => `${x.name}: ${this.link_(s, x)}`).join('\n')}`);
    parts.push(this.agent.enabled ? 'I’ll text you as people reply.' : 'I’ll text you as people reply. Reply STATUS anytime, CONFIRM to lock it in, or just text me a message for the group.');
    return parts.join('\n');
  }

  // ---------- guest ----------
  guest(phone, t, text) {
    const { s, person } = t, p = s.plan, word = firstWord(text);
    const act = (action, data = {}) => this.store.guestAction(person.invite, action, data, { via: 'sms' });
    const guard = fn => { try { return fn(); } catch (error) { if (!error.status) throw error; return this.reply(phone, `Rall-e: ${error.message}`); } };
    const response = YES.test(text) ? 'YES' : MAYBE.test(text) ? 'MAYBE' : NO.test(text) ? 'NO' : '';
    if (response) return guard(() => {
      const view = act('smsReply', { text: response }), c = this.counts(view.plan);
      return this.reply(phone, response === 'YES' ? `You’re in for ${p.title}! ${c}. See you there.` : response === 'MAYBE' ? `Marked you as a maybe. ${c}. Reply YES or NO when you know.` : `Got it — you’re out this time. I’ll let ${s.name} know.`);
    });
    const vote = /^(vote\s*)?#?(\d)$/i.exec(text.trim());
    if (vote && p.suggestions.length) return guard(() => {
      const idea = p.suggestions[Number(vote[2]) - 1]; if (!idea) return this.reply(phone, `Reply VOTE 1${p.suggestions.length > 1 ? `–${p.suggestions.length}` : ''}.`);
      const view = act('vote', { id: idea.id }), after = view.plan.suggestions.find(x => x.id === idea.id);
      return this.reply(phone, after.votes.includes(person.id) ? `Vote counted for ${eventById(idea.eventId).short} (${after.votes.length} so far).` : `Removed your vote for ${eventById(idea.eventId).short}.`);
    });
    if (['STATUS', 'PLAN', 'DETAILS', 'LINK'].includes(word)) return this.reply(phone, this.summary(s, person));
    const suggestion = word === 'SUGGEST' || /\b(instead|how about|what about|rather|could we|suggest)\b/i.test(text) ? findEvent(text, p.stops) : null;
    if (suggestion) return guard(() => {
      if (p.mode !== 'loose' || p.status !== 'proposed') { act('chat', { text }); return this.reply(phone, `${s.name} locked this plan, so it’s not open to new ideas — I passed your message along instead.`); }
      const view = act('suggest', { eventId: suggestion.id, reason: text.slice(0, 200) }), index = view.plan.suggestions.findIndex(x => x.by === person.id) + 1;
      return this.reply(phone, `Shared your idea: ${suggestion.short} (${suggestion.time}). Friends can reply VOTE ${index}; ${s.name} makes the call.`);
    });
    if (QUESTION.test(text)) { const a = this.answer(s, text); if (a) return this.reply(phone, a); }
    return guard(() => {
      act('chat', { text });
      if (!this.fanout) this.reply(phone, `I passed that to the plan page for ${s.name}. Nobody else is on text for this plan yet.`);
    });
  }

  // ---------- fan-out ----------
  onPlanEvent({ digest, s, action, actor, data }) {
    const p = s.plan, host = s.name, recipients = this.recipients(digest, s), nat = this.agent.enabled;
    const exclude = row => (actor === 'host' ? row.role === 'host' : row.participant === actor);
    const guests = recipients.filter(r => r.role === 'guest' && !exclude(r)), hosts = recipients.filter(r => r.role === 'host' && !exclude(r));
    const who = actor !== 'host' && p.participants.find(x => x.id === actor);
    let sent = 0;
    const send = (rows, body) => { for (const r of rows) { this.sms.deliver(r.phone, typeof body === 'function' ? body(r) : body, { kind: 'update' }); sent++; } };
    const personal = r => this.link_(s, p.participants.find(x => x.id === r.participant) || {});
    const ideas = () => p.suggestions.map((x, i) => `${i + 1}) ${eventById(x.eventId).short} — ${x.name}, ${x.votes.length} vote${x.votes.length === 1 ? '' : 's'}`).join('\n');
    if (action === 'consent' && who) { this.db.prepare('UPDATE sms_threads SET muted=? WHERE digest=? AND participant=?').run(data.enabled ? 0 : 1, digest, actor); return 0; }
    if (who && ['rsvp', 'text', 'smsReply'].includes(action) && ['yes', 'maybe', 'no'].includes(who.response) && !/^(stop|help)$/i.test(data.text || '')) {
      send(hosts, `Rall-e: ${who.name} ${pretty(who.response)} for ${p.title}. ${this.counts(p)}.`);
      if (who.response === 'yes') send(guests, `Rall-e: ${who.name} is in for ${p.title}! ${this.counts(p)}.`);
    } else if (who && action === 'joined') {
      send(hosts, `Rall-e: ${who.name} joined ${p.title} from the shared link. ${this.counts(p)}.${nat ? ` Not expected? Tell me to remove ${who.name}.` : ''}`);
      send(guests, `Rall-e: ${who.name} joined ${p.title}! ${this.counts(p)}.`);
    } else if (who && action === 'suggest') {
      const e = eventById(data.eventId), n = p.suggestions.findIndex(x => x.by === who.id) + 1;
      send(hosts, nat ? `Rall-e: ${who.name} suggested ${e.short} (${e.time}) instead. Want to switch, add it as another stop, or keep the plan?` : `Rall-e: ${who.name} suggested ${e.short} (${e.time}) instead.\n${ideas()}\nReply PICK ${n} to switch the plan.`);
      send(guests, nat ? `Rall-e: ${who.name} suggested ${e.short} (${e.time}) instead of ${p.title}. Into it? Tell me and I’ll count your vote.` : `Rall-e: ${who.name} suggested ${e.short} (${e.time}) instead of ${p.title}. Reply VOTE ${n} to back it.`);
    } else if (who && action === 'vote') {
      const idea = p.suggestions.find(x => x.id === data.id);
      if (idea?.votes.includes(who.id)) send(hosts, nat ? `Rall-e: ${who.name} is also up for ${eventById(idea.eventId).short} (${idea.votes.length} votes). Say the word if you want to switch.` : `Rall-e: ${who.name} voted for ${eventById(idea.eventId).short}.\n${ideas()}\nReply PICK and a number to choose.`);
    } else if (action === 'chat') {
      // Group messages land in each person's own thread, so label them as the group (Mike: "Group Message (Marc, Jeff + 3 others)").
      const from = who ? who.name : host, line = `${from}: ${String(data.text).slice(0, 300)}`;
      const everyone = [host, ...p.participants.filter(x => x.response !== 'no' && !x.stopped).map(x => x.name)];
      const label = r => {
        const me = r.role === 'host' ? host : p.participants.find(x => x.id === r.participant)?.name;
        const others = [from, ...everyone.filter(n => n !== from && n !== me)], shown = others.slice(0, 2).join(', '), more = others.length - 2;
        const first = !this.db.prepare("SELECT 1 FROM sms_log WHERE phone=? AND kind='group' LIMIT 1").get(r.phone);
        return `👥 ${p.title} · ${shown}${more > 0 ? ` + ${more} ${more === 1 ? 'other' : 'others'}` : ''}\n${line}${first ? '\n(Group message. Reply “tell the group …” to answer everyone; anything else stays between us.)' : ''}`;
      };
      for (const r of [...hosts, ...guests]) { this.sms.deliver(r.phone, label(r), { kind: 'group' }); sent++; }
    } else if (actor === 'host') {
      if (action === 'confirm') send(guests, r => `Rall-e: ${host} confirmed ${p.title}!\n${this.itinerary(s)}\nYour plan: ${personal(r)}\n${nat ? 'Let me know if anything changes.' : 'Reply YES, MAYBE or NO if anything changes.'}`);
      if (action === 'selectSuggestion') send(guests, `Rall-e: ${host} switched the plan to ${p.title} — ${eventById(p.stops[0]).time}. ${nat ? 'Still in?' : 'Reply YES, MAYBE or NO.'}`);
      if (['addStop', 'removeStop'].includes(action)) send(guests, `Rall-e: ${host} updated the plan. ${this.itinerary(s)}`);
      if (action === 'mode') send(guests, p.mode === 'loose' ? `Rall-e: ${host} is open to ideas for ${p.title}. ${nat ? 'Got another idea? Just tell me.' : 'Text something like “how about dinner instead?”'}` : `Rall-e: ${host} locked in the itinerary for ${p.title}.`);
      if (action === 'reopen') send(guests, `Rall-e: ${host} reopened ${p.title} for changes. ${nat ? 'Got an idea? Just tell me.' : 'Text an idea like “how about dinner instead?”'}`);
      if (action === 'drop') send(guests, `Rall-e: ${host} called off ${p.title}. Maybe next time!`);
    }
    return sent;
  }

  // ---------- presenter helpers ----------
  linkHost(sessionId, phone) {
    const digest = this.store.digestOf(sessionId), s = this.store.load(digest);
    this.link(phone, digest, s, 'host');
    this.db.prepare('DELETE FROM sms_pending WHERE phone=?').run(phone);
    const status = this.sms.deliver(phone, `Rall-e: you’ll get updates on ${s.plan.title} here as friends reply. Text a message for the group anytime, or STATUS, CONFIRM, HELP. Reply STOP to opt out.`, { kind: 'welcome' });
    return { status };
  }
  // A friend invited by link turned on texts from their invite page (consent box + texted code): link their phone
  // to their spot on the plan and say hello, so from now on they get updates and can text Rall-e about it.
  guestTexts(invite, phone) {
    const { row, s, person } = this.store.guest(invite);
    this.linkGuest(row.session, s, person.id, phone);
    this.sms.deliver(phone, `Rall-e: you’re in the loop for ${s.name}’s plan: ${s.plan.title}. I’ll text you when anything changes. Reply here with questions or ideas; say “tell the group…” to message everyone. Reply STOP to opt out.`, { kind: 'invite' });
    this.sendCard(phone);
    return { texting: true };
  }
  linkGuest(digest, s, participant, phone) { this.link(phone, digest, s, 'guest', participant); const p = s.plan.participants.find(x => x.id === participant); if (p) this.remember(digest, p.name, phone); }

  // ---------- copy ----------
  vibePrompt() { return `What are you in the mood for this weekend?\n${VIBES.map(([n, , label]) => `${n} ${label}`).join('\n')}\nReply a number, or describe it (“something outdoors”, “comedy”).`; }
  pitch(e) { return `How about ${e.short}? ${e.venue}, ${e.area} · ${e.time} · ${priceOf(e)}. ${e.tag} (sample outing)\nReply YES to make it the plan, NO for something else, or ask me about time, price or access.`; }
  itinerary(s) {
    const legs = this.sms.discovery?.cachedLegs ? this.sms.discovery.cachedLegs(s.plan.stops) : [];
    return s.plan.stops.map(id => eventById(id)).map((e, i) => `${i ? ` → ${legs[i - 1] ? `(${legText(legs[i - 1])}) → ` : ''}` : ''}${e.time.replace('Saturday · ', 'Sat ')} ${e.short}${e.short.includes(e.venue) ? '' : ` (${e.venue})`}`).join('');
  }
  counts(p) {
    const n = r => p.participants.filter(x => x.response === r).length;
    return [`${n('yes')} going`, n('maybe') && `${n('maybe')} maybe`, n('pending') && `${n('pending')} waiting`].filter(Boolean).join(', ');
  }
  summary(s, person) {
    const p = s.plan, status = { proposed: 'still planning', confirmed: 'confirmed', happened: 'done', dropped: 'called off' }[p.status];
    const group = r => p.participants.filter(x => x.response === r).map(x => x.name);
    const lines = [`${p.title} — ${status} (${s.name}’s plan)`, this.itinerary(s)];
    const going = [['Going', group('yes')], ['Maybe', group('maybe')], ['Waiting', group('pending')], ['Out', group('no')]].filter(([, x]) => x.length).map(([k, x]) => `${k}: ${x.join(', ')}`).join(' · ');
    if (going) lines.push(going);
    if (p.suggestions.length) lines.push(`Ideas: ${p.suggestions.map((x, i) => `${i + 1}) ${eventById(x.eventId).short} (${x.votes.length})`).join(' ')}`);
    if (person) lines.push(`You: ${({ yes: 'going', maybe: 'maybe', no: 'out', pending: 'no reply yet — YES, MAYBE or NO?' })[person.response]}`, this.link_(s, person));
    return lines.join('\n');
  }
  answer(s, text, focus) {
    const t = text.toLowerCase(), stops = focus ? [focus] : s.plan.stops.map(eventById).filter(Boolean);
    if (!stops.length) return null;
    const each = fn => stops.map(fn).join('\n');
    if (/who.*(going|coming|in)\b|how many/.test(t) && s.plan.participants.length) return `${this.counts(s.plan)}. ${s.plan.participants.map(x => `${x.name} ${pretty(x.response)}`).join('; ')}.`;
    if (/\bdoors\b|\bstart|what time|\bwhen\b|\btime\b|how long/.test(t)) return each(e => `${e.short}: ${e.time} (doors/arrival: ${e.doors}). Plan on ${e.duration}.`);
    if (/price|cost|how much|\bfree\b|budget|\$/.test(t)) return each(e => `${e.short}: ${priceOf(e)}.`) + ' Nothing is booked or charged in this demo.';
    if (/\b21\b|\bage\b|kids|under|id\b/.test(t)) return each(e => `${e.venue}: ${e.age}.`);
    if (/access|wheelchair|steps|stairs/.test(t)) return each(e => `${e.venue}: ${e.accessibility}`) + ' (Sample info — confirm with the venue.)';
    if (/where|address|location|park/.test(t)) return each(e => `${e.venue}, ${e.area} (fictional demo venue).`);
    if (/book|pay|split|reserv|ticket/.test(t)) return 'Booking and payments aren’t part of this demo — Rall-e just gets everyone on the same page.';
    return null;
  }
  help(t) {
    if (!t) return 'Rall-e helps friends make plans by text. Text anything to start a plan. Reply STOP to opt out. Msg & data rates may apply.';
    if (t.role === 'host') return 'Rall-e host commands: STATUS, INVITE name number, CONFIRM, PICK 1, ADD dinner, LOCK/OPEN, DROP, LINKS, NEW, PLANS. Anything else goes to your group. STOP to opt out.';
    return 'Rall-e: reply YES, MAYBE or NO; suggest an idea (“how about dinner instead?”); VOTE 1; STATUS; or ask about time, price or access. Anything else goes to the group. STOP to opt out.';
  }
}
