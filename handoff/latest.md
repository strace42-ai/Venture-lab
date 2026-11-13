# Venture Lab — Latest handoff

**Task:** VL-004B / Live Research Provider Adapters, Evidence Safety & Controlled Trial — **Phase A only** (`tasks/current-task.md` v1.0)
**Status:** PHASE A IMPLEMENTED + AUDIT ROUNDS 1–3 FIXES (round 1 on `9fe7bac`, round 2 on `feb9a52`, round 3 on `a5026da`), offline only. **No paid API call was made, no cloud resource created, no deploy.** PR open, **not merged**. Phase B is blocked until the founder authorises it.
**As of:** 2026-11-13 · **Implementer:** Claude Code

## Git
| | |
|---|---|
| Base | `main` @ `c900fd6` (VL-004A merged; VL-004B docs activated) |
| Branch | `claude/vl-004b-live-providers` |
| PR | opened to `main` (see the PR list), not merged |

## Audit round 3 — NULL-safe constraints (audit of `a5026da`)
In PostgreSQL a CHECK passes when its expression is NULL (UNKNOWN). Migration 006 is already applied in existing databases, so the fix is a new migration, **007_null_safe_checks**, rather than an edit of 006.

| Constraint | Loophole | Fix | PostgreSQL tests (`migration-006.test.ts`, a real upgrade 005 → 006 → 007) |
|---|---|---|---|
| `mr_competitors_market_status_consistent` (006) | `market_verified = (market_status IN …)` is NULL when `market_verified IS NULL`, so «verified + NULL» was accepted | `market_status IS NULL OR market_verified IS NOT DISTINCT FROM (market_status IN ('verified','declared'))` | • refused: `verified + NULL`, `unknown + NULL`, `declared + NULL`, `conflicting + NULL`, `declared + false`;<br>• refused: status NULL on a new row (`market_status_required`), with or without a boolean;<br>• accepted: all four consistent pairs;<br>• the historical row is kept unchanged (`NULL / true`) and never counted as a proven rival. |
| `mr_usage_cost_bound` (005) | `reconciled` / `tariff` / `not_billed` with `actual_cost NULL`: `cost = actual_cost` and `actual_cost <= estimated_cost` were both NULL, so the row was accepted (an «observed» cost without an observation). In addition, `estimated_cost IS NULL` bypassed the whole check. | `actual_cost IS NOT NULL`, NULL-safe `IS NOT DISTINCT FROM` comparisons; new `mr_usage_estimate_required` (`NOT VALID`, so rows written before 005 stay as they were) | • refused: `reconciled` / `tariff` / `not_billed` without an actual cost, a missing estimate, a cost above the bound, `unknown` below the worst case;<br>• accepted: valid rows of every reconciliation kind. |

Other constraints of 005/006 were reviewed:
- the column CHECKs of the form `col IS NULL OR …` are nullable by design (optional values);
- `mr_snapshot_entries_carry_other_job` compares with the NOT NULL `job_id`;
- `fetch_status`, `reconciliation` and `carried_count` are NOT NULL;
- the carry trigger raises on NULL dates.

No other loophole was found. The 004 checks referenced here are on NOT NULL columns.

A pre-existing test (`machine-review.test.ts`, cross-feed usage row) inserted a usage row without `estimated_cost`. It now sets one, so it still asserts the **foreign-key** refusal it was written for.

Checks:
- real upgrade of the populated QA database 006 → 007: both new checks validated against all existing rows;
- fresh database 001–007 plus the fixture 3-day CLI: 3/10 → 3/10 → 4/10, unchanged;
- 377 tests;
- benchmark unchanged.

