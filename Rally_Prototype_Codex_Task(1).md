# Codex Task: Rally Demo Prototype — AWS + Twilio

Updated: 2026-09-25
Stage: PROTOTYPE, not a production MVP
Audience: approximately 10 initial testers; this is a planning assumption, not a hard user limit.

## Primary instruction to Codex

Build a polished, coherent, demonstrable product experience first. Think about the future, but prioritize getting the basic idea working for a demo. This task replaces the earlier architecture-first MVP assignment, including its mandatory ADRs, broad schemas, generic orchestration framework, and comparative agent benchmarks.

Success is a presentable chat-first coordination experience: Rally proposes an outing, the host reacts and chooses friends, each person responds through text or a lightweight web link, and one shared plan updates for everyone. This is not primarily an event-entry form or dashboard. Deep integrations and autonomous execution are not required. Use seeded data and explicitly identified simulations wherever they save substantial work.

Do not spend the first implementation cycle building invisible infrastructure. Start with a short repository inspection, a concise implementation checklist, and the visible experience. Ask only blocking questions. Make reversible assumptions for the rest and record them.

This handoff is a plan, not authorization to provision AWS resources, deploy publicly, or send texts now. At implementation time, use the user's approved target and permission scope.

## 1. Confirmed direction and source confidence

### Explicit developer decisions, September 25

- Replace the MVP build with a much lighter prototype.
- Host on AWS, probably a single EC2 instance initially.
- A Twilio account already exists for sending texts. Credentials, sender readiness, and inbound setup have not been verified.
- Expect about 10 users initially; do not impose a ten-user product limit.
- Make it visually polished and show how the product works, without deep functionality.
- Keep the long-term MVP ideas as future direction, not prerequisites for this demo.

### Business references

Primary demo:
https://claude.ai/artifact/3jemZDcTyaPFj4HwozvjLy

Additional artifact links supplied with the conversation:
- https://claude.ai/artifact/JKXLUEdebQGzqwWK2pDrjc
- https://claude.ai/artifact/SNAksoR4H1FfHAgh9kPqVL
- https://claude.ai/artifact/GC6kFMHDRVkbfv7pgiwwyg
- https://claude.ai/artifact/F5cH3nChGDkpMLXt6LNugQ

Review status: all five links were attempted on September 25, but the web reader could not access them. A subsequent interactive-browser attempt on the primary demo remained on Claude's bot/security verification page after one reload. The other four were not tried in that browser after the site-level block. No live artifact interactions or source code have been inspected. However, all 17 supplied demo screenshots WERE visually reviewed; they establish the design and visible states described below. Do not confuse screenshot review with successful click-through testing.

The attached screenshot, image(20260925-154521).png, WAS inspected. It contains business notes about plan types, not screens from the interactive demos. The first additional link is explicitly shown under "Locked Plan - Single Event." Mapping the other links to individual plan types has not been verified.

When starting implementation, try each artifact in an authorized browser if accessible in that environment. For every link, record inspected branches or the actual blocker; do not mark blocked pages as tested. Exercise the main flow, alternate replies, host/guest switching, chat/page tabs, suggestions, RSVP changes, split controls, booking handoff, and reset. Stop at security checks or real external side effects; never bypass them. Screenshots now provide enough to start the main experience if the links remain blocked. Exported artifact source or a recording would resolve the remaining branch behavior. Do not make access to Claude a runtime dependency.

### Product behaviors confirmed in the screenshot

| Plan type | Business description | Prototype treatment |
| --- | --- | --- |
| Locked plan — single event | Host builds a plan and shares it with friends | Core path: display a fixed event and collect responses |
| Locked plan — multiple stops | Host builds a plan with three stops; three is a suggested maximum | Same plan UI with an ordered itinerary |
| Loose plan — single proposal | Host proposes one plan and is open to suggestions | Show a proposal plus participant suggestions and host selection |
| Loose plan — multiple stops | Suggested itinerary, maximum three stops; friends may suggest alternatives | Reuse itinerary UI; default to one suggestion per person |
| Loose plan — multiple stops with multiple suggestions | Business notes say 15 proposals from five friends may be overwhelming | Defer an unrestricted multi-proposal experience |

The three-stop limit and one-suggestion-per-person limit are business suggestions, not settled architecture constraints. Make them easy-to-change configuration defaults. They do not imply a limit on participants.

