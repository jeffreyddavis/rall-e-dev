# Rall-e: start here (for developers and AI agents)

Rall-e is an AI agent you text to find things to do and plan them with friends. This repo is the **prototype being demoed to investors**, and it is live at https://rall-e.ai with real testers. Treat production with care: real people's texts go through it.

This file covers how the project works and the rules. **`docs/STATUS.md`** covers where things stand right now: what's live, recent changes and open items. Read both before changing anything.

> **Keep these current.** Whoever finishes a round of work (human or agent) updates `docs/STATUS.md` in the same commit: add a line to the change log, and adjust "Live state" and "Open items". Change this file when architecture, workflow or rules change.

## Product in one minute
- **Hosts text Rall-e.**
  - The agent (Claude, with OpenAI as backup) finds real things nearby: events, restaurants, movies, outdoors.
  - It sends options as picture cards and builds a plan with one or more stops.
  - It invites friends and fans out every change.
- **Friends** get a personal link (`/p/<token>`). There they RSVP, tap "My pick", suggest ideas and chat. Once opted in, they can do all of this by text too.
- **Invite-only.**
  - The website (`/`) is the front door: join the waitlist, or accept an invite at `/i/<code>`. There is no web chat anymore; Rall-e lives in texts.
  - Every member gets 10 invites (`INVITES_PER_USER`). An invite counts when someone joins. The inviter is texted when that happens.
  - Members manage reusable links, and their profile photo, on a private page at `/me/<token>`, which Rall-e texts them (30 days).
  - Strangers who text Rall-e get one "invite-only / waitlist" reply, then silence.
- **Pages:**
  - `/n/<token>`: host's plan view.
  - `/s/<token>`: public share page with "join".
  - `/e/<id>`: one option.
  - `/v/<token>`: vault, a one-time 15-minute link for card, address and allergies.
  - `/lab`: text simulator with fictional 555 numbers.
  - `/ops`: operator dashboard.
- **Texting is the main experience.** The web pages support it.