## Audit round 2 — fixes (audit of `feb9a52`)
| # | Finding | Fix | Tests |
|---|---|---|---|
| **P1** | `marketEvidence()` could drop a real Russian rival: an English page, several currencies or mixed signals made it «not proven», and an unproven rival then silently stopped limiting the RU dimensions. | **Three states** instead of a yes/no:<br>• `verified` — strong RU signals (₽/руб/RUB, +7, ИНН/ОГРН, СБП/«Мир»/ЮKassa) establish «ru» **whatever the page language**; a multi-currency page with ₽ is RU, with the mix recorded; an RU domain alone gives «ru» only without western prices; $/€/£ only gives «west»;<br>• `conflicting` — an RU domain with prices only in $/€/£;<br>• `unknown` — no availability signal (Russian localisation alone).<br>A rival in a conflicting or unknown market is a **possible competitor** — neither proof of competition nor of its absence:<br>• it never refutes a claim, never holds an idea and never adds to Russia validation;<br>• but it **caps the RU dimensions at 3** (no «4 with an independent RU source»);<br>• and it **blocks a «nobody in Russia does X» claim** from being supported (the verdict becomes `needs_more_evidence`).<br>Scoring weights and the formula are unchanged; only the existing cap and verdict gates use the new status. | Unit:<br>• an English-language Russian product (RUB, +7, ИНН) → ru;<br>• a multilingual multi-currency page ($/€/₽) → ru, with the mix recorded;<br>• `.ru` + $ only → conflicting;<br>• no prices: `.ru` → ru, Russian on `.com` → unknown, English `.com` → unknown;<br>• $ + € → west.<br>Pipeline (`live-market.test.ts`):<br>• baseline cap 4 is unchanged without rivals;<br>• a conflicting or unknown rival → cap 3, not 4, and no hold;<br>• a proven rival → cap ≤ 2;<br>• the skeptic «supporting» the absence claim while a possible direct rival exists → downgraded, score null;<br>• recorded Quote Compare with rivals moved to neutral `.com` pages without ₽ → rivals possible, the gap neither refuted nor counted (`ruUnmetJob` null, never 5). |
| P2 | `siteOf()` took the last two labels: wrong for `co.uk`, `com.au` and similar. | Public Suffix List via `tldts` **7.4.22** (already in the tree through jsdom; now a direct, exact-pinned dependency). Private suffixes are respected, so `alice.github.io` ≠ `bob.github.io`. | `co.uk`, `com.au`, `github.io`, `.ru`, IP cases; two different owners under one compound suffix are not merged, while the product's own `blog.touchstay.co.uk` still counts as a self-report. |
| P2 | The home-page re-check could confirm a market despite conflicting signals on the product page. | `combinedMarketEvidence()`: the home page is used **only when the product page is `unknown`**. Signals of both pages are pooled and re-judged; conflicts are kept; a conflicting or verified page is never overridden. | A conflicting page plus a ₽ home page stays conflicting (also through `groundOffer`); an unknown page plus a ₽ home page is verified via both; a pooled multi-currency mix is recorded. |
| P2 | `market_verified boolean NOT NULL DEFAULT true` (005) marked historical rows as verified. | **Migration 006**:<br>• `market_status` is NULL for existing rows, read as «not assessed (historical row)», never verified, and counted as unverified in diagnostics;<br>• `market_verified` lost its default and NOT NULL;<br>• new rows must state the status, and the two columns must agree. Both rules are `NOT VALID` CHECKs, so append-only history is not rewritten;<br>• the worker writes the status explicitly (`declared` for the fixture emulation). | `migration-006.test.ts` runs a **real upgrade**: migrate 001–005, insert a historical competitor, apply 006. The old row keeps its values and is not counted as a proven direct rival. A new row without a status, with an inconsistent status or with an invalid value is refused; valid rows are accepted. The fresh schema is also checked. |

### Effect on the three regression cases (same recorded corpus, compared with `feb9a52` by the same script)
| Case | `feb9a52` | now | Why |
|---|---|---|---|
| Guest Guide | HOLD, 32, grade B, `ruUnmetJob` 0. RealtyCalendar and GuestCom proven direct; RYNTO not counted. | **Identical.** RYNTO's status is now `unknown`. | Two proven direct rivals (RU domain or ₽) already refute the gap and hold the idea. RYNTO's recorded page has Russian text and «Бесплатный тариф» but no RU availability signal, and its home page returns 404, so it stays a possible competitor. The fixture was not changed. |
| VAG Report | PASSED, 25, grade C, `ruWeakness` 3; VAGLOGS adjacent and unverified. | **Identical.** VAGLOGS's status is now `unknown`. | Without proven rivals the cap was already 3: the RU claim is a vendor page, not an independent RU source. The new «possible rival → cap 3» rule therefore changes nothing here. |
| Quote Compare | HOLD, 10, grade C, `ruUnmetJob` 0; ВНИКЛИ and Vortholm proven direct. | **Identical.** Both are `verified` (RU domain plus ₽ or «бесплатно» on a `.ru` page). | Unchanged evidence. |

