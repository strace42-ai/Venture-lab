# Venture Lab — Latest implementation handoff

**Task:** VL-002 / Research Engine Foundation (`tasks/current-task.md`, Version 1.0)
**Status:** IMPLEMENTED + REVIEW ROUND 1 FIXED. Awaiting re-audit and founder approval. **Not merged.**
**As of:** 2026-11-12
**Implementer:** Claude Code
(The previous VL-001 handoff is in git history and in `tasks/done/VL-001-dashboard-foundation.md`.)

## Git
| | |
|---|---|
| Base | `main` @ `60f7d00` (includes the merged VL-001 and the VL-002 docs) |
| Feature branch | `claude/vl-002-research-engine` |
| Implementation commit | `d6981af155101b15ea77c87bf3ea3ba4dfe44871` |
| Commit audited by ChatGPT | `0d761dc70403d6cfcdfc3f5fcf816da88075fb72` |
| Review-fix commit | `6a43687782756a43a983f5f8ddafa0177a71775e` |
| Handoff update | the next commit on the same branch, which updates this file |
| PR | https://github.com/strace42-ai/Venture-lab/pull/2 |

## Review round 1 — ChatGPT findings and root-cause fixes
Review: https://github.com/strace42-ai/Venture-lab/pull/2#pullrequestreview-5868393820 (on `0d761dc`).

| # | Finding | Root cause | Fix (architecture) | Regression tests |
|---|---|---|---|---|
| **P1a** | Synthetic and real ideas mix in «Реальные данные» | Every read path loaded all rows. The importer only guarded against a *same-externalId* collision. | **The dataset is an explicit dimension of every read.** `loadIdeas`, `loadResearchRuns`, `loadSnapshot`, `listSnapshots`, `loadDataset` and `createSnapshot` all require `dataset: 'real' \| 'test'`, and no «all» option exists. Every API endpoint takes `?dataset=` (default `real`, anything else → 400). **Migration 002** adds DB-level guarantees through composite foreign keys: an idea ↔ its first and last research run, a snapshot entry ↔ its idea ↔ its snapshot. As a result a cross-dataset link cannot exist even through raw SQL. Snapshots are unique per (dataset, date). The UI gets a third explicit mode, **«Тестовые импорты»** (`?mode=test`), with its own banner; REAL shows only `human-reviewed` research. CLI: `research:snapshot --dataset real\|test` (default `real`). | `review-fixes.test.ts` › P1a (4 tests): synthetic and real imports in one PostgreSQL DB. REAL ranking, KPIs, runs, evidence, snapshots and every API endpoint contain no synthetic rows. A test idea is 404 in REAL. `dataset=all` → 400. Raw-SQL cross-dataset INSERT/UPDATE is rejected by FKs. UI: a TEST source sends `dataset=test` on every request; TEST mode is labelled. CI smoke asserts that the REAL snapshot is empty after synthetic imports. |
| **P1b** | TOP-10 movement resets after today's snapshot | The baseline was the latest snapshot `as_of ≤ today`, so the ranking was compared with itself. | The baseline is the latest stored snapshot **strictly before** `rankAsOf`. Behaviour is defined and documented: before today's snapshot, after it, and for later imports the same day, the comparison is always with the previous stored snapshot. `/api/top10` also returns `latestSnapshot.entries` with movement computed against the stored snapshot before it (`comparedTo`), via the shared `compareToBaseline` in `src/domain/scoring.ts`. | `review-fixes.test.ts` › P1b: yesterday's snapshot → reorder plus a new idea → today's snapshot. DB and API keep up/down/new against yesterday (not «same»). A later import the same day is still compared with yesterday, and today's snapshot stays unchanged. |
| **P1c** | A partial update erases the accumulated dossier | `ideaContent` turned absent fields into `null`/`[]`, and the UPDATE overwrote all columns. | **PATCH semantics** (`mergeIdeaContent`): an absent key keeps the stored value; an explicit `null`/`[]` clears it, with a warning naming the fields; required fields are always replaced. Schema defaults that turned absence into `[]` or «Россия» were removed. The dry-run lists exactly which fields change. Root cause of the same class, also fixed: an assessment in a short update could not cite earlier evidence, because refs were checked only within the file. Refs now resolve against the file **plus** the evidence already stored for the idea; an unknown ref still rejects the file. | `review-fixes.test.ts` › P1c (3 tests): a short update keeps every dossier field and list and counts as «unchanged» while the assessment is appended; explicit null/[] clears with a warning and the old value stays in `idea_revisions`; a new idea gets defaults. `import.test.ts`: an unknown ref rejects the whole file, and a ref to earlier stored evidence is accepted. |
| **P1/P2** | Radar shows stale DEMO rows under REAL | `lastView` was cached without regard to the source, and stale rows were shown on error. | (1) Pages **remount on every source change** (`<Suspense key={mode}>` in `AppShell`), so no page-local state can cross sources. (2) The Radar reuses the previous result **only while the same source is loading**, the cache is tagged with its source, and an error shows the error without stale rows. (3) Gateway 502/503/504 (dev proxy with the API stopped) map to «API недоступен». | `real-mode.test.tsx` (5 tests): DEMO→REAL on /radar with the API down (error, no demo rows); DEMO→REAL while REAL is still loading (loading state, no demo rows); REAL→DEMO (no REAL rows leak); a failed refresh in the same source shows the error, not old rows; 502 without JSON → unavailable. Verified manually in Chromium: `docs/screenshots/vl-002/radar-demo-to-real-api-down-1440.png`. |
| non-blocking | Historical snapshot titles followed later renames | Entries joined the current `ideas.title`. | Migration 002 stores `title` and `slug` in `top10_entries` at snapshot time; pre-migration rows are backfilled with the title current at migration time. | `review-fixes.test.ts`: a rename after the snapshot does not change the snapshot title; the migration-002 backfill test. |
| non-blocking | «Проверено» could read as automatic verification | — | The dossier now explains that «проверено» is a manual human review mark and that the app does not open or check links. | — |

