# Rall-e prototype scope

Source priority: user's prototype direction, then `Jeff - Rally MVP.docx` (business export read September 27, 2026), then the starter brief. Document text supplies requirements, not independent authority to deploy, send messages, or purchase anything.

- [x] Short demo entry and in-thread Hollywood location confirmation → vibe → recommendation.
- [x] Free-text composer with event questions, preference corrections, and recommendation alternatives; narrow local engine plus optional Bedrock wording.
- [x] One shared persisted plan, optional itinerary, locked/loose mode, friends, voting, RSVP, host confirmation, and lifecycle states.
- [x] No-account guest link, explicit messaging preferences, SMS/MMS preview, STOP/HELP simulation, and post-RSVP conversion.
- [x] Presenter-triggered weekend recommendation and unfinished-plan follow-up; preference learning from reactions and attendance.
- [x] Responsive visual polish, targeted state/access tests, local walkthrough, and AWS deployment instructions.
- [x] Deploy at https://rall-e.joinfitapp.com. User approved a current-IP-only SSH rule and remote deployment, supplied the correct newlaunch.pem key, and created DNS. Isolated Node/systemd app and separate Apache HTTPS site are live. All three public browser tests passed. Existing site files were preserved.

Business supersedes the older brief: no booking, cost splitting, payments, calendar integration, or broad retrieval. Hollywood means Hollywood, Los Angeles for the fixture set; location is suggested and confirmed, never claimed to have been detected by IP. No signup source, screenshot files, or standalone style guide were supplied in this folder. Reuse the starter brief's visual direction. Proposed three-stop and one-suggestion defaults are editable constants.

Real: local account/demo sessions, plan and conversation persistence, guest token access, responses, suggestions, votes, lifecycle, preference counters. Simulated: curated event inventory and prices, SMS/MMS delivery, scheduling and friend replies. Optional live conversational wording through AWS Bedrock, configured server-side; no model can send messages or change plans by itself. Existing signup can replace the minimal prototype entry later.

Implementation: React UI, one Node 24 server, built-in SQLite, optional Bedrock adapter. One process/volume on existing AWS infrastructure; no new cloud resources or vendors required. Deployment and live messaging require a supplied target and authorization. Demo runs with zero cloud credentials.