## Architecture
| Area | Files | Notes |
| --- | --- | --- |
| HTTP server + routes | `server/index.mjs` | A single Node `http` server with no framework. It also serves the Vite build from `dist/` and OG preview tags and images. |
| Plans / sessions | `server/store.mjs` | SQLite via `node:sqlite`. One **session** holds one host and their current `plan`. Tokens are stored hashed. `invites` maps friend links to participants. |
| Texting engine | `server/textflow.mjs` | Threads (`sms_threads`: phone ↔ session, role host/guest), routing, keyword fallback engine, group fan-out (`onPlanEvent`), option cards, invites, opt-in by texting in, `newPlan`. |
| AI agent | `server/agent.mjs`, `features.mjs` | The system prompt, per-turn "situation" (`state()`), tools per role (`new`/`host`/`guest`), and the tool loop. `call()` tries Claude, then OpenAI on outage errors (circuit breaker of about 2 minutes). |
| Messaging transport | `server/sms.mjs`, `sendblue.mjs` | `deliver()` is the **only** way to send, and it enforces opt-in, STOP and daily caps. Twilio handles SMS/MMS; Sendblue handles iMessage/RCS. There's also the webhook catch-up poller (`catchUp`), the ops data and the lab. |
| Invites / waitlist / photos | `server/invites.mjs`, `photos.mjs`, `src/Design.jsx` (Onboarding: waitlist + invite join), `src/MePage.jsx` | Tables: `invite_links`, `invite_uses`, `invite_quota`, `me_links`, `waitlist`, `profile_photos`. Photos are re-encoded with `sharp` to 320×320 JPEG, which strips EXIF/GPS. The Apache body limit is 32 KB, so the page shrinks uploads in the browser first. |
| Curated sources / weather / own events | `server/sources.mjs`, `discovery.mjs` (`weather`, `customEvent`, `local`) | Sources tab in `/ops`: ICS feeds (parsed) and event pages (schema.org JSON-LD, else Claude reads the page). Respects robots.txt; refreshed every 12h; events in `curated_events`. Weather from api.weather.gov (US). Their own events get ids `cu_*`. The playbook is in `docs/DATA_SOURCES.md`. |
| Time awareness | `server/timeline.mjs` | `localNow`, `planTiming` (the verdict line in the agent's situation), `plan.when` / `plan.progress` on the session's plan. |
| Agent memory | `server/memory.mjs` | Per-person facts (`remember`/`forget`), behavior signals, and the capped card shown in `state()`. A person's facts are only used in their own conversation; sensitive facts only when they said them. Design: `docs/MEMORY.md`. |
| "What's new" texts | `server/whatsnew.mjs`, `server/releases.mjs` | Release notes texted to every member when they go live (opt out: "no updates"). **Add a line to `releases.mjs` for every user-facing feature or fix** (`hold: true` until Jeff approves wording). |
| Reservations and purchases | `server/bookings.mjs`, `src/TransactionsTab.jsx` | Booking links pre-filled for the venue's platform, the `bookings` table, and the /ops Transactions volume. Never log in to people's Resy/OpenTable accounts; card numbers never go to the AI. |
| Restaurant calls | `server/voice.mjs` | Vapi outbound calls to Google-verified restaurant numbers, only on an explicit member request. Transient assistant with inline structured extraction, per-call authenticated webhook and reconciliation; result texts use `sms.deliver()` and include the restaurant's reason plus a quote (structured output v2, transcript fallback; stored in `voice_calls.details`). Listens first and can press phone-menu keys (dtmf) only to reach reservations/staff. Requires an imported outbound-capable number and `VAPI_CALLS_ENABLED=live`. Setup: `docs/VAPI.md`. |
| Who else is going | `server/going.mjs` | Events people say they're going to (`going` table); friends = saved contacts either way or shared plans; only `share=1` rows are ever shown. |
| Favorites | `server/favorites.mjs`, `src/FavPage.jsx` | Top-5 lists per category and city; public `/f/<token>` page; friends' lists feed `find_things` results. |
| Ideas inbox | `server/ideas.mjs`, `src/IdeasTab.jsx` | Member tips (gems, sites, feedback, features) plus team ideas; the team task list. Tips never change agent behavior until approved. |
| Group polls | `server/polls.mjs`, `src/PollPage.jsx` | Tables: `polls`, `poll_people` (one token per person), `poll_answers` (pick/rank/defer). Scoring: a pick counts as N points; a ranking gives N-1 down to 0. |
| Discovery | `server/discovery.mjs`, `catalog.mjs` | Ticketmaster, Google Places (+photos), SerpApi movie showtimes (12h cache), and a Gracenote adapter (key pending). Found items are persisted in `discovered_events`. |
| Other server modules | `vault.mjs`, `signup.mjs`, `og.mjs`, `stats.mjs`, `usage.mjs`, `wipe.mjs` | Vault (AES-GCM, Stripe SetupIntents), web signup/opt-in codes, OG images (JPEG), anonymous Insights, API usage, and wipes. |
| Front end | `src/*.jsx` | React + Vite. The main files are `OpsPage.jsx`, `Insights.jsx`, `EveningView.jsx`, `GuestPage.jsx`, `VaultPage.jsx`, `OptionCard.jsx` and `SharePage.jsx`. |
| Tests | `test/*.test.mjs` | `node --test test/*.test.mjs`, with no network. The Twilio/Sendblue/Anthropic fetch calls are stubbed. **All must pass before deploy** (the deploy script enforces it). |

### Key concepts / gotchas
- **Phones and roles.** A phone can have several threads. `threadsFor(phone)` returns only live ones: the session still holds that plan id, and a guest's invite hasn't expired (7 days). No threads means role `new`. Someone who *had* threads is treated as a former guest, not a stranger.
- **New plan ≠ wipe.** If friends are on the current plan, `start_new_plan` / `NEW` creates a **second session** for the host, and the old plan keeps its guests. `store.resetAt` wipes a plan in place and deletes its invites, so use it only for empty drafts.
- **Opt-in (legal and demo safety).** Rall-e texts only numbers in `sms.allowed`. That set is `SMS_ALLOWED_RECIPIENTS` (core testers) plus the `sms_optins` table. People get into `sms_optins` in three ways:
  - Web double opt-in: a consent box plus a texted code, on a share page or an invite page.
  - An invited friend texting Rall-e first. Their first reply carries the STOP/HELP wording.
  - STOP is always honored.

  A host typing a friend's number **never** lets us text that friend: carrier rules forbid third-party consent. The agent tells the host to forward the friend's link instead. See `ops/`, and the project doc on invite texting.
- **Channels.**
  - iPhone users get iMessage via Sendblue on +1 310-307-6383.
  - Android users get SMS/MMS via Twilio on +1 415-792-4712.
  - Exception: people who text the Sendblue line are answered on that line (`lastLine`).
  - If Sendblue refuses a recipient (`INBOUND_ONLY_PLAN`), the text falls back to Twilio.
  - Option cards on plain SMS go out as MMS with the preview image attached, because SMS draws no link previews.
- **Webhooks can go missing.** Twilio has twice timed out reaching us. `sms.catchUp()` runs every minute and after startup. It polls both providers for recent inbound texts and handles unseen ones, deduplicated by `sms_inbound`.
- **Privacy.**
  - Card numbers texted in are scrubbed before storage.
  - The AI sees only masked vault data.
  - Insights are anonymous (salted daily hashes). 555 lab numbers are excluded from stats and from the ops people list.
  - Gap examples must be free of personal information.
  - Restaurant calls disable audio recordings, detailed logs and packet captures. Vapi transcript artifacts are enabled for post-call extraction; only limited reservation results are stored locally. The caller stops when a restaurant requires payments or full contact details.
- **The running server loads `discovered_events` only at startup.**

## Workflow
### Run locally
```sh
npm ci
node --env-file=.env server/index.mjs   # Node 24+; http://127.0.0.1:3000, /lab for the text simulator
npm run dev                             # Vite front-end dev server
node --test test/*.test.mjs             # unit tests
```
Without `SMS_MODE=live` nothing is ever texted: preview mode logs instead.

### Deploy (production)
- `bash scripts/deploy.sh live`. It rsyncs a clean copy, runs `npm ci`, tests and build, then uploads and activates with a health check and **automatic rollback**.
  - Needs the SSH alias `rally` (`scripts/ssh-config.example`; get the key from Jeff).
  - Needs the repo `.env`. Server secrets are generated from it; only the whitelisted keys in the script are sent.
- **Server layout:**
  - Releases: `/opt/rally-demo/releases/<stamp>`, with `current` as a symlink.
  - Settings: `/etc/rally-demo.env`.
  - DB: `/var/lib/rally-demo/rally.sqlite`.
  - systemd service: `rally-demo`, on port 3107.
  - Apache in front: a shared host that also serves an unrelated MacroFit app, so **don't touch other vhosts**.
- **One-off scripts against live data:** `bash scripts/server-node.sh my-script.mjs [--stop]`.
  - **Back up the DB before any write** (`sudo cp rally.sqlite rally.pre-<what>.sqlite`).
  - Use `--stop` for anything that rewrites sessions or threads.
- **Wipe everyone before going public:** `node server/wipe-all.mjs --confirm-wipe-all-conversations`, run on the server via `server-node.sh`. Also delete the `rally.pre-*.sqlite` backups then.

### Git
- Remote: `github.com/jeffreyddavis/rall-e`, branch `master`. **Push every finished, tested and deployed round.**
- `bash scripts/gitpush.sh <message-file>` does `git add -A`, a **secret scan** (every `.env` value plus common key patterns; it refuses if any is found), then commits and pushes. It uses `GITHUB_TOKEN` from `.env` only for the push, and sets `GIT_NAME`/`GIT_EMAIL` to commit as yourself.
- `.env`, `*.env`, `.local/`, `data/` and `dist/` are git-ignored. Never commit secrets or tester phone numbers.

### Operating the live demo
- **`/ops`, operator key (`SMS_OPERATOR_KEY`):**
  - Conversations: every tester, and anyone who has texted in, tagged "not opted in" when we can't reply.
  - Nudge the agent with an instruction, send exact text, and wipe a person.
  - Insights, including the "couldn't do" gaps table with status and notes.
  - Usage and remaining quota for Claude, OpenAI, Twilio, Sendblue, SerpApi, Ticketmaster, Google and our caps.
- **`/ops`, viewer key (`OPS_VIEWER_KEY`)** is for the business side: read-only.
  - **It must not reveal that operator features exist**, not even on the login page. Operator-only API routes return 404 to viewers.
- **Follow-ups to a tester:** use `POST /api/ops/nudge {phone, note}` with an instruction. The agent then writes the text in its own voice. Get Jeff's OK before texting testers on his behalf.

## Product principles
- **Promote features that solve the problem.** When what someone says is exactly what a feature handles, Rall-e offers it right away (need-based offers aren't throttled like unprompted tips).
  - Example: a host unsure what the group wants → offer a group vote (`start_poll`).
  - Keep that mapping in the agent prompt ("Answering a need") and in `server/features.mjs` when adding features.

## Rules (non-negotiable)
1. Never paste secrets in chat, Slack, commits, docs or logs. Show only the last 4 digits of phone numbers in logs.
2. Only opted-in or allowlisted people get texts. Never text someone because a host provided their number.
3. Every outbound text goes through `sms.deliver()`, which applies opt-in, STOP, caps and logging.
4. The AI only sees masked vault data. Card numbers are never stored or sent to the AI.
5. Operator-only actions are enforced on the server. The viewer dashboard shows no hint of them.
6. Tests must pass, and deploys go through `scripts/deploy.sh` (tests, rollback). Push to GitHub after each round.
7. Keep `docs/STATUS.md` (and this file) current in the same commit as the change. User-facing changes also get a release note in `server/releases.mjs`; members are texted about it after deploy.
8. Don't copy the unrelated "Backend" `.env` into this project.

## Other docs
- `docs/MEMORY.md`: proposed architecture for agent memory (per-person facts, episodes, crews, general learning).
- `docs/STATUS.md`: live state, change log, open items (updated every round).
- `ops/TWILIO_SETUP.md`, `ops/VAULT.md`, `ops/DEPLOYMENT_STATUS.md`: setup history and details (older; STATUS.md wins when they disagree).
- `PROTOTYPE_SCOPE.md`: the original scope. `README.md`: the original web demo walkthrough.
