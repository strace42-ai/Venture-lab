# CURRENT TASK — VL-004B / Live Research Provider Adapters, Evidence Safety & Controlled Trial
Version: 1.0
Date: 2026-11-12
Status: READY FOR CLAUDE — **PHASE A ONLY IS AUTHORIZED**
Repo: strace42-ai/Venture-lab
Base: current main after merged VL-004A PR #5
Suggested branch: `claude/vl-004b-live-providers`
Owners: Founder + ChatGPT
Source-of-truth: `docs/no-vpn-automation-architecture.md` v2.0, `docs/machine-research-worker.md`, `docs/scoring-model.md`.

## Mission
Turn the working VL-004A fixture-based zero-human Research Worker into a **real-provider-ready** research engine that can discover overseas products, search/directly inspect Russian rivals, challenge assertions using an independent second model, score from actual retrieved sources, and publish an automatic machine TOP-10 without manual research approval.

**Critical distinction**: Claude may fully IMPLEMENT and TEST the adapters and live mode with offline/mocked HTTP in Phase A. Do NOT spend money, create Yandex Cloud accounts, require real secrets, send requests to paid endpoints, put live mode into an unattended schedule, publicly deploy, or run the actual internet trial until founder has explicitly authorized a specific provider, account and total trial budget (Phase B). The routine *research workflow*, once activated, must remain zero-human-in-the-loop.

## Current status (verified)
- VL-004A was merged in PR #5; migration `004_machine_research.sql`, `server/machine/*`, `/machine` dashboard, live/fixture separation, hard application reservation ledger, retries, skeptical review and quality gates exist.
- CLI fixtures cover 3 successive days and no manual approval; all actual market data are still synthetic. The current `feed=live` is deliberately unconfigured/empty.
- The 9-idea VL-003P corpus with live public-source references is an **adversarial benchmark**, not an already human- or machine-certified market ranking. No importing fake approvals to legacy REAL.
- The user explicitly requires an autonomous daily process, not manual approval, not dependence on ChatGPT chat / Claude session, and no VPN on end-user device.

## Phase A (implement now, NO external provider calls)
### 1. Provider adapters and versioned configuration
- Implement `YandexSearchProvider` for official Search API, `YandexAIStudioLLMProvider` for analyst and **a distinct model-family skeptic**, and a `LiveSourceReader` for permitted actual page retrieval. Plug into existing `SearchProvider`, `SourceReader`, `LLMProvider`, `SkepticalReviewer` contracts; preserve offline fixtures and DI.
- Support `SEARCH_TYPE_COM` for worldwide discovery and `SEARCH_TYPE_RU` for Russian rivals; proper encoding, pagination, dedup, locale/rate-limit, resilient parsing of actual provider response (not assumptions or hallucinated source URLs). Search results are leads, not page proof.
- Initial suggested model pairing: **Qwen3.6 35B** for discovery/structured extraction, **DeepSeek V4.1 Flash** for skeptical challenge. Pin official current model IDs, configurable/reversible, no deprecated DeepSeek V4 Flash (scheduled retirement 2026-11-15). If provider supports only one model due availability, fail-closed or explicitly mark `single-model-degraded` with conservative gate, NEVER claim independent second model.
- Document configuration with env names and `.env.example` containing **no tokens**; no secrets in logs, screenshots, git, tests, handoff. A one-off operator must configure Yandex Cloud IAM and billing out-of-band. No dependency on ChatGPT Plus or Claude Pro API access.

### 2. Live source evidence, market data correctness
- Fetch actual source pages **only through secure fetcher**; extract meaningful human-visible text and claim excerpts. Parse HTML, redirects and PDFs only if safely/appropriately supported; if JS-rendered sites need headless fallback, isolate and bound it. Respect robots/terms and provider policies.
- Strict SSRF protections: disallow loopback/private/link-local/metadata/DNS rebinding, IPv4/IPv6, dangerous redirects/ports/protocols, length/time/depth/size caps, content-type restrictions, no embedded-script execution by default, sandbox browser if any.
- Treat web page content as **untrusted data**: prompt injection and adversarial text cannot override instructions, source provenance, score or approvals. Never let generated content call arbitrary tools/URLs.
- Before accepting `PageRead.offer`, validate that the reported product name, country/market, functionality/jobs, price are actually grounded in fetched webpage (and classify any tentative attribution as uncertain). A vendor offer is vendor self-report; page exists ≠ customers/revenue/demand. Unretrievable blocked pages must remain unknown.
- Source record: canonical URL, actual fetch time, publisher, status/HTTP, content hash, exact quote and its location, source type (vendor/independent/primary), model provenance.
- Validate structured outputs with Zod. For market claims including popularity, paid users, revenue, price and active product features, require claim-specific source matches and independent corroboration when available. Mark conflicts rather than inventing "facts".
- In Russian rival search, search English and Russian synonyms, adjacent substitutes, brand-specific queries, pricing. **No hit ≠ no rival**. Keep existing caps but reassess if needed from real evidence.
- Do not let `SourceReader` trust an LLM-generated `offer` without deterministic evidence linkage. The fixture `offer` is only an emulator.