The fixture engine is also unchanged: 3/10 → 3/10 → 4/10 with the same scores (fixture rivals are `declared`). The benchmark numbers are unchanged.

## Audit round 1 — fixes
| # | Finding | Fix | Tests |
|---|---|---|---|
| **P1** | A rival's market could be the model's guess: when page signals were missing, `groundOffer` still returned `market:'ru'`, and the rival counted as a direct RU competitor (caps, refutations, holds). | `marketEvidence()` (`server/live/grounding.ts`) separates the **product market** from the page language.<br>• «ru» requires an RU availability signal (RU domain, ₽/руб price, +7 phone, ИНН/ОГРН) plus Russian content, and no $/€/£ price.<br>• «west» requires a $/€/£ price on a western-language page.<br>• RU localisation alone is not enough.<br>• Undetermined → **automatic re-check of the site's home page** (same safe fetcher, no model call, no charge).<br>• Still undetermined → the offer is kept with `marketVerified:false` and stored as `mr_competitors.market_verified=false`. The UI shows «рынок не подтверждён».<br>• Such a rival is **excluded** from `directRu`/`adjacentRu` caps, refutation validation, free/≥2-rivals holds and Russia validation; the next rotation re-checks it.<br>• Diagnostics show the count. | Unit:<br>• neutral English `.com` where the model says «ru» → not established;<br>• Russian localisation without sales signals → not established;<br>• English `.ru` with a $ price → not established, conflict recorded;<br>• ₽ + +7 + ИНН → «ru» even when the model said «west»;<br>• home-page re-check resolves it.<br>Integration (pipeline):<br>• an unproven «direct» VAG rival leaves scores, score and state **unchanged**;<br>• the same rival with ₽/+7 **does** cap the RU dimensions;<br>• RYNTO (Russian page, no availability signal) is shown, not counted, and its home page was probed;<br>• RealtyCalendar and GuestCom stay proven direct and the guest guide stays held.<br>Integration (worker + PostgreSQL): the published TOP equals the baseline; `market_verified=false` is stored. |
| **P1** | Source independence came from the extraction model's `pageKind`, which could raise the evidence grade and reliability. | New `assessProvenance()` (`server/live/provenance.ts`). «independent» requires the model's claim **and** all of the following verifiable signals:<br>• a site that is not the product's (not the seed source, not a site with a grounded offer this run, brand not in the domain);<br>• no offer on the page;<br>• publication markup (og:type=article / schema.org Article·Review·NewsArticle·BlogPosting / `<article>`);<br>• a named publisher or author that is not the product.<br>Otherwise the type is **UNKNOWN** («тип не установлен») or a self-report. The decision, its signals and the reason are stored in `mr_sources.provenance` and shown in the dossier; diagnostics count rejected claims. | Unit:<br>• the vendor's own page with `pageKind:'independent'` / `isProductPage:false` → self-report;<br>• a third-party page without markup/byline → UNKNOWN;<br>• publisher or author = product → self-report;<br>• a site seen offering a product → self-report;<br>• positive: a marked-up third-party review → independent;<br>• `forum` is never independent.<br>Integration:<br>• the misclassified Touch Stay pricing page stays a self-report (`vendor_claim`);<br>• the same review without provenance → UNKNOWN, grade **B → C**, lower reliability.<br>Worker: an unverified forum «independent» is stored as `unknown` / `unverified`; the TOP is unchanged. |
| P2 | `--execute` was able to make paid calls whenever credentials were present | A separate fail-closed activation flag: `VL_LIVE_EXECUTE=phase-b-authorized` is required in addition to the config, credentials, `--max-spend-rub` and «not in CI». | CLI checked: refused without the flag. |
| — | Found while fixing | JavaScript `\b` does not work next to Cyrillic letters, so `\bруб` (payment evidence) and `\bИНН` never matched. Replaced with explicit guards. | Covered by the ₽/ИНН tests |

