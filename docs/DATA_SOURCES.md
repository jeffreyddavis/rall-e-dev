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
- **Anything behind a login**, Facebook events, or sites whose `robots.txt` asks bots to stay out. Rall-e checks robots.txt and reports it as the error.
- **Sweatpals and similar apps**: add a public page only if it loads without an account and robots.txt allows it; otherwise skip it.

## Checking quality
- The Sources tab shows each source's event count, when it was last checked, and any error.
- If a page gives 0 events, look for a calendar feed on the same site instead.
- To test, text Rall-e "what's on this week" as someone in that city, or check what it shows for that city.
