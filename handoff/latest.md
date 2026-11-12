# Venture Lab — Latest handoff

**Task:** VL-004A / Zero-human Autonomous Research Worker (fixture-first) — `tasks/current-task.md`, architecture `docs/no-vpn-automation-architecture.md` v2.0
**Status:** IMPLEMENTED + REVIEW ROUND 1 FIXES (ChatGPT, PR #5 review 5875231122). Awaiting re-audit. **Not merged.**
**As of:** 2026-11-12 · **Implementer:** Claude Code

## Git
| | |
|---|---|
| Base | `main` @ `56ef07b` (VL-003P merged, VL-004A activated) |
| Branch | `claude/vl-004a-autonomous-research-worker` |
| PR | see the PR list (opened to `main`, not merged) |

## Review round 1 — fixes (audit of `f1abce4`)
| # | Finding | Root cause | Fix | Regression tests (`server/test/machine-review.test.ts`, 21) |
|---|---|---|---|---|
| **P1** | The monthly budget was not a hard cap. Spend from a lease takeover could be lost. | `acquire` only checked `month ≥ cap` and then handed the attempt the whole job budget. Different dates were not serialised. A superseded attempt's usage was written but `mr_jobs.spent` did not include it. | New **spend ledger `mr_attempts`**. Each attempt **reserves** min(job left, month left, job budget ÷ max_attempts) under a per feed+month advisory lock, and the `CallContext` cannot spend more than that reservation. Committed spend is actual usage, or the full reservation until the actual is known. An attempt's usage is always settled, even after it lost ownership; only the owner publishes or changes job status. Reservations and recorded usage are immutable (DB triggers). `monthly_cap` is stored per job and shown in the UI. | (a) 39 950 of 40 000 already spent → the run reserves 50, ends «partial», the month total stays ≤ 40 000, nothing is published; (b) two dates in one month run in parallel → total ≤ cap, at most one succeeds; (c) A blocked mid-run, its lease expires, B takes over and publishes, then A returns: ledger `superseded`+`succeeded`, both usages counted, `job.spent` = A + B, exactly one snapshot; recorded usage and reservations cannot be rewritten or deleted. |
| **P1** | The «skeptic» only generated extra search queries | `SkepticalReviewer` had just `counterQueries`; all judgements were made by pipeline code | New `SkepticalReviewer.challenge(input) → SkepticFindings`. Input: seed, analyst proposal, checked claims, source excerpts, raw rivals. Output: a verdict per claim (supported / refuted / needs_more_evidence, with source ids and reason), a classification of every rival with a reason, and critical/minor disputes. It is Zod-validated, and references to missing claims or sources are rejected. Its output drives scoring and the gate: a critical dispute means hold, and a claim counts only if both the code and the skeptic support it. The skeptic has its own model id and usage, and its verdicts are stored in `mr_claims.skeptic_verdict/reason` and `mr_competitors.classification_reason`. The fixture skeptic emulates semantic review via the fixture pages' `relevantTo` annotation; VL-004B plugs a real model in behind the same interface. | A refutation that is a content judgement, not a job-tag match («a price list is not proof of paying users») → contradicted, critical dispute, hold; a missing verdict means the claim is not counted; invalid skeptic schema or dangling references → never scored; skeptic usage is metered. |
| **P1** | Quote verification gave false positives, and the evidence grade was inflated | `includes('')` is always true; there was no runtime validation of model output; the grade looked at any fetched independent page; 0 rivals plus 3 queries gave 5/5 | `quoteProblem`: at least 12 characters, at least 2 words, no boilerplate. Analyst and discovery output are validated with Zod (`server/machine/schemas.ts`). Each claim stores `supporting_source_keys`. The **grade is computed only from sources that support scored claims**, and an unresolved high-impact `needs_more_evidence` lowers it. **Zero rivals found gives a cap of 3**, or 4 with an independent Russian source, never 5. An «absence» claim without independent support is `needs_more_evidence`. A refuted RU basis gives 0, never a new score. | Empty and boilerplate quotes; a true quote from an unrelated page; an unrelated independent page leaves the grade at C; three zero-hit RU searches give 3 (4 with an independent RU source); an absence claim with no rivals is not supported; invalid analyst output (missing field, ghost claim reference, out-of-range value) is rejected; vendor-only support stays C. |
| **P2** | Feed and provenance integrity in the DB | Single-column FKs; snapshot entries were not tied to the snapshot's job or to the assessment's values | Every event table has `feed` plus composite FKs `(job_id, feed)` and `(candidate_id, feed)`. Assessments, sources and snapshots reference `(job_id, feed, as_of)`, so no backdating. Entries reference `(snapshot_id, job_id, feed)` and `(assessment_id, job_id, candidate_id, title, market_score, confidence, evidence_grade, state)`, so an entry can only be an exact copy of a passed assessment from the same job. A passed assessment cannot have grade D. Job identity is immutable and jobs cannot be deleted. Migration 004 was edited in place because it is not yet on `main`. | Direct SQL: a cross-feed review, claim or usage row is refused; a held idea or another candidate's assessment in the TOP is refused; an inflated frozen score is refused while an exact copy is accepted; another job's entry is refused; a backdated assessment is refused; changing a job's feed or date and deleting jobs are refused; passed + grade D is refused. |

Non-blocking items addressed:
- the overview shows the configured monthly cap;
- in the fixture feed, the analyst and skeptic passes are labelled «— эмуляция» and each claim shows the skeptic verdict;
- the docs no longer imply that a mocked model verified real sources.

Effect on the fixture scenario (stricter evidence lowers some scores; the regressions still hold):
- **Day 1** TOP: invoice 64 / focus 63 / appliance 53.
- **Day 2:** contract 69 / invoice 64 / focus **56** (a new direct RU rival refutes both RU claims → 0) / appliance withdrawn (404).
- **Day 3:** appliance is requalified; 4/10.
- Guest guide, VAG and quote compare remain on hold for the reasons found by the skeptic.

Checks: `lint` ✔ · `typecheck` ✔ · `build` ✔ · `CI=true npm test` ✔ **15 files, 218 tests** · fresh-database CLI smoke (3 days, idempotent re-run, live refusal) ✔ · responsive QA on 8 routes × 5 widths ✔ (no overflow or errors) · screenshots refreshed in `docs/screenshots/vl-004a/` (new: `skeptic-verdicts-focus-1440.png`).

## What was built (end-to-end: worker → PostgreSQL → automatic TOP-10 → read API → premium UI)
- **Migration `004_machine_research.sql`** adds a separate, typed machine dataset, with every table except `mr_jobs` append-only:
  - `mr_jobs`: idempotent key, lease, attempts, hard budget, partial/failed state;
  - `mr_candidates`: registry plus the discovery seed;
  - `mr_sources`: fetch status, hash, excerpt (quarantined pages have no text);
  - `mr_claims`: verification status with reason;
  - `mr_searches`: coverage, including queries with 0 hits;
  - `mr_competitors`: who found each one, analyst or skeptic;
  - `mr_reviews`: analyst / claim_checker / skeptic / quality_gate;
  - `mr_assessments`: 12 typed score columns, confidence components, Founder Fit, grade, state, hold reasons;
  - `mr_snapshots` + `mr_snapshot_entries`: frozen machine TOP-10 with previous rank and score delta;
  - `mr_usage`: provider, operation, model, request id, tokens, cost, price version.

  Legacy tables are not touched. Each row belongs to one feed, `fixture` or `live`.
- **Provider interfaces** (`server/machine/types.ts`): `SearchProvider`, `SourceReader`, `LLMProvider`, `SkepticalReviewer`, plus a deterministic `ClaimChecker` and `QualityGate` in code. Only **fixture implementations** exist in this sprint; there is no network access and nothing is billed.
- **Pipeline** (`server/machine/pipeline.ts`): discovery, then analyst, then source reads (prompt-injection quarantine, HTTP and access errors, rate limits), then RU/West competitor search with **independent skeptic counter-queries**, then exact quote ↔ source checks, then the contradiction hunt, then competition-aware re-scoring (unsupported evidence dimensions = unknown; RU dimensions capped by the rivals found), then the quality gate, then rubric v1.0 scoring through `src/domain/scoring.ts` (no copy of the rules). Incumbents are re-researched on every run. Details: `docs/machine-research-worker.md`.
- **Worker** (`server/machine/worker.ts`):
  - job lease and advisory lock, so a duplicate concurrent attempt gets «already-running»;
  - an expired lease is taken over; attempts are bounded, then the job is «exhausted»;
  - all rows and the snapshot are written in **one transaction**, so a failure leaves the previous TOP-10 published;
  - hard per-job budget across all attempts plus a monthly cap; exceeding either gives `partial`, nothing is published, usage is kept;
  - scheduler in Asia/Novokuznetsk at 06:00 local (`research:worker:tick`).
- **CLI:** `npm run research:worker:run -- --fixture --as-of YYYY-MM-DD`, `research:worker:tick`, `research:worker:status`. Without `--fixture` (live) the CLI refuses: that is VL-004B.
- **Read API** (GET only, validated): `/api/machine/overview`, `/runs`, `/snapshots`, `/snapshots/:asOf`, `/candidates/:id`, each with `?feed=fixture|live`.
- **UI:**
  - `/machine` «Автоматический TOP-10» is the first nav item and the first mobile tab. It shows a run-status strip (last success, latest run or failure, stale indicator, costs, schedule), the TOP-10 as a table on desktop and cards on mobile (N/10 note, movement, evidence grade, «Проверено системой»), new today, a change feed (entered/exited/up/down, state changes, new competitors), the watchlist with automatic hold reasons, and the runs list.
  - `/machine/:id` is the machine dossier: hold notice, claims with verification status, competitors (flagged when the skeptic found them), sources with fetch status, the 12-dimension breakdown with adjustment notes, machine reviews, search coverage and the immutable assessment history. It carries a «Человек не проверял» badge.
  - The DEMO/REAL/TEST mode banner is hidden on machine routes; a feed banner (fixture emulation vs live) replaces it.

## VL-003P mistakes as regression scenarios (fixture world, `server/machine/fixtures/world.ts`)
| Scenario | What the machine must do | Result |
|---|---|---|
| Guest guide (analyst cites only a Sostav overview) | Skeptic queries «гостевой портал…», «инструкция по заселению бот…», «автосообщения гостям pms…», «аналог Touch Stay» | Finds **RealtyCalendar «Автопилот», RYNTO, GuestCom** (direct, RU) → `ru-gap` contradicted → ruWeakness/ruUnmetJob 5→1 → **RESEARCH_HOLD** |
| VAG Report («no western automation») | Skeptic queries «VCDS log analyzer online» | Finds **VAGLOGS** (free, direct) → claim contradicted → defensibility 1 → HOLD; drive2 403 is recorded as unretrievable |
| Quote compare (day 3) | Skeptic category synonyms | **ВНИКЛИ, Vortholm** → HOLD |

Three fixture days:
- **Day 1:** TOP 3/10.
- **Day 2:** a new direct RU rival («Пример: ФокусПара») drops focus coworking from 68 to 64 and from #2 to #3; the appliance assistant's key source returns 404, so it is held and exits the TOP; a new idea enters.
- **Day 3:** automatic re-research finds a new independent source and the appliance assistant is **requalified**; TOP 4/10.

Also covered: prompt injection is quarantined and cannot inflate the score; vendor pages produce `vendor_claim`.
Fixture items with real URLs paraphrase the VL-003P corpus. Fictional items use example.* domains and names that start with «Пример:». The fixture world is labelled an emulation everywhere.

## Checks actually run (local PostgreSQL 16, Node 22)
| Check | Result |
|---|---|
| `npm run lint` | ✔ 0 problems |
| `npm run typecheck` / `npm run build` | ✔ / ✔ |
| `CI=true TEST_DATABASE_URL=… npm test` | ✔ (round 1) **15 files, 218 tests** (`machine.test.ts` 23, `machine-review.test.ts` 21, `src/test/machine.test.tsx` 8; all VL-001–VL-003 regressions pass) |
| CLI three days + idempotent re-run + status (dev DB) | ✔ 3/10 → 3/10 → 4/10; re-run «already-succeeded» |
| Responsive QA, Playwright at 390/768/1024/1280/1440 on 10 routes (machine top, live empty, 4 dossiers, legacy demo/test pages) | ✔ no horizontal overflow, no console or page errors |
| CI | a new «VL-004A autonomous worker» smoke step in `.github/workflows/ci.yml`; result in the PR |

Integration tests cover:
- the three days and the three regressions;
- the injection quarantine and access errors;
- vendor self-reports;
- two independent passes plus code checks;
- no «human» labels;
- immutable day-1 snapshot, with UPDATE/DELETE forbidden on machine tables;
- idempotency;
- isolation (legacy tables untouched, `feed=live` empty, legacy API unchanged);
- API validation and 404s;
- concurrent duplicate attempts producing exactly one snapshot;
- failure → retry, and rollback mid-persist;
- takeover of an expired lease, and the bounded «exhausted» state;
- a live lease blocking a second worker;
- the job budget («partial», no publication, no retry overspend) and the monthly cap;
- rate limits leaving candidates as DISCOVERED and unranked;
- live without providers being refused;
- the timezone schedule and stale detection.

Screenshots: `docs/screenshots/vl-004a/` (TOP-10 at 1440 and 390, guest-guide regression at 1440 and 390, VAG regression, requalified appliance, injection quarantine, live feed empty).

## Known limitations / risks
- Fixture «LLM» passes are deterministic emulations. Competitor matching relies on structured `offer.jobs` tags; in live mode an extraction model will produce these and can make mistakes. The gate thresholds (3 RU queries, ≥2 direct or free rivals) are policy v1 and need calibration on live data (VL-004D).
- The registry re-researches every candidate on every run. That suits fixtures; live mode needs rotation and budgets per candidate.
- The cost units are emulated (`fixture-prices-2026-11`). Real provider prices and connectivity from a Russian server are still unverified (VL-004B).
- No production scheduler, hosting or HTTPS (VL-004C). The API remains local-only, read-only, GET.
- The `/` overview still shows the legacy DEMO/REAL/TEST ranking. The machine TOP-10 is the first nav item; making it the landing page after live launch is a product decision.
- Docker was not used (no daemon); a native PostgreSQL 16 was used instead. Testing on real devices was not done; responsive checks used Playwright emulation.

## Next
ChatGPT independent audit of this PR. Then VL-004B: a bounded paid trial of real providers after the founder sets credentials and a spend cap.
