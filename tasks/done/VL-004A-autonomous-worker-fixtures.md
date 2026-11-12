# ARCHIVED — VL-004A / Zero-human Autonomous Research Worker (fixture-first)
Status: COMPLETED; PR #5 merged into main on 2026-11-12
PR: https://github.com/strace42-ai/Venture-lab/pull/5

# VL-004A / Zero-human Autonomous Research Worker (historical specification)
Status: COMPLETED
Owner: Founder + ChatGPT
Base: latest main with merged VL-003P PR #4
Suggested branch: `claude/vl-004a-autonomous-research-worker`
Priority: high — next engineering milestone
Source of truth: `docs/no-vpn-automation-architecture.md` v2.0; this active task supersedes the original VL-003P manual-review requirement.

## Product requirement (do not weaken)
**NO HUMAN RESEARCH APPROVAL LOOP.** Daily discovery, claim verification, challenger review, scoring, automatic rank changes, TOP-10 and publishing occur without asking founder to inspect links or approve the import. User interacts by opening a dashboard. Initial provider account credentials and a one-time spend ceiling may require user authorization; after setup, research is automatic.

## First engineering slice (fixtures only; no external charges)
1. Read all VL-001–VL-003 components, the existing scoring model, research importer and historical snapshots. Preserve legacy manually reviewed data; introduce a SEPARATE `machine-assessed` dataset and evidence statuses without lying about 'human checked'.
2. Implement provider adapter interfaces SearchProvider, SourceReader, LLMProvider, ClaimChecker and SkepticalReviewer with deterministic fixture providers. Provide multiple independent passes in orchestration even though fixture mode does not call an LLM.
3. Implement DB migrations for scheduler jobs, source/claim provenance, competitor-search coverage, machine-review decisions, assessment versions, auto TOP-10 snapshots, request/token/cost telemetry and typed dataset separation. Avoid building an unstructured generic JSON warehouse.
4. Schedule daily run in Asia/Novokuznetsk with an idempotent job key, bounded retries, stale/partial state and hard spend caps. Provide local trigger `research:worker:run --fixture --as-of ...`.
5. Full self-running workflow: discover new products → search Russia/adjacent substitutes → retrieve source claims → programmatic exact-source checks → independent skeptical critic / contradiction hunt → risk and evidence quality gate → compute rubric v1.0 score+confidence+FounderFit → append current assessment and old immutable snapshots → **publish automatic primary TOP-10**. No approval command.
6. UI: premium-dark dashboard with today's new ideas, **Автоматический TOP-10**, changes over time, evidence-grade and confidence, competitor changes, last successful run/failure indicator and costs. Keep legacy human-verified history in an optional clearly labeled separate view. Do not call AI check 'human verified'.
7. Automated hold/watchlist for claims with broken URLs, contradicting sources, weak RU competitor coverage or material market risks. Not enough qualifying ideas = N/10. No made-up full top ten.
8. Test three sequential days (new competing RU analogue lowers an old idea's rank; material source rejection withdraws recommended status, automatic re-research requalifies if evidence arrives); test idempotency, no history mutation, source type/vendor self-report, page access errors, injection attempt, rate/budget cap and dataset isolation.
9. Run all VL-001–VL-003 regressions; CI, screenshots 390/1440, handoff, PR, no merge.

## Explicit exclusions
- No live Yandex/other paid API, user account creation or charge; those require a separately authorized VL-004B experiment.
- No production VPS/deploy yet; no unauthenticated public write endpoints.
- No fabrication of `human-reviewed`, `approval`, or `checked by human`; **machine evidence passing has its own DB state**.
- No automatic chat-to-database bridge assumption; autonomous worker runs independently of ChatGPT conversations.
- No unapproved crawler/terms bypass, VPN evasion, public messages or customer outreach.
- VL-003P is already merged and archived. Do not reintroduce its human-review gate into the machine dataset; keep the old path for backward compatibility.

## Required engineer workflow
- Read `CLAUDE.md`, this task, architecture v2.0, `docs/scoring-model.md`, existing `server/research` implementation and VL-003P research corpus; inspect database migrations/tests before coding.
- **Implement an end-to-end vertical slice, not just a document or mock front-end**: durable PostgreSQL job + evidence + machine assessments + snapshot + read API + premium UI. Initial data may be deterministic fixtures; never call it live discovery.
- Preserve integrity flags across both machine and legacy modes; newly discovered Russian direct competition must be able to invalidate the machine recommendation and automatically lower eligibility.
- Test reboot/retry recovery and simultaneous/duplicate job attempts. No user-visible fictitious verified claim or manufactured 10th item.
- Keep current demo/test/manual REAL labels explicit; new machine research is the primary future dashboard mode but must not relabel old rows as system checked.
- Run CI/lint/typecheck/tests/build and screenshot QA at 390/1440; report any unavailable Docker/real-device testing honestly.
- Work in branch off latest `main`; commit and push code; open PR for independent ChatGPT audit; **DO NOT MERGE**.

## Exit test
A single `--fixture` command launches a fully automatic multi-agent emulation, creates a date-stamped source-grounded machine TOP-10 without human clicks, preserves last successful rank on failure, and displays results in the dashboard, while avoiding accidental inclusion of demo or legacy manual records.

## Next stages
VL-004B: founder configures lawful provider credentials and a one-time spending cap; conduct bounded paid real-source smoke tests.
VL-004C: deploy app + scheduler securely with HTTPS access from Russia without VPN and backup/observability.
