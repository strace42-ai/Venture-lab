# Autonomous machine-research worker (VL-004A + VL-004B Phase A) — as implemented

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

   **Code cross-checks the skeptic as well** (it is a model output too):
   - a rival is accepted only when search actually surfaced it — same source, name and **market**, on a page fetched `ok`. An invented rival («RealtyCalendar» on the Focusmate page) or a re-marketed one is dropped with «отклонено: …» in the review and cannot create a competitor, move a cap, a score or the TOP-10;
   - `supported` must cite only sources that really contain the quote (`supporting_source_keys`);
   - `refuted` must cite a validated direct rival in the claimed market (absence claims) or a fetched page (other claims).

   A verdict that fails these checks becomes `needs_more_evidence` (fail-closed: no support, no refutation), and a critical dispute resting on it is downgraded to minor.

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
- **Spend ledger `mr_attempts`.** Every attempt reserves budget **under a per feed+month advisory lock**. It starts with a **chunk** = min(job budget left, month cap left, job budget ÷ max_attempts) and **tops up** chunk by chunk (`topUpAttempt`) under the same lock — only while it still owns the job with a live lease, and never beyond the job budget or the month cap. A top-up also renews the lease (heartbeat). So a normal run can use the whole job budget (e.g. 3000 with 3 attempts), while a stuck or superseded attempt is refused further budget and holds only what it already reserved. The `CallContext` can never spend beyond its reservation.
- **Committed spend.** Committed spend is the actual usage where it is recorded and **the full reservation** otherwise. A crashed or superseded attempt therefore never makes the ledger under-count. When an attempt finishes, its actual usage is settled even if another attempt took the job over, and only the owner may publish or change the job status.
- **Result.** Concurrent dates in one month cannot exceed the monthly cap together. Exhausting a budget gives an honest `partial`: no new TOP is published and all usage stays in the ledger.
- **One transaction.** All research rows and the snapshot are written in one transaction, so any failure keeps the previous TOP-10 published.
- **Schedule.** `Asia/Novokuznetsk`, 06:00 local time.

## Data integrity (`server/db/migrations/004_machine_research.sql`)
- **Composite feed keys.** Every event table carries `feed` and references `(job_id, feed)` and `(candidate_id, feed)`. Mixed-feed rows are refused by PostgreSQL itself.
- **Assessment date.** Assessments, sources and snapshots reference `(job_id, feed, as_of)`, so they cannot be backdated.
- **Snapshot entries** reference `(snapshot_id, job_id, feed)` and `(assessment_id, job_id, candidate_id, title, market_score, confidence, evidence_grade, state)`. A frozen entry is therefore an exact copy of an `AUTOMATED_EVIDENCE_PASSED` assessment from the same job and candidate.
- **Grade rule.** A passed assessment can never have grade D.
- **Migration 006 (VL-004B audit round 2).** `mr_competitors.market_status`:
  - historical rows are NULL, which reads as «not assessed», never verified (005 had defaulted them to `market_verified=true`);
  - `market_verified` lost its default;
  - new rows must state the status, and the two columns must agree. Both rules are enforced by `NOT VALID` checks, so history is not rewritten.
- **Migration 005 (VL-004B).**
  - Source provenance: canonical URL, fetch time, title, content type, failure, grounded offer, extraction model.
  - Quote locations.
  - Usage reconciliation, with a CHECK that the ledger never counts less than the worst case unless the provider reported the cost.
  - Job independence mode.
  - Carried-forward snapshot entries.
  - New fetch statuses: `robots_disallowed`, `unsafe_url`, `unsupported_content`, `too_large`, `timeout`.
- **Immutability.** Event tables are append-only. Jobs and attempts cannot be deleted, a job's identity is immutable, a reservation can only grow (top-up) and only while its attempt is running and unsettled, and recorded usage cannot be rewritten.

## Providers
`SearchProvider`, `SourceReader`, `LLMProvider` and `SkepticalReviewer` live in `server/machine/types.ts`. There are two implementations:
- **fixture** (`server/machine/providers/fixture.ts`, `server/machine/fixtures/world.ts`) — offline emulation, the `fixture` feed;
- **live** (`server/live/*`, VL-004B) — Yandex Search API, AI Studio (Qwen3.6 35B analyst/extraction, DeepSeek V4.1 Flash skeptic) and a secure page reader, the `live` feed. In Phase A they are exercised only on recorded HTTP; paid calls need Phase B authorisation (see `docs/live-provider-setup.md`).

### Live mode (VL-004B) — what code guarantees around the models
- **Search results are leads.** Discovery seeds must come from real discovery hits (`sourceUrl` ∈ hits). Before analysis the analyst gets an **evidence pack** of pages actually found and fetched, and every claim may cite only those URLs. A model-generated URL is **never fetched** and never counts.
- **Secure reader** (`server/live/net/`):
  - http(s) on 80/443 only;
  - every DNS answer must be public (no loopback, private, link-local/metadata, CGNAT, ULA, mapped forms…), and the connection is pinned to the validated address, so DNS rebinding cannot redirect it;
  - redirects are re-validated hop by hop, and https→http is refused;
  - robots.txt is honoured (5xx = disallow);
  - size cap after decompression, timeouts, HTML/text only (PDF → `unsupported_content`);
  - visible text only: scripts and hidden elements are dropped;
  - instruction-like content (also when hidden) → quarantine.