**Migration 002 on an existing database:** applied on my local DB that already held a pre-fix synthetic snapshot: the backfill set the snapshot to `synthetic = true` and froze the titles. A legacy snapshot that mixes datasets aborts the migration with a clear instruction (`db:reset`); this case is tested.

## Primary acceptance scenario — status
| # | Scenario step | Status | Evidence |
|---|---|---|---|
| 1 | A fresh project starts with an empty REAL database, and the UI says nothing has been imported | ✅ | `docs/screenshots/vl-002/real-empty-*.png`; test `REAL mode — empty database`; API test `empty database` |
| 2 | Drop an approved JSON into `research/inbox/`, or import an explicitly synthetic sample | ✅ | `research/examples/synthetic-run-{1,2}.json` (synthetic, example.org/example.com only). Since the review they go to the isolated **TEST** dataset (`?mode=test`). |
| 3 | A dry-run validates without writing and shows inserts, updates, rejects, sources and conflicts; `--apply` persists | ✅ | CLI output below; test `dry-run reports the diff but writes nothing` |
| 4 | Imported ideas appear in the Radar; the dossier shows evidence names, clickable URLs, dates, verification state and competitors | ✅ | Same views for REAL and TEST. Screenshots use TEST (`test-radar-1440.png`, `test-dossier-1440.png`) because no real research exists yet; the REAL rendering is covered by UI test `dossier shows source links with provenance…` |
| 5 | The unchanged rubric v1.0 scores the idea; rank, confidence and Founder Fit stay separate; an unassessed idea is not 0 | ✅ | test `REAL scores and ranking match the unchanged VL-001 rubric`; «не оценено» in Radar and dossier |
| 6 | An explicit dated snapshot is unchanged by a later reassessment or rejection; movement is computed against the previous stored snapshot | ✅ | tests `a later reassessment and rejection never rewrite a stored snapshot…` and P1b `yesterday snapshot → … → today snapshot` |
| 7 | Re-importing the same file creates no duplicates and no history change; data survives a restart | ✅ | tests `re-importing the exact same file is a no-op`, `data survives a restart`; manual API restart below |
| 8 | Switching to DEMO brings back the VL-001 fixture, visibly labelled, and the modes never mix | ✅ | tests `switching from DEMO to REAL replaces all data`, `labels follow the mode`, the P2 Radar tests; `demo-overview-*.png` |