### 3. Reliability, quotas and real pricing
- Existing CallContext reserves **estimated** costs pre-call. Actual Yandex billing can differ (tokens/response, tariffs, retries, timeouts). Build a reconciliation and conservative charging envelope: estimate worst case from max tokens/request before calling; after response record actual token usage/cost, provider request ID, effective pricing date/version. Enforce fail-closed when cost cannot be bounded or observed. Application limit is **not** a provider billing guarantee; document and support Yandex-side billing alerts/quotas.
- Retain global monthly per-feed lock, lease/attempt ledger, idempotency and top-up semantics. Real provider network calls can time out after remote billing — count worst-case reserve until reconciled and avoid unbounded blind retries. Preserve prior successfully published snapshot if run fails or partial.
- Backoff/retry on 429/5xx with jitter and bounds; never retry authentication errors forever; rate limiting and circuit breaker.
- Rate-limit, cost and per-source-budget controls; bounded number of new candidates and rotating incumbent rechecks (do NOT re-research the entire growing registry every morning).
- Add run diagnostics: search requests by region, primary pages successfully fetched, number of validated distinct RU competitors, contradictions, cost estimated vs observed, average confidence, dead-letter/partial reasons. Dashboard must show date/freshness/currency and honest partial/empty states.
- Keep current user's no-human approval requirement: automatic machine quality gate and publication after an eligible run; no human 'checked' or 'human-reviewed' flag manufactured.

### 4. Offline benchmark & tests (mandatory)
- Add **recorded/mock provider response fixtures** shaped like official Yandex Search API and AI Studio. Tests MUST NOT hit paid endpoints or arbitrary live web.
- Case A: digital guest guide: RealtyCalendar Autopilot, RYNTO, GuestCom available as real RU rivals; skeptical pass detects/labels them, removes unsupported "empty niche", holds/scores down candidate.
- Case B: VAGLOGS vs VAG Report (CSV logs vs Auto-Scan DTC) carefully distinguishes adjacent vs direct functionality; never conflates vendors.
- Case C: general quote comparator is crowded (ВНИКЛИ, Vortholm); remove unsupported RU-market-gap claim.
- Case D: independent page mentions a number without proof of real customer payments; the system cannot turn marketing into verified revenue.
- Case E: foreign primary page unreachable / robots disallowed; don't use generated text as fetched fact.
- Case F: injected source and invalid LLM JSON cannot trigger URL fetch/approval or inflate rating.
- Case G: concurrent/expired jobs, actual vs estimated billing, late response, double charge prevention, budget exhaustion, one published snapshot, no leak between fixture/live.
- Case H: source links 404/redirect to private network and DNS rebinding/large body fail safely.
- Benchmark quality: create reports with false positive/false negative competitor retrieval and source verification precision; **do not claim model accuracy from mocks**.
- Existing 231-test baseline must stay green (count can increase). Run lint/typecheck/tests/build and CI; do QA at 390px and desktop if UI changed.

### 5. CLI & handoff
- Add explicit gated `research:worker:run --live --once --dry-run` / `--fixture` (adapt syntax sensibly). Unset keys or activation flag -> no outbound requests. All live paid calls blocked unless founder chooses Phase B, sets credentials in secure environment, supplies `--live --execute --max-spend-rub <N>` and config enables provider. A dry-run MUST NOT hit paid APIs. No scheduled live run in Phase A.
- Provide operator setup guide `docs/live-provider-setup.md`: required IAM roles/keys, allowlisting, Yandex API fees, disabled-by-default behavior, secrets/quotas, exact dry-run/test commands, how to set a one-time cap and revoke access, how to inspect actual provider charges.
- Handoff include exact provider endpoints and official docs, models/IDs and tariffs checked, test outputs, unsupported cases, benchmark results. PR only; DO NOT MERGE.

## Phase B — BLOCKED UNTIL EXPLICIT FOUNDER AUTHORIZATION
When Phase A is audited and ready, ask only then for **one-time** approved trial ceiling (proposed `500 ₽` as a ceiling, NOT authorized yet), Yandex Cloud account/configuration and suitable execution host. Never request users to paste API keys in chat. Run real search+LLM smoke against ~3–5 carefully bounded candidate opportunities and compare to the 9-idea research corpus. Record true billed usage and test reachability of foreign primary sites **from the proposed deployment network**. No unattended paid recurring run until provider quality, actual spend and connectivity are validated.

## Provider docs (official, verify again when implementing)
- Search types RU/COM: https://aistudio.yandex.ru/ru/docs/search-api/concepts/web-search
- Search API pricing: https://aistudio.yandex.ru/ru/docs/search-api/pricing
- Supported models/IDs: https://aistudio.yandex.ru/ru/docs/ai-studio/concepts/generation/models
- AI Studio pricing: https://aistudio.yandex.ru/ru/docs/ai-studio/pricing
- Availability guidance: https://yandex.cloud/ru/recommendations

## Completion criteria Phase A
A reviewer can run a **fully functioning live-provider adapter contract** using offline HTTP recordings, including rich source evidence, distinct machine analyst/skeptic, safe network reader and billing estimation/reconciliation, generate a realistic candidate/ranking in isolated test DB **without paid calls**, and observe correct guardrails and preserved history. Handoff & PR demonstrate production-readiness for a small Phase B test — NOT a claim that autonomous live research, server deployment or no-VPN end-user access are already proven.
