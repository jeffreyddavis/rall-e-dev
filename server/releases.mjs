// Release notes: every member is texted when a feature or fix goes live (see server/whatsnew.mjs).
// Add one entry per user-facing change, newest last, in the same commit as the change. Rules:
// - id: unique, never reused or edited after it ships (it's how we know who already got it).
// - text: one short line, plain words, written for the person texting Rall-e (what they can do now).
// - hold: true keeps it from going out (e.g. until Jeff approves the wording, in /ops → Release notes). Internal-only fixes don't get an entry.
// - team: true makes it a dev update for the Rall-e team (the core testers) only: tools and changes members wouldn't care about.
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
  { id: '2026-10-02-call-details', date: '2026-10-02', text: 'After I call a restaurant, I now tell you why it didn\'t work out and quote what they said (hours, how to book, times they offered).' },
  { id: '2026-10-02-call-menus', date: '2026-10-02', text: 'When I call a restaurant that answers with a phone menu ("press 1 for reservations"), I can now press the button to reach a person.' },
  { id: '2026-10-05-checked-picks', date: '2026-10-05', text: 'I now check that a place is open when you\'d go (and not closed for the season) before I suggest it. Tell me the time, like "dinner at 7", and I\'ll only pick places open then.' },
  { id: '2026-10-05-offer-call', date: '2026-10-05', text: 'Want a table? Along with the booking link, I\'ll offer to call the restaurant for you, so you don\'t have to.' },
  { id: '2026-10-05-plan-page', date: '2026-10-05', text: 'Planning with someone else? I\'ll send the Rall-e page right away so you can both see the options, RSVPs and picks in one place.' },
  { id: '2026-10-05-team-updates', date: '2026-10-05', team: true, hold: true, text: 'You now get team-only updates like this one, about tools for the three of us. Regular members never see them.' },
  { id: '2026-10-05-team-sources', date: '2026-10-05', team: true, hold: true, text: 'Text me an event website and its city ("add this source for Austin: https://...") and I\'ll add it as a source right away, no review. It shows up in /ops → Sources.' },
  { id: '2026-10-05-team-ideas', date: '2026-10-05', team: true, hold: true, text: 'Text me an idea, feedback or a bug ("idea: ...") and I\'ll put it straight on the team list in /ops → Ideas.' },
  { id: '2026-10-05-team-source-fixer', date: '2026-10-05', team: true, hold: true, text: 'Sources that show 0 or 1 events now fix themselves: a smarter check works out where the page really loads its events from and saves a rule for it. See the "Fixed:" notes in /ops → Sources, or tap Try to fix.' },
  { id: '2026-10-05-team-footer', date: '2026-10-05', team: true, hold: true, text: 'Update texts now include the "no updates" line only on someone\'s first update and every 5th after that, instead of every time.' },
  { id: '2026-10-05-team-browser', date: '2026-10-05', team: true, hold: true, text: 'Sources whose events only show up after the page loads (like venues using a ticketing widget) can now be read with a real browser on our server. Sites that forbid bots (Bookeo, DICE, Resident Advisor) are never touched, so venues that only list events through them stay at 0.' },
  { id: '2026-10-05-music-mix', date: '2026-10-05', hold: true, text: 'Live music picks now mix small local shows and bigger names from all our sources, with ticket prices shown when the venue lists them.' }
];
