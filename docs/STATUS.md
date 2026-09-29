# Rall-e status

_Last updated: 2026-09-29. Update this file with every round of work (see AGENTS.md)._

## Live state
- **Site:** https://rall-e.ai. It's the texting prototype in LIVE mode for testers and people who opted in. Web signup and share pages are public.
- **People:**
  - Jeff is the owner and operator.
  - Mike and Marc are testing and giving product feedback. Mike focuses on viral loops and sharing; Marc on the plan pages.
  - Tori and VCs will be invited for the demo, and Jeff's wife Deborah is testing.
  - The business side has the viewer dashboard.
  - Phone numbers live only in `.env` and the DB, never in docs.
- **Channels:**
  - iMessage: Sendblue dedicated line +1 310-307-6383 ($100/month; inbound-first).
  - SMS/MMS: Twilio +1 415-792-4712, a Sole Proprietor A2P 10DLC campaign (about 1 msg/sec; about 3k segments/day across carriers).
- **AI:** Claude `claude-sonnet-5-5` (Messages API, tool loop). Backup: OpenAI `gpt-6-sol` with `reasoning_effort: none`, tested in a simulated outage.
- **Discovery:**
  - Ticketmaster (free tier: only about a third of events carry prices), Google Places + photos, SerpApi showtimes (free, 250/month).
  - Pending: Gracenote (key in about a week), SeatGeek (approval).
- **Vault:** on. Stripe is in **test** mode; the Stripe account's public name still shows "MacroFit", so rename it in the Stripe dashboard.
- **Tests:** 65 pass.

## Open items / next
- **Invite texting (see the project doc `claude/invite-texting-research.md`):**
  - Build a "text the invite from your phone" button: a prefilled `sms:` link or share sheet, sent person-to-person, so no consent issue.
  - Start registering a Standard/Low-Volume Standard 10DLC brand. It needs an EIN; use a new Messaging Service so the current line keeps working.
  - Update the Twilio campaign's opt-in description for web double opt-in and for people who text in.
- **Webhook timeouts:** Twilio inbound twice timed out with no trace on our side. The catch-up poller now recovers them. The shared Apache has no Rall-e access log; consider one (careful: MacroFit shares the host).
- **Custom stops** (e.g. "pick up milk"): the agent can only add found places. Consider free-text stops.
- **Before going public:**
  - Run wipe-all and delete the `rally.pre-*.sqlite` backups on the server.
  - Decide what the viewer dashboard shows.
- **Ideas:** real iMessage group chats (Sendblue groups), travel times, reservations/tickets, SeatGeek/Gracenote once keys arrive, Donovan's frosted-glass spec, and watching the SerpApi quota.

## Change log (newest first)
- **09-29, "one thread per person" and "missed texts":**
  - Android users who text the Sendblue line are answered there, not from the Twilio number. Before, they ended up with two threads.
  - A per-minute catch-up recovers inbound texts whose webhook never arrived.
- **09-29, "picture cards on SMS":** option cards to green-bubble phones go out as MMS with the preview image and a title line.
- **09-29, "opt-in by texting in":**
  - An invited friend who texts Rall-e is opted in, and their first reply includes the STOP/HELP wording.
  - The invite page shows "Texts are on" only when true.
  - `/ops` lists everyone who has texted in, tagged "not opted in" when we can't reply.
- **09-29, "new plan keeps the old one":** starting a new plan with friends on the current one creates a second plan instead of wiping it.
  - Jeff's Te'Kila + Casa Vega plan (with Mike and Marc) was restored from a backup after the family plan replaced it.
  - Former guests aren't treated as strangers.
- **09-29, "day, not night":**
  - Wording no longer assumes plans happen at night.
  - Friends can turn on texts from their invite page.
  - The agent never promises to text people who haven't opted in; it tells the host to forward their link.
- **09-29:**
  - Stripe card form fix.
  - Insights gaps: status and notes, 10 per page, visible to viewers.
  - One-time Insights backfill from testing history.
  - OpenAI backup brain.
  - Insights tab.
  - Viewer dashboard with no operator hints.
  - Wipes (per person, and all).
  - Usage tab.
  - Earlier search results kept for follow-ups.
  - All requested options on the list page.
- **09-28 → 09-29:** the texting prototype: Rall-e agent, iMessage via Sendblue, live discovery, option cards and pages, share and join loop, vault, demo console.
- **09-27:** first deploy of the web demo on EC2.
