# Twilio demo connection

Two-way event collaboration by text is implemented (September 28, 2026). **Live sending stays off** (`SMS_MODE=preview`) until approved tester numbers are listed. **No SMS has been sent from this work.** Real incoming texts are not routed yet: the current Twilio sender already belongs to another app. Rehearse the full flow in the presenter text lab at `/lab`.

Verified against the live Twilio account on September 28, 2026 (read-only API checks; no messages created, no webhook URLs changed):

- Account is **active** / **Full**, with a positive SMS balance.
- Sender `+14157924712` exists on the account, SMS-capable, and is attached to messaging service `Sole Proprietor A2P Messaging Service`.
- US A2P 10DLC campaign on that service is **VERIFIED** (`SOLE_PROPRIETOR`).
- Outbound from this demo **must** use `TWILIO_MESSAGING_SERVICE_SID` (not a raw `From`) so traffic rides that campaign.
- Inbound SMS on `+14157924712` currently POSTs to a Field CRM Replit webhook. The toll-free number on the same account also points at Field CRM. **Do not retarget either webhook** without an explicit routing decision; that would break the other product.
- The API key can send and list numbers/services. Account-resource fetch needs the Auth Token (expected). Auth Token is still required to validate signed webhooks.

## Credentials and configuration

The project's ignored `.env` is the source for local setup. Do not copy the Backend environment. Names supplied by the business map as follows:

| Supplied term | Configuration |
| --- | --- |
| Account SID | `TWILIO_ACCOUNT_SID` |
| Standard API Key SID | `TWILIO_API_KEY_SID` |
| Client Secret (for that API key) | `TWILIO_API_KEY_SECRET` |
| Live account Auth Token | `TWILIO_AUTH_TOKEN` — required for webhook signatures |
| Twilio phone number | `TWILIO_FROM_NUMBER` in international format (inbound `To` matching) |
| Messaging Service SID | `TWILIO_MESSAGING_SERVICE_SID` — required for US outbound |

The API key and its secret authenticate outbound requests. The account Auth Token verifies signed inbound messages and status callbacks using Twilio's official SDK. These are different secrets.

`SMS_MODE=preview` disables sends. `SMS_ALLOWED_RECIPIENTS` must list consenting testers in international or 10-digit US format. `SMS_OPERATOR_KEY` is a separate generated presenter password; it is not a Twilio credential. `PUBLIC_BASE_URL` (now `https://rall-e.ai`) is the exact public HTTPS origin used for links and webhook signatures.

## Presenter flow

Create a plan and its guest invitations. From Invite links or Presenter controls, choose **Text approved testers**, then enter the private presenter password. Choose one guest, enter the consenting tester's number, and preview the exact invitation. In live mode only, check the consent confirmation and press **Send this text**. Confirmed plans can also send one confirmation per guest. Changing plans never sends automatically.

The password stays in React component memory while the panel is open; it is never bundled or saved to browser storage. Server routes require both the host session and presenter password. The default rolling daily cap is 20 explicit send attempts. Incoming TwiML acknowledgements are separate from that cap.

## Collaborating by text

`server/textflow.mjs` is the conversation engine. It maps each phone to its plans (`sms_threads`), and texts go to the most recent plan; `PLANS` / `SWITCH 2` changes that.

**Host (plans entirely by text).** An approved tester texts anything → Rall-e asks their name → confirms Hollywood → offers vibes (1–4 or free text) → pitches a sample outing (ask about time, price, access, age) → `YES` → “Mike 310-555-0102, Dave 310-555-0103, Sarah”. Friends with numbers get an invitation text with their personal link. Names without numbers (or numbers that can't be texted) come back as links to forward. Commands at any time: `STATUS`, `INVITE name number`, `CONFIRM`, `PICK 1`, `ADD dinner`, `REMOVE trail`, `LOCK` / `OPEN`, `DROP`, `DONE`, `LINKS`, `NEW`, `HELP`. Anything else is relayed to the group.

**Guests.** `YES` / `MAYBE` / `NO` (plus “I’m in”, “can’t”, …); suggestions (“how about dinner instead?”, `SUGGEST comedy`); `VOTE 1`; `STATUS`; questions (“what time?”, “how much?”, “who’s going?”) answered from the plan. Anything else is relayed to the group as “Mike: …” and saved to the plan's activity feed.

**Group updates.** Every committed plan change, from the web or by text, fans out to the other people on that plan who are on text: RSVPs (to the host; “is in” also to guests), suggestions and votes, host switches/stops/lock/confirm/drop, and group messages. Confirmations include each guest's personal link. A guest who turns off texts on their web page is muted. `STOP` is honored everywhere.

**Web hosts.** Presenter controls → Text approved testers → **Text me this plan’s updates** links the host's phone to a web-created plan. Invitations sent from that panel also link the guest's phone, so their replies work the same way.

**Text lab (`/lab`).** Protected by `SMS_OPERATOR_KEY`. Plays any number of fictional `555` phones side by side through the real engine. It refuses real-looking numbers, so it can't impersonate a person. In preview mode nothing is sent. In live mode, texts the lab generates for allowlisted testers really go out.

**Safety rails.** All outbound goes through one gate (`Sms.deliver`): preview mode logs only; live mode sends only to `SMS_ALLOWED_RECIPIENTS`, never to STOPped numbers, within `SMS_CONVERSATION_DAILY_LIMIT` (150) and `SMS_PER_RECIPIENT_DAILY_LIMIT` (40). Sends are serialized about 1/second (`SMS_SEND_SPACING_MS`) for Sole Proprietor A2P throughput, use the messaging service, are status-tracked through signed callbacks (`/api/twilio/status?log=…`), and a timeout is never retried. In live mode only allowlisted numbers can start a new plan by texting in. Inbound is signature-validated and deduplicated by MessageSid. Replies are sent through the queue, not TwiML, so every text is in the ledger.

## Inbound routing decision (still open)

Real two-way texting needs `+14157924712`'s incoming webhook (or a new number's) to point at `https://rall-e.ai/api/twilio/inbound`. Options:

