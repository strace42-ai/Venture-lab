# CURRENT TASK — VL-003 / Research Operations & Evidence Review
Version: 1.0
Status: READY FOR CLAUDE
Owner: Founder + ChatGPT
Repository: strace42-ai/Venture-lab
Base: latest `main` (VL-002 merged)
Suggested feature branch: `claude/vl-003-research-operations`

## Mission
Transform the VL-002 research database into a **daily usable founder intelligence cockpit**: premium Research Journal, citation/evidence review queue, snapshot comparison, and an honest manual pipeline for taking ChatGPT research through review to the REAL database. Keep previous score logic, data integrity and visual identity. No unattended automation or paid APIs yet.

## Required reading
`CLAUDE.md`, `docs/product-vision.md`, `docs/design-principles.md`, `docs/scoring-model.md`, `docs/research-import-format.md`, `docs/research-operations-vl003.md`, `docs/agent-workflow.md`, `docs/roadmap.md`; inspect current code and tests first. **The detailed specification is in `docs/research-operations-vl003.md` and is part of acceptance criteria.**

## Required vertical user journey
1. User opens Research Journal: sees dated research runs and what changed in each.
2. User opens evidence queue: unreviewed claims, exact source links, publisher, dates, claim, idea and rubric dimensions. Status is honest.
3. User marks a source `checked` or `rejected` through a locally safe review CLI with rationale and explicit `--apply`; immutable review event appears in Journal/queue.
4. User compares two stored snapshots: rank changes, new/exited ideas, score/confidence deltas and frozen snapshot-era titles.
5. A new strictly validated research JSON draft can be checked, founder-approved and imported by explicit existing commands; journal, current top-10 and dossier reflect it without demo/test contamination. No real research automatically imported without a human approval step.

## Deliverables (must)
### A. UI
- Fully functional Research Journal `/journal` (replace placeholder); consistent with premium-dark design; date/run navigation, source provenance, coverage/limitations, linked idea changes, honest counts.
- Evidence review workbench as a Journal tab or route; source filtering (status/market/source type/idea/age), review history, clickable source, clear "checking URL != proof" messaging.
- Historical Top-10 comparator from two actual stored snapshots; illustrate movement and exits, no fabricated full ten if <10 supported.
- Clean loading/empty/error states in REAL/TEST, separate DEMO; excellent 390px mobile and 1440px desktop.

### B. Data + review CLI
- Add only necessary read APIs and database migration(s); preserve immutable audit history and existing VL-002 behavior.
- `research:review` CLI supports safe dry-run, explicit `--apply`, actor/reason/status, append-only human review, validation and dataset isolation. Do NOT introduce unauthenticated public write endpoints.
- Derive run-level added/updated/rejected counts faithfully from existing import records; if insufficient, add forward-compatible immutable action history with clear legacy limitations.
- Top-10 snapshot compare MUST use stored snapshot entries for period A/B, not current mutable score/title/stage, with accurate "new/exit" and score changes.
- No copy of scoring rules in another layer.

### C. Import preparation
- Versioned ChatGPT research export guide/template matching **actual** `vl-research-1` Zod schema. Provide a helper to validate source coverage/duplicates without claiming independent truth.
- Distinguish `draft` vs `founder-approved human-reviewed REAL import`. Never set `checked` based on AI output alone. Explicit founder sign-off needed before a real apply. If current importer can be misused to bypass this, add suitable safe workflow/gate without breaking prior tests.
- Prepare a small **draft** of 3–5 previously investigated candidate ideas with verifiable grounded public URLs only if access to current sources is available. If not, stop at reusable template and document that actual primary-source verification/import is pending. No fabricated figures or artificial top-ten fill.
- Reproduce one full import using isolated TEST data; in REAL only explicitly approved public research may enter.

### D. Quality and handoff
- Preserve current suite; add database review/atomicity/isolation tests, journal API/UI, snapshot compare with edge cases, draft helper validation, responsive QA; run lint/types/tests/build and CI.
- Provide screenshots for desktop/mobile and a handoff with PR link, exact commands, test results, demo-vs-real disclosure, risks and future work.
- Work in a new branch from main, commit/push and open PR; DO NOT MERGE.

## Important constraints
- Existing daily ChatGPT research automation delivers chat reports, **not** direct Github/DB writes. This sprint cannot claim auto-sync. Founder-approved export and import are manual.
- No OpenAI/Claude APIs, autonomous crawling, scheduled ingestion, paid services, public deployment, customer outreach or credentials in repo.
- No automatic market scoring of AI-authored claims as "verified". Evidence integrity and current UI take priority over number of features.
- No need to ask the founder to pick mundane technical libraries; decide and document.

## Definition of Done
An operator can execute **candidate draft → source review → approved import → real Journal/Radar/Top-10 update → compare with earlier snapshot**, or gets an explicitly documented hold when no founder-approved data are available. TEST scenario fully reproducible locally and in CI; GitHub PR open awaiting founder's approval.
