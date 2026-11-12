# Venture Lab — автономный Research Worker без VPN (архитектура v1.0)
Date: 2026-11-12
Status: DESIGN / not deployed / no external credentials provisioned
Owner: Founder + ChatGPT
Prerequisite: complete the current VL-003P pilot. This document is **not** authorization for purchases, provider registrations, deployments, public endpoints or changing `tasks/current-task.md`.

## Product outcome
The founder opens Venture Lab from Russia over ordinary HTTPS without enabling a VPN. A **server-side** worker searches **Western and Russian** product markets, records claim-level source evidence, de-duplicates competitors/ideas, proposes draft scores and an updated **provisional** TOP-10 each day. Results appear in the dashboard once the daily research run has completed. Founder-review remains the gate to **verified/approved REAL history** and to any announcement that claims are checked.

This is NOT a promise that scheduled ChatGPT conversations directly write to Venture Lab. ChatGPT Plus / Claude Pro do not include external API quotas and aren't the runtime of the worker.

## Validated provider options (official documentation checked 2026-11-12)
### Search
- Yandex Search API: web search can target worldwide / Russian search indexes, REST and SDK. Documentation: https://aistudio.yandex.ru/ru/docs/search-api/concepts/ and https://aistudio.yandex.ru/ru/docs/search-api/operations/web-search-sync
- Prices as of 2026-11-12, RUB incl. VAT: nighttime deferred search 25.41 ₽/1,000 requests; nighttime synchronous 366 ₽/1,000; daytime synchronous 488 ₽/1,000. Verify current rates before activating: https://aistudio.yandex.ru/ru/docs/search-api/pricing
- Async search may take minutes/hours and is subject to permitted Moscow time windows. Do NOT promise a report exactly at 08:00 unless completed; show last successful run/freshness and retry. Use synchronous fallback within budget if needed.
- Worldwide index does not guarantee fetchable complete primary pages. Unreachable pages remain **unverified**, not fabricated.

### Model
- Yandex AI Studio via OpenAI-compatible APIs supports as of 2026-11-12: DeepSeek V4.1 Flash, Qwen3.6 35B, YandexGPT 5.1 and others. Exact available models/deprecations: https://aistudio.yandex.ru/ru/docs/ai-studio/concepts/generation/models
- Official token rates as of 2026-11-12 (RUB incl. VAT / 1,000 tokens): DeepSeek V4.1 Flash 0.3 in/0.5 out; Qwen3.6 35B 0.2 in/0.3 out; YandexGPT Pro 5.1 0.8 in/0.8 out. Recheck: https://aistudio.yandex.ru/ru/docs/ai-studio/pricing
- Never choose deprecated model IDs by default; pin provider/model version and support fallback with model-provenance records.
- A model must work on **retrieved source material**. Model opinion is not evidence; source links and corroboration are required.

### Host / browser
- Deploy web app, worker and DB on a legally accessible server/hosting with normal HTTPS reachability from Russia; preferably Russian hosting for first release, subject to backup and legal/privacy review. NO VPN needed on the founder's device for dashboard viewing.
- DB is NOT internet exposed; API restricted behind TLS, authenticated admin; no direct unauthenticated research approvals or arbitrary URL-fetch endpoints.
- The ability of our server to reach individual non-Russian websites must be tested; if unavailable, record coverage gap. Do not claim all web pages are accessible without VPN.
- Official OpenAI API service does not list Russia in supported countries as of check; do not require it or plan evasive access. Official source: https://developers.openai.com/api/docs/supported-countries

## Automated daily pipeline (Asia/Novokuznetsk UTC+7)
00. Maintain a live **Idea Registry** with stable IDs, prior findings and competitors.
01. Scheduler before morning (e.g. 05:00 local) creates `research_job` with time budget, provider budget and idempotent run key, based on a 00:00–06:00 Moscow window for deferred search where appropriate.
02. Discover new Western products (official vendor sites, authorized feeds / permitted discovery APIs, English and other languages); use rotating sector buckets and novelty dedup.
03. Find RU competition with Russian Search plus Russian brand/feature queries and adjacent substitutes. Record exact query, timestamp, search type, top results and *coverage limitations*. "Nothing found" ≠ "doesn't exist".
04. Retrieve permitted primary sources, claim statements and supporting exact passages with source metadata. Follow robots/terms; respect rate limits; block internal addresses/SSRF/private-network fetches, oversized pages, sensitive content. Website content is untrusted; prompt-injection isolation.
05. Analyze at least two passes: cheap candidate extraction/classification (Qwen), deeper Russian competitive comparison and hypothesis challenges (DeepSeek). A distinct checker checks claim-source matches where access exists; the checker is still AI, not a human.
06. Distinguish `confirmed_in_source` (source page has the claim), `unverified`, `conflicted`, `human_checked` (manual action only). Company self-report != independent evidence.
07. Deduplicate by stable idea ID and competitor product URLs; avoid duplicate scoring; compare to stored incumbents; record score rationales under unchanged 12-criterion rubric and separate confidence metrics, founder-fit, risk and missing evidence. Proposal does not automatically become a human-approved score.
08. Store **candidate** research and model-generated draft assessments in separate staging tables with complete provider/source/queries/timestamps/cost provenance. DO NOT fake `human-reviewed`, `checked`, or import AI draft via bypass into REAL. Existing VL-003 approval gate remains authoritative.
09. Generate two distinctly labeled leaderboards:
    - **PROVISIONAL TOP-10**: automatically calculated, source-linked, AI-draft and visibly "требует проверки"; can refresh daily and include new candidates.
    - **APPROVED TOP-10**: existing frozen/approved REAL snapshot and rank, unchanged until founder explicitly approves/imports. If <10, show honest N/10.
   Historical snapshots of provisional rankings separate from approved and must never overwrite immutable REAL snapshots.
