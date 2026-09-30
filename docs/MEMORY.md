# Agent memory: architecture proposal

_Status: proposal (2026-09-30). Nothing below is built yet except where marked "today"._

## Goal
Rall-e should get to know each person, their people and what works in each city, the way a good friend would. It should remember what matters, stop re-asking, get better picks over time and forget what's stale, **without** the prompt growing with every text.

The core idea: **memory is structured data we curate, not a transcript we replay.** The model reads a small, budgeted "what I know" card every turn. It can look up more on demand. A background job does the slow work of deciding what's worth keeping.

## What we have today (to build on)
| Piece | Where | Limits |
| --- | --- | --- |
| Last 16 texts per person | `Agent.history` | Anything older is gone from the agent's view. |
| Situation snapshot (plan, people, location, timing, features seen) | `Agent.state` | Only about *now*; nothing about the person. |
| Vault: dietary, allergies, contact, card (masked to the AI) | `server/vault.mjs` | Only what they explicitly saved. |
| Preference counters per plan session (`preferences[category]`) | `store.mjs` | Tied to a session, not a person; the agent never sees them. |
| Saved contacts (name → phone) per host | `host_contacts` | No relationship info ("my wife"). |
| Anonymous product stats and "couldn't do" gaps | `stats.mjs` | Good for the team, not fed back to the agent. |

## The model: five kinds of memory
1. **Working context (per turn, today):** recent texts plus the situation. Stays small by design.
2. **Person profile: structured facts about one person.** Each fact is a row, not prose:
   - `kind`: `like`, `dislike`, `constraint` (budget, accessibility, kids, no car), `home` (base, neighborhoods), `rhythm` (free on Sunday afternoons, early riser), `style` (wants 2 options not 5, hates long texts), `person` (a relationship: "Deborah = wife"), `note`.
   - `value` is a short phrase, not a paragraph.
   - `source`: `said` (they told us), `did` (behavior: picked, went, skipped), `inferred`.
   - `confidence`, `evidence` (ids of the texts or events it came from), `created`, `confirmed_at`, `expires_at`.
   - `visibility`: `self` (only used with them), `group` (fine to use when planning with the people it involves), `sensitive` (health, kids, religion and the like: only when they volunteered it, only with them; allergies keep living in the vault).
3. **Episodes: one short record per outing or notable conversation.** For example: "Tue Sep 29 · family day trip, Tunnel of Trees + Thorne Swift, with Deborah · went · loved the outlook, restroom stop was a hassle." Written when a plan closes (hooked to the auto-close from yesterday). This is how "last time with Mike we did…" works without keeping the transcript.
4. **Relationships and groups.** People and crews someone plans with:
   - who they are (by name; phone kept separately)
   - how they're related
   - how often they plan together
   - shared tastes of the crew, for example "Marc & Mike: tequila bars, comedy, late nights".
   - A crew is simply a set of people who have been on plans together. Facts about a crew only come from what the group did or said in the group.
5. **General knowledge (not personal): what Rall-e learns across everyone, anonymized.**
   - Which kinds of picks turn into plans, per city and time of day. Which sources and venues are reliable, including closures we discovered.
   - Seasonal patterns, and which feature offers help.
   - This feeds ranking and a short "local tips" line per city. It never includes anyone's personal details.
   - It extends `stats.mjs` and the gaps log.

## Writing memories (two speeds)
- **In the moment, cheap and explicit.**
  - The agent calls `remember(kind, value, about?)` when someone says something durable ("I don't drink", "my wife Deborah", "we have a 6-year-old"), and `forget(...)` when asked.
  - Behavior is logged automatically as signals with no AI involved: My pick taps, poll answers, RSVPs, stops added or removed, "not my thing", plans that happened or were dropped, and repeated searches.
- **Later, in a background "consolidation" pass.** This runs when a conversation goes quiet (about 30 minutes idle) and when a plan closes.
  - A small, cheap model reads the new texts and signals since the last pass, plus the current profile. It returns proposed changes as JSON: add, strengthen, correct or retire facts, plus the episode summary.
  - Code applies them with fixed rules:
    - What they said beats what we inferred, and newer beats older.
    - Duplicates merge and strengthen confidence.
    - Inferred facts need evidence from two different occasions before they're used.
    - Sensitive facts are only kept if they were said, never inferred.
  - This keeps the live reply fast and the rules auditable.

