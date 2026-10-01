// Wiping conversations (test phase -> public phase, or someone who got a shared link outside the approved list).
//  wipeTexts(sms, phone)    their texts with Rall-e and their group messages; they stay on their plans
//  removePerson(sms, phone) everything about them: texts, plans they're in or host, vault, location, opt-in
//  wipeAllConversations(sms) every conversation for everyone (accounts and plans stay) - run from the command line
// Deletes are permanent. Twilio and Sendblue keep their own message logs on their side.
const tables = db => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name));
const del = (db, have, table, where, ...args) => have.has(table) ? Number(db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args).changes) : 0;

export function wipeTexts(sms, phone) {
  const db = sms.db, have = tables(db), n = {};
  // Their group messages also live in each plan's activity feed as "Name: text".
  for (const t of sms.flow.threadsFor(phone)) {
    const name = t.role === 'host' ? t.s.name : t.person?.name, s = sms.store.load(t.digest);
    const before = s.activity.length; s.activity = s.activity.filter(a => !(name && a.text?.startsWith(`${name}: `)));
    if (s.activity.length !== before) { sms.store.persist(t.digest, s); n.group_messages = (n.group_messages || 0) + before - s.activity.length; }
  }
  n.texts = del(db, have, 'sms_log', 'phone=?', phone) + del(db, have, 'sms_messages', 'recipient=?', phone);
  for (const table of ['sms_pending', 'recent_finds', 'option_sets', 'features_seen', 'feature_queue']) del(db, have, table, 'phone=?', phone);
  sms.lastIn.delete(phone);
  return n;
}

export function removePerson(sms, phone) {
  const db = sms.db, have = tables(db), n = wipeTexts(sms, phone), plans = [];
  for (const t of sms.flow.threadsFor(phone)) {
    if (t.role === 'guest' && t.person) { try { sms.store.hostActionAt(t.digest, 'removeGuest', { id: t.person.id }); plans.push(`left ${t.s.plan.title}`); } catch {} }
    if (t.role === 'host') {
      // Plans they host go away entirely, with every link into them.
      for (const table of ['invites', 'share_links', 'night_links']) del(db, have, table, 'session=?', t.digest);
      del(db, have, 'session_alias', 'digest=?', t.digest); del(db, have, 'sms_threads', 'digest=?', t.digest); del(db, have, 'host_contacts', 'digest=?', t.digest);
      del(db, have, 'sessions', 'id=?', t.digest); plans.push(`deleted ${t.s.plan.title}`);
    }
  }
  for (const table of ['sms_threads', 'sms_optins', 'signup_codes', 'vault_profiles', 'vault_links', 'vault_audit', 'profiles', 'location_links', 'imessage_nudges', 'phone_services', 'sms_cards', 'profile_photos', 'me_links', 'waitlist']) del(db, have, table, 'phone=?', phone);
  del(db, have, 'memory_facts', 'person=?', phone); del(db, have, 'update_prefs', 'phone=?', phone); sms.voice?.wipe(phone); del(db, have, 'bookings', 'phone=?', phone); del(db, have, 'going', 'phone=?', phone); sms.favorites?.wipe(phone); sms.ideas?.wipe(phone); del(db, have, 'update_sent', 'phone=?', phone); del(db, have, 'memory_signals', 'person=?', phone); del(db, have, 'invite_links', 'owner=?', phone); del(db, have, 'invite_uses', 'invitee=? OR owner=?', phone, phone);
  del(db, have, 'host_contacts', 'phone=?', phone);
  // An opt-out (STOP) is kept on purpose so they are never texted again by mistake.
  if (!sms.testers.has(phone)) sms.allowed.delete(phone);
  return { ...n, plans, stillTexts: sms.allowed.has(phone) };
}

export function wipeAllConversations(sms) {
  const db = sms.db, have = tables(db), n = {};
  for (const table of ['sms_log', 'sms_messages', 'sms_pending', 'sms_inbound', 'recent_finds', 'option_sets', 'features_seen', 'feature_queue']) n[table] = del(db, have, table, '1=1');
  for (const row of db.prepare('SELECT id FROM sessions').all()) {
    const s = sms.store.load(row.id); if (!s) continue;
    s.activity = []; if (Array.isArray(s.messages)) s.messages = []; sms.store.persist(row.id, s);
  }
  sms.lastIn.clear();
  return n;
}