The screenshot also notes that agents cannot purchase exact movie tickets or pay the theater in that scenario; the host would use a provider account and a seat-map link. It mentions friends paying the host back. For this prototype, show an external booking handoff and, if useful, a clearly simulated reimbursement status. Do not build ticket purchasing, wallets, payment processing, or actual money collection. Do not promise an exact seat-map deep link without a working provider URL.

## 2. Screenshot-grounded demo story

The main example is "Saturday night out": dinner at Casa Vera, followed by stand-up at The Foundry. Use these as fixtures, not verified real availability. The screenshot dates and prices are sample content, not current facts.

1. Start on "Chat with Rall-e". Rally proactively offers the host a suggested outing based on seeded availability/preferences. It need not connect a real calendar.
2. Offer quick replies such as "Love it, let's go" and "What else is out there?", plus a text composer. Keep free text narrow but useful: edit the draft or give a graceful fallback rather than pretending unrestricted autonomy.
3. After the host accepts, Rally suggests familiar friends and asks who to include. The screenshots show "Yeah, all of them" and "Just Mike for now". Host approval precedes actual invites.
4. "The page" tab shows the shared plan: host/date, ordered stops, availability-versus-booking badges, participants, and RSVP controls. Chat and page must reflect the same saved plan, not independent mock states.
5. An existing participant such as Mike sees a text invitation, YES/MAYBE/NO responses, acknowledgment, and an optional plan link. A simulated reply must update the same RSVP state as the web page.
6. A new invitee such as Sarah or Dave sees an invite in the host's name and a link to a no-app/no-account guest page. Use scoped invite tokens. Show explicit messaging preferences; do not infer blanket SMS permission from opening a link.
7. Guests respond "I'm in", "Maybe", or "Can't". Avatars and counts update across views. In loose mode, add the previously described suggestion flow; its detailed UI has not been observed in these screenshots.
8. The shared page includes an estimated split, with "Even", "Host covers", and "By item" modes. Implement inexpensive arithmetic/fixture interactions, not collections or a payment backend.
9. The demo's explanatory copy says booking becomes available when two people are in and adjusts to headcount. Use this as a configurable demonstration rule, not a universal product policy. Keep booking readiness, host finalization, provider confirmation, and payment status distinct. Hand off externally or label a simulated booking; nothing is actually purchased.
10. A dismissible post-RSVP prompt offers "Try Rall-e" / "Not now" so a guest can start a plan for their own group. This is a simple demo transition, not a full onboarding program.

Locked versus loose and single versus multiple stops remain the business-plan variants. The screenshot sequence grounds the main chat/RSVP experience but does not establish every variant's behavior.

Support switching between seeded host and guest identities in demo mode. In live tester mode, use separate scoped sessions/invite tokens; never expose an unrestricted identity switch to real users.

Start with one event, then reuse the same components for multiple stops. Do not build four separate applications for the four plan variants.

### Presenter controls versus product UI

The reference includes an outer demo shell with "The old way" / "With rall-e", scenario chips, a "Viewing as" persona switcher, and reset. These are presenter aids, not production account controls. The old-way sequence contrasts group chat, event listings, a social feed, and a solo AI agent. It is a scripted pitch narrative, not researched claims about those services or a requirement to integrate them. Keep it optional and lightweight.

Visible scenario chips: Saturday night out, Golf Sunday, Bachelor weekend, Right now, Someone new, Oktoberfest. Only the Saturday flow is documented in the supplied screenshots. Implement it first. Other scenarios may be fixture variants or marked previews until inspected; their visible names do not authorize building six separate products.

### Screenshot reference index

All filenames below follow image(20260925-TIME).png. These were visually reviewed, not interactively executed:

| Times | Observed content |
| --- | --- |
| 155426, 155431 | Old-way group chat, scrolling, outcome and next action |
| 155437 | Event-listing comparison screen |
| 155445 | Social-feed comparison screen |
| 155450 | Solo-agent comparison screen |
| 155457, 155503 | Main scenario/persona controls; host proactive chat and friend selection |
| 155508 | Host shared-plan page, invite status, itinerary, RSVP |
| 155514, 155519, 155522 | Mike's text invite, affirmative reply, acknowledgment and shared page |
| 155533, 155541, 155547 | Sarah's new-guest invitation, shared page, cost-split controls and sections |
| 155555, 155608 | Dave's invitation and affirmative shared-plan state |
| 155615 | Sarah's post-RSVP conversion modal |

