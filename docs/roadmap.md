# Venture Lab — Delivery roadmap

## VL-001 — Premium dashboard [COMPLETED, merged]
React/TypeScript premium dark UI, Overview, Radar, Dossier, scoring v1, typed demo fixtures, 41 tests and responsive screen captures. No backend or live data.

## VL-002 — Research Engine Foundation [CURRENT TASK]
Full vertical slice: PostgreSQL persistence, evidence provenance, strict structured manual import (dry-run/apply), readable API, explicit REAL/DEMO modes, historical assessment/stage and immutable TOP-10 snapshots, CI/integration tests. See `tasks/current-task.md` and `docs/research-engine-contract.md`.

## VL-003 — Research operations & daily delivery [PLANNED]
Turn daily new research into a machine-readable payload, review queue, deduplication and historical ranking. Automate only after stable manual import. Verify whether scheduled ChatGPT output can be exported using authorized integrations; never assume the daily automation writes directly to repo or database.

## VL-004 — Validation laboratory [PLANNED]
Interview/outreach records, experiment hypotheses, price tests, confirmed payments/retention, decision log and funnel. No automatic unsolicited messaging.

## VL-005 — Build Studio [PLANNED]
Read-only GitHub integrations: PR, branch, CI, handoff status; task management and founder approval workflow.

## VL-006 — Portfolio / operational economics [PLANNED]
Recorded revenue vs hypothetical opportunity, hosting/LLM costs, contribution margin, retention, project lifecycle and kill decisions.

## VL-007 — Optional orchestration & SaaS readiness [PLANNED]
Additional API costs, spend controls, background jobs, security, roles, tenant isolation and compliance. Only after a real need is shown.

**Principle:** each milestone has an explicit versioned task. No progressing to next milestone until PR review and founder approval.