Recorded corpus changes:
- genuine third-party pages got publication markup (og:type=article, og:site_name, author);
- the Touch Stay pricing page now has a deliberately wrong extraction recording (`independent`, not a product page);
- RYNTO and VAGLOGS have no RU availability signal on their recorded pages, so they are now **«рынок не подтверждён»** (shown, not counted). The guest guide is still held through RealtyCalendar and GuestCom.

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
| Direct-RU rivals with a proven market, pipeline | 4 | 0 | 0 | 100% | 100% |
| Direct-RU rivals, recorded skeptic alone | 4 | 1 (invented «Bnovo Гид») + 2 with an unproven market (RYNTO, VAGLOGS-as-direct) | — | 57% | — |
| Claims accepted, pipeline | 8 | 0 | 0 | 100% | 100% |
| Claims «supported» by recorded skeptic alone | 8 | 1 («10,000 companies use» taken as payment) | — | 89% | — |

Rivals with an unproven market are shown but not counted: 2 of 2. Independent publications verified by provenance: 4. Model «independent» claims rejected: 1 (the Touch Stay pricing page). The corpus was written together with the guardrails. 100% only means the guardrails do what they were built for on these cases. Real quality is measured only in Phase B.

## Cases A–H (all automated)
- **A — guest guide.** RealtyCalendar «Автопилот» and GuestCom are validated as direct RU rivals with a proven market (RU domain or ₽/руб). GuestCom is reachable only through a synonym query. The «empty niche» claim is contradicted, `ruUnmetJob` = 0 and the idea is held. RYNTO (Russian page, no availability signal; home page re-checked) is shown as «рынок не подтверждён» and not counted. The invented «Bnovo Гид» is dropped.
- **B — VAGLOGS vs VAG Report.** VAGLOGS proves only CSV-log analysis, so it is **adjacent**; its market is not proven (no RU availability signal), so it is shown and not counted. The model's Auto-Scan job is dropped as not on the page. The skeptic's «direct» label and its refutation are rejected and its critical dispute downgraded. Ross-Tech is never counted as a rival. drive2 returns 403 and stays unretrievable.
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
| `CI=true TEST_DATABASE_URL=… npm test` | ✔ **22 files, 377 tests** (round 3; round 2: 375; round 1: 350; initial: 334). Round 2 added `live-market` 5, `migration-006` 3 and `live-providers` +17. Earlier per-file counts: `live-net` 42, `live-providers` 38, `live-pipeline` 25, `live-worker` 13, UI test +2 assertions. All VL-001…VL-004A tests pass unchanged. |
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
- **Source type.** «independent» now requires verifiable provenance (see audit fixes). A well-marked-up **sponsored** article on a third-party site would still pass — a residual risk.
- **Market signals.** These are page signals, not proof of legal registration or payment acceptance in Russia. A rival without a verified market is a «possible competitor»: it caps the RU dimensions at 3 and blocks absence claims, but it never refutes a claim or holds an idea. RYNTO and VAGLOGS are in this state in the corpus.
- **Public Suffix List.** The list bundled in `tldts` 7.4.22 ages with the package; update the dependency periodically.
- **Cost.** One run with the default bounds (3 new + 3 rechecks) cost about 55 ₽ on recorded data; the token counts are synthetic. Searches dominate (≈14 per candidate).
- **Pre-existing layout issue.** On the 1440 dashboard, the evidence-grade column of the TOP table scrolls inside its card (unchanged since VL-004A).

