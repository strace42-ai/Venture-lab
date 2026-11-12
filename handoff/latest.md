# Venture Lab — Latest implementation handoff

**Task:** VL-003 / Research Operations & Evidence Review (`tasks/current-task.md` v1.0 + `docs/research-operations-vl003.md` v1.0)
**Status:** IMPLEMENTED + REVIEW ROUND 1 CORRECTIVE PASS. Awaiting ChatGPT re-audit and founder approval. **Not merged.**
**As of:** 2026-11-12
**Implementer:** Claude Code
(The VL-002 handoff is in git history, commit `a98e1c9` and earlier.)

## Git
| | |
|---|---|
| Base | `main` @ `a98e1c9` (VL-002 merged, VL-003 docs) |
| Feature branch | `claude/vl-003-research-operations` |
| Implementation commit | `8d34ca4` |
| Audited by ChatGPT | `5dc81a0` — https://github.com/strace42-ai/Venture-lab/pull/3#pullrequestreview-5870490987 |
| Corrective-pass commit | the latest commit on the branch (see PR) |
| PR | https://github.com/strace42-ai/Venture-lab/pull/3 (not merged) |

## Review round 1 — corrective pass
| # | Finding | Root cause | Fix | Regression tests |
|---|---|---|---|---|
| **P1** | A manually rejected source that the current assessment relies on did not affect recommendations. A 90/100 idea stayed «сильнейшая находка» and counted as a high-confidence lead. | Ranking, `strongestFind` and the KPIs looked only at score, confidence, risks and stage. Nothing connected `assessment.evidenceIds` to the current review status of those sources. | New **derived, current** flag `src/domain/integrity.ts` → `assessmentIntegrity(idea, assessment)` with four states: `needs-review` (a cited source is rejected or missing), `unverified` (unreviewed or unattributed: weak, **not** refuted), `verified`, `unlinked`. It is attached to every `ScoredIdea`/`RankedEntry` as `integrity`. `isFindEligible` excludes `needs-review`. `highConfidenceLeads` excludes it, and a new KPI is `assessmentsNeedingReview`. The idea **stays in the ranking with its stored score**, so the rubric is not silently changed. **Nothing is written:** assessments, the review history and frozen snapshots are unchanged. UI: an Overview alert listing ideas and source ids; a «Оценка требует пересмотра» badge in the TOP-10, Radar (table and cards) and the dossier header; a dossier notice that says what the flag changes and what it does not, and **how to lift it** (a new assessment revision that does not cite the rejected sources, or reversing a mistaken rejection with `research:review`); evidence queue cards note that the current assessment relies on this rejected source. `/api/top10` current entries also carry `integrity`. Documented in `docs/scoring-model.md`. | `server/test/vl003.test.ts` › «evidence integrity…» (4 PostgreSQL integration tests). Import a scored REAL idea, then: it is the lead and counted as strong → manual `rejected` of its cited source → `/api/overview`, `/api/ideas/:id` and `/api/top10` show `needs-review` with `rejected: ['s1']`; same score and rank; the lead moves to the next idea (whose cited source is only *unreviewed*, so not excluded); KPIs 2→1 strong and 1 needing review; assessment count and `top10_entries` unchanged → a new revision citing a checked `s2` lifts the flag, the lead returns, and both revisions plus the rejected review stay in history → a revision that still cites `s1` is flagged again. `src/test/integrity.test.tsx` (10): domain states, uncited rejection ignored, strongest find and KPIs, unreviewed not excluded, historical as-of ranking unchanged, Overview alert and flagged row and a different hero, no alert when checked, dossier notice text, Radar flag. |
| **P2** | The mobile journal intro pushed the queue and runs far down | Long lede, an always-expanded explainer, 8 filters, and 5 full-size stat cards | ≤640 px: a compact title and a one-line lede; «Открытие ссылки — не доказательство» stays visible as the summary of a collapsible «Как проверяются источники» (`<details>`, keyboard accessible); secondary filters sit behind «Ещё фильтры · N» (status and idea stay visible); the stats are a compact swipeable strip. The desktop layout is unchanged. | Existing journal UI tests still pass (filters, explainer text). Responsive QA. Screenshots: `evidence-queue-test-390.png` (count and queue now on the first screen) and `journal-runs-test-390.png` (run selector and run on the first screen). |
| boundary | Run evidence status is the current one, not the status at import | — | The label now reads «статус на сегодня (не на дату импорта)». | — |

