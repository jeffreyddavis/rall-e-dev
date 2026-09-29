// Kept for the record: the one-time Insights backfill run on 2026-09-29 (guarded by stat_meta.backfilled_history).
// One-time: backfill Insights from the testing period (before the counters existed). Guarded, so it can't run twice.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/var/lib/rally-demo/rally.sqlite');
if (db.prepare("SELECT 1 FROM stat_meta WHERE key='backfilled_history'").get()) { console.log('already done'); process.exit(0); }
const cut = Number(db.prepare("SELECT value FROM stat_meta WHERE key='backfilled'").get().value);
const day = t => new Date(t).toISOString().slice(0, 10), fict = p => /^\+1\d{3}555\d{4}$/.test(p || '');
const add = (t, e, n = 1) => n && db.prepare('INSERT INTO stat_counts VALUES (?,?,?) ON CONFLICT(day, event) DO UPDATE SET n=n+excluded.n').run(day(t), e, n);
const out = db.prepare("SELECT phone, body, kind, created FROM sms_log WHERE direction='out' AND status NOT IN ('blocked','preview') AND created < ? ORDER BY created").all(cut).filter(r => !fict(r.phone));
const firstSeen = (list, key) => { const m = new Map(); for (const r of list) { const k = key(r); if (k && !m.has(k)) m.set(k, r.created); } return m; };
const plans = firstSeen(out.filter(r => r.kind === 'invite'), r => /invited you to (.+?) —/.exec(r.body)?.[1]);
const confirmed = firstSeen(out, r => /^Rall-e: \w+ confirmed (.+?)!/.exec(r.body)?.[1]);
const yes = firstSeen(out, r => { const m = /^Rall-e: (\w+) is in for (.+?)!/.exec(r.body); return m && `${m[1]}|${m[2]}`; });
const stops = firstSeen(out, r => /updated the plan\./.test(r.body) && r.body.split('\n')[0].slice(0, 80));
const group = firstSeen(out.filter(r => ['update', 'group'].includes(r.kind)), r => { const line = r.body.replace(/^👥[^\n]*\n/, '').split('\n')[0]; return /^[A-Z][a-z]+: /.test(line) && line; });
const counts = { plans_created: plans, plans_confirmed: confirmed, rsvp_yes: yes, stops_added: stops, group_messages: group };
for (const [e, m] of Object.entries(counts)) for (const t of m.values()) add(t, e);
add(out.find(r => r.kind === 'invite')?.created || Date.now(), 'invites_sent', 0); for (const r of out.filter(r => r.kind === 'invite')) add(r.created, 'invites_sent');
for (const s of db.prepare('SELECT phone, ids, pick, created FROM option_sets WHERE created < ?').all(cut).filter(r => !fict(r.phone))) {
  const ids = JSON.parse(s.ids); add(s.created, 'option_sets_sent'); add(s.created, 'options_shown', ids.length); if (s.pick) add(s.created, 'my_picks');
  add(s.created, `searches_${ids[0].startsWith('mv_') ? 'movies' : ids[0].startsWith('tm_') ? 'events' : 'places'}`);
}
add(Date.parse('2026-09-29T00:40:00Z'), 'signups_by_text'); add(Date.parse('2026-09-29T13:10:00Z'), 'operator_nudges', 2);
// What people asked for that Rall-e couldn't do, from reading the test conversations. Anonymized by hand.
const G = [
  ['plan_locked_for_changes', 4, 'wanted a friend’s new idea added to a plan that was already confirmed', 'agent', '2026-09-29T01:25', '2026-09-29T02:30'],
  ['restaurant_reservations', 2, 'wants a table for two booked this week, and to know what’s available', 'agent', '2026-09-29T01:10', '2026-09-29T03:08'],
  ['other_days_of_the_week', 2, 'asked what’s happening on a weekday, not just Saturday', 'agent', '2026-09-29T01:14', '2026-09-29T01:23'],
  ['movie_showtimes', 2, 'asked what movies are showing this weekend, not just which theaters are nearby', 'agent', '2026-09-29T03:52', '2026-09-29T03:54'],
  ['unsupported_city', 1, 'asked what’s on this week in a neighborhood outside the demo area', 'agent', '2026-09-29T01:20', '2026-09-29T01:20'],
  ['location_needed', 1, 'asked for a bar with margaritas near a restaurant before sharing where they are', 'agent', '2026-09-29T02:26', '2026-09-29T02:26'],
  ['missing_friend_numbers', 1, 'asked to invite two friends by name, with no numbers on file', 'agent', '2026-09-29T02:31', '2026-09-29T02:31'],
  ['specific_venue_not_found', 1, 'wanted a specific restaurant added that search didn’t return', 'agent', '2026-09-29T03:10', '2026-09-29T03:10'],
  ['rewrite_group_message', 1, 'wanted Rall-e to pass a message to the group in its own words', 'agent', '2026-09-29T03:10', '2026-09-29T03:10'],
  ['plan_history', 1, 'asked Rall-e to remember and credit who first suggested a stop', 'agent', '2026-09-29T03:12', '2026-09-29T03:12'],
  ['distance_from_me', 1, 'wanted to see how far each theater is from them', 'agent', '2026-09-29T03:54', '2026-09-29T03:54'],
  ['estate_sales', 1, 'asked about estate sales happening nearby', 'agent', '2026-09-29T05:23', '2026-09-29T05:23'],
  ['prices_unavailable', 1, 'asked how much comedy show tickets cost', 'agent', '2026-09-29T13:00', '2026-09-29T13:00'],
  ['more_than_three_options', 1, 'asked for 5 places; the list page only showed 3', 'report', '2026-09-29T08:29', '2026-09-29T08:29'],
  ['daily_text_cap_hit', 6, 'Texts held back after a person hit the 40-a-day safety cap (since raised to 200)', 'auto', '2026-09-29T03:08', '2026-09-29T03:16'],
  ['text_send_failed', 5, 'A text could not be delivered (iMessage line refused a number that hadn’t texted it yet)', 'auto', '2026-09-29T01:51', '2026-09-29T03:08'],
  ['ai_reply_failed', 1, 'Claude returned an empty response during an outage (the retry answered)', 'auto', '2026-09-29T14:05', '2026-09-29T14:05'],
  ['slow_link_previews', 1, 'picture cards showed grey “loading” boxes instead of photos', 'report', '2026-09-29T03:14', '2026-09-29T03:14']
];
for (const [c, n, ex, src, a, b] of G) db.prepare('INSERT INTO gaps VALUES (?,?,?,?,?,?) ON CONFLICT(category) DO UPDATE SET n=n+excluded.n, first_at=MIN(first_at, excluded.first_at)').run(c, n, ex, src, Date.parse(a + ':00Z'), Date.parse(b + ':00Z'));
db.prepare("INSERT INTO stat_meta VALUES ('backfilled_history', ?)").run(String(Date.now()));
console.log(JSON.stringify(Object.fromEntries(Object.entries(counts).map(([k, m]) => [k, m.size]))), 'invites', out.filter(r => r.kind === 'invite').length);
console.log(JSON.stringify(db.prepare('SELECT event, SUM(n) n FROM stat_counts GROUP BY event ORDER BY event').all().map(r => `${r.event}=${r.n}`)));