## VL-004B-prep — audit fixes (audit of `d49a831`)
| # | Finding | Fix | Tests (`server/test/live-prep.test.ts`) |
|---|---|---|---|
| **P1** | A failed probe (`ok:false` checks) still became a **succeeded** job, so stage 2 could run after a broken XML or model check. | The probe returns `{ passed, report, failure }`. The job is `succeeded` **only if all 6 required checks pass**. Otherwise it is `failed`: real usage is settled in the ledger and the next stage stays blocked by the existing stage-order check.<br>A failed stage is **never re-run implicitly**: only with an explicit `--retry`, which makes a new attempt in the same stage budget (5 ₽, at most 2 retries), without resetting costs. `--retry` on a succeeded stage is refused. | **PostgreSQL integration:**<br>• (a) **XML with 0 documents** → probe `failed`; all real calls are in `mr_usage` with costs > 0; attempt `failed` with `used` = cost; stage 2 is refused **before any provider or page request**, and no stage-2 job is created.<br>• (b) **invalid model JSON** in the minimal-schema check → `failed`; stage 2 is refused with 0 requests; a probe re-run without `--retry` is refused with 0 requests; with `--retry` → attempt 2 `succeeded`, the first attempt's costs are unchanged, and both attempts together stay ≤ 5 ₽; stage 2 is then allowed; `--retry` on a succeeded probe is refused. |
| **P1** | Raw responses could overwrite each other between stages: `seq` started from zero in one shared folder, and `writeFileSync` overwrote. | Path = `<raw>/trial_<id>_<stage>/attempt-<n>/<seq>-<host>-<status>.json`, derived from the request's **ledger id** (= `mr_usage.request_id`, also stored inside the record with job key and attempt). Files are created with O_EXCL (`wx`) and are **never overwritten**; an impossible clash is kept as a separate `-clash-` file and reported. | **Probe, stage 2, stage 3** in the **same** directory, each with a fresh transport, same hosts, HTTP 200:<br>• every record is kept, 1 file per provider request, 0 clashes;<br>• all earlier files are **byte-identical** afterwards (SHA-256);<br>• one folder per stage;<br>• the ledger ids of the records equal the `mr_usage.request_id` set exactly.<br>Unit test: the same ledger id twice leaves the original untouched and stores the clash separately. |
| P2 | Model independence | The gate refuses an analyst and skeptic from the same family **even with `VL_ALLOW_SINGLE_MODEL=true`**: degraded mode is never allowed for paid runs. | Probe and stage 2 are both refused with the «VL_ALLOW_SINGLE_MODEL здесь не действует» reason. |
| P2 | Fail-closed gate | `cfg = null` is always a problem («конфигурация live не загружена»), with or without `cfgError`. | Both variants assert `ok === false`, a non-empty problems list and the message (the old `toBeTruthy()` was replaced). |
| P2 | Symlinks | `assertOutsideRepo` compares the **real path** (`realpath` of the longest existing prefix plus the not-yet-existing tail) against the real repo root; `CapturingTransport` re-checks after `mkdir`. | A symlink outside the repo pointing into it is refused; a non-existent tail under such a link is refused; a transport on such a link is refused before anything is created. |

Checks:
- `lint` ✔, `typecheck` ✔, `build` ✔;
- **419 tests** (23 files) on PostgreSQL ✔, of which `live-prep` has 42;
- benchmark unchanged;
- the CLI still refuses `--execute --probe` without permission (exit 2, no request).

No change to scoring or research logic. **No paid request, no cloud resource, no deploy, no merge.**

