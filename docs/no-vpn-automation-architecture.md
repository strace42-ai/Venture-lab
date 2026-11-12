# Venture Lab — полностью автономный Research Worker без VPN (архитектура v2.0)
Date: 2026-11-12
Status: DESIGN, NOT IMPLEMENTED, NOT DEPLOYED
Owner: Founder + ChatGPT
Decision: Founder explicitly requested **zero-human-in-the-research-loop**. This supersedes the human-approval REQUIREMENT for the future autonomous worker in v1.0. Preserve compatibility with historical human-approved data, but do not require human review to publish the automatic evidence-ranked TOP-10.
Current engineering task `tasks/current-task.md` is VL-003P and was not modified while Claude may be working on it. The next development task will explicitly implement this architecture.

## Non-negotiable product outcome
Venture Lab researches foreign and Russian digital-product markets independently on a schedule from a server accessible in Russia **without VPN on the user's device**. It collects source evidence, checks claims using programmatic extraction and independent AI critique, rates opportunities against the same 12-factor 100-point rubric, keeps date-stamped history, and **publishes a primary machine-researched TOP-10 automatically**. No human approval, clicking each source, copying chat replies, operating the importer, or approving research jobs is required. When fewer than 10 candidates pass quality gates, show N/10; never fill ten by invention.

Only **initial product administration** remains a founder action: providing lawful cloud/API credentials, enabling spending up to an explicit ceiling, choosing domain/hosting, authorizing deployment, and high-impact external actions. Those are one-time system setup/security authorizations, not daily research review. Do not automatically buy APIs, send sales messages, deploy unsafe code, or open public write endpoints.

### Three independent states, not false labels
1. `DISCOVERED`: candidate exists; sources may be sparse. Stored in candidate registry; **not yet ranked**.
2. `AUTOMATED_EVIDENCE_PASSED`: machine checks passed according to recorded policy/version; eligible for the automatic official research TOP-10. Display **"Проверено системой"**, never "Проверено человеком", with evidence grade and last observed date. This does not certify absolute truth.
3. `RESEARCH_HOLD`: insufficient / contradicted / inaccessible evidence or critical safety/legal/network constraint; excluded from recommended TOP-10, can be revisited automatically on later days.

Existing VL-003 `human-reviewed` records remain preserved as **legacy human-review history**. Do NOT forge `approvedBy`, `checked`, or `human-reviewed` to bypass the import gate. Create a **new typed, migration-backed machine-assessed dataset and statuses** with its own immutable assessments and snapshots; make the auto-verified feed the dashboard default after launch. Do not mix synthetic tests, legacy human-checked evidence or automated evidence unnoticed.

## Where research comes from
The autonomous runtime is an independent server-side worker: **not a ChatGPT Plus automation and not Claude Pro**. Source acquisition may use official Yandex Search API worldwide and RU indexes and permitted vendor sites/feeds. AI analysis may use officially available models through Yandex AI Studio. Access to some overseas primary pages from a Russian server can fail; explicitly capture page-read failures, coverage and last successful fetch. Do not use VPN or evasive proxies as a default. Confirm actual provider connectivity on the target server before production.

Providers documented as of 2026-11-12 (verify rates/availability again before activation):
- Yandex Search API: https://aistudio.yandex.ru/ru/docs/search-api/concepts/ ; pricing https://aistudio.yandex.ru/ru/docs/search-api/pricing
- Yandex AI Studio models: https://aistudio.yandex.ru/ru/docs/ai-studio/concepts/generation/models ; pricing https://aistudio.yandex.ru/ru/docs/ai-studio/pricing
- OpenAI API access is not a required dependency. Normal ChatGPT Plus tasks do not push their output into PostgreSQL or supply included API tokens.

