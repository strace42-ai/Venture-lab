# Venture Lab — Delivery roadmap

## VL-001 — Premium dashboard [COMPLETED, merged]
React/TypeScript premium dark UI, Overview, Radar, Dossier, scoring v1, typed demo fixtures, 41 tests and responsive screen captures. No backend or live data.

## VL-002 — Research Engine Foundation [COMPLETED, merged]
Full vertical slice: PostgreSQL persistence, evidence provenance, strict structured manual import (dry-run/apply), readable API, explicit REAL/DEMO modes, historical assessment/stage and immutable TOP-10 snapshots, CI/integration tests. See `tasks/current-task.md` and `docs/research-engine-contract.md`.

## VL-003 — Research Journal & evidence verification [COMPLETED, merged]
Premium dated research journal, evidence review queue with append-only human checking, stored TOP-10 snapshot comparison and manually approved research draft→import pipeline. See `tasks/current-task.md` and `docs/research-operations-vl003.md`. No automatic ChatGPT→GitHub→DB bridge in this stage.

## VL-003P — First real research pilot [COMPLETED, merged]
Validate the 3-idea AI draft and build a source-rich pilot batch of up to 10 real opportunities. This is a legacy **manual review/import compatibility test**, NOT an ongoing requirement. Following founder's newer decision, daily research will no longer require human source sign-off. See `tasks/current-task.md` and `docs/no-vpn-automation-architecture.md` v2.

## VL-004A — Autonomous Research Worker, fixture-first [COMPLETED, merged PR #5]
**Zero-human-in-the-loop automated research**: server-side worker with swappable RU/world search and LLM provider interfaces, independent adversarial machine review, programmatic source checks, evidence quality gates and automatically published PRIMARY machine TOP-10 with immutable history, cost/freshness and premium dashboard. No mandatory manual review. Legacy human-reviewed records remain separate; no paid APIs or deployment without one-time founder authorization. See `docs/no-vpn-automation-architecture.md` and `tasks/backlog/VL-004A-autonomous-research-worker.md`.

## VL-004B — Live-provider integration and controlled trial [CURRENT TASK — PHASE A ONLY]
Build real-provider adapters for Yandex Search API (RU/world) and Yandex AI Studio (distinct analyst and skeptic model families), secure real webpage reader, source-grounding, metered real-cost safety and realistic adversarial tests. **Phase A uses only mocked/recorded HTTP and zero paid calls.** Phase B requires separately approved one-time API budget, credentials and network test; daily manual approvals are NOT part of the research pipeline. See `tasks/current-task.md`.

## VL-004B Phase B — Controlled REAL-source smoke [BLOCKED PENDING FOUNDER APPROVAL]
After Phase A PR passes audit, run small explicitly authorized capped provider trial on real RU/world searches and foreign-page reachability; report cost/quality/coverage. Do not activate recurring paid jobs yet.

## VL-004C — Hosted no-VPN dashboard [PLANNED]
Authorized secure HTTPS web app reachable from Russia without user VPN, backups, monitoring, user auth and unattended daily execution with automatic ranked publication. Never expose unauthenticated database or mutation endpoints.

## Optional ChatGPT chat export bridge [BACKLOG / NOT REQUIRED]
An authorized integration could deliver current ChatGPT automation reports into review queue, but task execution does not automatically grant it connector write access or a direct PostgreSQL link. Treat as a possible editorial input, not the runtime dependency.

## VL-004 — Validation laboratory [PLANNED]
Interview/outreach records, experiment hypotheses, price tests, confirmed payments/retention, decision log and funnel. No automatic unsolicited messaging.

## VL-005 — Build Studio [PLANNED]
Read-only GitHub integrations: PR, branch, CI, handoff status; task management and founder approval workflow.

## VL-006 — Portfolio / operational economics [PLANNED]
Recorded revenue vs hypothetical opportunity, hosting/LLM costs, contribution margin, retention, project lifecycle and kill decisions.

## VL-007 — Optional orchestration & SaaS readiness [PLANNED]
Additional API costs, spend controls, background jobs, security, roles, tenant isolation and compliance. Only after a real need is shown.

**Principle:** each milestone has an explicit versioned task. No progressing to next milestone until PR review and founder approval.
