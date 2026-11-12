# CURRENT TASK — VL-002 / Research Engine Foundation
Version: 1.0
Status: READY FOR CLAUDE
Owner: Founder + ChatGPT
Repository: strace42-ai/Venture-lab
Base: main (after merged VL-001)
Target branch: new `claude/vl-002-research-engine`

## Mission
Turn Venture Lab from a beautiful demo into a **usable, persistent evidence-backed research product**. A reviewed structured research report should be importable without copy-pasting into dozens of UI fields; Radar, dossier, overview and TOP-10 should then display actual records and their verifiable evidence. Preserve the VL-001 premium UI.

**Read first**: `CLAUDE.md`, `docs/product-vision.md`, `docs/scoring-model.md`, `docs/data-contracts.md`, and especially `docs/research-engine-contract.md`. Check existing data types/components and actual build scripts before design decisions.

## User-facing success demo (PRIMARY acceptance scenario)
1. Fresh local project starts with an **empty real research database**. UI explicitly says no research has been imported.
2. The founder drops an approved, versioned JSON research file into `research/inbox/` (or imports an explicitly synthetic sample).
3. CLI dry-run validates it without writing; shows inserts, updates, rejects, sources, conflicts. With `--apply`, data persists in DB.
4. Refresh REAL mode UI: imported ideas appear in Radar, dossier shows evidence names, clickable URLs, observation dates, verification state and competitors.
5. When a genuine assessment is present, the unchanged rubric v1.0 generates the score; rank, evidence confidence and Founder Fit remain distinct. Unknown/unassessed values are not silently presented as 0-rated ideas.
6. A dated TOP-10 snapshot can be created explicitly, and prior snapshots do not change if an idea is later reassessed or rejected; movement is computed against the previous stored snapshot.
7. Re-import the exact same file: no duplicates, scores or rank history changes. Data survives restart.
8. Switch to DEMO intentionally: old VL-001 fixture returns, visibly labeled. Never mix both modes.

## Must implement
### A — Minimal local persistence and API
- PostgreSQL in a simple `docker compose` configuration for local development, with migrations and isolated test DB. No remote DB, cloud account or paid services. Use TypeScript server (Fastify or another lightweight justified framework), Zod validation, a maintainable query layer. Explain versions/choices in README.
- Tables/constraints for ideas, stage transitions (append-only), assessments (append-only, rubric version and dimensions), evidence, RU/Western competitors, research runs, immutable top-ten snapshots + entries, import runs and their checksums. Build only fields needed for the primary scenario; migrations must be safe and repeatable.
- Minimal local read API: overview, ideas with query/filter/sort/pagination, detail, research runs, TOP-10 and health. Validate inputs, safe error handling; restrict CORS and network binding to local development.
- Keep current `src/domain` scoring and ranking **single source of truth**. Sharing domain types is preferable to duplicating business logic in API; if reorganizing, preserve all existing tests and explain migration.

### B — Honest research import
- Document versioned `vl-research-1` JSON schema, provide TWO synthetic examples with explicit `demo/test` markers and no purported real evidence. Support import of user-supplied REAL data with original source URLs and provenance.
- `npm run research:validate -- <path>` and `npm run research:import -- <path> --apply` (or clearly documented equivalents), safe file path handling, useful diagnostics and no-write dry-run by default.
- Stable idempotency by `runId + checksum`, explicit conflict for same ID/different content, unique idea external ID, transactionality (invalid item must not partially write successful items). No guessing/fuzzy auto-merge.
- Persist evidence URL/title/publisher, source type, observed/retrieved/published dates, review state and source-linked claim; distinguish unreviewed from checked. If claim lacks sufficient attribution, do not promote it as verified.
- Accept **optional** 12-dimension assessment with justification and evidence references. If absent, idea is `unscored` in UI, not a fabricated score. Previous assessments and source provenance are immutable; corrections append revisions.
- Snapshot action is explicit, idempotent per period/snapshot ID; snapshot generated from eligible ideas with assessments on that date. A new import does NOT rewrite a historical snapshot. Keep movement honest.

### C — Real UI integration without losing design
- Preserve existing UI and all VL-001 functionality; add a clear `DEMO / REAL` development-mode choice (URL/query/config with visible banner), not an ambiguous fallback.
- Replace direct demo-only provider when REAL selected with loading/empty/error states and API-backed data adapter; display actual evidence and competitor names/links with review status, never bare unsupported claims as established facts.
- For REAL mode, overview/Radar/dossier/Top-10 work with the imported subset and show clear "не оценено / источник требует проверки" states where necessary. No fake payment or agent status.
- Screenshots of REAL mode with the synthetic test import clearly labeled demo; screenshots of empty real mode; preserve polished 390px / 1440px layout.
- Do not introduce major redesign unrelated to data ingestion.

### D — Validation and delivery
- Tests for migration, schema validation, transaction rollback, duplicate/conflict imports, append-only updates, snapshot immutability, ranking/score consistency, API input validation, REAL empty/error states and DEMO mode regression.
- CI GitHub Actions for lint/typecheck/tests/build; Postgres service for isolated integration tests (avoid using real credentials). If some suites are local-only, clearly document and justify.
- Documentation: precise prerequisites (Node and Docker), one-command local start if feasible, run migrations, import example, inspect in browser, clean/reset safely.
- Run actual checks; report command outputs rather than mere claims. Mobile responsive sweep, check console/errors, include screenshots.
- `handoff/latest.md`: branch/commit/PR, architecture diagram in text, migrations, validation commands/results, known limitations, cost/security notes and proposed VL-003.

## Boundaries and non-goals
- No OpenAI/Claude API integration; ChatGPT automation does NOT directly write to the live app without an explicit export/integration.
- No unattended internet browsing, scheduled ingestion, autonomous LLM scoring, browser scraping.
- No production deployment, public hosting, sign-up/auth, payments, arbitrary client data, automatic messages to prospects or API keys.
- Never invent sources, sales, Western metrics, competitor coverage or real interview records. Previous chat reports can be imported ONLY as explicitly reviewed input with links. Do not fill REAL mode with fabricated proof.
- No merging the PR without founder approval.
- Avoid adding a large general-purpose CRUD app. This is a vertically complete **import → persistent storage → verified display → immutable TOP-10** sprint.

## Definition of done
- REAL empty → reviewed import → real view → duplicate safe → revised assessment → preserved previous snapshot demonstrated end-to-end.
- Scores remain accurate and match VL-001 rubric; no history retroactively rewritten.
- Quality gate: lint/types/tests/build + API integration tests + responsive screenshots; CI added.
- Handoff updated, separate branch pushed, PR opened and not merged.

## Decision rules
You may choose detailed implementation libraries and migrate code folders if justified by clear architecture, but keep existing route URLs and general design. If DB or automated tests are unexpectedly blocked, deliver the strongest working vertical slice and accurately mark incomplete acceptance criteria. Do not request extra services or paid tokens for this sprint.
