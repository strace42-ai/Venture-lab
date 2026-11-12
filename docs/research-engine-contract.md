# Research Engine — Data Contract & Ingestion v1 (for VL-002)

## Product outcome
Convert documented research into a persistent, auditable opportunity database that feeds the existing premium UI. A valid research item should be usable in Radar/dossier, carry traceable Western/RU evidence, be scored with the EXACT existing rubric, and have a stable history of assessments and TOP-10 positions.

## Two explicitly different modes
1. **DEMO**: current typed synthetic fixture from VL-001, clearly labeled as demo. Remains selectable in development only. Never count demo as factual market discovery or payment.
2. **REAL**: actual human-reviewed research records imported from versioned JSON files. Only real mode can show non-demo metrics, and only for confirmed records. Never silently mix real and demo ideas, snapshots or counts. Empty REAL mode shows an honest "No imported research yet" state.

## Research discovery workflow now vs later
- Today: ChatGPT creates a detailed research report in conversation. Via linked GitHub, ChatGPT/founder can separately commit a machine-readable research JSON into `research/inbox/`; this requires a distinct action and does **not** happen automatically because an automation ran.
- VL-002: CLI/API validates and imports that JSON to local persistent database. Founder can inspect the dry run and approve actual import. No LLM calls, scheduled execution or expensive APIs.
- Later: scheduled research → structured export → review queue → import → snapshots. This requires separate automation/integration work and authorization.
- Never scrape the conversation or claim access to scheduled task results without an actual integration.

## Canonical object model (choose normalized tables with clear constraints)
- Idea: stable ID, slug, title, pitch, target persona, problem, category, segment, origin markets, Russia-specific unserved job, why now, monetization hypothesis, price hypothesis, distribution, MVP, excluded features, risks, created/updated timestamps.
- Lifecycle transition: immutable event (idea ID, stage, effective timestamp, actor, reason); stage as of historical snapshot must be reconstructible.
- Assessment: immutable version (idea, rubric_version, assessed_at, assessor, **12 raw values 0–5 or unknown**, 5 confidence dimensions 0–100, founder fit 5 components, rationale, associated evidence IDs, unknowns, revision reason). Sum with existing `src/domain/scoring.ts`, don't copy formulas into a second algorithm. Model version is immutable per assessment.
- Evidence: immutable original claim with source URL, publisher, source title, published_at optional, observed_at, retrieved_at, source type (independent | company_self_report | primary_data | unknown), region (west | ru), source language, confidence, verification status (unreviewed | checked | rejected), affected dimensions and text explaining support. Missing source is **unverified claim** and must not look like corroborated evidence. Avoid unsupported numbers.
- Competitor: stable ID, linked idea, name, verified URL, target market, direct/adjacent/substitute, observed date, functions/coverage, specific gap and source evidence IDs. "Not found in checked sources" is NOT "no competition".
- Research run: unique run ID, date, source references, discovered/updated/rejected idea IDs, search coverage, limitations; may include candidate submissions pending review.
- Top-10 snapshot: snapshot ID, period/as-of timestamp, locked rubric version, ordered entries with idea ID, score, confidence, rank; source run/import ID, created_at. Never rewrite past snapshots during today's import; movement calculated from previous **stored snapshot**.
- Import run: immutable record of input file checksum, schema version, imported/unchanged/rejected counts, timestamps, validation diagnostics, origin and actor.

## Suggested import envelope v1
Use a documented Zod schema and ship versioned JSON examples in `research/examples/`. Use external key/idea slug rather than title for dedup.

```json
{
  "schemaVersion": "vl-research-1",
  "runId": "research-2026-11-12-manual-001",
  "researchedAt": "2026-11-12",
  "source": "human-reviewed",
  "ideas": [
    {
      "externalId": "example-idea-1",
      "title": "Название идеи",
      "pitch": "Краткая проблема и решение",
      "segment": "B2B",
      "category": "SMB-сервисы",
      "westernProducts": [{"name": "Example", "url": "https://example.org"}],
      "russianCompetitors": [],
      "sources": [{"url": "https://example.org", "publisher": "Example", "observedAt": "2026-11-12", "claim": "Проверенная формулировка", "verificationStatus": "unreviewed"}],
      "assessment": null
    }
  ]
}
```

**This is a schema illustration, not a claim that example.org is an actual competitor.** Expand schemas only where needed and document exact supported fields; make optionality explicit. Prefer real constraints, not a giant generic JSON column; JSONB is acceptable for versioned score components with validation.

## Data integrity rules
1. Import is **dry-run by default**; explicit `--apply` writes to DB; single DB transaction or safe batch with complete rollback on malformed input. Provide before/after summary.
2. Same `runId` + same checksum = idempotent no-op. Same runId with different bytes must conflict; never overwrite provenance.
3. Deduplicate by stable externalId/slug, use URL canonicalization only within grounded normalization rules, never auto-merge similar but distinct ideas.
4. Scores must be computed from component values and persist raw assessment, never import user-supplied aggregate as authority. Reject inconsistent rubric versions.
5. Unknown component remains null with visible unknown marker and confidence penalty/limitation. Assessment must include rationale/evidence association. No fake score caused by absent components.
6. Imported unreviewed source claims must show **unreviewed** in UI; a website containing text is not independent proof the claim is accurate.
7. Separate actual recorded payment evidence from claimed/pending/synthetic experiment figures. VL-002 does not import private customer or payment records.
8. Version and append all assessments/stages and keep previous top-10 snapshots immutable. Never recalculate old movement from current status.
9. Validate dates, URL scheme, numerical ranges, length limits, unique keys and referenced IDs; guard against malformed JSON and script injection; render text safely.
10. Time zones and provenance: store UTC instants for events, ISO date only for research period; labels display the correct snapshot date.
11. Imports of sources must never automatically transmit proprietary or personal documents to third-party AI APIs.
12. If REAL database is empty or unavailable, show explicit empty/error state, never pretend to be fresh.

## Query contract
Implement a minimal read-only API for `/api/health`, `/api/overview`, `/api/ideas`, `/api/ideas/:id`, `/api/research-runs`, `/api/top10` (or equivalent, documented). Support filtering/pagination for idea list and return evidence links with provenance and review status. Make the UI data adapter support demo and persistent modes explicitly.

## Testing requirements
- Database migration from clean state, rollback path / rebuild instructions, persistence across server restarts.
- Import validation, no-write dry-run, first import, duplicate import, conflict on changed runId, partial invalid batch atomicity, updates append history.
- Historical stage transition and assessment changes preserve previous snapshot ranks.
- Missing URL / missing publisher / missing date => not verified; malformed URLs fail.
- Scoring totals and Top-10 consistent with existing VL-001 unit tests; test mode separation and empty/live error states.
- Query freshness and non-fabricated source display.
- Threat model: local-only DB/API, no public deployment without auth, CORS restricted, no secrets committed, no arbitrary file path reads.
- CI should run lint, typecheck, tests and build; integration tests must use isolated test database.

## Non-goals in VL-002
No automated ChatGPT/Claude APIs, web search, crawler, nightly fetching, unattended research/scoring, payment processing, customer outreach, cloud production deployment, full Experiment/Portfolio CRUD, multi-tenancy or complex user management. No data migration from hidden/past chats. API isn't publicly exposed.

## Exit outcome
Founder can put a reviewed research JSON file in `research/inbox/`, run one documented validation/import command, refresh the app in REAL mode and see sourced opportunities with correctly recomputed current ranking and stored snapshots. GitHub repo stays the durable handoff; DB is local, not auto-synced by GitHub without a running importer.
