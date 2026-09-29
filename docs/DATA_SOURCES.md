# Event sources playbook

This is how the team feeds Rall-e good local events city by city, beyond Ticketmaster and Google Places. Code is in `server/sources.mjs`; the UI is the **Sources** tab in `/ops` (operator key only).

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

## What we don't pull from
- **Partiful**: events are private invites with no public listings. We only see them when a member shares a link with Rall-e.
- **ClassPass and Mindbody**: classes sit behind logins, and their terms forbid scraping. The right path is their partner and affiliate programs, when we're ready.
- **Anything behind a login**, Facebook events, or sites whose `robots.txt` asks bots to stay out. Rall-e checks robots.txt and reports it as the error.
- **Sweatpals and similar apps**: add a public page only if it loads without an account and robots.txt allows it; otherwise skip it.

## Checking quality
- The Sources tab shows each source's event count, when it was last checked, and any error.
- If a page gives 0 events, look for a calendar feed on the same site instead.
- To test, text Rall-e "what's on this week" as someone in that city, or check what it shows for that city.