The pilot remains an unreviewed ai-draft. It was **not** imported into REAL.

**QA data note:** to demonstrate P1 in the TEST dataset, `test-invoice-reminders/r3` was rejected locally with `research:review --dataset test … --apply`. This changed the local development database only and nothing in the repository. See `overview-integrity-test-*.png`, `dossier-integrity-test-*.png`, `radar-integrity-test-1440.png` and `evidence-rejected-cited-test-1440.png`.

### Checks for the corrective pass (2026-11-12)
| Check | Result |
|---|---|
| `npm run lint` / `npm run typecheck` / `npm run build` | ✔ / ✔ / ✔ |
| `CI=true TEST_DATABASE_URL=… npm test` | ✔ **12 files, 166 tests** (+14: 4 integration, 10 UI/domain) |
| `npm audit --omit=dev` | ✔ 0 vulnerabilities |
| Responsive QA, Playwright at 390/768/1024/1280/1440 on journal tabs (REAL/TEST/DEMO), overview, radar and dossiers including a flagged idea | ✔ no horizontal overflow, no console or page errors |
| GitHub Actions | result recorded in the PR after push |

## What was built
### A. UI — `/journal` (replaces the placeholder; tabs `?tab=runs|evidence|history`)
- **Прогоны.** Stats, a date index of runs (on mobile, a select), and run details: approval badge (approved by / when / statement, or «одобрение не записано» for legacy REAL runs), counts (new / updated dossiers / assessments / stage changes / rejected / sources / status changes), the current status bar of the run's evidence, coverage and limitations, per-idea changes (changed fields, assessment score, stage from→to with reason, sources and competitors), run links, provenance (file, SHA-256, importer, time). Manual reviews have their own timeline (previous → new status, actor, reason).
- **Проверка источников.** An explainer that says «Открытие ссылки — не доказательство». Filters in the URL: status (default «требуют проверки»), idea, market, source type, rubric criterion, idea risk, observation age, «только без ссылки». Pagination at 50 items. Each card shows the claim, a clickable source, publisher / type / dates / age, criteria, «В текущей оценке», review history, and **copyable `research:review` commands** (REAL/TEST only; an unattributed claim can only be rejected).
- **История ТОП-10.** Two stored-snapshot selectors (`?a=&b=`). A is always the earlier one (auto-swap with a note). Summary counts (вошла / выбыла / выше / ниже / без изменений). A table on desktop and cards on mobile. Values are **frozen in the snapshots**: titles A/B, rank, score and confidence deltas. Exit detail: «ниже 10» vs «выбыла из рейтинга». Entry detail: «новая в рейтинге» vs «поднялась снизу». The page states N/10 and never pads the top. With 0 or 1 snapshots it shows an honest empty state with the command to run.
- Dossier: each source shows the latest decision (manual or at import, who, when, reason). Mobile tab bar: «Журнал» replaced «Валидация» (a placeholder that is still in the drawer).
- DEMO: the journal is built from the fixture with honest notes (no provenance). Its snapshots are marked **«восстановлены»**, not stored.

