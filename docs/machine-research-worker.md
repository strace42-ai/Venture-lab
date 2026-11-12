# Autonomous machine-research worker (VL-004A) — as implemented

The architecture source of truth is `docs/no-vpn-automation-architecture.md` v2.0. This page describes what the code does today.
**There is no human approval step anywhere in the machine pipeline.**

## Pipeline (`server/machine/pipeline.ts`)
1. **Discovery.** A discovery search plus an LLM pass finds new seeds. Seeds are validated with Zod. Every candidate already in the registry is **re-researched on every run**.
2. **Analyst** (LLM pass #1) proposes claims (each claim has an exact quote, source URLs and a rubric dimension), rubric values with the claim keys behind them, Founder Fit, and Russian-market queries. The output is **validated at runtime with Zod** (`server/machine/schemas.ts`): bad ranges, dangling claim references or missing fields mean the candidate is not scored (`DISCOVERED`).
3. **SourceReader** reads every cited page. The page text is untrusted. Pages that look like instruction injection are quarantined; HTTP errors, blocks and rate limits are recorded.
4. **Competitor search.** The analyst's queries run first, then the skeptic's **independent counter-queries**. Every query is logged, including those with 0 hits. Search returns *raw* rivals only; classifying them is the skeptic's job.
5. **ClaimChecker** (code). The quote must be specific: at least 12 characters, at least 2 words, not page boilerplate («Start now», «Подробнее»…). An empty or boilerplate quote never matches. The code records exactly which fetched sources contain the quote (`supporting_source_keys`) and assigns `corroborated` / `single_source` / `vendor_claim` / `unretrievable` / `unknown`.
6. **Skeptic** (LLM pass #2, a different model) is a separate interface: `SkepticalReviewer.challenge(input) → SkepticFindings`. The input is the seed, the analyst's proposal, the checked claims, the source excerpts and the raw rivals. The output is validated with Zod; any reference to a source or claim that does not exist rejects the whole output. It contains:
   - a verdict per claim (`supported` / `refuted` / `needs_more_evidence`) with source ids and a reason;
   - a classification of every rival (direct / adjacent / substitute) with a reason;
   - the unresolved disputes (`critical` / `minor`).

   The fixture skeptic emulates the semantic review through the fixture pages' `relevantTo` annotation: a literal quote taken from an unrelated page does not support the claim. «Absence» claims ("nobody in Russia does X") are `needs_more_evidence` unless an independent source supports them; zero search hits prove nothing.
7. **Scoring.** Only `src/domain/scoring.ts` computes scores.
   - A claim counts only when **both** the code check and the skeptic support it (`claimSupports`).
   - Evidence dimensions without such a claim are **null (unknown)**.
   - A Russian dimension whose only basis is refuted becomes **0**: a rival doing the job is evidence that the criterion fails.
   - Caps from the competition found: fewer than 3 RU queries → 2; ≥2 direct rivals → 1; 1 direct → 2; adjacent only → 3. **When no rivals are found the cap is 3**, or 4 when an independent Russian source supports an RU claim — **never 5**.
   - Execution judgements that cite no source are capped at 4.
8. **Evidence grade** comes only from the sources that support claims used in non-null scores:
   - A: ≥2 corroborated claims and independent backing;
   - B: independent backing;
   - C: vendor-only;
   - D: no supported Western demand;
   - an unresolved high-impact `needs_more_evidence` lowers the grade by one.

   An unrelated page that was fetched does not count.
9. **Quality gate.** `RESEARCH_HOLD` when any of these holds:
   - no supported Western demand claim;
   - fewer than 3 RU queries;
   - an absence claim refuted by ≥2 direct rivals or by a free rival;
   - a **critical skeptic dispute**;
   - grade D.

   A rate-limited run gives `DISCOVERED`. Every other candidate becomes `AUTOMATED_EVIDENCE_PASSED`, shown as «Проверено системой».
10. **Automatic TOP-10** contains passed candidates only. It is **N/10 and never padded**.

## Worker and hard spend caps (`server/machine/worker.ts`)
- **Idempotency and ownership.** Each job key is `daily:<feed>:<as_of>`, with a lease. A duplicate attempt gets «already-running»; an expired lease can be taken over; attempts are bounded.
- **Spend ledger `mr_attempts`.** Every attempt reserves budget **under a per feed+month advisory lock**. The reservation is min(job budget left, month cap left, job budget ÷ max_attempts). The `CallContext` can never spend beyond the reservation, so the cap holds even for an attempt that outlives its lease.
- **Committed spend.** Committed spend is the actual usage where it is recorded and **the full reservation** otherwise. A crashed or superseded attempt therefore never makes the ledger under-count. When an attempt finishes, its actual usage is settled even if another attempt took the job over, and only the owner may publish or change the job status.
- **Result.** Concurrent dates in one month cannot exceed the monthly cap together. Exhausting a budget gives an honest `partial`: no new TOP is published and all usage stays in the ledger.
- **One transaction.** All research rows and the snapshot are written in one transaction, so any failure keeps the previous TOP-10 published.
- **Schedule.** `Asia/Novokuznetsk`, 06:00 local time.

## Data integrity (`server/db/migrations/004_machine_research.sql`)
- **Composite feed keys.** Every event table carries `feed` and references `(job_id, feed)` and `(candidate_id, feed)`. Mixed-feed rows are refused by PostgreSQL itself.
- **Assessment date.** Assessments, sources and snapshots reference `(job_id, feed, as_of)`, so they cannot be backdated.
- **Snapshot entries** reference `(snapshot_id, job_id, feed)` and `(assessment_id, job_id, candidate_id, title, market_score, confidence, evidence_grade, state)`. A frozen entry is therefore an exact copy of an `AUTOMATED_EVIDENCE_PASSED` assessment from the same job and candidate.
- **Grade rule.** A passed assessment can never have grade D.
- **Immutability.** Event tables are append-only. Jobs and attempts cannot be deleted, a job's identity is immutable, a reservation is immutable, and recorded usage cannot be rewritten.

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
