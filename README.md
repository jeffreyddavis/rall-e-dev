# Rall-e prototype

A conversational Hollywood outing demo: discover an idea, bring friends in through personal links, collect text/web responses and suggestions, and confirm one shared plan. The business export takes precedence over the older brief: booking, cost splitting, payments, and calendar connectors are excluded.

**Live demo: https://rall-e.joinfitapp.com**

Deployed September 27, 2026 on the existing EC2 host with its own Apache virtual host, isolated Node 24.21.0 runtime, systemd service, and SQLite data directory. Updated from the supplied Rally Figma exports: blue/white branding, photo-led invitations, signup preview states, and RSVP/vote confirmation. The primary product experience is SMS; browser chat is a presenter preview. Event inventory and scheduled nudges remain simulations; Bedrock is optional and not connected. The Twilio invitation/RSVP adapter is installed but disabled pending configuration. See [design review](design-reference/REVIEW.md) and [Twilio setup](ops/TWILIO_SETUP.md).

## Run locally

Use **Node 24 or newer** (SQLite is built into Node). The system Node on the initial development machine is older, so the bundled Node 24 runtime was used for validation.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3000. The signup screens are a demo: only the first name is saved, verification uses the displayed code 123456, and Google connection is skipped. This is not authenticated signup. Each browser gets its own isolated demo session. Data persists in `data/rally.sqlite`, including conversation, preference scores, plans, and invitations. There is no external database requirement.

On this Windows machine, `./start-demo.ps1` automatically uses the bundled Node 24 runtime when system Node is too old.

Environment files are not automatically loaded. To use an optional local `.env`, run `node --env-file=.env server/index.mjs`. Keep all credentials server-side. Do not copy the unrelated Backend environment file here.

## Three-minute walkthrough

1. Choose **Try the demo**, continue through the welcome and first-name screen, skip phone verification, and choose **Let’s make a plan**. Confirm Hollywood and pick **Live shows**. A sample rooftop event appears.
2. Type **When do doors open?** Then **not that, something outdoors**. Rall-e answers from the catalogue and proposes the trail; preference scores update.
3. Choose **Make this the plan**, pick Mike and Dave, and create the page. Copy Mike’s personal link into a different browser or device. The **Preview as** menu also demonstrates guest views within the presenter’s own session.
4. In Mike’s **Texts** view, reply YES. The same RSVP appears on the shared page. Change it to Maybe and back on the page. Joining never silently opts the guest into texts.
5. Suggest dinner instead. Other guests can vote. The host chooses the suggestion, optionally adds comedy as a second stop, and confirms. All views update within three seconds.
6. Preview the group text, then mark the outing as happened to update preferences. Nothing is purchased or sent.
7. Presenter controls demonstrate an unfinished-plan follow-up or a weekend recommendation (after opt-in). Each preview is deduplicated. Reset affects only this browser’s demo and invalidates its guest links.

## What is real

| Capability | Implementation |
| --- | --- |
| Responsive host/guest UI | React, custom illustrated event artwork, keyboard-accessible dialogs |
| Plan and conversation state | SQLite, persisted across refresh and server restart |
| Guest access | Random scoped 7-day bearer invitation; no account; other invite tokens withheld |
| RSVP, suggestions, votes | Real shared state, locked/loose rules, host-only selection and confirmation |
| Preferences | Small reaction/attendance scores; no complex profiling infrastructure |
| Event catalogue | Five fictional Hollywood-area fixtures with sample prices, times, and access details |
| Conversation by default | Local narrow intent matching and grounded sample answers; freely typed but not a general LLM |
| Optional AI | AWS Bedrock Converse for contextual wording; no tools or authority to mutate state; 12-second fallback |
| SMS and MMS | Browser Texts and MMS remain previews. Optional Twilio invitation/confirmation sends and RSVP replies are implemented but disabled; full conversational SMS is still pending |
| Proactive scheduling | Presenter-triggered preview, opt-in and deduplication; no cron or background sends |
| STOP / HELP | Simulated state and informational replies; web RSVP remains available after STOP |
| Signup | Figma-derived landing, welcome, profile, phone/code and Google preview states; first-name-only demo identity |
| Location | User-confirmed Hollywood, Los Angeles; no IP geolocation |
| Booking, payment, split | Excluded per business direction |

Illustrations represent fictional outings, not photographs of real venues. No external event providers, calendar integrations, distributed queues, agents, or additional database vendors were introduced.

## Optional live conversation

Set `AWS_REGION` and `BEDROCK_MODEL_ID` to an already approved Converse-compatible model/inference profile. Supply credentials through the normal AWS SDK credential chain, preferably an EC2 role. The server sends the relevant catalogue, plan, preference scores, and recent conversation to that configured model. Do not connect live AI for personal tester information without accepting that data flow. All event selection and plan changes remain application controls. Without working credentials/model access the demo continues locally and explicitly shows curated fallback mode.