## Architecture
```
research/inbox/*.json ─► server/cli/research.ts  validate | import [--apply] | snapshot [--dataset real|test] [--apply]
                               │
                               ▼
               server/research/schema.ts   (Zod, strict vl-research-1)
               server/research/importer.ts (plan = read-only diff; apply = 1 transaction + advisory lock)
               server/research/snapshot.ts (explicit, idempotent, full ranking as of date)
                               │
                               ▼
                    PostgreSQL 16 (migrations 001_research_engine, 002_dataset_isolation)
     ideas ─┬─ idea_revisions        stage_transitions        assessments (raw 0–5|null, no totals)
            ├─ evidence ── evidence_reviews                   competitors (ru/west)
            └─ research_runs ── import_runs (run_id UNIQUE, sha256 checksum)
     top10_snapshots ── top10_entries          (append-only tables: UPDATE/DELETE → trigger error)
     dataset = ideas.synthetic / research_runs.synthetic / top10_*.synthetic, linked by composite FKs
                               │
               server/research/repository.ts  (every read scoped to ONE dataset; baseline = latest snapshot < today)
                               │
               server/api/app.ts  Fastify, 127.0.0.1, GET-only, CORS allow-list, Zod params
                     /api/health /api/overview /api/ideas /api/ideas/:id /api/research-runs /api/top10   (?dataset=real|test)
                               │       ▲ src/domain/{scoring,selectors}.ts — single source of truth
                               ▼       │ (buildOverview / buildRadarView / buildIdeaDetail used by BOTH)
               src/data/source.ts  REAL/TEST: createApiSource(dataset)   DEMO: createDemoSource(demoData)
                               │
               src/data/DataContext.tsx (mode real|test|demo: ?mode → saved → VITE_DATA_MODE → real)
               AppShell: <Suspense key={mode}> — pages remount on every source change
                               ▼
               Overview / Radar / Dossier pages (loading · empty · error · ready)
```
**Domain reorganisation (explained):**
- `src/domain/types.ts` was generalised. Evidence and competitors now carry real provenance; descriptive fields, validation plan and founder fit became nullable; `synthetic` replaced `demo: true`.
- New `Dataset` with `mode`, `rankAsOf` and `baseline` (`stored` snapshot | `reconstruct` for DEMO).
- `rankAgainstBaseline` was added. `rankIdeas` skips unscored ideas.
- View-model builders (`buildOverview`, `buildRadarView`, `buildIdeaDetail`) moved into `selectors.ts`, so the API and the DEMO adapter share them.
- All 41 VL-001 tests still pass. The only test edits were mechanical: `demo` → `synthetic`, and a non-null assertion on the now-nullable `confidence`.

## Migrations
- `server/db/migrations/001_research_engine.sql`: every table, CHECK constraint, unique key, index and append-only trigger (`vl_forbid_mutation`).
- `server/db/migrations/002_dataset_isolation.sql`:
  - composite FKs that isolate datasets;
  - snapshots unique per (dataset, date);
  - frozen `title`/`slug` in snapshot entries;
  - backfill of existing rows. The append-only triggers are disabled only inside this migration transaction and re-enabled at its end (tested).
- Runner `server/db/migrate.ts`:
  - forward-only;
  - each file runs in its own transaction under an advisory lock;
  - SHA-256 of each applied file is stored in `schema_migrations`, and a modified applied file is a hard error.
- Rollback / rebuild for local development: `npm run db:reset -- --yes`. This drops the schema and re-migrates, and refuses non-local database hosts.

## Security and cost notes
- **Cost:** no paid API, no cloud, no deploy. The only infrastructure is a local PostgreSQL in Docker.
- **API exposure:**
  - The API binds to loopback only; `loadConfig` throws on a non-loopback `API_HOST`.
  - GET/HEAD only. CORS is an explicit allow-list of local UI origins.
  - Responses carry `no-store`, `nosniff` and `default-src 'none'` headers.
  - Errors return no stack traces, and a database outage returns 503.
