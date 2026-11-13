# Live providers — operator setup (VL-004B)

**Status: Phase A.** The adapters are implemented and tested on recorded HTTP only. **No paid request has been made**, and none can be made until the founder authorises Phase B (a specific Yandex Cloud account, an execution host and a one-time trial ceiling). Live mode is off by default.

The research workflow itself stays zero-human: once a run is started it searches, reads, checks, scores and publishes without any approval step. The only human actions are one-off operator setup and authorising money.

## What gets called

| Purpose | Endpoint (official) | Docs (checked 2026-11-12) |
|---|---|---|
| Web search, Russia (`SEARCH_TYPE_RU`, region 225) and worldwide (`SEARCH_TYPE_COM`) | `POST https://searchapi.api.cloud.yandex.net/v2/web/search` → `{ rawData: base64(XML) }` | [web search](https://aistudio.yandex.ru/ru/docs/search-api/concepts/web-search), [REST reference](https://aistudio.yandex.ru/ru/docs/search-api/api-ref/WebSearch/search), [pricing](https://aistudio.yandex.ru/ru/docs/search-api/pricing) |
| Analyst, discovery and offer extraction: **Qwen3.6 35B** `qwen3.6-35b-a3b` | `POST https://ai.api.cloud.yandex.net/v1/chat/completions` (OpenAI-compatible), `model: gpt://<folder_ID>/<model>` | [models](https://aistudio.yandex.ru/ru/docs/ai-studio/concepts/generation/models), [request](https://aistudio.yandex.ru/docs/en/ai-studio/operations/generation/completions-basic), [pricing](https://aistudio.yandex.ru/ru/docs/ai-studio/pricing) |
| Independent skeptic, different family: **DeepSeek V4.1 Flash** `deepseek-v4.1-flash` | same endpoint | DeepSeek V4 Flash (`deepseek-v4-flash`) is deprecated and switched off on 2026-11-15; the config refuses it |
| Public web pages | direct HTTPS fetch through the SSRF-safe reader | robots.txt is honoured |

Tariffs reserved before each call (RUB incl. VAT, `yandex-2026-11-12`):
- search: 488 ₽ / 1000 synchronous daytime requests, so **49 kop per request** (the night rate of 366 ₽ is not assumed);
- Qwen3.6 35B: 0.20 / 0.30 ₽ per 1000 input / output tokens;
- DeepSeek V4.1 Flash: 0.30 / 0.50 ₽ per 1000 input / output tokens.

Search 5xx and authorization errors are documented as not billed. If a tariff changes, update `server/live/prices.ts` and its version string. A model with no tariff is never called.

## One-time setup (Phase B, by the operator — not now)

1. **Yandex Cloud.** Create (or choose) a cloud and a folder, and link a billing account. Note the folder ID.
2. **Service account** in that folder with the minimal roles:
   - `search-api.webSearch.user` — Search API;
   - `ai.languageModels.user` — text generation.

   Re-check the role names in the console; they are not shown in the API references above.
3. **API key** for the service account, scoped to these services where the console offers scopes. Alternatively, issue short-lived IAM tokens on the host.
4. **Spend control in Yandex Cloud Billing.** Create a budget with alert thresholds for the trial amount. Read [cost-control recommendations](https://yandex.cloud/ru/recommendations).

   **The application cap is not a provider billing guarantee:** it bounds what *this program* reserves, and it cannot stop Yandex from billing a request that was already sent.
5. **Execution host secrets.** Set the variables only in the host's secret store or shell. Never in git, `.env` files committed to the repo, chat, logs or screenshots.
   ```bash
   export VL_LIVE_PROVIDER=yandex
   export YANDEX_FOLDER_ID=<folder id>
   export YANDEX_API_KEY=<secret>      # or YANDEX_IAM_TOKEN
   export VL_LIVE_EXECUTE=phase-b-authorized   # separate activation flag; set only after Phase B is authorised
   ```
   **Claude Code cloud environment (network secrets).** Here the real key never enters the container:
   - **Where the key lives.** The environment stores it as a *network secret* for each host: header `Authorization`, prefix `Api-Key`.
   - **What the app sends.** `YANDEX_API_KEY` holds a dummy value, so the app sends `Authorization: Api-Key <dummy>`.
   - **Who substitutes the key.** The agent proxy named in `HTTPS_PROXY` replaces the dummy, but **only for requests sent through it**:
     - the provider transport (`server/live/net/provider-proxy.ts`) sends exactly the two paid endpoints through a CONNECT tunnel when `HTTPS_PROXY` is set:
       - `searchapi.api.cloud.yandex.net/v2/web/search`;
       - `ai.api.cloud.yandex.net/v1/chat/completions`;
     - without `HTTPS_PROXY` it connects directly, as before;
     - a malformed or non-`http://` `HTTPS_PROXY` is refused before any request.
   - **Web reader.** The web reader never uses the proxy, and its SSRF guard, DNS pinning and robots.txt are unchanged.
   - **TLS.** TLS is verified with Node's trust store: the proxy CA must be trusted. In this environment `NODE_OPTIONS=--use-openssl-ca` already does that. Elsewhere, set `NODE_EXTRA_CA_CERTS` to the proxy CA bundle; never disable verification.
   - **Dry-run.** `--dry-run` prints the route («Маршрут платных запросов»).
   - **What the tests do not prove.** The offline tests show that the tunnel is used. Only an authorised real request shows that the secret is substituted.

6. **Network allowlist on the host.** The host needs outbound HTTPS to:
   - `searchapi.api.cloud.yandex.net`;
   - `ai.api.cloud.yandex.net`;
   - the public web (for reading sources).

   The reader refuses private, loopback, link-local and metadata addresses by itself.

## Commands

```bash
# Phase A — safe anywhere, no network request of any kind:
npm run research:worker:run -- --live --once --dry-run [--as-of YYYY-MM-DD]
#   prints: config (secrets hidden), readiness problems, tariffs, call bounds, worst-case cost
npm run research:benchmark            # offline benchmark of the guardrails on recorded HTTP
npm test                              # includes the recorded-HTTP live tests

# Phase B ONLY, after explicit founder authorisation, on the approved host (plan: docs/vl-004b-phase-b-trial-plan.md):
#   env: VL_LIVE_EXECUTE=phase-b-authorized, VL_TRIAL_ID=<id>, VL_TRIAL_BUDGET_RUB=300 (cumulative for ALL stages)
npm run research:worker:run -- --live --once --execute --probe --max-spend-rub 5
npm run research:worker:run -- --live --once --execute --stage stage2 --seeds research/phase-b/seeds-stage2.json --no-discovery --max-spend-rub 60
npm run research:worker:run -- --live --once --execute --stage stage3 --seeds research/phase-b/seeds-stage3.json --no-discovery --max-spend-rub 235
npm run research:worker:export -- --live --trial <id> --out review.csv
npm run research:worker:status -- --live
```

`--execute` is refused when `VL_LIVE_EXECUTE=phase-b-authorized` is not set (credentials alone never enable paid calls), and when:
- `VL_LIVE_PROVIDER` is not `yandex`, or the folder or credentials are missing;
- the analyst and the skeptic come from the same model family. The exception is `VL_ALLOW_SINGLE_MODEL=true`: then every candidate is held as `single-model-degraded` and nothing is presented as independent review;
- it runs in CI;
- `--max-spend-rub` is missing.

Every paid action, `--probe` included, passes one gate (`server/live/gate.ts`):
- the trial's **cumulative** ceiling (≤ 300 ₽, immutable once created) caps every reservation and every top-up;
- stage ceilings are 5, 60 and 235 ₽, and stages run strictly in that order;
- trial stages are dated with the real day and never publish into the live TOP-10;
- Search API calls go out at most once per 1.1 s, retries included;
- two paid runs never overlap: a host lock file plus a DB advisory lock;
- raw provider responses are saved redacted, outside the git tree only.

`--max-spend-rub N` is the hard ceiling for that job, in kopecks in the ledger. `VL_LIVE_MONTHLY_BUDGET_KOP` caps the month. There is no scheduled live run: `tick --live` is refused in Phase A.

## Reasoning models (VL-004B-reasoning)
Both trial models reason by default. They return `message.reasoning_content`, and the reasoning tokens are part of `completion_tokens` and of `max_tokens`. The probe of 13.11.2026 showed the risk: Qwen3.6 spent the whole `max_tokens` on reasoning, so `content` was empty.

The policy is in `server/live/reasoning.ts`:
- **Simple JSON operations** (`probe_schema`, `extract_offer`):
  - use `reasoning_effort: "none"`, but **only** once the model's profile says the mode is `verified`;
  - until then, `max_tokens` = answer + a reasoning reserve: 1024 for the probe, 2048 for extraction.
- **Reasoned operations** (`discover_seeds`, `analyse_candidate`, `skeptic_challenge`) keep the model default and get a 4096-token reserve.
- **The worst-case reservation** uses the `max_tokens` actually sent, including the reserve, so the spending bound covers reasoning.
- **Only `content` counts.** An answer is accepted only as JSON in `content` that passes the schema. `finish_reason=length`, empty content or JSON found only in `reasoning_content` are rejected and reported.
- **What is verified, as of 2026-11-13:**
  - the Yandex docs say the Qwen family can turn reasoning off, but they do not name the value;
  - the official SDK (`yandex-ai-studio-sdk` 0.22.1) sends `reasoning_effort` with low / medium / high only;
  - DeepSeek reasoning control is not documented by Yandex.

  `none` is therefore **unverified** for both models. The probe checks it with one non-required diagnostic call per model. The result is `disabled`, `ignored`, `rejected` or `inconclusive`. Production does not use `none` until a separate change marks it `verified`.

## Bounds and costs of one run

The run's bounds are configurable:
- `VL_LIVE_MAX_NEW` new candidates (default 3);
- `VL_LIVE_MAX_RECHECKS` incumbents re-researched (default 3; the least recently assessed go first);
- `VL_HITS_PER_QUERY` / `VL_EVIDENCE_HITS` pages read per query;
- `VL_MAX_COUNTER_QUERIES` skeptic queries;
- `VL_MAX_*_PER_RUN` hard call counters.

A recent PASSED assessment of an incumbent that was not re-researched (≤ `VL_LIVE_CARRY_DAYS`, at most 30) stays in the TOP. It is shown with its own date as «не перепроверялась».

Before every paid call the worker reserves a **worst case**:
- input tokens ≤ UTF-8 bytes of the prompt plus framing;
- output ≤ `max_tokens`;
- searches at the daytime tariff.

After the response it **reconciles**:
- LLM calls from `usage` × tariff;
- searches from the tariff;
- 5xx / auth errors on Search as not billed.

The cost stays at the worst case («unknown») when:
- there is a timeout;
- an LLM call returns 5xx or 429;
- `usage` is missing.

If the reported usage exceeds the bound, that is an **anomaly**: the run stops making paid calls and fails, and the observed value is kept for audit.

## Revoking access and checking real charges

- **Revoke:** delete the API key (or the service account) in the console, and unset the variables on the host. Live mode then refuses to start.
- **Real charges:** Yandex Cloud Billing → the billing account → «Детализация» by service (Search API, AI Studio). Compare them with `mr_usage`:
  - `estimated_cost` / `cost` / `actual_cost`;
  - `reconciliation`;
  - `provider_request_id`.

  The dashboard's «Диагностика последнего прогона» shows reserved → charged. The provider's bill is authoritative.

## Known limits of Phase A
- **Search XML.** The XML parser follows the classic Yandex XML layout (`yandexsearch/response/results/grouping/group/doc`) and is tolerant to missing fields. A real response has not been captured yet; capture one in Phase B and add it to the recordings.
- **AI Studio JSON.** `response_format: json_schema` support in AI Studio for these models is documented only in general terms. If it is rejected, use `VL_LLM_RESPONSE_FORMAT=json_object` or `none`. The output is validated with Zod either way.
- **Unsupported content.** PDFs and JavaScript-only pages are recorded as `unsupported_content`, never guessed. There is no headless browser.
- **Reachability.** Foreign primary sites may not be reachable from a Russian host. This is to be measured in Phase B from the proposed host.
- **Market signals.** These are page signals, not proof that a product is registered in Russia or accepts payment there. Rivals without them are shown but not counted, which can under-count real competition until a later rotation finds a signal.
- **Independence.** «Independent» relies on publication markup and an identified publisher. A well-marked-up sponsored article on a third-party site would still pass — that is a residual risk for Phase B review.
