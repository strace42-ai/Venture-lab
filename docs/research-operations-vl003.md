# VL-003 — Research Operations / Product specification v1.0
Date: 2026-11-12
Status: scope approved as development task; implementation pending

## Why this sprint
VL-001 created the excellent visual shell. VL-002 created durable evidence-backed PostgreSQL import, isolated REAL/TEST datasets, scoring and immutable snapshots. **VL-003 turns these foundations into a daily-working research cockpit.**
The north star is the founder's ability to answer in one interface:
- What was discovered on each date, in which source, with what level of confidence?
- Which ideas entered or left the all-time TOP-10, and WHY?
- Which critical claims require source checking before they can justify a high score?
- How can ChatGPT produce a structured research artifact without pretending this chat automatically changes a local database?

## Core workflow to demonstrate
1. Researcher produces a **candidate research draft** from web research with specific sources (not a synthetic sample disguised as facts).
2. Draft remains **unapproved**: links, dates, claim/source association and Russian competitors must be checked and a founder explicitly accepts the research record as an import candidate.
3. Export/validation helper emits the exact `vl-research-1` envelope or validates it; dry-run surfaces duplicate IDs, scoring gaps, citations and import changes.
4. Only after founder approval, import to REAL database using established `--apply` CLI. Importing a real source does NOT automatically set it to `checked`: that requires source-by-source human review.
5. Venture Lab's **Research Journal** shows the dated run and its provenance; an **Evidence Review Workbench** lists unchecked claims with clear links and revision status.
6. Two immutable TOP-10 snapshots can be compared in an attractive, comprehensible UI, with entered/exited/up/down and score confidence changes. If there are fewer than 10 validated scored ideas, show N/10, never fabricate filler.
7. Next morning a second run can update a pre-existing dossier with partial fields without losing anything and create a new historical view.

## Information architecture / visual direction
Keep the VL-001/VL-002 premium dark design. Add genuinely useful, sophisticated **Research Journal** page: date index, research-run header, first-seen/updated/rejected counts, examined markets, coverage gaps, provenance, links to changed ideas, state of verified/unverified evidence. Link Journal → idea dossier → sources and back.
Create **Evidence Queue** (tab on Journal or separate sub-route) with filters by idea, market, independent/company self-report, review status, age, missing URL, scoring dimension and risk. No fake 'verified' icon based only on URL presence; visible concise explanation of manual-review semantics.
Create **Top-10 History** panel with two saved snapshot selectors, comparison table and meaningful movement indicators. Scores and titles should use values frozen in snapshots, not today's mutations.
Desktop and 390px mobile should remain visually premium; accessible table/cards and empty/loading/error modes.

## Data / provenance design
- Reuse existing `/api/research-runs`, `/api/top10`, `/api/ideas` and DB where possible, enhance with paginated evidence queue, run details, and snapshot comparison endpoints only if necessary.
- Keep REAL and TEST completely isolated, also in journal, filters and comparisons. DEMO stays synthetic and separate.
- Derive a `New / Changed / Rejected` journal accurately from stored import run/actions if available; do not infer changes from today's snapshot alone. If history lacks enough detail, add migration with append-only import action records, never fabricate. Backfill limitations openly.
- Evidence metadata: URL, publisher, title, observed/retrieved/published dates, source type, exact claim supported, relevance to 12 dimensions, reviewed-by and review timestamp. Distinguish `unreviewed`, `checked`, `rejected`.
- Review status changes append a review event; never change the original immutable claim. A document that exists does not prove the source's claim.
- Never auto-promote "human-reviewed" envelope to individually `checked` sources. If AI generates it, mark all source claims unreviewed until a human checks them.
- Confidence and market score separate; score revisions and risk changes must be explained with direct evidence. Do not silently adjust the global scoring rubric.
- Historical ordering: time zones explicit and consistent with DB; no look-ahead of late imports when comparing stored snapshots.
- Dedup key stable `externalId`, no fuzzy auto-merging. Check duplicate source URLs/competitor brand URLs and emit warnings only; duplicates may be legitimate.
- Retain original JSON in version control when appropriate; never commit sensitive third-party personal data or proprietary documents.

## Human review without unsafe web writes
Option A (preferred in VL-003): build **review CLI** e.g. `npm run research:review -- --idea <id> --evidence <id> --status checked|rejected --reason "..."` with preview/dry-run and explicit `--apply`, actor + timestamp + audit log, transactional, restricted to local DB. Display queue from read-only local API, and provide an honest "how to mark reviewed" command in UI. Avoid new public unauthenticated write routes.
Alternative: implement a local authenticated write endpoint only if you can supply a safe, tested threat model and approval flow without broadening scope.
Never let LLM automatically verify its own citations.

## Structured research export
Create a clear in-repo template and short guide for ChatGPT/Claude on producing a `vl-research-1` payload for `research/drafts/`:
- strict fields as defined in `server/research/schema.ts`, 12 scores with 0–5 or null, 5 confidence fields, source IDs and 2-side competition.
- `runId` unique; source URLs with groundable publisher/date; 1–10 ideas per research run; source status `unreviewed` by default.
- Include "searched in RU" coverage / uncertainty and lack of verification openly. Price is hypothesis, not measured conversion.
- A draft is not an approved `human-reviewed` import. Do not have the tooling misrepresent AI-generated drafts as human-reviewed. Founder confirms approval before any real import.
- CLI helper: validate + dry-run and show concise diff / missing evidence / duplicate-source warnings and recommend whether import is safe.
- Do not make unapproved AI-produced content part of the REAL rankings.

## Pilot with actual public research
Aim to prepare **3–5 candidate idea dossiers** from already researched themes (e.g. Focusmate-style coworking, VAG report, personal CRM, Quote Compare, etc.) using newly rechecked primary sources and real Russian competitors; include links and dates, explicitly separate speculation. If browse/source access is not supported in Claude's environment, stop at candidate templates and mark the pilot as waiting for researcher/founder; DO NOT invent research or force a pass. Actual import only after founder reviews and approves records. TOP-10 should remain incomplete if not enough validated ideas.
Use at least one update of an existing idea to demonstrate immutable assessment/source history; this can be with controlled test data in TEST mode.

## Tests & safeguards
- New API/run filters, source queue with review status, manual review CLI append-only/idempotence/invalid input/transaction rollback.
- Compare snapshot A/B including changed score, rank, new, gone, rejected, zero/one snapshots, update of title and temporal edge cases.
- REAL/TEST isolation for all new endpoints + CLI; cross-dataset review rejected.
- Citation linkage, unverified claim handling, source invalidation, no client-supplied aggregate scores.
- Prior VL-001/VL-002 tests still pass, CI green, mobile responsive checks 390px and desktop 1440px.
- Safe local-only defaults, no public deploy/API key exposure.

## Explicit exclusions
No unattended ChatGPT automation export, AI/API self-scoring, background scraper, paid services, cloud deployment, multi-user accounts, customer messaging, billing, unrelated portfolios/validation CRUD. The existing 08:00 ChatGPT research automation sends a chat report; **it does NOT write to GitHub or a locally running PostgreSQL database**. The bridge to truly automatic ingestion is a later separately authorized integration. Do not claim otherwise.

## Product acceptance
- A beautiful Journal and Review Queue work with API-backed, provenance-rich data and honest empties.
- Source review appends auditable events and immediately changes queue status, without rewriting claims.
- Snapshot history UI compares stored snapshots correctly across research days.
- JSON research draft → validation → founder approval → explicit CLI apply → new Journal/Radar/Top-10 is documented and can be reproduced locally.
- Tests pass in CI, screenshots and handoff supplied.