- **Offers are grounded by code** (`server/live/grounding.ts`). The extraction model proposes name, market, jobs-with-quotes and price; code keeps only what is literally on the page. Anything else is stored as «uncertain» and never used.
- **A rival's market must be established, not guessed** (audits P1, round 2). `marketEvidence()` returns one of three states:
  - **`verified`.**
    - A **strong RU signal** establishes «ru» whatever the page language: a ₽/руб/RUB price, a +7 phone, ИНН/ОГРН, or Russian payment rails (СБП, «Мир», ЮKassa). An English page of a Russian product is Russian.
    - A multi-currency page with ₽ is sold in Russia; the mix is recorded.
    - An RU domain alone also gives «ru», but only without western prices.
    - $/€/£ prices with no RU signal give «west».
  - **`conflicting`** — an RU domain with prices only in $/€/£.
  - **`unknown`** — no availability signal at all. Russian language alone is localisation, not sales.

  How the home page is used, and what a rival without a verified market means:
  - **Home page only fills a gap.** It is fetched automatically (free) only when the product page is `unknown`. The signals of both pages are pooled and re-judged, with conflicts kept. A `conflicting` or `verified` page is never overridden.
  - **A rival whose market is not verified** is stored with `mr_competitors.market_status` (`verified` · `declared` for fixture emulation · `conflicting` · `unknown`). It is a **possible competitor**, neither proof of competition nor proof of its absence:
    - it is not used for refutations, «≥2 direct / free» holds or Russia validation;
    - but while it exists the Russian dimensions are capped at 3 («competition unclear», never the 4 from an independent RU source);
    - and an «empty niche in Russia» claim cannot be supported.
  - These are page signals, not proof of legal registration or payment acceptance in Russia.
- **Registrable domain** (`siteOf`) uses the Public Suffix List (`tldts`, including private suffixes): `a.b.co.uk` → `b.co.uk`, `alice.github.io` ≠ `bob.github.io`.
- **«Independent» needs verifiable provenance** (`server/live/provenance.ts`, audit P1).
  - The model's «independent» is necessary but never sufficient. All of these are also required:
    - a site that does not belong to the product: not the seed source, not a site with a grounded offer this run, the brand not in the domain;
    - no product offer on the page;
    - publication markup (`og:type=article`, schema.org Article/Review/NewsArticle/BlogPosting, or `<article>`);
    - a named publisher or author that is not the product.
  - Otherwise the source type is UNKNOWN («тип не установлен») or a self-report, and it cannot raise the evidence grade or reliability.
  - The decision and its signals are stored in `mr_sources.provenance`.
- **Competitor kind is decided by code** from the jobs proven on the rival's page: direct = the idea's primary job. The skeptic's label is checked against it. A rival the skeptic omits is still counted, and a rival it invents is dropped. The Western analogue is never a rival.
- **Popularity ≠ payment.** A claim about paying users or revenue needs a quote about money; «10,000 companies use» does not verify it.
- **Independent second model.** The analyst and skeptic families must differ (Qwen vs DeepSeek). The same family is refused, or — only if explicitly allowed — every candidate is held as `single-model-degraded`.
- **Money.** Before every paid call the worker reserves a worst case: input bytes + framing + `max_tokens`, or the search tariff. After the response it reconciles from `usage` × tariff, the tariff or «not billed».
  - A timeout or missing usage keeps the worst case (`unknown`).
  - Usage above the bound is an anomaly and stops paid calls.
  - Retries happen only on 429/5xx, with backoff, jitter and Retry-After; there are no retries on 401/403. A circuit breaker opens after repeated failures.
  - Ledger: `mr_usage.estimated_cost / actual_cost / reconciliation / provider_request_id`.
- **Rotation.** At most `VL_LIVE_MAX_NEW` new candidates and `VL_LIVE_MAX_RECHECKS` incumbents (the least recently assessed) are researched per run. A recent PASSED assessment of an incumbent that was not rechecked is **carried forward** into the TOP with its own date. The DB requires that it is older than the snapshot, at most 30 days old, and an exact copy of that assessment.
- **Diagnostics** of the latest run, on the dashboard and the API:
  - searches by region;
  - pages read and failure reasons;
  - validated RU direct/adjacent rivals;
  - contradictions;
  - cost reserved → charged, unknown calls and anomalies;
  - average confidence;
  - partial or failure reason;
  - carried entries.
- The fixture world is an offline emulation.
- Pages under real URLs paraphrase what the VL-003P corpus observed on 2026-11-12. They are **regression scenarios**: guest guide → RealtyCalendar / RYNTO / GuestCom; VAG → VAGLOGS; quote comparison → ВНИКЛИ / Vortholm.
- Fictional items use example.* domains and names that start with «Пример:».
- Live providers are in `server/live/`; they are only ever run on recorded HTTP in tests (`server/live/recordings/`) until Phase B.

## Commands
```bash
npm run research:worker:run -- --fixture --as-of 2026-11-10   # also 2026-11-11, 2026-11-12
npm run research:worker:tick -- --fixture [--now 2026-11-12T00:30:00Z]
npm run research:worker:status -- --fixture
npm run research:worker:run -- --live --once --dry-run          # VL-004B: config + worst-case plan, no network
npm run research:benchmark                                       # VL-004B: offline guardrail benchmark (recorded HTTP)
# Phase B only (founder-authorised): npm run research:worker:run -- --live --once --execute --max-spend-rub N
```
API (read-only): `/api/machine/overview|runs|snapshots|snapshots/:asOf|candidates/:id?feed=fixture|live`. UI: `/machine` and `/machine/:id`.
