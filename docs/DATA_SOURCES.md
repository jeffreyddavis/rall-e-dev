# Event sources playbook

This is how the team feeds Rall-e good local events city by city, beyond Ticketmaster and Google Places. Code is in `server/sources.mjs`; the UI is the **Sources** tab in `/ops` (both the operator and viewer keys).

## Adding a source
1. Find a public calendar feed or events page for the city (see the list below).
2. In `/ops` → Sources, paste the link and the city (for example "Austin, TX"), and optionally a name.
3. Rall-e reads it right away and shows how many upcoming events it found (next 90 days), or why it couldn't.
   - It re-checks every source about every 12 hours.
   - Its events then appear in searches for people near that city (about 30 miles), next to Ticketmaster and Places.

You can also drop links in Slack for the agent/developer to add.

## What works best (in order)
| Kind | How to get the link | Notes |
| --- | --- | --- |
| **Meetup groups** | `https://www.meetup.com/<group-name>/events/ical` | Official feed; free. Pick active groups: run clubs, board games, hiking, language exchange. |
| **Luma calendars** | On the calendar page, use "Add iCal Subscription" and copy the link | Official feed. Community, tech, wellness and social calendars per city. |
| **Venue / organizer calendars** | "Subscribe", "iCal" or "Add to calendar" links on their site; public Google Calendars ("Public URL to this calendar", iCal format) | Comedy clubs, bookstores, breweries, parks departments. |
| **Event listing pages** | The page itself | Works when the page has schema.org event data (most ticketing, venue and tourism sites). Otherwise Claude reads the page text, which uses some Claude tokens (shown in Usage). |