### B. Data + review CLI
- **Migration 003** (forward-only): `evidence_reviews` gains `origin ('import'|'manual')`, `actor`, `reason`. Shape CHECK: a manual review has no run, has an actor, and a reason of at least 10 characters. `import_runs` gains `approved_by/at`, `approval_statement`. CHECK: a `human-reviewed` run requires approval (`NOT VALID`, so legacy rows stay as they are and the journal flags them).
- **Journal derivation** (`server/research/journal.ts`) uses only stored history keyed by `run_id` (ideas.first_run_id, idea_revisions diff, assessments, stage_transitions, competitors, evidence, evidence_reviews). Nothing is inferred from today's snapshot. «Обновлено» means descriptive fields changed; a stage-only change is counted under stage changes and rejections.
- **`npm run research:review`** (`server/research/review.ts`): dry-run by default. `--apply` appends one `evidence_reviews` row in a transaction under the import advisory lock. It is strictly validated (Zod: dataset, ids, status, reason ≥10, actor). It is idempotent (same status → no-op). Cross-dataset requests are rejected. `checked` requires url + publisher + observedAt. The claim is never modified (append-only triggers). **There is no HTTP write endpoint.**
- **Read-only API:** `GET /api/journal`, `/api/evidence` (filters + pagination, 400 on bad params), `/api/snapshots`, `/api/snapshots/compare?a&b` (400 on the same id, 404 for ids outside the dataset). Every endpoint reads exactly one dataset.
- Scoring is not duplicated: the journal's assessment score and snapshot values come from `src/domain/scoring.ts` and the stored snapshot entries.

### C. Import preparation and approval gate
- `docs/research-export-guide.md` plus `research/templates/vl-research-1.ai-draft.template.json` (it validates against the real schema) and `research/drafts/README.md`.
- Schema: `source: "ai-draft"`. An ai-draft **cannot** have checked/rejected sources or a per-source `reviewedBy`. There is an optional `approval {approvedBy, approvedAt, statement}`.
- **Apply gate** (`applyGate`, enforced in `applyImport` and printed in the dry-run): it refuses `ai-draft` files, any file under `research/drafts/`, and `human-reviewed` files without `approval`.
- A human-reviewed `checked`/`rejected` source without a per-source `reviewedBy` is stored as `unreviewed` with a warning, so the envelope never auto-promotes sources.
- An import **never overrides** a manual review.
- `npm run research:draft-check` checks structure and coverage: West/RU sources, RU competitors, attribution gaps, missing or unknown scores, duplicate URLs (warnings), and overlap with URLs already in REAL. It ends with a verdict and next steps, and it explicitly says it does not establish truth.

### Pilot (real public research, NOT imported)
`research/drafts/draft-2026-11-12-pilot-001.json`: 3 candidate ideas (a 1-on-1 virtual focus coworking service for Russian speakers, a personal relationship CRM, supplier quote (КП) comparison). It cites 10 sources opened on 2026-11-12 through web tools: focusmate.com (home page, pricing), getdex.com/pricing.md, monicahq.com, sourceday.com, thecode.media, devby.io, two bitrix24.ru marketplace apps and workspace.ru.
- All sources are `unreviewed`, there is no assessment (no AI self-scoring), RU prices are labelled as hypotheses, and «не найдено в РФ» is labelled as «не найдено в нескольких запросах».
- `draft-check` gives «готов к проверке основателем (НЕ одобрен)» with warnings. The import dry-run shows 3 new unscored ideas and **⛔ refuses to apply** (ai-draft, drafts folder).
- **Hold:** the founder must open every link, verify the RU competitors, add `approval`, and move the file to `research/inbox/` before any REAL import. **REAL stays empty.** The TOP-10 is not filled.

### TEST scenario (reproducible locally and in CI)
`synthetic-run-1 --apply` → `snapshot --dataset test --as-of 2026-11-06` → `synthetic-run-2 --apply` → `snapshot --as-of 2026-11-11` → `research:review --dataset test … --apply` → the journal shows 2 runs and the manual review, and the comparator shows entered / exited / unchanged. The same sequence runs as a CI smoke step, including assertions that the ai-draft cannot be applied and that a cross-dataset review is refused.