## VL-004B-prep (2026-11-13) — offline preparation for the Phase B trial (no paid call)
Implemented on branch `claude/vl-004b-prep` (stacked on PR #7 → PR #6). Audit remarks on the plan addressed:

| # | Remark | Implementation | Tests (`server/test/live-prep.test.ts`, 35) |
|---|---|---|---|
| 1 | 5 + 60 + 240 ≠ 300 | Stages **5 + 60 + 235 = 300 ₽**. **Migration 008** adds `mr_trials`: an immutable trial budget and one job per stage, `trial:<id>:<stage>`. Every reservation and every top-up is capped by the trial's cumulative committed spend, under a per-trial advisory lock (lock order: trial → month → job). Stage order is enforced: probe → stage2 → stage3. | The stage caps sum to 300. A 10 ₽ trial binds stage 2 below its own 60 ₽ cap, and total committed spend stays ≤ 10 ₽. The trial budget is immutable (code and DB). A finished stage repeated costs 0 requests. |
| 2 | `--probe` must be as protected as `--execute` | One gate, `server/live/gate.ts`, for the probe and for stages. All of these are required:<br>• `--once --execute`;<br>• `VL_LIVE_EXECUTE=phase-b-authorized`;<br>• not in CI;<br>• config ready and independent model families;<br>• models with a pinned tariff;<br>• `VL_TRIAL_ID` and a trial budget ≤ 300;<br>• `--max-spend-rub` ≤ the stage cap;<br>• `--seeds` + `--no-discovery` for stages;<br>• no `--as-of`.<br>A refusal happens before any DB or network I/O. | 14 refusal cases + model, family and credential refusals. A **real CLI process** refuses `--probe` without `--execute`, without the flag, in CI, and a stage without seeds — exit 2, «ни одного запроса не сделано». |
| 3 | Search API 1 request/s, 429, parallel processes | `MinIntervalLimiter` (1100 ms; config cannot go below 1000) applies to **every HTTP attempt**, retries after 429/5xx included; concurrent callers are serialised. Parallel paid execution is **prohibited**: a host O_EXCL lock file (a stale lock of a dead pid is reclaimed) plus a DB session advisory lock for the whole run. | Virtual time: sequential and concurrent calls ≥ 1100 ms apart; 429 → retry → next query still spaced; a full pipeline run spaced ≥ 1100 ms. Lock file busy/stale; DB lock refuses a second paid run even with a different lock file. |
| 4 | Probe vs production schema | Probe = **transport** (plain completion, no `response_format`, `max_tokens` 16; auth, model URI and `usage`) + **minimal JSON schema** (2 fields, `max_tokens` 60) per model, plus one RU and one COM search. Production schemas are checked on the first candidate (gate C). | 6 checks pass on recordings; 2 searches + 4 model calls, all `max_tokens` ≤ 60; no page reads; ≤ 5 ₽; nothing published. |
| 5 | Seeds without discovery; no future dating | `seeds` with `discovery: false` → not a single discovery search or model call, and no incumbent rechecks. Live runs dated in the future are refused; `--as-of` is forbidden in paid mode. Two stages on the same real day do not conflict (distinct job keys). The DB trigger refuses snapshots of trial jobs. | No `discover_seeds` call and no discovery query; `mr_searches` has 0 discovery rows; probe and stage2 have the same real `as_of`; a future `as_of` is refused; a snapshot for a trial job is refused by the DB. |
| 6 | Raw responses | `CapturingTransport` writes **outside the git tree only** (a directory inside the repo is refused, even an ignored one), with modes 0700/0600. Redacted: key and IAM token (values + patterns), folder id, `Authorization` values, e-mails, phones. Request headers are never written. Search `rawData` is also stored decoded for parser review. | Redaction unit tests; repo paths refused; probe writes 6 files, none contains the key or folder id, all mode 0600, decoded XML present. |
| 7 | CSV export | `research:worker:export -- --live --trial <id> \| --job <key> --out file`. Rows by kind:<br>• assessment — state, score, grade, holds;<br>• source — URL, fetch status, source type, provenance and signals, uncertainty;<br>• competitor — kind, market, market status, signals, uncertainty, job evidence quotes, reason, price;<br>• claim — quote, cited and supporting sources, locations, checker status, skeptic verdict.<br>Empty reviewer columns follow; cells are guarded against formula injection. | The export contains GuestCom with its job quote, RYNTO with an `unknown` market, a claim with its quote, the independent review with verified provenance, and an assessment HOLD. |
| 8 | Plan update | `docs/vl-004b-phase-b-trial-plan.md` revision 2:<br>• stages 5/60/235 and one cumulative 300 ₽ ledger;<br>• a cumulative SQL check;<br>• a Billing budget of 300 ₽ with thresholds **5 / 65 / 150 / 240 / 300 ₽** tied to the stages;<br>• new env vars and runbook commands;<br>• the extended founder checklist. | — |

Also:
- `research/phase-b/seeds-stage2.json` (1) and `seeds-stage3.json` (4): hypotheses from the VL-003P corpus, validated by tests.
- The CI smoke covers probe refusals and the export.
- Existing live tests now use a virtual clock (the limiter is real) and a fixed «today» (no future dating).

Checks:
- `lint` ✔, `typecheck` ✔, `build` ✔;
- **412 tests** (23 files) on PostgreSQL ✔;
- benchmark unchanged;
- the fixture CLI is unchanged.

No UI change, so no new QA screenshots. **No paid request, no cloud resource, no deploy, no merge.**

## Phase B plan (2026-11-13)
- The plan for a bounded real-data trial is `docs/vl-004b-phase-b-trial-plan.md`; the manual review template is `research/reviews/phase-b-review-template.csv`.
- **No paid call is authorised.**
- Found while planning: the synchronous Search API quota is **1 request/s**, and the Phase A adapter did not rate-limit. Fixed by VL-004B-prep (above).

## Next
1. ChatGPT independent audit of this PR.
2. **Phase B** only after explicit founder authorisation of a provider account, a host and a one-time ceiling (proposed ≤ 500 ₽, **not authorised**). Steps: real search + model smoke on 3–5 candidates, capture real responses, compare with the 9-idea corpus, measure reachability from the host, reconcile with Yandex Billing.
