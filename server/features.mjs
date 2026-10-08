// Rall-e's showcase features, shared by the operator console (demo triggers) and the agent (natural, occasional tips).
// `pitch` is how Rall-e would describe it in a text; `operator` is the instruction a demo trigger gives the agent.
export const FEATURES = [
  { id: 'things_to_do', label: 'Things to do nearby', pitch: 'finding real events, restaurants and bars near them, with a page of the options',
    operator: 'Show them 2–3 great, specific options near them for tonight or this weekend (find_things, then list them in your text), tailored to what you know about them. Ask which sounds good.' },
  { id: 'showtimes', label: 'Movie showtimes', pitch: 'real movie showtimes at theaters near them',
    operator: 'Show off live movie showtimes: find_things with category movies for tonight (or tomorrow if it is late where they are), list 2–3 good options with times in your text. Mention they can pick one and you will plan it with friends.' },
  { id: 'plan_friends', label: 'Plan it with friends', pitch: 'turning an idea into a plan: they name who to invite and you text everyone and track who is in',
    operator: 'Offer to turn what they are into (or their last idea) into a plan with friends: they just tell you who to invite and you text everyone, track RSVPs and keep the group posted. Ask who they would bring.' },
  { id: 'evening_view', label: 'Plan page', pitch: 'a page with the whole plan: every stop, who is in, and ideas the group can pick',
    operator: 'Send them the link to their plan page (host: get_links and send only their own plan page link; friend: get_my_link) and say in one line what they will see there (the whole plan, who is in, picks, share button).' },
  { id: 'share_night', label: 'Share the plan', pitch: 'sharing the plan with anyone; people can sign up and join right from the link',
    operator: 'Tell them they can share their plan with anyone using the Share button on their plan page (send the link if helpful), and that people can join the plan straight from it.' },
  { id: 'group_chat', label: 'Group messages', pitch: 'private texts by default, and "tell the group…" to message everyone on the plan',
    operator: 'Explain in one or two lines that texts to you are private, and starting a text with "tell the group" sends it to everyone on the plan (their friends see it labeled as the group).' },
  { id: 'my_pick', label: 'My pick voting', pitch: 'tapping My pick on options so you and the group can decide quickly',
    operator: 'Point out that on their plan page they can tap "My pick", and the group sees who picked what, so deciding takes seconds.' },
  { id: 'vault', label: 'Secure vault', pitch: 'a secure place for dietary needs, allergies and loyalty numbers so bookings go smoothly',
    operator: 'Offer the secure vault for dietary needs, allergies, loyalty numbers and contact details so future bookings are smooth. If it fits, send_secure_link.' },
  { id: 'location', label: 'One-tap location', pitch: 'sharing their location with one tap so suggestions are nearby',
    operator: 'Offer one-tap location sharing so your suggestions are right around them: send_location_link with a short line about why.' },
  { id: 'invites', label: 'Invite friends', pitch: 'their personal invite link: Rall-e is invite-only and they have a few invites to share',
    operator: 'Tell them Rall-e is invite-only and they have invites to share: call get_invite_link and send their invite link plus their invites page, in one or two lines.' },
  { id: 'profile_photo', label: 'Profile photo', pitch: 'adding a profile photo by texting one, so friends see their face on plan pages',
    operator: 'Suggest they add a profile photo so friends see their face on plan pages: they can just text you a photo, or use their page (get_my_page). One or two lines.' },
  { id: 'weather', label: 'Weather-aware plans', pitch: 'checking the forecast so plans fit the weather',
    operator: 'Check get_weather for where they are and suggest one or two things that fit the next few days\' weather (find_things, listed in your text). Keep it short.' },
  { id: 'own_event', label: 'Host their own event', pitch: 'creating their own event (a BBQ, game night, a picnic) and inviting friends to it',
    operator: 'Tell them they can plan their own thing too, like a BBQ, game night or picnic: they just say what, when and where, and you make the plan and invite everyone. One or two lines.' },
  { id: 'group_vote', label: 'Group vote', pitch: 'letting the group vote on options (pick one, rank them, or leave it to the host) with a link for each friend',
    operator: 'Offer to let their group vote on the options so they don\'t have to guess what everyone wants: if they have friends on a plan and a few options, offer start_poll in one or two lines (or start it if they already asked).' },
  { id: 'reservations', label: 'Restaurant reservations', pitch: 'sending a restaurant booking link, or phoning the restaurant when call_restaurant is available and they explicitly ask',
    operator: 'Offer to help book a restaurant with a booking link. If call_restaurant is available, mention you can also phone the restaurant after they explicitly ask in their own text. A demo instruction is not authorization to place a call. Confirm the place, party size, day and time first.' },
  { id: 'alerts', label: 'Tell me when…', pitch: 'watching for something they care about (a band coming to town, an event opening, low tides for tide pooling, waterfalls after a storm, news on a beach or trail page) and texting them when it turns up',
    operator: 'Tell them you can keep an eye out for things they care about, like a favorite band coming to town or a seasonal event opening, and text them when it turns up. Ask if there is anything they want you to watch for (then watch_for). One or two lines.' },
  { id: 'weekend_picks', label: 'Weekend picks', pitch: 'a short text every Thursday with 2–3 ideas for the weekend, picked for them',
    operator: 'Offer weekend picks: every Thursday afternoon you text them 2–3 ideas for the weekend based on what they like. Ask if they want them (then weekend_picks on). One or two lines.' },
  { id: 'reactions', label: 'Emoji reactions', pitch: 'reacting to texts with emoji',
    operator: 'React to their latest message with a fitting emoji (react) and mention in a few words that they can react to your texts too and you will understand.' }
];
export const featureById = id => FEATURES.find(f => f.id === id);