## Reading memories (budgeted)
- **Always-on profile card, hard cap of about 200 tokens.**
  - It's rendered from the facts by a score: importance of the kind × confidence × recency.
  - Constraints and allergies always make the cut; stale inferred likes drop off first.
  - It sits in the situation where "Location" is today, for example: "Knows: home Harbor Springs MI · family of 3, daughter peanut allergy (vault) · likes scenic drives, fall colors, low-key dinners · plans mostly with Deborah; Marc & Mike for nights out · prefers 3 options, short texts."
- **Context triggers:** pull in the facts that matter for what's happening.
  - Inviting Mike brings up the Mike and crew facts. A dinner search brings up food likes, dislikes and budget. A plan in another city brings up that city's general tips.
- **On-demand recall:** a `recall(query)` tool searches episodes and archived facts, for example "what did we do with Mike last time?" or "that pizza place I liked".
  - Start with SQLite full-text search (FTS5, built in); add embeddings later only if needed.
- **Caps:**
  - About 60 active facts per person; the lowest-scoring go to an archive that recall can still reach.
  - Episodes are one line each.
  - Nothing is ever injected unbounded.

## Privacy and control (non-negotiable, extends AGENTS.md rules)
- **Provenance on everything:** every fact knows which text or event it came from, so we can explain and undo it.
- **Never cross people:** one person's `self` or `sensitive` facts are never used in texts to or about others. Group suggestions only use `group` facts.
- **They can see and edit it:**
  - "What do you know about me?" works by text.
  - The private `/me` page gets a "What Rall-e knows" list with delete buttons.
  - "Forget that" works.
- **Retention:**
  - Inferred facts fade after about 90 days unless reconfirmed; said facts stay until changed.
  - Episodes are kept about a year.
  - Wipes (per person and wipe-all) remove all of it.
  - The anonymized general layer survives wipes, like Insights.
- **Guardrails:** the AI still only sees masked vault data. Nothing from memory is ever used to text someone who hasn't opted in.

## Data model (SQLite)
- `memory_facts`: id, person (phone), about (person or crew id, optional), kind, value, source, confidence, visibility, evidence JSON, created, confirmed_at, expires_at, archived.
- `memory_episodes`: id, person, plan id, day, summary, people JSON, outcome, created (plus an FTS5 index).
- `memory_signals`: person, type, subject (event, category or venue), weight, at. Raw, pruned after consolidation.
- `people_links`: person, other (phone or name), relation, plans_together, last_together.
- `memory_runs`: person, last_consolidated_at, tokens used (for cost tracking in Usage).

## Phases
1. **Foundations (about 1–2 days).**
   - Tables; `remember`, `forget` and `what_do_you_know` tools; the profile card in the situation.
   - Behavior signals from picks, polls, RSVPs and closed plans.
   - The "What Rall-e knows" section on `/me`; wipes cover memory.
   - Migrate session preference counters and saved contacts into it.
2. **Consolidation and episodes:** the idle and plan-close job (cheap model), episode summaries, the `recall` tool with FTS, decay and archive.
3. **Relationships, crews and general learning:**
   - Crew profiles; anonymized "what works here" feeding ranking and city tips.
   - An eval harness that replays real (anonymized) conversations and checks two things. First, it stops re-asking known facts. Second, picks turn into plans more often. Each check also measures the extra tokens per turn.

## Decisions for Jeff
- **What can people see?** Proposal: everything we remember about *them*, editable on `/me`.
- **Sensitive facts** (kids, health, religion): keep only when they volunteer them? Proposal: yes, and only used with them.
- **Consolidation model:** a small, cheap model (for example Claude Haiku-class). Cost scales with texts, not history.
- **Crew memory:** is it OK for Rall-e to say "last time you and Mike did X" in a group text? Proposal: only facts that came from the group itself.
