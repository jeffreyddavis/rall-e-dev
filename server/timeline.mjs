// Time awareness for the agent: each person's local time, when a plan is happening, and whether it's upcoming,
// underway or over, so "show me the weather" at 11 PM isn't about the trail they hiked this afternoon.
import { eventById } from './catalog.mjs';

// US time zone from longitude (the NWS forecast lookup refines this when available; see Discovery.weather).
export function tzFromLng(lat, lng) {
  if (lng == null) return 'America/New_York';
  if (lat != null && lat > 51 && lng < -129) return 'America/Anchorage';
  if (lng < -154) return 'Pacific/Honolulu';
  if (lng >= -87.5) return 'America/New_York';
  if (lng >= -101.5) return 'America/Chicago';
  if (lng >= -114.5) return lat != null && lat < 37 && lng < -109 ? 'America/Phoenix' : 'America/Denver';
  return 'America/Los_Angeles';
}
const parts = (ts, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long' })
  .formatToParts(new Date(ts)).map(p => [p.type, p.value]));
export function localNow(tz, ts = Date.now()) {
  const p = parts(ts, tz), date = `${p.year}-${p.month}-${p.day}`, hour = Number(p.hour);
  return { tz, date, time: `${p.hour}:${p.minute}`, hour, weekday: p.weekday, label: new Date(ts).toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    daypart: hour < 5 ? 'middle of the night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'late evening' };
}
export const stamp = (ts, tz) => new Date(ts).toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });
export function ago(ms) { const m = Math.round(ms / 60000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 36 * 60 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`; }
const days = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);
const niceDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// When the plan happens: set from the conversation (set_plan_time), else from dated stops.
export function planWhen(p) {
  if (p.when?.date) return p.when;
  const dated = p.stops.map(id => eventById(id)).map(e => e?.localDate || (e?.startsAt ? String(e.startsAt).slice(0, 10) : null)).filter(Boolean).sort();
  const first = p.stops.map(id => eventById(id)).find(e => e?.startsAt);
  return dated.length ? { date: dated[0], time: first?.startsAt ? String(first.startsAt).slice(11, 16) : '', basis: 'from its stops' } : null;
}
// One line for the agent: where the plan sits relative to now, and what that implies.
export function planTiming(s, now) {
  const p = s.plan, w = planWhen(p), progress = p.progress?.done?.length ? ` Done so far: ${p.progress.done.map(id => eventById(id)?.short || id).join(', ')}.` : '';
  if (['happened', 'dropped'].includes(p.status)) return `Plan timing: this plan is ${p.status === 'happened' ? 'over (marked as happened)' : 'called off'}. Don't plan around it; anything new is a new plan.`;
  if (!w) return `Plan timing: not saved yet. Infer it from the conversation the way a friend would (e.g. "itinerary for today" sent Tue 12:01 PM means Tuesday) and save it now with set_plan_time before you reply; if that day has passed or it's clearly over, also mark_happened. Only ask if it really matters.${progress}`;
  const d = days(w.date, now.date), at = w.time ? ` around ${w.time}` : '';
  const when = d === 0 ? `today${at}` : d === 1 ? `tomorrow${at}` : d === -1 ? `yesterday${at}` : d > 0 ? `${niceDate(w.date)}${at} (in ${d} days)` : `${niceDate(w.date)} (${-d} days ago)`;
  let verdict;
  if (d < 0) verdict = 'It is in the past, so it almost certainly happened: treat it as done (mark_happened when it comes up, or ask how it went), and plan anything new as a new outing.';
  else if (d > 0) verdict = 'It is upcoming.';
  else if (p.progress?.status === 'underway') verdict = `It is underway right now (they're out doing it).`;
  else if (w.time && now.time < w.time) verdict = 'It is later today.';
  else if (now.hour >= 21 || (w.time && now.time > w.time && now.hour - Number(w.time.slice(0, 2)) >= 5)) verdict = `It's ${now.daypart} now, so today's outing is most likely over: don't suggest things for it anymore, and ask how it went or mark_happened if they say so.`;
  else verdict = 'It is today; it may be underway (watch for clues like "we just finished…", "heading to…").';
  return `Plan timing: ${when} (${w.basis || 'set from the conversation'}). ${verdict}${progress}`;
}
