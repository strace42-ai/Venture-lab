# Research import format — `vl-research-1`

The exact contract implemented by `server/research/schema.ts` (Zod) and `server/research/importer.ts`.
It refines the illustration in `docs/research-engine-contract.md`. **Every object is strict: unknown
keys are rejected.** One effect of this is that user-supplied totals (`score`, `total`, …) can never
be imported. Scores are always recomputed from the raw components by `src/domain/scoring.ts`.

Examples: `research/examples/synthetic-run-1.json` and `synthetic-run-2.json`. Both are **synthetic
test data**: `source: "synthetic-test"`, links only to the reserved domains example.org/example.com,
and titles prefixed «Тест:».

## Envelope

| Field | Type | Required | Notes |
|---|---|---|---|
| `schemaVersion` | `"vl-research-1"` | ✔ | Any other value is rejected. |
| `runId` | string `^[a-z0-9][a-z0-9._-]{2,99}$` | ✔ | Idempotency key together with the file's SHA-256. |
| `researchedAt` | `YYYY-MM-DD` | ✔ | Research date. Not in the future. Default effective date for stage changes. |
| `source` | `"human-reviewed"` \| `"synthetic-test"` | ✔ | REAL research must be `human-reviewed`. |
| `synthetic` | boolean | ✔ | Must be `true` for `synthetic-test` and `false` for `human-reviewed`. |
| `reviewedBy` | text ≤120 | ✔ | Who reviewed the research. Becomes the actor of stage transitions. |
| `title`, `coverage`, `limitations` | text | — | Shown in «Исследовательские прогоны». |
| `markets` | text[] ≤30 | — | |
| `sourceReferences` | http(s) URL[] | — | |
| `ideas` | Idea[] (1–500) | ✔ | |

## Idea

| Field | Type | Required | Notes |
|---|---|---|---|
| `externalId` | `^[a-z0-9][a-z0-9-]{1,79}$` | ✔ | Stable dedup key. Never use the title for this. |
| `slug` | same pattern | — | Defaults to `externalId`. **Cannot change** after the first import. |
| `title` (3–200), `pitch` (≤1000), `segment` (`B2B`\|`B2C`), `category` (≤60) | | ✔ | |
| `geography` | text | — | Default `Россия`. |
| `targetPersona`, `problem`, `ruUnmetJob`, `whyNow`, `thesis`, `monetization`, `priceHypothesis`, `distribution`, `mvp`, `nextAction` | text \| null | — | Descriptive fields. A later run may refresh them; every version is kept in `idea_revisions`. |
| `excludedFeatures`, `originMarkets` | text[] | — | |
| `riskFlags` | enum[] | — | `legal`, `lockedApi`, `demandUnverified`, `coldStart`, `networkEffect`, `lowRetention`, `dataPrivacy`, `highCogs`, `competitionUnverified`. |
| `stage` | lifecycle enum | — | When omitted: `scored` if the idea has an assessment, otherwise `researching`. An existing idea that receives a new assessment moves from discovered/researching to `scored`. A change is appended as a transition. |
| `stageReason` | text | for `rejected` | |
| `stageChangedAt` | `YYYY-MM-DD` | — | Defaults to `researchedAt`. Must not be earlier than the previous transition. |
| `sources` | Source[] ≤200 | — | Default `[]`. |
| `westernProducts` | WesternProduct[] | — | Stored as competitors with market `west`. |
| `russianCompetitors` | Competitor[] | — | |
| `assessment` | Assessment \| null | — | **Optional.** When it is absent, the idea is shown as «не оценено» and is not ranked. |

## Source (evidence)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `^[a-z0-9][a-z0-9._-]{0,63}$` | ✔ | Unique within the idea. **Immutable**: changed content under the same id is a conflict. |
| `region` | `west` \| `ru` | ✔ | |
| `claim` | text ≤1000 | ✔ | The source-linked claim. |
| `url` | http(s) URL | — | Credentials and non-http schemes are rejected. The fragment is dropped. |
| `title`, `publisher`, `supportNote` | text | — | |
| `sourceType` | `independent` \| `company_self_report` \| `primary_data` \| `unknown` | — | Default `unknown`. |
| `language` | ISO 639-1 | — | |
| `publishedAt`, `observedAt`, `retrievedAt` | `YYYY-MM-DD` | — | Must not be in the future. |
| `dimensions` | rubric keys[] | — | Rubric criteria the claim supports. |
| `verificationStatus` | `unreviewed` \| `checked` \| `rejected` | — | Default `unreviewed`. A `checked` source without **url + publisher + observedAt** is stored as `unreviewed`, and the import prints a warning. A status change on identical content is appended to `evidence_reviews`. |

## WesternProduct / Competitor

`id`, `name` (required), `url`, `kind` (`direct`\|`adjacent`\|`substitute`; required for RU
competitors), `coverage` (`high`\|`partial`\|`low`\|`unknown`), `functions`, `gap` (RU) / `note`
(West), `observedAt`, and `evidenceIds` (must reference this idea's sources). These records are
immutable: a changed record under the same id is a conflict.

## Assessment (append-only revision)

| Field | Type | Required | Notes |
|---|---|---|---|
| `assessedAt` | `YYYY-MM-DD` or ISO datetime with offset | ✔ | Not earlier than the latest stored assessment of the idea. |
| `assessor` | text | ✔ | |
| `rubricVersion` | `"v1.0"` | ✔ | Other versions are rejected. |
| `scores` | object with **all 12** keys → `0..5` or `null` | ✔ | `null` means unknown: it gives 0 points and is shown as «?». It is never treated as evidence of absence. |
| `confidence` | `{completeness, corroboration, recency, reliability, russiaValidation}` 0..100 | ✔ | Weighted 30/25/15/20/10. |
| `founderFit` | `{skills, access, timeToSale (0..10), motivation, synergy (0..5)}` \| null | — | Diagnostic only. Not part of the rank. |
| `rationale` | text 20..4000 | ✔ | |
| `evidenceIds` | id[] ≥1 | ✔ | Must reference this idea's sources. The import warns when they are unreviewed. |
| `unknowns` | text[] | — | |
| `revisionReason` | text | — | |

Re-importing an identical assessment is a no-op (content hash). A different assessment is
appended as a new revision. Earlier revisions are never updated: database triggers forbid
UPDATE and DELETE on them.

## Idempotency and conflicts

| Situation | Result |
|---|---|
| Same `runId`, same bytes | `already-imported`, nothing changes |
| Same `runId`, different bytes | `conflict`, nothing is written. Use a new `runId`. |
| Any validation or plan error in any idea | Whole file rejected, nothing is written |
| Unexpected failure while writing | Transaction rolled back (tested with fault injection) |
| Existing synthetic idea in a human-reviewed file (or the other way round) | Rejected: synthetic and real data are never mixed |

## Commands

```bash
npm run research:validate -- research/inbox/file.json          # schema only, no DB
npm run research:import   -- research/inbox/file.json          # dry-run diff (default)
npm run research:import   -- research/inbox/file.json --apply  # one transaction
npm run research:snapshot -- [--as-of YYYY-MM-DD] [--id top10-...] [--apply]
```

Only `.json` files inside `research/` can be read (symlink escapes are blocked; maximum 5 MB).