## Fully autonomous daily flow (default timezone Asia/Novokuznetsk)
1. Schedule research early enough for 08:00 local delivery, with correct timezone, deadlines, partial-run status and last successful run timestamps.
2. Discovery: rotate markets (US/EU/Asia/global) and product sectors, find **new** existing products with working references; cross-reference existing idea registry to avoid repeat novelty.
3. Competitor search: distinct Russian keyword/brand/category queries, synonyms, adjacent/free substitutes and RU product directories. Log searches, timestamps and *coverage*. "Not found" never means "no competitors".
4. Evidence collection: fetch lawfully accessible primary pages with URL, publisher, observed date, source type, exact relevant excerpt or structured feature, hash, and fetch status. Store source-of-truth content excerpts within copyright limits. Never treat a search snippet alone as independent proof.
5. Independent verification: **two structurally separate agents** (candidate analyst and skeptical reviewer; use different model families if practical) plus deterministic code checks (schema, URL reachability, exact quote/claim correspondence, date, duplication, unit/currency arithmetic). Skeptical reviewer searches for **counterevidence** including RU rivals and mistaken economics. AI reviewers must cite exact source IDs and cannot certify "checked by human".
6. Classify each material claim: `corroborated` / `vendor_claim` / `single_source` / `contradicted` / `unretrievable` / `unknown`; show **what the source claims**, not that the claim is independently true. Published prices are offers, investments are not revenue, GMV is not company revenue.
7. Apply **automatic quality gates**, before score publication. Each ranked candidate must have at least one retrievable real Western product primary source; a documented attempt to find RU competitors and relevant substitutes; source-linked descriptions of the unmet job, business model and distribution path; no unresolved contradictions on high-impact claims. Important commercial claims require independent corroboration when possible; unsupported numbers are not counted. If source access blocked or competition search thin, lower confidence, keep in discovered/hold as appropriate, do not award high RU-gap score.
8. Score independently on the *existing* versioned 12-dimension /100 rubric, with separately derived evidence-confidence /100 and Founder Fit /40. A 0 score means evidence of failing the criterion; lack of evidence = UNKNOWN. Never copy aggregate score from generated prose or manually force scores. Record cited claim IDs and rationale per criterion.
9. Challenge gate: skeptical reviewer tries to reject the idea. Machine detects evidence invalidation and contradictory RU competitors; invalid prior high score is flagged immediately. If critical supports are rejected/unretrievable, exclude idea from strongest recommendation pending an **automatic re-research pass**. This is automated review, not a human blocking queue.
10. Commit **immutable machine assessments, review events and machine TOP-10 snapshots**, with previous rank, score delta, source changes and model/version provenance. Automatically publish dashboard's official **automated TOP-10** at end of successful run (or N/10). Historical snapshots never rewritten. Legacy human-approved snapshots stay distinct.
11. Display new candidates, TOP-10 rank/movements, evidence certainty, confidence, competitive changes, why this ranks, network effects, payback hypotheses, model/request costs and timestamps. Full report in Russian with sources.
12. Handle retries, dedup, expiring sources, out-of-date pages, short/outage days: mark partial/stale rather than pretending fresh, preserve last successful snapshot, optionally run catch-up within hard budgets.
13. In future, automated weekly deeper re-check of incumbents and source freshness; promotions/demotions are versioned decisions.

## Required publication rules
- **No approval click, no manual source-check requirement** for daily automated rankings. All decisions are made by deterministic gates + evidence-aware AI.
- "Проверено системой" means structural/source correspondence and corroboration rules were applied; it is NOT equivalent to external independent certification or human verification.
- Ideas with unknown or contested evidence remain visible in the **watchlist**, not misrepresented as confidently ranked.
- Autonomous TOP-10 is the primary product surface. Do not bury it beneath the old human-approved TOP-10. Provide a separate historical/legacy view if useful.
- The assistant can and will err; every material rating requires evidence links, date, confidence, reviewed-by model provenance, and transparently noted limitations.
- No mandatory human decision in pipeline. Founder may optionally correct a record, which becomes a separate versioned input to later automatic runs.

