# AI Collaboration Protocol v1

## Responsibilities
- Founder: sets strategic priorities, approves paid APIs, deployments, public content, mergers and product decisions.
- ChatGPT: product research, requirements, score/evidence design, independent analysis; may edit repo docs via authorized GitHub connector.
- Claude Code: implementation and real local verification in isolated branches, PR, implementation handoff.
- Codex or independent reviewer: PR/architecture audit on code and tests, not just Claude's self-summary.

## Source of truth
1. `tasks/current-task.md` — authorized CURRENT implementation task, revised by ChatGPT/founder.
2. `docs/*` — product, scoring, design and data contracts.
3. Code and CI — facts about implementation.
4. `handoff/latest.md` — Claude's account of delivery (must be checked against code and CI).
5. PR discussion and decision log — review, objections, approvals.

Conflict resolution: if acceptance criteria conflict with implementation assumptions, prefer documented current task, mark issue, do not take risky liberties.

## Workflow
1. ChatGPT/founder writes versioned task with objective/scope/exclusions, acceptance tests and boundaries.
2. Claude reads docs and current task, notes source HEAD and task version; creates `claude/<task-slug>` branch from main.
3. Claude implements within scope; commits, runs tests, updates handoff on SAME branch, opens PR to main.
4. Reviewer reads diff, tests and actual app; reports reproducible severity-ranked findings.
5. Claude fixes findings in same PR; reviewer rechecks.
6. Founder approves merge. Never auto-merge or auto-deploy as default.
7. New task only after state recorded; do not silently overwrite current task while Claude is working (pin task version/commit).

## Handoff required
Task/version, source branch/SHA, implementation branch/commit, PR link, changed files, completed and explicitly excluded scope, actual commands/results, screenshot evidence where available, unresolved bugs and security concerns, next suggested task; no unverifiable "all green" assertions.

## Concurrency and safety
Avoid concurrent writers to same branch/files. Ensure each PR starts from known main commit. Keep protected main and minimal GitHub permissions. No secrets or API keys in repo, no paid API usage or automatic outreach to customers without founder approval.

## Automation levels
Level 0: ChatGPT and Claude exchange structured files through GitHub; founder manually triggers each chat.
Level 1: CI and PR checks, status ingestion via GitHub integration.
Level 2: paid APIs/orchestrator, queues, cost caps and approval gates. NOT in the first sprint.