10. Publish dashboard run summary and optional Telegram digest via a permitted bot integration (only after founder authorizes token and delivery). Include fresh run date, status, new discoveries, deltas, 10 provisional ideas when enough, review queue, costs and failures.
11. Founder opens source queue and approves specific claims/assessments or rejects candidates; API/CLI must maintain human audit log. A single "Approve all" that falsely marks every source human checked is NOT acceptable.
12. Recover gracefully: stale-run banner, retries with budget caps, rerun idempotently, dead-letter queue, cancel/skip reprocessing.

## Model/provider design (swappable)
`SearchProvider.search(query, region, locale, filters): SearchResult[]`
`SourceReader.read(url): {retrievedAt, content, status, sourceType, error?}`
`LLMProvider.structured<T>(task, sources, schema, budget): T`
`EvidenceVerifier.check(claim, source): VerificationFinding`
`ReviewQueue.enqueue(draft)`
`Publisher.publishProvisional(run)`
Each adapter can run in fixture mode. Do not tie production execution to a ChatGPT conversation, web widget, or Claude Code subscription.

## Proposed server modules (not mandatory names)
- `server/worker/scheduler` — cron / queue and idempotent daily run record
- `server/worker/discover` — feeds, search queries, world markets
- `server/worker/ru-competition` — competition coverage matrix
- `server/worker/evidence` — source extraction and provenance
- `server/worker/score` — rubric and challenge pass
- `server/worker/publish` — provisional read model and digest
- `server/worker/providers/{search,llm,web}` — provider adapters with fixtures
- `server/worker/metrics` — latency, requests/tokens/costs, alerts
- `server/worker/security` — allowlisted hosts where useful, SSRF/robots/PII
Use existing Fastify, Zod, PostgreSQL, shared scoring domain and existing UI styling. Prefer a queue/storage native to Postgres for first single-node server instead of adding Redis infrastructure without evidence.

## Operating costs (illustrative arithmetic only; no actual spend yet)
A fixed illustrative workload **100 search requests/day** = 3,000/month:
- nighttime deferred: 3,000/1,000 × 25.41 ≈ **76.23 ₽/month** (if all queries eligible and succeed at that rate);
- nighttime synchronous: 3,000/1,000 × 366 ≈ **1,098 ₽/month**.
A workload **100k input + 25k output DeepSeek V4.1 Flash tokens/day**:
- per day 100×0.3 + 25×0.5 = **42.5 ₽**, or **1,275 ₽ per 30 days**.
**Not included:** VPS, domains, paid feed providers, downloads/processing, retries, other tools, storage, and vendor price changes. These aren't forecasts of necessary volume.
Implement configurable per-day and per-month **hard caps** per provider and per job; start in dry-run, do not silently spend. Show estimated vs actual costs in cockpit. Activation requires founder's explicit permission and account/API key.

## Delivery stages
**VL-004A / dry-run engineering** (after VL-003P):
- Implement worker's interfaces, scheduler, research-run/staging DB migration, deterministic fixture providers, provenance, dedup, provisional leaderboard and safe review UI/API. No API keys or paid services, no public hosting.
- Demonstrate autonomous mock-run on local DB after restart; intact approved REAL dataset; smoke tests and CI.
**VL-004B / single paid source trial with approval**:
- Founder separately creates Yandex Cloud account and keys (never share keys in chat/repo). Validate RU+world search and model endpoints from actual host, verify 5–10 source pages. Cost cap 300–500 ₽ for testing, or founder-approved amount. Measure quality and spend.
- Schedule 3 consecutive daily test runs; compare outcome against manually researched baseline; no automatic approval.
**VL-004C / hosted operating release**:
- Authenticated site on HTTPS accessible from Russia without VPN, isolated Postgres, encrypted secrets, backups, monitoring, retry and Telegram opt-in delivery. First run/health check and threat model before opening access.
**VL-004D / quality and growth**:
- More discovery sources within terms, verification passes, coverage-score calibration, cost/quality analytics, bounded automatic candidate research. Potential future migration to other lawful supported providers.

## Acceptance tests
- 3 simulated "days" deliver different daily drafts with persistent history, prevent duplicate runs, include source metadata and RU competitor proof.
- New direct Russian competitor reduces/flags provisional RU gap estimate with change explanation; do not keep the old claim "no competitors".
- Poisoned/prompt-injected vendor webpage cannot cause instructions to execute or cross into API keys / admin approval.
- AI cannot sign human approval or set human_checked; attempts rejected in DB and API.
- Staging does not leak into approved REAL score/Top10 or overwrite current assessments.
- A run with missing search access or source fetch reports partial coverage and no invented references.
- Budget cap prevents further search/LLM calls; failures retried with bounded backoff, no double spend on duplicates.
- Correct local timezone and scheduling; when late, mark stale/in-progress honestly.
- App works from normal browser, API not exposed without auth, no public database port.
- Provider can be replaced via adapter, all outputs Zod validated.
- CI green with deterministic fixtures. Real external API smoke only via explicit approval; no secret leaks.

## Critical honesty
- Scheduled ChatGPT reports are NOT ingested automatically unless separately supported by an authorized integration. Existing daily chat automation may continue as an independent editorial cross-check. Do not advertise ChatGPT as model of the autonomous worker when worker actually uses DeepSeek/Qwen/YandexGPT.
- "No VPN for dashboard" is a user-side access promise that requires real connectivity tests on chosen host/network and locale. This says nothing about availability of every target foreign website.
- Never auto-publish commercial claims as independently verified; separate provisional research from official founder-approved data.
