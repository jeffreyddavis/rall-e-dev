// The team-facing notes behind the Sources tab ("How we pick sources"). Keep in step with docs/DATA_SOURCES.md.
// Plain data so anyone can update it: add a row to `decisions` when the team reviews a new idea.
export const SOURCE_NOTES = {
  updated: 'Oct 1, 2026',
  how: [
    ['Calendar feeds first', 'For each source page Rall-e first looks for a proper calendar feed: Localist calendars (many universities, museums and cities), feeds the page links to (.ics, iCal, webcal), WordPress event calendars, and CivicPlus city calendars. Only when there is none does Claude read the page, which costs a little.'],
    ['Checked twice a day', 'Every source is re-read about every 12 hours. Pages whose text hasn’t changed aren’t re-read by AI.'],
    ['Local music automatically', 'When someone asks about live music, Rall-e finds small music venues near them (skipping arenas, casinos and big theaters) and adds up to 8 of their websites as sources, once a week per area. JamBase adds local and national concerts with venue size, so local gigs rank above arena shows.'],
    ['One-off events by hand', 'Supper clubs, pop-ups, night markets and other things with no feed: add them with “Add a one-off event by hand” above. They show up in searches near that city.'],
    ['House rules', 'Public pages only, robots.txt respected, no logins, and we take event facts (what, when, where, price), not other people’s writing or photos.']
  ],
  decisions: [
    ['Done', 'Schema.org event data, calendar feeds, CivicPlus, Localist', 'Per source and per venue. A whole-web crawl (Web Data Commons host list) can come later.', 'Marc’s niche-sources doc'],
    ['Done', 'One-off events by hand (“own the deserts”)', 'Form on this tab, both keys.', 'Marc’s niche-sources doc'],
    ['Done', 'JamBase (live music)', 'Trial key: 1,000 calls until Oct 15, hard stop. Free Developer plan is non-commercial with attribution; Startup is $500/mo.', 'Mike: local music'],
    ['Done', 'LA sources from the booking-sites sheet', 'Comedy Store calendar, Fever, Luma LA, The LA Grind, Hollywood Bowl, USC (Localist), LA Public Library. Escape Room LA and Pottery Studio are bookable activities with no event list.', 'LA booking-sites sheet'],
    ['Waiting on a key', 'USDA Local Food Portal (farmers markets, farm stands, u-pick, agritourism)', 'Built. Needs a free key: usdalocalfoodportal.com/fe/fregisterpublicapi/ (set USDA_LOCALFOOD_KEY).', 'Marc’s niche-sources doc'],
    ['Waiting on a key', 'ACTIVE Network (parks and rec, YMCAs)', 'Needs a free registration key. Not built yet.', 'Marc’s niche-sources doc'],
    ['Team signup', 'Fever, TodayTix, Viator/GetYourGuide affiliates, SeatGeek', 'Business signups needed. Fever’s public LA page already feeds us.', 'Marc’s niche-sources doc'],
    ['Skipped', 'Resident Advisor, DICE internal data, hidden map data behind trivia and run-club finders', 'Against those sites’ terms. Better through partnerships.', 'Marc’s niche-sources doc'],
    ['Skipped', 'PickYourOwn.org', 'They forbid republishing; Rall-e only links out.', 'Marc’s niche-sources doc'],
    ['Skipped', 'Apify TikTok scraping', 'TikTok’s terms restrict scraping. Worth a team conversation first.', 'LA booking-sites sheet'],
    ['Later', 'Food-truck city open data, parkrun, Untappd, Burbio', 'City-by-city, tiny US footprint, no events, or sales-gated.', 'Marc’s niche-sources doc'],
    ['Not a source', 'OpenTable, Resy, Peerspace, LA City Golf', 'Booking platforms, not event lists. Tables go through “book a table”.', 'LA booking-sites sheet']
  ]
};