Exact fonts, unseen screens, split-button outcomes, booking-button behavior, and arbitrary chat responses remain unverified. The screenshots are a visual target, not evidence that background services exist.

## 3. What should be real versus simulated

| Capability | Prototype expectation |
| --- | --- |
| Responsive polished web UI | Real, clickable, coherent end-to-end |
| Create/edit a plan and itinerary | Real and persisted |
| Locked/loose mode and participation | Real basic rules; host owns finalization |
| Guest response and suggestion | Real and persisted, with scoped access |
| Sharing links | Real host/guest views; use safe demo links until hosted |
| Outbound SMS | Real Twilio adapter, dry-run by default; live only to approved consenting testers |
| RSVP by text | Required visible demo path using simulated replies; narrow live YES/MAYBE/NO handling if ready |
| Delivery status | Show actual known state; API acceptance is not proof of delivery |
| AI draft generation | One narrow live model call if ready; deterministic fallback if not |
| Agent progress visualization | Simple status timeline; label staged/simulated activity honestly |
| Venue, restaurant, movie, or activity discovery | Seeded fixtures unless a trivial approved source is already available |
| Booking and payment | External handoff or clearly marked simulation only |
| Cost split | Real simple estimated arithmetic or disclosed fixtures; no charges or collections |
| Calendar, contacts, email OAuth | Mock connection states; no new connector framework |
| Personal/group memory | A few saved preferences or fixtures, not a generalized memory system |

Document this matrix in the delivered README and make demo-only states clear in the UI. Never label fixture availability/prices as live, scripted steps as autonomous work, or a simulated purchase as confirmed.

## 4. Visual quality is part of the deliverable

- Use the screenshot's visible brand treatment "rall-e" / "Rall-e" in the demo UI; Rally can remain the internal project name pending naming confirmation.
- Match the observed warm cream/beige surfaces, rust/terracotta primary actions, dark brown/black text, serif headings with sans-serif body text, thin warm borders, rounded cards/pills, and muted green confirmation panels. Exact font/color values are not known; choose consistent accessible approximations.
- Use chat bubbles, quick-reply buttons, an understated header, and two tabs: host "Chat with Rall-e" / "The page"; guest "Texts" / "The page". Maintain visible selection and persona context.
- The thick rounded phone frame is a desktop presentation device. On a real phone, use the viewport naturally rather than nesting a cramped phone inside the phone. Keep RSVP and navigation discoverable without reproducing awkward screenshot cropping.
- Prioritize the host planning screen and the guest's mobile invitation/response experience.
- Include credible seed content, useful result cards, clear itinerary hierarchy, avatars/participation state, and deliberate spacing.
- Provide loading, success, empty, error, disabled, and expired-link states.
- Keep primary actions obvious: propose, invite, respond, suggest, finalize.
- Avoid exposing infrastructure jargon such as queues or leases in the end-user interface.
- Provide a visible, protected reset-demo action that resets only demo data.
- Verify at desktop and mobile widths using rendered screenshots and browser interaction tests. Check keyboard navigation, labels, overflow, and legibility.
- No dead primary buttons. If an integration is simulated, the button should still show a coherent, labeled demo outcome.

The marketing experience can be a tasteful landing/sign-in page in the same app. A separate promotional site/repository is not required.

## 5. Lightweight implementation defaults

Use existing working code and services where available. Do not migrate useful existing work merely to match these defaults.

- One TypeScript/Node application with React; Next.js is fine and can be self-hosted. No Vercel dependency or Vercel deployment task.
- One AWS EC2 host is the provisional deployment target. Use a simple container/Compose setup or the repository's existing process management.
- Serve the app behind HTTPS, with process restart, health check, persistent storage, environment configuration, and readable logs.
- One database. Reuse configured Postgres/Supabase if present; otherwise SQLite on a persistent volume is acceptable for this single-instance prototype. Do not add a new database vendor to satisfy the old plan.
- One small application service for plan changes and a Twilio adapter. No microservices.
- Use ordinary request/response and basic polling for updates if sufficient. No realtime platform is required.
- A tiny persisted job/message record and a single-process background handler are enough if needed. Do not introduce a distributed queue platform.
- Keep a small LLM adapter with structured output validation and fixtures as fallback. OpenAI remains the earlier default, but reuse an approved configured provider if one exists.
- Keep secrets server-side and provide an environment-variable template with no credentials.
- Prepare simple EC2 deployment instructions. Confirm the actual AWS account, region, host, DNS/TLS, and deployment authorization before provisioning or deploying.

