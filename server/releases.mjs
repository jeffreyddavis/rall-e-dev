// Release notes: every member is texted when a feature or fix goes live (see server/whatsnew.mjs).
// Add one entry per user-facing change, newest last, in the same commit as the change. Rules:
// - id: unique, never reused or edited after it ships (it's how we know who already got it).
// - text: one short line, plain words, written for the person texting Rall-e (what they can do now).
// - hold: true keeps it from going out (e.g. until Jeff approves the wording). Internal-only fixes don't get an entry.
export const RELEASES = [
  { id: '2026-09-30-whats-new', date: '2026-09-30', text: 'You\'ll now get a short text like this whenever something new goes live on Rall-e.' },
  { id: '2026-09-30-own-plans', date: '2026-09-30', text: 'Invited to a friend\'s plan? You can now start your own separate plan from the same chat. Just ask me to plan it.' },
  { id: '2026-09-30-book-table', date: '2026-09-30', text: 'Want a table? Ask me to book it: I\'ll send the restaurant\'s booking page with your party size, day and time already filled in.' },
  { id: '2026-09-30-local-music', date: '2026-09-30', text: 'Live music picks now lead with local gigs at small venues (bars, clubs, listening rooms) instead of arenas.' },
  { id: '2026-10-01-whos-going', date: '2026-10-01', text: 'Going to a concert, game or conference? Tell me and I\'ll let you know which friends on Rall-e are going too (you choose whether friends can see you\'re going).' },
  { id: '2026-10-01-favorites', date: '2026-10-01', text: 'Make a top 5: text me "my top 5 coffee spots in <your city>" and I\'ll make a page you can share. Friends on Rall-e see your picks when they look nearby.' },
  { id: '2026-10-01-tips', date: '2026-10-01', text: 'Know a hidden gem or a site with great local events? Text it to me (or any feedback) and the team will add the good ones, credited to you.' },
  { id: '2026-10-01-restaurant-calls', date: '2026-10-01', text: 'Want me to phone a restaurant for a table? Tell me to call after we pick the place, party size and time. I’ll text you what they say.' },
  { id: '2026-10-02-call-fix', date: '2026-10-02', text: 'Fixed: asking me to call a restaurant now works the way you\'d say it ("call Cure", "call them again", or just "yes" when I offer), instead of me asking you to confirm again.' },
  { id: '2026-10-02-call-details', date: '2026-10-02', text: 'After I call a restaurant, I now tell you why it didn\'t work out and quote what they said (hours, how to book, times they offered).' }
];
