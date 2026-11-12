# Venture Lab — Delivery roadmap

## VL-001 — Premium dashboard [COMPLETED, merged]
React/TypeScript premium dark UI, Overview, Radar, Dossier, scoring v1, typed demo fixtures, 41 tests and responsive screen captures. No backend or live data.

## VL-002 — Research Engine Foundation [COMPLETED, merged]
Full vertical slice: PostgreSQL persistence, evidence provenance, strict structured manual import (dry-run/apply), readable API, explicit REAL/DEMO modes, historical assessment/stage and immutable TOP-10 snapshots, CI/integration tests. See `tasks/current-task.md` and `docs/research-engine-contract.md`.

## VL-003 — Research Journal & evidence verification [CURRENT TASK]
Premium dated research journal, evidence review queue with append-only human checking, stored TOP-10 snapshot comparison and manually approved research draft→import pipeline. See `tasks/current-task.md` and `docs/research-operations-vl003.md`. No automatic ChatGPT→GitHub→DB bridge in this stage.

## VL-003B — Scheduled research delivery bridge [FUTURE, depends on VL-003]
Find and implement a documented authorized export/integration path for scheduled ChatGPT reports and founder approval. Never assume a chat automation directly writes to GitHub or a local DB; evaluate authorization, credentials, reliability and operating cost separately.

## VL-004 — Validation laboratory [PLANNED]
Interview/outreach records, experiment hypotheses, price tests, confirmed payments/retention, decision log and funnel. No automatic unsolicited messaging.

## VL-005 — Build Studio [PLANNED]
Read-only GitHub integrations: PR, branch, CI, handoff status; task management and founder approval workflow.

## VL-006 — Portfolio / operational economics [PLANNED]
Recorded revenue vs hypothetical opportunity, hosting/LLM costs, contribution margin, retention, project lifecycle and kill decisions.

## VL-007 — Optional orchestration & SaaS readiness [PLANNED]
Additional API costs, spend controls, background jobs, security, roles, tenant isolation and compliance. Only after a real need is shown.

**Principle:** each milestone has an explicit versioned task. No progressing to next milestone until PR review and founder approval.