- **Import:**
  - Files are read only from inside `research/`, as regular `.json` files of at most 5 MB; symlink escapes are blocked by realpath.
  - URLs must be http(s), may not contain credentials, and lose their fragment.
  - Control characters are rejected, and all text is rendered by React as plain text.
  - In the UI, external links are opened only for http(s), with `rel="noopener noreferrer nofollow"`.
- **Credentials:**
  - Local dev only: compose `venture_lab/venture_lab_local`, bound to 127.0.0.1.
  - CI uses a throwaway `ci/ci` for an ephemeral service container.
  - No secrets are committed; `.env*` is ignored apart from `.env.example`.
- **Data:** no data is sent to third-party AI APIs. No payments or customer data are imported.

## Files
- **New:**
  - `server/` — config, db, research, api, cli, test
  - `src/data/{source,mode}.ts`, `src/components/StateViews.tsx`, `src/test/real-mode.test.tsx`
  - `research/examples/*.json`, `research/inbox/README.md`
  - `docs/research-import-format.md`, `docs/screenshots/vl-002/*` (15 images)
  - review round 1: `server/db/migrations/002_dataset_isolation.sql`, `server/test/review-fixes.test.ts`
  - `docker-compose.yml`, `scripts/db-init/01-test-db.sql`, `scripts/dev-all.mjs`
  - `.github/workflows/ci.yml`, `.env.example`, `tsconfig.server.json`
- **Modified:**
  - `src/domain/{types,scoring,selectors,labels}.ts`, `src/data/{demo,context}.ts`, `src/data/DataContext.tsx`
  - pages `Overview` / `Radar` / `Idea`, `AppShell`, `primitives`, styles
  - `README.md`, `package.json` (+ lock), `vite.config.ts` (API proxy), `eslint.config.js`, `tsconfig*.json`, `.gitignore`

## Verification actually run
Environment: Node v22.23.4 and npm 10.9.9 in a Linux container. **PostgreSQL 16 ran natively** on 127.0.0.1:54329, because there is no Docker daemon in this environment.