## Security and operational constraints
- Source content is untrusted: prompt-injection isolation, no tool calls caused by embedded webpage instructions, SSRF/private-address protections, robots/terms/rate limits, safe redirects and timeouts.
- No public unprotected mutation or approval endpoints, no credentials in repo/logs; encrypted secret storage; least privilege and backups.
- Use cost-limited independent agent passes, bounded page/content/token budgets; **hard daily/monthly spend ceilings**, skip or degrade when exhausted; no user approval per run inside the configured authorized spending envelope.
- Store model version/provider, token/API usage, pricing version and request ID per job. Avoid infinite re-verification loops. Billing limits do not themselves guarantee provider charges are capped; implement application hard stop and usage alert.
- DB/API only privately reachable unless authenticated and HTTPS protected. Test access from Russia without VPN; server access to foreign web remains separate concern.
- No proactive contacting buyers, making purchases, legal attestations, arbitrary repository merges or deploying code as part of the research worker.

## Technical boundaries
Reusable adapters:
`SearchProvider.search(query, region,...)`,
`SourceReader.read(url)`,
`LLMProvider.structured(task, excerpts, schema, budget)`,
`ClaimChecker.check(claim, sourceRefs)`,
`ContradictionHunter.challenge(idea, sources)`,
`QualityGate.evaluate(idea, claims, coverage)`,
`MachineAssessmentPublisher.commit(assessment, run)`,
`RankPublisher.publishMachineTop10(asOf)`.
Use TypeScript/Fastify/Zod/PostgreSQL, **share existing scoring code** instead of maintaining diverging rules. PostgreSQL-backed queue for single VPS is fine. Strict tests and migrations for new dataset types are essential.

## Sprint boundaries
**VL-004A: fixture-based engineering**, after VL-003P is closed: provider interfaces, deterministic multi-day synthetic cases, machine-review statuses, independent quality gates, immutable automated-rank history, no manual gate, dashboard highlighting machine TOP-10. No billable API, keys or live hosting in this sprint.
**VL-004B: small, explicitly authorized paid API trial**: official Yandex Search API RU/world + Yandex AI Studio, validate actual access, citations and models from the target host. Founder enables a *one-time* budget/credentials; then each run needs no approval. Compare machine outcomes to source-grounded benchmark / adversarial tests.
**VL-004C: hosted operation**: secure VPS, scheduled jobs, backups, monitoring, regular browser accessible from Russia without VPN, daily results after successful worker completion. No fake precise readiness promises.
**VL-004D: quality optimization**: source diversity, counterevidence, scores calibration, cost/performance. Extend only as trustworthy evidence permits.

## Acceptance and adversarial tests
- Three fixture days with truly different Western discoveries; old incumbents remain and TOP-10 is all-time, not just today's batch.
- Direct RU rival discovered on day 2 causes justified RU-gap score reduction, changed rank and stored dated explanation.
- An analyst and challenger disagree → separate contradictory claim states; unresolved material conflict triggers hold, not confident 95/100.
- Vendor inflated revenue claim is labeled company self-report; investments/GMV are never treated as audited net revenue.
- Unreachable Western site and weak Russian search → no invented website text, downgraded confidence, no unsupported "no competitors".
- Scoring rubric v1.0 math and confidence distinct; all assessment changes source-linked and versioned.
- No user review event exists or is required to publish a machine TOP-10; never set human-approved flags automatically.
- Same schedule key re-run is idempotent; successful prior snapshots unchanged; failing run preserves last valid score.
- Prompt injection against reviewer cannot trigger dangerous tools, network calls or false "human checked".
- Runtime budget exhausted prevents additional billable requests; retry bounded; costs and freshness visible.
- CI fixture runs, migration tests and 390/1440px UX all green; provider integration separately authorized.

## Honest limitations
Automatic research can be highly useful but is not guaranteed true or complete. Financial and legal claims are particularly error-prone; document evidence gaps and machine confidence explicitly. Autonomous research may publish wrong interpretations; controls reduce and surface error risk but cannot eliminate it.
The current ChatGPT chat schedule is **not** the autonomous runtime. Our worker can run independently without the device VPN, once API/provider accounts, secure hosting and deployment are explicitly configured.
