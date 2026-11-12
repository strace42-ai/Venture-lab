# Venture Lab — Latest handoff

**Task:** VL-004B / Live Research Provider Adapters, Evidence Safety & Controlled Trial — **Phase A only** (`tasks/current-task.md` v1.0)
**Status:** PHASE A IMPLEMENTED, offline only. **No paid API call was made, no cloud resource created, no deploy.** PR open, **not merged**. Phase B is blocked until the founder authorises it.
**As of:** 2026-11-12 · **Implementer:** Claude Code

## Git
| | |
|---|---|
| Base | `main` @ `c900fd6` (VL-004A merged; VL-004B docs activated) |
| Branch | `claude/vl-004b-live-providers` |
| PR | opened to `main` (see the PR list), not merged |

## What was built
Everything plugs into the existing VL-004A contracts (`SearchProvider`, `SourceReader`, `LLMProvider`, `SkepticalReviewer`, `CallContext`, worker, ledger). The fixture feed is unchanged: same scores, all VL-004A tests green.

| Area | Code | What it does |
|---|---|---|
| Config | `server/live/config.ts`, `.env.example` | Env only, **off by default**. Pinned models `qwen3.6-35b-a3b` (analyst/extraction) and `deepseek-v4.1-flash` (skeptic). Deprecated `deepseek-v4-flash` / `yandexgpt-5-lite` are refused. Endpoints must be official Yandex hosts. The same model family is refused, unless `VL_ALLOW_SINGLE_MODEL=true`, in which case every candidate is held as `single-model-degraded`. Secrets never appear in printed config or errors. |
| Tariffs | `server/live/prices.ts` | `yandex-2026-11-12`. Search costs 49 kop per request (daytime sync, 488 ₽/1000). Qwen3.6 35B costs 0.20 / 0.30 ₽ per 1000 input / output tokens; DeepSeek V4.1 Flash 0.30 / 0.50 ₽. The worst-case bound is input UTF-8 bytes plus framing plus `max_tokens`. |
| Paid calls | `server/live/provider-http.ts` | Reserve the worst case before **every** HTTP attempt, then reconcile:<br>• `reconciled` — usage × tariff;<br>• `tariff` — fixed per-request price;<br>• `not_billed` — Search 5xx / auth errors;<br>• `unknown` — worst case kept on timeout, missing usage or ambiguous errors;<br>• `anomaly_over_estimate` — stops all further paid calls.<br>Retries only on 429/5xx, with backoff, jitter and Retry-After. No retry on 401/403. Per-run circuit breaker. Only official hosts are called. |
| Search | `server/live/yandex-search.ts` | `POST searchapi…/v2/web/search`. `ru` → `SEARCH_TYPE_RU` + region 225 + `LOCALIZATION_RU`; `world`/`west` → `SEARCH_TYPE_COM` + `LOCALIZATION_EN`. The `rawData` base64 XML is parsed tolerantly: error 15 means no results, DOCTYPE/ENTITY is refused. Pagination is bounded; URLs are canonicalised and de-duplicated. Hits are leads, not proof. |
| AI Studio | `server/live/ai-studio.ts` | `POST ai.api.cloud.yandex.net/v1/chat/completions` with `gpt://<folder>/<model>`, `Api-Key`/`Bearer` and `OpenAI-Project`, `temperature 0`, `response_format json_schema` (from Zod). Output is Zod-validated: invalid output raises `InvalidModelOutput` and the candidate is never scored. Page text enters prompts only as quoted DATA. Roles: `YandexAnalyst` (discovery from hits, analysis from the evidence pack), `OfferExtractor`, `YandexSkeptic` (own RU/EN counter-queries: synonyms, analogues, «бесплатно», «тарифы»). |
| Safe reader | `server/live/net/*`, `server/live/html.ts`, `server/live/live-reader.ts` | • http(s) on ports 80/443 only;<br>• all DNS answers must be public (IPv4/IPv6, mapped/NAT64/6to4, metadata, CGNAT…);<br>• the connection is pinned to the validated address (no DNS rebinding);<br>• redirects re-validated per hop, https→http refused;<br>• robots.txt honoured (5xx = disallow);<br>• decompressed-size cap (gzip bomb), timeouts, HTML/text only (PDF → `unsupported_content`);<br>• visible text only (scripts and hidden elements dropped), windows-1251 decoding;<br>• instruction-like content, visible or hidden, → quarantine;<br>• per-host politeness;<br>• one fetch per URL per run. |
| Grounding | `server/live/grounding.ts` | The extraction model only proposes. Code keeps the name, each job (with a verbatim quote) and the price only if they are **on the page**. Market comes from page signals (domain / lang / script / currency). Everything else is stored as `uncertain`. A vendor's own offer is a self-report; the Western product's site is never «independent». |
| Pipeline | `server/machine/pipeline.ts` (`vl-004b-pipeline-1`) | • **Evidence pack:** the analyst can cite only pages actually found and fetched; a model-made URL is never fetched and never counts.<br>• Discovery seeds must come from real hits.<br>• **Competitor kind decided by code** from the jobs proven on the rival's page: rivals the skeptic omits are added, invented ones dropped, the Western analogue excluded.<br>• **Popularity ≠ payment** rule for paid-users/revenue claims.<br>• Quote locations are recorded.<br>• Same-family models → hold.<br>• Bounded hits per query and RU queries. |
| Worker / DB | `server/machine/worker.ts`, `server/db/migrations/005_live_providers.sql` | • Provenance columns.<br>• Usage reconciliation columns with a CHECK: the ledger is never below the worst case unless the cost was observed.<br>• Job `independence` mode.<br>• Seed discovery context (`ru_keywords`, `source_url`).<br>• **Rotation:** ≤ `maxNew` new candidates plus ≤ `maxRechecks` least recently assessed incumbents. A recent PASSED assessment is **carried forward** with its own date. The DB enforces: older than the snapshot, ≤ 30 days old, an exact copy of the assessment, never from the same job. |
| CLI | `server/cli/worker.ts`, `server/live/run.ts` | • `run --live --once --dry-run` — config, readiness, tariffs, bounds and worst case, **zero network**.<br>• `run --live --once --execute --max-spend-rub N` — Phase B only. Refused without `VL_LIVE_PROVIDER=yandex` and credentials, in CI, without a ceiling, or for same-family models.<br>• `tick --live` is refused (no schedule in Phase A).<br>• `status --live`. |
| Read API / UI | `server/machine/read.ts`, `src/pages/MachinePage.tsx`, `MachineCandidatePage.tsx` | • «Диагностика последнего прогона»: searches by region, pages read and failure reasons, validated RU direct/adjacent rivals, contradictions, cost reserved → charged, unknown calls and anomalies, average confidence, partial reason, carried entries.<br>• Live costs shown in ₽.<br>• Carried entries shown as «оценка от …, не перепроверялась».<br>• Sources show fetch time, canonical URL, failure and unconfirmed offer fields.<br>• Honest «no live runs; paid calls disabled» state. |
| Recordings | `server/live/recordings/*` | Mock transports in the **official response shapes** (Search `{rawData}`, Chat Completions with `usage`, web pages with DNS) plus cases A–F. Texts paraphrase the VL-003P public pages; fictional items use `.example` domains. **Not real captures.** |
| Benchmark | `server/live/benchmark.ts`, `npm run research:benchmark`, `docs/benchmarks/vl-004b-offline.md` | Precision / recall of direct-RU rival identification and of claim/source verification, compared with what the recorded model outputs said alone. |
| Docs | `docs/live-provider-setup.md`, `docs/machine-research-worker.md` | Operator guide: endpoints and docs, IAM roles, key handling, network allowlist, billing budgets/alerts, dry-run/execute, revoking access, reconciling with Yandex Billing. |

