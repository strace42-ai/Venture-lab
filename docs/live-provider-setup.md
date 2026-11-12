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
   ```
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

# Phase B ONLY, after explicit founder authorisation, on the approved host:
npm run research:worker:run -- --live --once --execute --max-spend-rub 500 [--as-of YYYY-MM-DD]
npm run research:worker:status -- --live
```

`--execute` is refused when:
- `VL_LIVE_PROVIDER` is not `yandex`, or the folder or credentials are missing;
- the analyst and the skeptic come from the same model family. The exception is `VL_ALLOW_SINGLE_MODEL=true`: then every candidate is held as `single-model-degraded` and nothing is presented as independent review;
- it runs in CI;
- `--max-spend-rub` is missing.

`--max-spend-rub N` is the hard ceiling for that job, in kopecks in the ledger. `VL_LIVE_MONTHLY_BUDGET_KOP` caps the month. There is no scheduled live run: `tick --live` is refused in Phase A.

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