1. **New toll-free number for Rall-e.** Keeps Field CRM untouched. Needs toll-free verification (days), about $2/month.
2. **Demo windows on the shared number.** Temporarily point the number at Rall-e during a scheduled demo, then restore Field CRM's URL. Record the original URL first.
3. **Proxy.** Rall-e receives everything and forwards unknown senders to Field CRM. Not recommended: Field CRM's own signature validation would likely fail.

A Sole Proprietor A2P brand allows only one 10DLC number, so a second 10DLC number would need a Standard brand/campaign.

## Remaining connection steps

1. Keep preview mode. Add consenting tester numbers to `SMS_ALLOWED_RECIPIENTS` only when they have agreed to receive this demo's texts.
2. Obtain a **dedicated** Rall-e number (or an agreed time-window to share `+14157924712`) before pointing inbound SMS at `https://rall-e.ai/api/twilio/inbound`. Inspect existing number configuration first; if it serves another app, do not change it.
3. When credentials are ready for the host, copy only Rall-e's selected configuration to root-owned `/etc/rally-demo.env`; never upload `.env` in the release archive. Preserve the SQLite directory. Leave `SMS_MODE=preview` until an approved tester send is scheduled.
4. Choose an inbound routing option above. After the webhook points at Rall-e, set `SMS_MODE=live` only for the demonstration. Start with one approved tester: text the number, verify the reply, delivery status and STOP. Then run the group flow.

## Behavior and prototype limits

- A preview expires after ten minutes and becomes invalid if the plan changes.
- A persistent send attempt is claimed before Twilio I/O. Duplicate clicks do not send again. A timeout is marked unknown and is never automatically retried; inspect Twilio's log before resolving it.
- Delivery callbacks validate the exact public URL and all form parameters. Accepted/queued/sent do not mean delivered. Late callbacks do not regress delivered status.
- Incoming replies are deduplicated by Twilio Message SID. A number on several plans texts its most recent one; the invitation says so and `PLANS`/`SWITCH` change it.
- STOP suppresses that phone number globally, including after resetting a demo, and marks the guest as stopped on the plan. START/UNSTOP re-enables texts (Twilio sends the confirmations). Twilio handles its own STOP acknowledgement.
- Phone numbers are stored only in the server's SMS ledger. Guest views do not expose them. Presenter history shows masked numbers. No provider error payloads or secrets are returned to the browser.
- Live scope: host planning, invitations, RSVPs, suggestions, votes, Q&A, group relay and plan updates by text. The in-app Texts view, MMS example and scheduled nudges remain simulations. There is no background scheduler, and texting non-testers is not allowed.
- Replies are keyword/pattern based (deterministic), not an LLM. Unrecognized text from a guest is treated as a group message.
- Switching to a suggestion keeps existing RSVPs; the switch text asks everyone to reply again.
- US 10-digit numbers are stored as `+1…`. Outbound uses the messaging service when `TWILIO_MESSAGING_SERVICE_SID` is set.

References: [Twilio API authentication](https://www.twilio.com/docs/usage/requests-to-twilio), [signed webhook validation](https://www.twilio.com/docs/usage/webhooks/webhooks-security), [Messaging Services](https://www.twilio.com/docs/messaging/services).

## Texting agent (Claude) and phone-first signup — built September 28, 2026

- **Agent** (`server/agent.mjs`): when `ANTHROPIC_API_KEY` is set, Claude (`claude-sonnet-5-5` with effort `low`, set via `ANTHROPIC_MODEL`/`ANTHROPIC_EFFORT`) handles every incoming text in plain language.
  - Its tools call the same plan operations as the web app: start account, recommend, make plan, invite, add/remove stop, lock/open, pick suggestion, confirm, cancel, done, new plan, links, message group; and for guests RSVP, suggest, vote, message group.
  - The model never sends texts itself. Its answer is the one reply to the sender, and group notices come from the deterministic fan-out.
  - Invites only use phone numbers the host actually typed in their last six texts.
  - STOP/START/HELP never reach the model. Texts from one phone are handled in order.
  - If the API fails, the keyword engine answers instead. `SMS_AGENT=off` disables the agent.
- **Contact card**: each phone gets one MMS with `https://rall-e.ai/rall-e.vcf`, a vCard named "Rall-e" with the blue R icon and the Rall-e number, so people can save Rall-e like Instinct. It is sent on first contact, with invites, and after web signup.
- **Phone-first signup** (`server/signup.mjs`, web onboarding): phone → 6-digit code texted from the Rall-e number → name → account.
  - Codes are hashed, expire in 10 minutes, are single-use, and allow 5 tries. Requests are limited to 1 per 30 s and 5 per hour per phone, and 10 per hour per IP.
  - A verified phone is linked to the account, so the same person plans on the web or by text. A returning phone signs back into its existing account.
  - Live mode only texts approved testers; others use "Skip for now". Preview mode shows the code on screen and never links the phone.
- **Go live with the agent**: add `ANTHROPIC_API_KEY=` to `.env` (key from https://platform.claude.com/settings/keys), then run `.local\go-live.cmd`. It runs 25 tests, builds, deploys, and, when the agent is on, sends the three testers a one-time "Rall-e is ready" text plus the contact card (`server/announce.mjs`, key `agent-v1`). Remote output is saved to `.local\deploy-remote.log`.