## Offline benchmark (recorded HTTP — measures guardrails, NOT model accuracy)
| | TP | FP | FN | Precision | Recall |
|---|---|---|---|---|---|
| Direct-RU rivals, pipeline | 5 | 0 | 0 | 100% | 100% |
| Direct-RU rivals, recorded skeptic alone | 5 | 2 (VAGLOGS conflated with Auto-Scan; invented «Bnovo Гид») | — | 71% | — |
| Claims accepted, pipeline | 8 | 0 | 0 | 100% | 100% |
| Claims «supported» by recorded skeptic alone | 8 | 1 («10,000 companies use» taken as payment) | — | 89% | — |

The corpus was written together with the guardrails. 100% only means the guardrails do what they were built for on these cases. Real quality is measured only in Phase B.

## Cases A–H (all automated)
- **A — guest guide.** RealtyCalendar «Автопилот», RYNTO and GuestCom are validated as direct RU rivals. GuestCom is reachable only through a synonym query. The «empty niche» claim is contradicted, `ruUnmetJob` = 0 and the idea is held. The invented «Bnovo Гид» is dropped. RYNTO's model-claimed market `west` is corrected to `ru` and flagged.
- **B — VAGLOGS vs VAG Report.** VAGLOGS proves only CSV-log analysis, so it is **adjacent**. The model's Auto-Scan job is dropped as not on the page. The skeptic's «direct» label and its refutation are rejected and its critical dispute downgraded. Ross-Tech is never counted as a rival. drive2 returns 403 and stays unretrievable.
- **C — quote comparison.** ВНИКЛИ and Vortholm are direct; the gap claim is contradicted and the idea held.
- **D — popularity ≠ payment.** «More than 10,000 companies use» never verifies «10,000 pay», even though the recorded skeptic says it does; `westernPay` stays unknown.
- **E — unreachable sources.** robots.txt `Disallow: /` means only `/robots.txt` is requested. The claims citing the page are unretrievable and the idea is held. The PDF is `unsupported_content`, the 404 is `http_error`. A model-remembered URL is **never requested**.
- **F — injection and invalid output.** Hidden and visible injections are quarantined and never reach a model; no request goes to `169.254.169.254`. Invalid analyst JSON leaves the candidate `DISCOVERED`; invalid skeptic JSON does the same.
- **G — worker, billing, concurrency.** Tested:
  - one LIVE snapshot, the fixture feed untouched;
  - usage reconciled, with observed < reserved;
  - idempotent re-run with 0 calls;
  - rotation with a carried-forward entry and the same score on recheck;
  - DB refusals for bad carried entries and forged under-counted usage;
  - budget 6 ₽ → `partial`, nothing published, previous TOP kept;
  - LLM timeout → `unknown` at worst case;
  - usage anomaly → failed, no publish;
  - 401 → one request, `not_billed`, failed;
  - late response after lease takeover → `superseded` + `succeeded`, one snapshot, no duplicate request ids, `job.spent` = A + B.