The adapter follows [AWS’s JavaScript Converse example](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_bedrock-runtime_code_examples.html). Live Bedrock was not verified in the local build. Backend’s existing credentials denied EC2/SSM/Route 53 inventory; they were not copied into the application.

## Tests and screenshots

```sh
npm test
# Start the app in another terminal; installed Google Chrome is used.
npm run test:browser
npm run build
```

State tests cover persisted shared data, guest/host scope, locked plans, invalid/expired tokens, reset isolation, consent/STOP, nudge deduplication, preference updates, and stop/suggestion limits. Browser tests exercise independent host/guest sessions, text/web response synchronization, suggestions, confirmation, refresh, mobile overflow, invalid links, origin checks, and dialog dismissal. Generated visual QA images are in `screenshots/`.

Verified September 27, 2026: **13/13 state/SMS tests, 4/4 design/browser checks, 1/1 gated SMS preview check, and Vite production build passed locally**. Desktop (1440px) and mobile (375px/390px) screenshots were reviewed. The remote site is deployed; Docker execution, live AWS Bedrock, and real messaging have not been verified.

## Existing AWS host

Deployed hostname: **rall-e.joinfitapp.com**. The user created its GoDaddy A record pointing to `13.57.102.105`. A dedicated Let's Encrypt certificate expires December 26, 2026; the host's existing Certbot timer renews it, with a Rall-e-specific Apache reload hook. No AWS instances or new infrastructure services were provisioned.

Current host layout:

- Service: `rally-demo.service`, running as dedicated unprivileged `rally-demo`, enabled at boot.
- App: `/opt/rally-demo/current` → `/opt/rally-demo/releases/20260927-002`.
- Runtime: `/opt/rally-demo/runtime/bin/node` (isolated from other apps).
- Database: `/var/lib/rally-demo/rally.sqlite` (including SQLite WAL/SHM companion files).
- Listener: `127.0.0.1:3107`; only Apache exposes the app publicly.
- Apache: `/etc/apache2/sites-available/rall-e.joinfitapp.com.conf`.
- Certificate: `/etc/letsencrypt/live/rall-e.joinfitapp.com/`; renewal hook `/etc/letsencrypt/renewal-hooks/deploy/rally-apache-reload`.
- Logs: `journalctl -u rally-demo`; Apache error log `/var/log/apache2/rall-e-error.log`. Personal invitation URLs are not access-logged by this virtual host.
- SSH: `ubuntu@13.57.102.105`, using the user-supplied `newlaunch.pem`. Security group permits TCP/22 from the approved `24.236.208.253/32` in addition to the original jump-host rules. A changed client IP requires updating that scoped rule.

Operations: `sudo systemctl status rally-demo`, `sudo systemctl restart rally-demo`, and `sudo journalctl -u rally-demo --since '10 minutes ago'`. New releases should use a new directory under `releases`, install their production dependencies with the isolated Node runtime, update only the `current` symlink, and restart only `rally-demo`. Keep SQLite data outside release directories. Rollback by repointing `current` to the prior release. To take just this site offline, disable only its Apache virtual host, config-test/reload Apache, and stop `rally-demo`; preserve its data directory.

The following alternative-container instructions remain available for a future host; the current host uses the systemd/Apache files in `ops/`, not Docker or nginx:

1. Inspect current processes, free ports, disk space, reverse proxy, and DNS. Preserve existing sites and choose an unused loopback port (Compose defaults to 3107).
2. Put this project in a separate directory, such as `/opt/rally-demo`. Do not upload `.env`, local SQLite files, or the Backend application.
3. If Docker is already the host’s deployment method, run `docker compose up -d --build`. It uses a separate project name and persistent volume. Verify `curl http://127.0.0.1:3107/health`.
4. Point only the new subdomain to the selected host. Add a separate proxy virtual host, obtain its certificate with the host’s normal tooling, run the proxy’s config test, then reload. `ops/nginx-rall-e.conf` is a starting template, not an instruction to overwrite the server’s current configuration.
5. Verify HTTPS, host session cookies, a guest link in a separate browser, plan persistence, and the health check. Production cookies require HTTPS.

If the host does not use containers, run `npm ci && npm run build` under Node 24, then run the server under an isolated unprivileged service account with `NODE_ENV=production`, a free loopback port, and a persistent `DB_PATH`. Keep the current Laravel stack separate.

Rollback: disable only the new virtual host and stop only the `rally-demo` Compose project. Keep its data volume; never use `down -v` unless explicitly discarding demo data.

## Prototype limits

This is a small trusted-demo application, not a public signup service. Invitation URLs confer access to that guest’s RSVP; do not forward them. There is no identity verification, recovery, enabled outbound messaging, provider retrieval, live availability, time-conflict solver, production anti-abuse layer, scheduled worker, or cross-device host login. Illustrative itinerary times may overlap; host judgment is required. Personal guest links expire after seven days. The demo uses one process and SQLite; do not scale replicas against separate databases.

Next investments should be the existing signup flow, one verified conversational provider, approved tester SMS, and one narrow Hollywood discovery source—only after the visible loop is accepted.