// Which tool use counts as having shown which feature.
export function featureForTool(name, input = {}) {
  if (name === 'find_things') return input.category === 'movies' ? 'showtimes' : 'things_to_do';
  if (name === 'show_options') return (input.event_ids || []).some(id => String(id).startsWith('mv_')) ? 'showtimes' : 'things_to_do';
  return { start_poll: 'group_vote', get_weather: 'weather', create_event: 'own_event', get_invite_link: 'invites', set_profile_photo: 'profile_photo', get_my_page: 'profile_photo', get_links: 'evening_view', get_my_link: 'evening_view', send_secure_link: 'vault', save_details: 'vault', send_location_link: 'location',
    book_table: 'reservations', call_restaurant: 'reservations', watch_for: 'alerts', weekend_picks: 'weekend_picks', react: 'reactions', message_group: 'group_chat', invite: 'plan_friends', make_plan: 'plan_friends' }[name] || null;
}

// Two tiers (Jeff): answering a need they just expressed ("my sister is vegetarian" -> vault) is offered right away,
// unless they're mid-setup of something else, in which case it's queued for when they're done. Unprompted self-promotion
// ("tips") waits at least 4 of their texts between mentions.
export class FeatureLog {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS features_seen (phone TEXT NOT NULL, feature TEXT NOT NULL, how TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (phone, feature));
      CREATE TABLE IF NOT EXISTS feature_queue (phone TEXT NOT NULL, feature TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (phone, feature));`);
  }
  mark(phone, feature, how) {
    if (!featureById(feature)) return;
    this.db.prepare('INSERT INTO features_seen VALUES (?,?,?,?) ON CONFLICT(phone, feature) DO UPDATE SET at=excluded.at, how=CASE WHEN features_seen.how IN (\'tip\',\'need\') THEN excluded.how ELSE features_seen.how END').run(phone, feature, how, Date.now());
    this.db.prepare('DELETE FROM feature_queue WHERE phone=? AND feature=?').run(phone, feature); // brought up: no longer pending
  }
  queue(phone, feature, reason) { if (featureById(feature)) this.db.prepare('INSERT OR REPLACE INTO feature_queue VALUES (?,?,?,?)').run(phone, feature, String(reason || '').slice(0, 200), Date.now()); }
  queued(phone) { return this.db.prepare('SELECT feature, reason FROM feature_queue WHERE phone=? AND at>? ORDER BY at').all(phone, Date.now() - 2 * 86400000); }
  seen(phone) { return this.db.prepare('SELECT feature, how, at FROM features_seen WHERE phone=?').all(phone); }
  // Texts they've sent since Rall-e last promoted itself unprompted (need-based offers don't count).
  sinceTip(phone) {
    const last = this.db.prepare("SELECT MAX(at) AS at FROM features_seen WHERE phone=? AND how IN ('tip','operator')").get(phone).at;
    return last ? this.db.prepare("SELECT COUNT(*) AS n FROM sms_log WHERE phone=? AND direction='in' AND created>?").get(phone, last).n : Infinity;
  }
  stateLine(phone) {
    const seen = new Set(this.seen(phone).map(r => r.feature)), gap = this.sinceTip(phone), fresh = FEATURES.filter(f => !seen.has(f.id)), queued = this.queued(phone);
    const lines = [`Features: ${seen.size ? `already seen: ${[...seen].join(', ')}` : 'none shown yet'}. Not seen yet: ${fresh.map(f => `${f.id} (${f.pitch})`).join('; ') || 'none'}.`];
    if (queued.length) lines.push(`Queued to bring up once they finish what they're setting up: ${queued.map(q => `${q.feature} (${q.reason})`).join('; ')}. If what they were doing is done now, offer the first one in this reply and call mention_feature with why=need.`);
    lines.push(gap < 4 ? `Unprompted tips: not now (you promoted a feature ${gap === 0 ? 'in your last reply' : `${gap} text(s) ago`}). Offers that answer a need they just expressed are still fine.` : 'Unprompted tips: allowed (one, only if it clearly helps).');
    return lines.join('\n');
  }
}