Think ahead by separating UI, plan operations, persistence, AI draft generation, and SMS behind small clear modules. Interfaces and ordinary migrations are enough; do not build a generic plugin platform.

### Minimal state

Persist only what the chosen flow uses, for example:
- testers/users or scoped invitation identities
- plans with owner, mode, status, and a version
- ordered stops
- participants/responses
- suggestions and host selection
- invite tokens and expiry
- outbound message attempts/provider IDs and known status
- optional compact activity/job state
- per-person messaging preference/consent scope and timestamp
- estimated split mode and allocations (not payment instruments)

These may be a few tables plus validated JSON; a normalized enterprise social graph is unnecessary. Data should survive app restart, and one person's plan must not become visible to another unintentionally.

## 6. Preserve the agentic idea without making it the bottleneck

Long-term: agents should coordinate through shared objectives, compact state, results, and blockers, with event-driven wakeups and deterministic safety.

Prototype:
- Start with one draft-producing model call or a deterministic fixture, plus a shared plan/activity record.
- If useful, show small role-oriented stages such as planning, discovery, and coordination.
- A staged timeline is acceptable when labeled; it is not evidence of independent collaborating agents.
- Add real multi-agent execution only if it materially improves this demo and is cheap to implement.
- Do not require task marketplaces, distributed leases, dynamic agent scheduling, extensive tool registries, or token-efficiency benchmarks before the demo works.
- Never allow model output alone to authorize sending messages, inviting people, booking, or charging money.

The shared-state philosophy is a future design direction and module boundary, not a requirement to implement the full emergent system now.

## 7. Twilio and minimum safety

A ready account does not necessarily mean a ready sender or approved messaging campaign. Verify sender capabilities and applicable account/country requirements against current Twilio documentation during implementation. Do not make the demo depend on uncertain messaging approval.

Required for the first live text demo:
- Server-side Twilio adapter with a mock/dry-run mode.
- Explicit send confirmation with recipient and message preview.
- Only approved, consenting tester recipients; disable arbitrary public sends.
- Do not use real phone numbers in fixture data.
- Basic send caps, duplicate protection, and a log of message attempts/provider IDs.
- Handle uncertain send outcomes carefully; do not blindly resend after a timeout.
- Support applicable opt-out behavior; honor stopped recipients.
- Use a truthful status such as queued, sent, delivered, or failed only when known.
- Store minimal personal information and keep it out of general logs.
- If delivery callbacks are implemented, validate Twilio signatures and deduplicate callbacks.

The screenshots make RSVP by text part of the intended experience. Demonstrate it in the simulated Texts view even if live inbound messaging is unavailable. If the Twilio sender supports inbound texts and setup is straightforward, implement only YES/MAYBE/NO and a short acknowledgment. Associate replies with a specific outstanding invitation; when several plans could match, ask which one rather than updating an arbitrary plan. Full natural-language SMS conversation handling is not required. Any inbound webhook must validate signatures and deduplicate provider message IDs. Document which parts are live versus simulated.

Do not copy the demo's consent assumptions into production logic. Its captions variably describe link opening, RSVP tapping, and consent for every future plan; those are inconsistent and are not a vetted messaging policy. Keep link opening separate from explicit, recorded messaging consent, scoped to the stated purpose. An inviter entering a friend's number is not sufficient authorization for this prototype to text arbitrary new recipients: use already-consenting testers or a host-shared link until the intended invitation flow is approved. RCS suggested-reply chips and a verified sender badge shown in the reference are presentation cues, not capabilities automatically supplied by a Twilio SMS account. Real SMS can use typed replies; do not claim RCS or verified branding unless configured and verified. The mock split copy about automatic collection must be replaced with truthful estimated/demo wording.

Also retain basic access control, input validation, secure scoped share links, and server-side host-only editing/finalization. A small tester audience is not a reason to make personal plans public.

## 8. Implementation order

### A. Short kickoff, then visible work

Inspect repository instructions and current work. Review available demo sources. Produce a short checklist covering selected demo flow, real/mock boundaries, and unresolved blockers. Do not write a large architecture package first.

### B. Polished interactive experience

Build the main screens with seed data and a resettable host/guest demonstration. Complete the single-event path first, then reuse it for multi-stop and loose-plan modes. Visually inspect and iterate.