- **H — network safety.** Covered:
  - 16 blocked address classes (incl. `::ffff:127.0.0.1`, NAT64, 6to4) and URL tricks (decimal/hex IP, credentials, ports, `.internal`);
  - redirects into private space;
  - mixed DNS answers and rebinding — the connection stays pinned;
  - robots 5xx and timeout;
  - redirect loops, oversized bodies and a gzip bomb (via a real loopback socket for `NodeTransport` only);
  - PDFs, windows-1251.

## Checks actually run (local PostgreSQL 16, Node 22)
| Check | Result |
|---|---|
| `npm run lint` / `typecheck` / `build` | ✔ / ✔ / ✔ |
| `CI=true TEST_DATABASE_URL=… npm test` | ✔ **20 files, 334 tests**, up from 231: `live-net` 42, `live-providers` 27, `live-pipeline` 21, `live-worker` 12, UI +1. All VL-001…VL-004A tests pass unchanged. |
| Fixture CLI 3 days (fresh DB) | ✔ 3/10 → 3/10 → 4/10, same scores as VL-004A |
| `--live --once --dry-run` | ✔ no network. `--execute` is refused without config, in CI and for deprecated models; `tick --live` is refused. |
| `npm run research:benchmark` | ✔ (table above) |
| Responsive QA, Playwright at 390/768/1024/1280/1440 on 8 routes (incl. live dashboard and 3 live dossiers) | ✔ no horizontal overflow, no console errors. Data came from an **isolated QA database** seeded by recorded HTTP. Screenshots are in `docs/screenshots/vl-004b/`. |
| CI | New step «VL-004B live adapters (no network, no paid calls)»: dry-run, execute refusals, tick refusal, benchmark. Result in the PR. |

