# BACKLOG — VL-004A / Autonomous Research Worker (no-VPN, fixture-first)
Status: QUEUED — NOT CURRENT
Owner: Founder + ChatGPT
Priority: High after VL-003P first real pilot
Spec: [docs/no-vpn-automation-architecture.md](../../docs/no-vpn-automation-architecture.md)

## Why
Replace manual delivery from the daily ChatGPT chat to Venture Lab with a **separate legitimate server-side scheduled research process**. Founder sees a daily provisional research feed + top-10, source and cost provenance, and maintains explicit approval of official REAL data. No user VPN.

## First engineering slice
1. Inspect actual `main` and current VL-003P pilot / data schema; plan forward-compatible migrations, do not overwrite already verified sources, snapshots, assessments, or founder approvals.
2. Implement `SearchProvider` / `LLMProvider` / `SourceReader` adapter interfaces using deterministic **fixture implementations** only.
3. Add `research_jobs`, `candidate_drafts`, `candidate_sources`, `research_job_usage`, and provisional daily ranking/snapshot data. Names can vary, but strict dataset separation, source provenance, model/version/cost, immutable approved history are required.
4. Implement safe idempotent schedule in `Asia/Novokuznetsk` and manual trigger `research:worker:run --fixture --as-of ...`. Prevent accidental double-run, record partial failures, budget caps and retry.
5. Workflow fixture: discovery → RU competitors → evidence → scoring proposal (same rubric, never impersonate human reviewer) → staging → provisional rank → review queue.
6. Add UI blocks to existing dark Research Journal/Overview for "**Автоматический ресерч — предварительно**", separate provisional TOP-10, last run status/freshness, source quality warnings, API cost. Approved REAL TOP-10 remains unchanged.
7. Test 3 days with fixture source changes, new direct RU competitor, missing pages, duplicates, injected instructions, provider failures, stale run, automatic score review flags, no REAL contamination and budget caps.
8. Preserve VL-001/2/3 tests and responsive UX; CI and screenshots. Handoff and PR to `main`, no merge.

## Exclusions
- No real Yandex account creation/keys or calling billable APIs (separate user approval for VL-004B).
- No production VPS, public deployment or automatic publishing of human-verified scores.
- No auto-edit of `approval`, `human-reviewed`, `checked` source statuses.
- No direct implicit access to scheduled ChatGPT chat output.
- No unapproved crawler or bypass of third-party services' terms; no VPN/proxy workarounds.
- Do not disturb currently active `tasks/current-task.md` while VL-003P is in progress.

## Clear next stages (not authorized here)
VL-004B: verify Yandex Search API world + RU queries, Yandex AI Studio models, official billable trial and budget with the founder's consent.
VL-004C: deploy secure Russian-accessible HTTPS app, backups, notification and 3-day pilot for real use.

## Acceptance
A local unattended scheduled fixture run reliably adds ONLY provisional candidates/drafts, with citations and transparent "AI-generated" labels, while REAL human-reviewed ranking stays intact; user has a polished clear preview of new findings. All tests pass.