## Checks actually run (2026-11-12, local PG 16, Node 22)
| Check | Result |
|---|---|
| `npm run lint` | ✔ 0 problems |
| `npm run typecheck` | ✔ |
| `CI=true TEST_DATABASE_URL=… npm test` | ✔ **11 files, 152 tests passed** (VL-003 added 40: `server/test/vl003.test.ts` 23, `src/domain/research-ops.test.ts` 9, `src/test/journal.test.tsx` 8; the existing VL-001/VL-002 suites still pass) |
| `npm run build` | ✔ |
| `npm audit --omit=dev` | ✔ 0 vulnerabilities |
| CLI smoke from `ci.yml` (VL-003 block) on a fresh database | ✔ (draft-check ok, ai-draft apply refused, review dry-run/apply, cross-dataset refused) |
| Responsive QA (Playwright, 390/768/1024/1280/1440 × 13 routes: journal tabs in REAL/TEST/DEMO, dossier, overview, radar) | ✔ no horizontal overflow, no console/page errors |
| GitHub Actions | runs on the PR; result is reported in the PR |

Tests cover:
- the gate (ai-draft, drafts path, missing approval, DB CHECK) and the reviewedBy downgrade;
- review: dry-run writes nothing, apply appends exactly one event, idempotence, invalid input, not-found, unattributed `checked`, cross-dataset in both directions, rollback via injected failure, append-only enforced by triggers, an import not overriding a manual review;
- journal counts and changed fields, stage reason, approval, real/test isolation;
- evidence API filters, pagination and 400s;
- snapshot listing isolation; compare with swap, entered/new, exited/left, down, frozen titles after a later rename, same id 400, other dataset or unknown id 404;
- domain compare: below-cut / from-below, empty and partial snapshots (N/10), same snapshot;
- evidence queue filters; DEMO journal honesty;
- UI: tabs via URL, filters, empty states for 0 and 1 snapshots, comparator with frozen titles and the N/10 note, review commands per mode, review history, error state;
- one UI regression found and fixed during QA: choosing «Все» in the status filter used to snap back to «Требуют проверки».

Screenshots: `docs/screenshots/vl-003/` (journal runs, evidence queue and TOP-10 history in TEST at 1440 and 390; empty REAL journal; DEMO history; dossier with review decisions).

## Demo vs real disclosure
- REAL: empty. No real research was imported. The pilot is a draft awaiting founder review.
- TEST: synthetic examples only (`example.org`, «Тест:» titles).
- DEMO: the VL-001 fixture, with history reconstructed and labelled as such.
- No ChatGPT auto-sync exists. The 08:00 automation only produces a chat report. No paid APIs, crawling, deployment or auth were added.

## Known limitations and risks
- The pilot sources were read through a web-fetch summariser, not by a human. Each claim must be checked on the original page before approval.
- `approval` records a statement typed into a JSON file. It is an honest-intent gate on a local single-user tool, not cryptographic authentication.
- Legacy REAL runs imported before migration 003 have no approval. The journal flags them. The DB CHECK is `NOT VALID` for those rows.
- The journal loads all runs and the evidence queue is computed in memory per request. This is fine for hundreds of runs and thousands of sources; at larger scale it needs SQL-side filtering and pagination.
- Time handling: dates are `YYYY-MM-DD` (UTC); review timestamps are UTC and displayed as UTC.
- The screenshot folder is about 6 MB (2× PNG).

## Next recommendation
1. The founder reviews the pilot draft: open the 10 links, check StudyMates, RuStore/App Store and Bitrix24, then approve, import into REAL, and use `research:review` per source.
2. The founder adds assessments after review, then takes the first REAL snapshot, and a second one after the next run, so the comparator has history.
3. A later task, which needs separate authorization: a safe bridge from the ChatGPT research report to `research/drafts/`, still without auto-apply.