| Command | Result |
|---|---|
| `rm -rf node_modules dist && npm ci` | ✅ exit 0 |
| `npm run lint` | ✅ exit 0, 0 warnings |
| `npm run typecheck` (`tsc -b`: app + node + server projects) | ✅ exit 0 |
| `TEST_DATABASE_URL=postgres://…/venture_lab_test CI=true npm test` | ✅ **8 files, 111 tests passed** (93 before the review + 18 regression) |
| `npm test` without `TEST_DATABASE_URL` | 69 passed, 42 DB-integration tests **skipped** (in CI, `CI=true` makes a missing DB URL a hard error) |
| `npm run build` | ✅ exit 0 |
| `npm audit --omit=dev` | ✅ found 0 vulnerabilities |
| **GitHub Actions CI** (`.github/workflows/ci.yml`, Postgres 16 service) | Before the review: run #1 on `d6981af` — success. After the review fixes: see the PR checks for `6a43687` and later (result recorded in the PR description). |
| `npm audit` (incl. dev) | 1 moderate advisory chain: `minimatch` via `@typescript-eslint/typescript-estree` (lint-time only; npm's fix is a downgrade) |

The test suites, by file:
- `src/domain/scoring.test.ts` (23) and `src/test/app.test.tsx` (18): VL-001 regression, unchanged behaviour.
- `src/test/real-mode.test.tsx` (20; +6 in review round 1: P2 Radar ×4, TEST-mode dataset scoping, 502 = unavailable):
  - REAL empty, unavailable and error states, and retry;
  - «не оценено»;
  - provenance links and review states;
  - non-http links never rendered;
  - API source error mapping and query building;
  - mode resolution, DEMO→REAL switch with no leak, and mode-correct labels.
- `server/test/migrations.test.ts` (6): clean migrate, repeatable, tampered checksum, append-only triggers, DB check constraints, reset/rebuild.
- `server/test/import.test.ts` (17; the «unknown evidence ref» case moved from schema-only to a DB test, which also checks refs to earlier stored evidence):
  - examples valid; malformed JSON; aggregate scores rejected;
  - 15 invalid-input cases (javascript: URL, credentials, impossible or future date, score 6, missing dimension, rubric v2, unknown or empty evidence refs, short rationale, synthetic mismatch, duplicate id, control chars, schema version, rejected without reason);
  - attribution downgrade warning; safe file paths;
  - dry-run writes nothing; first import; same-file no-op; same runId + different bytes = conflict;
  - invalid item = no partial write; fault-injection rollback;
  - appended revision, stage and review with earlier rows unchanged;
  - evidence immutability conflict; back-dated assessment, slug change and real/synthetic mixing rejected;
  - persistence across a new pool.
- `server/test/snapshot-ranking.test.ts` (7):
  - the VL-001 fixture imported as synthetic data gives identical scores, confidence and rank order;
  - unscored ideas not ranked;
  - snapshot dry-run, apply, exists, conflict, future and empty cases;
  - snapshot unchanged after reassessment and rejection, with movement against the stored snapshot (same / new / scoreDelta);
  - snapshot as of an earlier date;
  - no snapshot → movement `none`;
  - empty database → empty dataset;
  - rubric v2 rejected.
- `server/test/review-fixes.test.ts` (11, new): P1a ×4, P1b ×2 (incl. frozen titles), P1c ×3, migration 002 backfill and mixed-legacy refusal ×2.
- `server/test/api.test.ts` (9, now using `?dataset=test` for the synthetic examples):
  - non-loopback host refused; database down → 503;
  - empty DB; overview, list with filters / sort / pagination; detail provenance; top10; research runs;
  - 400 / 404 validation; CORS allow and deny; security headers;
  - fresh data after an import without a restart.

### End-to-end CLI run after the review fixes (fresh DB after `db:reset`, verbatim summary lines)
```
db:reset                                         → Схема пересоздана, применены: 001_research_engine, 002_dataset_isolation
research:import synthetic-run-1.json --apply    → ✔ Импорт записан… ℹ Синтетические данные изолированы: … только в режиме «Тестовые импорты»
research:import synthetic-run-1.json --apply    → Статус: already-imported
research:snapshot --dataset test --as-of 2026-11-06 --apply → Срез test-top10-2026-11-06 … создан; позиций в рейтинге: 3.
research:import synthetic-run-2.json --apply    → Идеи +1, =2 · Оценки +2 ревизий · ✔
research:snapshot --as-of 2026-11-06 --apply    → Набор данных: реальные исследования · На 2026-11-06 нет оценённых идей… срез не создан.
GET /api/health                                  → {"migrations":["001_research_engine","002_dataset_isolation"],"ideas":{"real":0,"test":5}}
GET /api/overview (REAL)                         → mode real, totalIdeas 0, ranking []
GET /api/top10?dataset=test                      → baseline test-top10-2026-11-06; invoice-reminders same, coffee-waste new, contract-clauses same
```

Before the review fixes (first submission):
```
research:import synthetic-run-1.json            → Статус: ready (dry-run: ничего не записано)
                                                  Идеи +4 · Источники +7 (1 понижено до unreviewed) · Конкуренты +2 · Оценки +3 · Стадии +4
research:import synthetic-run-1.json --apply    → ✔ Импорт записан в базу (одна транзакция).
research:import synthetic-run-1.json --apply    → Статус: already-imported · = Повторный импорт того же файла — ничего не изменено.
research:snapshot --as-of 2026-11-06 --apply    → Срез top10-2026-11-06 на 2026-11-06 создан; позиций в рейтинге: 3.
research:import synthetic-run-2.json --apply    → Идеи +1, =2 · Источники +2, 1 смен статуса · Оценки +2 ревизий · Стадии +2, отклонено идей: 1 · ✔
research:snapshot --as-of 2026-11-06 --apply    → Срез … уже существует — он неизменяем, ничего не сделано.
(API restarted) GET /api/health                  → {"status":"ok","db":"up","migrations":["001_research_engine"],"ideas":5}
GET /api/top10                                  → invoice-reminders 75 (same), coffee-waste 68 (new), contract-clauses 64 (same); latestSnapshot top10-2026-11-06
psql: UPDATE assessments …                       → ERROR: append-only table "assessments": UPDATE is not allowed
```

### Responsive / visual QA (Playwright + Chromium, production build via `vite preview`, live API)
- Re-run after the review fixes: 11 routes × 5 widths (390 / 768 / 1024 / 1280 / 1440) = 55 page loads.
  - REAL routes (empty, while the DB holds synthetic imports): overview, radar.
  - TEST routes: overview, radar (table and cards), scored dossier, unscored dossier, missing dossier.
  - DEMO routes: overview, radar, dossier.
- Manual Chromium check of P2: on /radar, switching DEMO→REAL with the API up showed «Исследования ещё не импортированы» and 0 demo rows; with the API down it showed «Локальная база исследований недоступна» and 0 demo rows.
- `scrollWidth == clientWidth` on all 55, and mobile tap targets are at least 44px.
- The only console errors were the expected `404` responses for the intentionally missing idea.
- Issues found while reviewing screenshots and fixed:
  - the empty-state instruction list broke into grid cells;
  - the mobile topbar pill squeezed the search field;
  - the synthetic badge stretched across the table cell;
  - DEMO showed the REAL «Тестовые данные» badge (regression test added);
  - «new since snapshot» counted database insertion time instead of the research date.
- Screenshots in `docs/screenshots/vl-002/` (regenerated after the fixes):
  - REAL, empty even though the DB holds synthetic imports (this demonstrates the isolation): `real-empty-overview-1440/390`, `real-empty-radar-1440`;
  - TEST, the synthetic import: `test-overview-1440` (+ viewport), `test-radar-1440/390`, `test-dossier-1440/390`, `test-dossier-unscored-1440`, `test-overview-390`;
  - mode switch with three options: `drawer-mode-switch-390`;
  - P2 check: `radar-demo-to-real-api-down-1440`;
  - DEMO: `demo-overview-1440-viewport`, `demo-overview-390`.

**NOT run / not verified:**
- `docker compose up` (no Docker daemon here); the compose file and init script are untested in this environment.
- Real devices, Firefox / WebKit, screen reader, axe / Lighthouse.
- Import of real (non-synthetic) research: none exists yet.

## Known limitations
- The API loads the full dataset per request and filters in memory using the shared domain selectors. That is fine for hundreds of ideas; push filtering into SQL before larger volumes.
- Snapshot entries store the **full** ranking so that movement is exact; `/api/top10` exposes ranks ≤ 10.
- Evidence and competitors are immutable per id: corrections need a new id. Only the verification status can change, through appended reviews.
- Descriptive idea fields follow PATCH semantics on re-import: an absent field is kept, an explicit null/[] clears it. Every version is kept in `idea_revisions`, but there is no UI for that history yet.
- Synthetic test imports and real research share one physical database but are separate datasets (enforced by FKs). Slugs and externalIds are still globally unique across both datasets, so a test idea can block a slug — the import then fails with a clear error.
- Snapshot titles for rows created **before** migration 002 were backfilled with the title current at migration time; from migration 002 on, titles are frozen at snapshot time.
- `/api/research-runs` and `/api/top10` have no dedicated UI page yet; the Research Journal is still a placeholder. The overview shows the latest runs and the snapshot baseline.
- Dates are UTC days: assessments and stage changes count from the start of their UTC day.
- Founder Fit for REAL data is taken from the assessment and is optional; when it is absent the UI shows «не оценено».
- Validation plans, experiments, builds, payments and agent activity are not imported in VL-002. REAL mode shows explicit empty states for them.

## Proposed VL-003 — Research operations
1. A Research Journal page backed by `/api/research-runs` and `/api/top10`: run provenance, import diagnostics, a snapshot list and a comparison of any two snapshots.
2. A review queue: imported claims with `unreviewed` / `unattributed` status, a local founder action to mark them checked or rejected (an appended review with an actor), and an evidence-to-dimension coverage view.
3. Export helper: a documented prompt/template so ChatGPT can produce `vl-research-1` JSON, and a `research:lint` step with deduplication hints (exact URL/externalId matches only, no fuzzy merges).
4. Move list filtering and pagination into SQL; add a `research:report` CLI that prints the score breakdown per idea.
5. Investigate only an authorized export path for scheduled ChatGPT research. No autonomous ingestion.