### C. Thin real functionality

Persist plans, responses, suggestions, and finalization. Add lightweight access control, sharing links, the SMS adapter, and one AI drafting call if available. Keep offline/mock mode reliable.

### D. Demo readiness and handoff

Run targeted tests, prepare the EC2 configuration/runbook, and supply a short presenter walkthrough. Deploy only when the target and authorization are confirmed. If real SMS or AI is blocked, deliver a working mock-mode demo and state the missing setup precisely.

## 9. Completion criteria and deliverables

The prototype is ready when:
- A presenter can complete create → invite → guest response/suggestion → finalize → text-update preview without dead ends.
- Locked plans cannot be edited by guests; loose plans permit the intended suggestion flow; host finalization persists.
- Single-event and up-to-three-stop examples are demonstrable.
- The interface looks intentional and works on a phone and desktop.
- The host's chat, guests' text/web responses, RSVP counts, and split estimate stay consistent across persona/tab switches and after refresh.
- The new-guest path works without full account creation, offers dismissible post-RSVP onboarding, and never treats a link open as general SMS consent.
- RSVP text simulation is testable even when live inbound Twilio setup is blocked; the real/mock distinction is clear.
- Plan data survives refresh and restart.
- The demo runs without external AI/discovery services using disclosed fixtures.
- Twilio is either verified with approved test recipients or explicitly marked configured-but-unverified/blocked; no fabricated delivery claim.
- Tests cover host/guest authorization, plan modes, persistence, expired/invalid share tokens, duplicate send prevention, and the core happy path.
- There are no real purchases or payment processing.
- No hardcoded ten-user ceiling exists.
- The app has a simple AWS/EC2 deployment path without Vercel.
- The README includes setup, real-versus-mock inventory, test results, demo/reset instructions, known limitations, and a short future-work list.

Deliver running code, screenshots from visual QA, a concise walkthrough, and setup/deployment instructions. A polished working demo is the main deliverable; documentation supports it.

## 10. Future MVP direction — explicitly NOT prototype gates

Preserve the earlier ideas for later:
- genuine decentralized multi-agent coordination over a durable blackboard
- durable event/job processing, atomic task claims/leases, cancellation and crash recovery
- common connector/OAuth framework with encrypted tokens and refresh
- generalized tool/action policies, approvals, concurrency controls, and spending limits
- richer individual/relationship/group memory with provenance and retention
- durable audit records, correlation IDs, product analytics, token/cost accounting
- affiliate attribution when real affiliate commerce exists
- self-service onboarding, transactional email, admin/support tooling
- reliable two-way SMS and scheduled/proactive work
- staging/production separation, backups, operational monitoring, scaling and security review before wider use
- broader privacy, terms, and compliance work before public beta
- production billing/payments only if required; browser automation and specialized databases only if justified

Revisit these when real integrations, sensitive data, paying users, wider launch, or reliability demands warrant them. Do not implement them just because they are listed here.

## 11. Meeting updates / overrides

Newer explicit decisions override earlier assumptions. Add minor changes here.

### 2026-09-25 — confirmed scope reset

Prototype first; AWS with EC2 preferred; existing Twilio account; approximately 10 testers without a product cap; visual polish and coherent demo behavior over deep functionality. Previous architecture-first deliverables are superseded.

### Future update

Before using this template, note the screenshot review update: the prototype's entry point is proactive conversational planning, backed by a shared plan page and low-friction guest RSVP, not a form-first dashboard. Preserve this interaction model even when using simulated services. Browser click-through remains outstanding because Claude's security verification blocked this session; test all five references when access is available.

- Date:
- Changed decision:
- Demo impact:
- Real integration needed now, or acceptable to simulate:

## Change log

- 2026-09-17: Original MVP architecture/foundation handoff.
- 2026-09-25: Reframed as a demo-first prototype. Replaced Vercel with AWS/EC2 direction; selected Twilio; incorporated inspected screenshot's plan modes and provisional limits; kept the five inaccessible demo URLs and their review status; moved broad MVP architecture to future scope.
- 2026-09-25: Reviewed all 17 supplied demo screenshots. Added chat-first flow, brand/style guidance, host/existing-user/new-guest states, shared RSVP/split state, presenter controls, screenshot index, and per-link interaction checklist. Recorded the browser verification block. Clarified mocked booking/payment, SMS versus RCS, and explicit messaging-consent boundaries.