## Local music (automatic)
When someone asks about live music, Rall-e finds small music venues near them on Google Places (it skips arenas, amphitheaters, casinos and performing-arts centers) and adds their websites as sources. It adds up to 8 per area, once a week. From then on their calendars are read every 12 hours. Music results are ranked with local gigs first, then smaller Ticketmaster shows, then the venues themselves, and big venues last.
City listing sites work well too, for example [WannaGoSee](https://wannagosee.com/rhode-island/greater-providence/) for Greater Providence.

## Automatic feed finding (since 10-01)
When a source page has no structured event data, Rall-e looks for a feed before paying for AI reading:
- **Localist** calendars (many universities, museums and cities) through their open `/api/2/events` API.
- **Calendar feeds the page links to**: `<link rel="alternate" type="text/calendar">`, `.ics`, `?ical=1` and `webcal:` links, and The Events Calendar's `/events/?ical=1`.
- **CivicPlus city calendars**: the `iCalendar.aspx` page and its per-category feeds.

The same checks run when the agent checks a venue (`check_places`). Example: adding `https://calendar.usc.edu/` picked up 150 events through Localist.

## Fixing sources that show 0 or 1 events (since 10-05)
People add sources that clearly list events, so a refresh that finds 0 or 1 is treated as a reading problem. Usually the page loads its events a second after it opens (JavaScript calling an API, a calendar widget, a feed), so its HTML has none.
- A one-time **debugging run** (`server/sourcedebug.mjs`, Claude Opus, `SOURCE_DEBUG_MODEL`) looks at the page like a developer: scripts, iframes, embedded JSON, feed and API links. It tests a rule and saves it only if it reads at least 2 upcoming events.
- **Rules** (`event_sources.rule`): an `.ics` feed, a JSON API with a field mapping, another page with schema.org events, or AI reading of a better list page. Refreshes use the saved rule first.
- At most **2 automatic runs per source**, one at a time. Runs use Opus, so they are capped per rolling 24 hours, separately: **40 automatic** runs (`SOURCE_DEBUG_DAILY`) and **30 Try to fix** clicks (`SOURCE_DEBUG_MANUAL`), so background runs can never use up the button. /ops says how many Try to fix are left and when another frees up. `/ops` → Sources shows "Working out how to read this page…", then "Fixed: …" or "Checked: …", and a **Try to fix** button for another run.
- Same limits as everything else: public pages only, robots.txt honored, plain GET requests, no logins, API keys or tokens, nothing on private networks, and never Resident Advisor's or DICE's internal APIs (see below). - **Pages that need a real browser** (events appear only after JavaScript runs, with no feed or API we may use): a `browser` rule opens the page in headless Chromium first (`server/renderer.mjs`, its own service `rally-render` on 127.0.0.1:3108 with a 700 MB cap, set up once with `bash scripts/setup-renderer.sh`). It reads the rendered page like a visitor would (schema.org data, else AI reading, skipped when the text hasn't changed). Bookeo, DICE and Resident Advisor requests are blocked even inside a rendered venue page (`NO_BOTS` in `server/publicurl.mjs`), so venues that only list events through them (Zebulon via DICE, Escape Room LA via Bookeo) stay at 0. Without the service, browser rules fail cleanly and the debugger doesn't offer them.

## Flyers members text in (since 10-06)
A public event someone texts a flyer or screenshot of lands in /ops → Ideas as a "Flyer event" (date, time, place, price). Approving it adds it to the index like a one-off event added by hand.

## Organizer newsletters (since 10-06)
Organizers send or forward newsletters to **events@rall-e.ai** (Cloudflare Email Routing → Email Worker `ops/cloudflare-email-worker.js` → `POST /api/inbound/email`). Claude reads the city and upcoming events. A new sender shows up in /ops → Ideas as "Newsletter from …"; approving adds its events and trusts the sender, so its later newsletters go straight in; declining blocks it.

## One-off events by hand
`/ops` → Sources → "Add a one-off event by hand" (both keys). Use it for supper clubs, pop-ups, night markets and other things with no feed. The doc calls this "own the deserts." The events show up in searches near that city.

## Marc's niche-sources doc (10-01): what we did and didn't do
| Item | Decision |
| --- | --- |
| schema.org/JSON-LD, iCal/RSS feeds, CivicPlus, Localist | **Done.** Done per source and per venue, not as a crawl of the whole web; a Web Data Commons host crawl can come later. |
| USDA Local Food Portal (farmers markets, agritourism, u-pick) | **Built; needs a free key.** Register at usdalocalfoodportal.com/fe/fregisterpublicapi/ and set `USDA_LOCALFOOD_KEY`. Farm and market searches then use it. |
| ACTIVE Network (parks and rec, YMCAs) | Needs a registration key; worth applying. Not built yet. |
| Manual seeding of "deserts" | **Done** (one-off events form). |
| PickYourOwn.org | Never ingested: they forbid republishing. Link out only. |
| Resident Advisor GraphQL, DICE internal JSON, capturing hidden locator endpoints (trivia, run clubs) | **Skipped.** These go against those sites' terms; we stick to published data and robots.txt. Revisit through partnerships. |
| Fever, TodayTix, Viator/GetYourGuide affiliates, SeatGeek | Need business signups (team). Fever's public LA page already feeds us. |
| Food-truck open data (Socrata/ArcGIS), parkrun, Untappd, Burbio | Later or no: city-specific, tiny US footprint, no events, or sales-gated. |

## Sources added 09-30
- **Los Angeles** (from the team's LA booking-sites sheet): The Comedy Store calendar, Fever Los Angeles, Luma Los Angeles, The LA Grind (Luma), Hollywood Bowl, Escape Room LA, and Pottery Studio 1 LA.
  - Escape Room LA and Pottery Studio are bookable activities without an event list, so they show 0 events.
  - The Hollywood Bowl page builds its schedule in the browser, so it reads 0; its shows mostly come through Ticketmaster.
  - DICE's LA page returned 404; it needs a working city URL.
- **Rhode Island**: WannaGoSee's Greater Providence and Providence pages, plus local venues adopted automatically (The Parlour, Nick-A-Nees, The Met, Myrtle and others).
- **From the sheet but not sources:** OpenTable, Resy, Peerspace and LA City Golf are booking platforms, not event lists; booking goes through `book_table`. Apify (TikTok scraping) is an idea to discuss: TikTok's terms restrict scraping.
- **JamBase** (added 09-30): local and national concerts with venue capacity, used for every live-music search (20-mile radius). Trial plan: 1,000 calls, hard stop; Developer plan is free for non-commercial use with attribution; Startup is $500 a month.

## What we don't pull from
- **Partiful**: events are private invites with no public listings. We only see them when a member shares a link with Rall-e.
- **ClassPass and Mindbody**: classes sit behind logins, and their terms forbid scraping. The right path is their partner and affiliate programs, when we're ready.
- **Bookeo, DICE, Resident Advisor** (`NO_BOTS` in `server/publicurl.mjs`): their terms forbid automated access. Bookeo enforces it: testing Escape Room LA's booking widget on 10-05 got the tester's IP blocked for 2 hours. Blocked for the source reader, the debugging agent and the page renderer, including widgets inside a venue's own page. Such venues can still be recommended as places, or their events added by hand.
- **Anything behind a login**, Facebook events, or sites whose `robots.txt` asks bots to stay out. Rall-e checks robots.txt and reports it as the error.
- **Sweatpals and similar apps**: add a public page only if it loads without an account and robots.txt allows it; otherwise skip it.

## Checking quality
- The Sources tab shows each source's event count, when it was last checked, and any error.
- If a page gives 0 events, look for a calendar feed on the same site instead.
- To test, text Rall-e "what's on this week" as someone in that city, or check what it shows for that city.
