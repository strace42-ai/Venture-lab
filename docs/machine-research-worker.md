# Autonomous machine-research worker (VL-004A) — as implemented

The architecture source of truth is `docs/no-vpn-automation-architecture.md` v2.0. This page describes what the code does today.
**There is no human approval step anywhere in the machine pipeline.**

## Pipeline (`server/machine/pipeline.ts`)
1. **Discovery.** A discovery search plus an LLM pass finds new seeds. Every candidate already in the registry is **re-researched on every run**.
2. **Analyst** (LLM pass #1) proposes claims (each claim has an exact quote, source URLs and a rubric dimension), rubric values with the claim keys behind them, Founder Fit, and Russian-market queries.
3. **SourceReader** reads every cited page. The page text is untrusted. Pages that look like instruction injection are **quarantined**: their text is never stored or used. HTTP errors, blocks and rate limits are recorded.
4. **Competitor search.** The analyst's queries run first, then the **skeptic's independent counter-queries** (category synonyms, «аналог <western product>», «<product> review»). Every query is logged, including those with 0 hits.
5. **ClaimChecker** (deterministic code) checks that the quote occurs in the fetched text. It assigns a status:
   - `corroborated`: at least 2 sources, at least one of them independent;
   - `single_source`;
   - `vendor_claim`: only the company's own pages;
   - `unretrievable`;
   - `unknown`: the quote was not found.
6. **Skeptic** (LLM pass #2, a different model id) refutes «absence» claims when it finds direct rivals: the claim becomes `contradicted`. It also reports thin Russian search coverage.
7. **Scoring.** Only `src/domain/scoring.ts` computes scores.
   - Evidence dimensions (westernNeed, westernPay, ruWeakness, ruUnmetJob, monetization, distribution) count only when a supported claim backs them. Otherwise the value is **null (unknown)**.
   - The Russian dimensions are capped by the competition found: ≥2 direct rivals → 1; 1 direct → 2; adjacent only → 3; fewer than 3 RU queries → 2.
   - Execution judgements that cite no source are capped at 4.
   - Every adjustment is written to `dimension_notes`.
8. **Quality gate** (code). A candidate is put in `RESEARCH_HOLD` when any of these holds:
   - no retrievable Western source supports demand;
   - fewer than 3 distinct Russian queries were run;
   - a high-impact absence claim is refuted by ≥2 direct rivals or by a free rival;
   - the evidence grade is D.

   A candidate whose research was cut short by a rate limit stays `DISCOVERED`. Every other candidate becomes `AUTOMATED_EVIDENCE_PASSED`, shown as «Проверено системой».
9. **Automatic TOP-10** contains passed candidates only, ordered by score → confidence → first-payment feasibility → id. It is **N/10 and never padded**.

## Worker (`server/machine/worker.ts`)
- **Idempotency and leases.** Each job key is `daily:<feed>:<as_of>`. Ownership uses a lease: a duplicate attempt gets «already-running», and a crashed attempt is taken over after its lease expires. Attempts are bounded (`max_attempts`).
- **One transaction.** All research rows and the snapshot are written in a single transaction. Any failure leaves the previous TOP-10 published.
- **Spend caps.** Each job has a hard budget that covers all its attempts; a monthly cap applies too. Exceeding either sets the job to `partial`, publishes nothing, and keeps usage telemetry with its price version.
- **Schedule.** `Asia/Novokuznetsk`, 06:00 local time (`server/machine/schedule.ts`, `research:worker:tick`). Production timers come in VL-004C.

## Data (`server/db/migrations/004_machine_research.sql`)
The machine dataset is separate and typed:
- `mr_jobs`, `mr_candidates`, `mr_sources`, `mr_claims`, `mr_searches`, `mr_competitors`, `mr_reviews`, `mr_assessments`, `mr_snapshots`, `mr_snapshot_entries`, `mr_usage`;
- every table except `mr_jobs` is append-only (DB triggers);
- `feed` is `fixture` or `live`;
- legacy `ideas`, `evidence` and `top10_*` are never read or written.

## Providers
`SearchProvider`, `SourceReader`, `LLMProvider` and `SkepticalReviewer` live in `server/machine/types.ts`. This sprint has only the fixture implementations (`server/machine/providers/fixture.ts`, `server/machine/fixtures/world.ts`).
- The fixture world is an offline emulation.
- Pages under real URLs paraphrase what the VL-003P corpus observed on 2026-11-12. They are **regression scenarios**: guest guide → RealtyCalendar / RYNTO / GuestCom; VAG → VAGLOGS; quote comparison → ВНИКЛИ / Vortholm.
- Fictional items use example.* domains and names that start with «Пример:».
- Live providers (Yandex Search API / AI Studio) are VL-004B. `--feed live` without providers is refused.

## Commands
```bash
npm run research:worker:run -- --fixture --as-of 2026-11-10   # also 2026-11-11, 2026-11-12
npm run research:worker:tick -- --fixture [--now 2026-11-12T00:30:00Z]
npm run research:worker:status -- --fixture
```
API (read-only): `/api/machine/overview|runs|snapshots|snapshots/:asOf|candidates/:id?feed=fixture|live`. UI: `/machine` and `/machine/:id`.
