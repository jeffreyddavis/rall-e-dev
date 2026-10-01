// Release notes: every member is texted when a feature or fix goes live (see server/whatsnew.mjs).
// Add one entry per user-facing change, newest last, in the same commit as the change. Rules:
// - id: unique, never reused or edited after it ships (it's how we know who already got it).
// - text: one short line, plain words, written for the person texting Rall-e (what they can do now).
// - hold: true keeps it from going out (e.g. until Jeff approves the wording). Internal-only fixes don't get an entry.
export const RELEASES = [
  { id: '2026-09-30-whats-new', date: '2026-09-30', text: 'You\'ll now get a short text like this whenever something new goes live on Rall-e.' },
  { id: '2026-09-30-own-plans', date: '2026-09-30', text: 'Invited to a friend\'s plan? You can now start your own separate plan from the same chat. Just ask me to plan it.' },
  { id: '2026-09-30-book-table', date: '2026-09-30', text: 'Want a table? Ask me to book it: I\'ll send the restaurant\'s booking page with your party size, day and time already filled in.' },
  { id: '2026-09-30-local-music', date: '2026-09-30', text: 'Live music picks now lead with local gigs at small venues (bars, clubs, listening rooms) instead of arenas.' }
];
