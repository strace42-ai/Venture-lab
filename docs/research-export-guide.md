# Research export guide — how ChatGPT / Claude prepare a `vl-research-1` draft

Version 1.0 (VL-003). Matches `server/research/schema.ts` exactly; when the two disagree, the code wins.
Template: [`research/templates/vl-research-1.ai-draft.template.json`](../research/templates/vl-research-1.ai-draft.template.json).
Field reference: [`docs/research-import-format.md`](research-import-format.md).

> **There is no automatic exchange with ChatGPT.** The 08:00 research automation only sends a chat report.
> It writes nothing to GitHub or to the local PostgreSQL. Every step below is manual and explicit.

## The pipeline (draft → review → approval → import)

| Step | Who | Command / action | What it proves |
|---|---|---|---|
| 1. Draft | ChatGPT / Claude / researcher | Save JSON to `research/drafts/<runId>.json` with `"source": "ai-draft"` | Nothing. It is a candidate. |
| 2. Check the draft | Operator | `npm run research:draft-check -- research/drafts/<file>.json` | Schema, coverage gaps, duplicates, overlap with REAL. **Not** truth. |
| 3. Human review | Founder | Open every URL, confirm the claim is on the page, check RU competitors exist | The research is fit for import. |
| 4. Approval | Founder | Change `source` → `human-reviewed`, add `approval {approvedBy, approvedAt, statement}`, move file to `research/inbox/` | Founder sign-off, stored in `import_runs`. |
| 5. Dry-run | Operator | `npm run research:import -- research/inbox/<file>.json` | Exact diff against the DB. |
| 6. Apply | Operator | `npm run research:import -- research/inbox/<file>.json --apply` | One transaction into REAL. |
| 7. Source review | Founder | `npm run research:review -- --dataset real --idea <externalId> --evidence <id> --status checked --reason "…" --actor "…" [--apply]` | One source was checked by a person. Appended, never overwrites. |
| 8. Snapshot | Operator | `npm run research:snapshot -- --dataset real --apply` | Frozen top-10 for the history comparator. |

The importer **refuses to apply** (gate, exit code 1):
- any file with `"source": "ai-draft"`;
- any file located under `research/drafts/`;
- a `human-reviewed` file without the `approval` block.

Sources imported as `checked` are downgraded to `unreviewed` unless they carry `url + publisher + observedAt`
**and** a per-source `reviewedBy` (the person who opened the link). An import never overrides a manual review
made with `research:review`.

## Rules for the AI author

1. **`"source": "ai-draft"`, `"synthetic": false`, every source `"verificationStatus": "unreviewed"`, no `reviewedBy`
   on sources.** The schema rejects an ai-draft that claims a checked/rejected source. An AI never verifies its own
   citations.
2. **Only real, openable URLs** you actually retrieved in this session. Give `publisher`, `title`, `observedAt`
   (the day you opened it) and, when visible, `publishedAt`. If you could not open a page, do not cite it.
3. **One source = one concrete claim.** `claim` states what the page says, `supportNote` says why it supports
   the idea *and its limits* (e.g. "company self-report", "marketing page, no figures").
4. `sourceType`: `independent` (press, research, registries), `company_self_report` (vendor site, press release,
   pricing page), `primary_data` (your own measured data), `unknown`.
5. **Both sides of the competition**: `westernProducts` (the analogue that proves demand) and
   `russianCompetitors` (what exists in RU and its `gap`). Write in `coverage` where and how you searched RU
   (queries, marketplaces, catalogs). "Not found" is a finding only together with how you searched.
6. **Prices are hypotheses.** `priceHypothesis` must not read like a measured conversion or revenue.
7. **No scores by default.** Leave `"assessment": null`. The founder adds an assessment after review. If an
   assessment is included, it must use all 12 keys (`null` = unknown, never 0 for "didn't look"),
   5 confidence fields 0–100, `rubricVersion: "v1.0"`, a rationale and `evidenceIds` that exist. Never invent
   totals: `score`/`total` keys are rejected.
8. 1–10 ideas per run, unique `runId` (`^[a-z0-9][a-z0-9._-]{2,99}$`), stable `externalId`
   (never reuse one for a different idea; never derive it from a translated title).
9. `limitations` must say what was **not** verified. Do not fill the top-10: an honest N/10 is the expected result.
10. No personal data of private individuals, no paywalled/proprietary documents pasted into the file.

## Rubric keys (for `dimensions` and `assessment.scores`)

`westernNeed`, `westernPay`, `ruWeakness`, `ruUnmetJob`, `monetization`, `speedToPilot`, `mvpFeasible`,
`fastTest`, `distribution`, `retention`, `defensibility`, `riskManageable` — see `docs/scoring-model.md`.

## What `draft-check` reports

- `invalid` — the schema rejected the file (errors listed with JSON paths).
- `needs-work` — the file parses, but has blocking gaps (e.g. an idea without a single source).
- `ready-for-founder-review` — no blocking gaps. **Warnings are still printed and must be read**: an idea has no
  RU source / no RU competitor, a source lacks URL, publisher or observedAt, no assessment, unknown (`null`)
  rubric criteria, duplicated URLs (duplicates may be legitimate), or a URL that already exists in the REAL
  dataset. **This verdict never means the claims are true.**

## Approval block (step 4)

```json
"source": "human-reviewed",
"reviewedBy": "Имя основателя",
"approval": {
  "approvedBy": "Имя основателя",
  "approvedAt": "2026-11-12",
  "statement": "Открыл все ссылки, утверждения на страницах есть, конкуренты в РФ проверены вручную."
}
```