## Official sources checked (2026-11-12)
- Search types RU/COM and request fields: https://aistudio.yandex.ru/ru/docs/search-api/concepts/web-search and https://aistudio.yandex.ru/ru/docs/search-api/api-ref/WebSearch/search
- Search pricing (488 ₽ / 1000 sync daytime; 5xx/auth not billed): https://aistudio.yandex.ru/ru/docs/search-api/pricing
- Models and IDs (Qwen3.6 35B `qwen3.6-35b-a3b`; DeepSeek V4.1 Flash `deepseek-v4.1-flash`; V4 Flash deprecated 2026-11-15): https://aistudio.yandex.ru/ru/docs/ai-studio/concepts/generation/models
- AI Studio pricing: https://aistudio.yandex.ru/ru/docs/ai-studio/pricing
- Chat Completions request (`ai.api.cloud.yandex.net/v1`, `Api-Key`, `OpenAI-Project`): https://aistudio.yandex.ru/docs/en/ai-studio/operations/generation/completions-basic

## Known limitations / risks (honest)
- **Search response format.** The official page does not publish the XML element schema. The parser follows the classic Yandex XML layout and is tolerant, but it is **unverified against a real response**; capture one in Phase B and add it to the recordings.
- **Structured output.** AI Studio `json_schema` support for Qwen/DeepSeek is documented only generally. `VL_LLM_RESPONSE_FORMAT=json_object|none` is the fallback; Zod validation stays in either case.
- **IAM role names** in the setup guide must be re-checked in the console.
- **Billing.** Night rates and cached-token discounts are not reserved (the conservative choice). The application cap is **not** a provider billing guarantee; Yandex Cloud Billing budgets and alerts are required.
- **Token bound.** The input-token bound (bytes ≥ tokens) assumes byte-level BPE. A violation is caught as an anomaly that stops paid calls; the ledger then keeps the bound and the observed value is stored for audit.
- **Coverage gaps.** No PDF parsing, no headless browser: JavaScript-only pages are `unsupported_content`.
- **Reachability.** Foreign primary sites may be unreachable from a Russian host — to be measured in Phase B.
- **Source type.** «independent» relies on the extraction model's page kind. It is never assigned to a page with a grounded offer or to the Western product's own site, but a vendor blog on another domain could still be mislabelled.
- **Cost.** One run with the default bounds (3 new + 3 rechecks) cost about 55 ₽ on recorded data; the token counts are synthetic. Searches dominate (≈14 per candidate).
- **Pre-existing layout issue.** On the 1440 dashboard, the evidence-grade column of the TOP table scrolls inside its card (unchanged since VL-004A).

## Next
1. ChatGPT independent audit of this PR.
2. **Phase B** only after explicit founder authorisation of a provider account, a host and a one-time ceiling (proposed ≤ 500 ₽, **not authorised**). Steps: real search + model smoke on 3–5 candidates, capture real responses, compare with the 9-idea corpus, measure reachability from the host, reconcile with Yandex Billing.
