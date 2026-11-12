# CURRENT TASK — VL-001 / Dashboard Foundation
Version: 1.0
Status: READY FOR CLAUDE
Owner: Founder + ChatGPT
Repository: strace42-ai/Venture-lab
Target branch: new `claude/vl-001-dashboard-foundation` created from `main`.

## Objective
Implement a visually exceptional, functional, responsive **premium dark founder dashboard** for Venture Lab in React + TypeScript. First sprint is demo-only and creates the design language. It should be compelling at first glance and realistic as an extensible product, not a generic admin template.

## Required starting steps
Read `CLAUDE.md`, `docs/product-vision.md`, `docs/design-principles.md`, `docs/scoring-model.md`, `docs/data-contracts.md`, `docs/agent-workflow.md`. Inspect the repository. Start a NEW branch from main. Select a maintainable React+TypeScript+Vite stack; appropriate component/style packages are allowed when justified, avoid dependency bloat.

## Scope MUST
1. Responsive application shell: desktop sidebar, mobile navigation, topbar, design tokens, dark theme, reusable UI primitives, accessible focus.
2. Premium Overview page with headline, dated **demo** research pulse, 5 KPI tiles, Top-10 ranking preview, strong find of the day, experiments/validation preview, portfolio/build status preview, agent activity and one meaningful chart on mock dataset.
3. Functional Radar page with query, category/stage filters and sort (score/confidence/recent); clean list and responsive cards/table.
4. Idea dossier detail view with thesis, Western/RU evidence placeholders, competition, all 12 score dimensions, risk flags, confidence vs score distinction and first validation plan. Click from dashboard/radar.
5. A demo data module with >=12 distinct plausible synthetic ideas and typed scoring components. Derived totals, ranking and change indicators must be computed, not copied hardcoded across multiple widgets. Provide `asOf` and `isDemo` markers.
6. Secondary routes (Validation, Build Studio, Portfolio, Research Journal) may use **polished intentional placeholders** with realistic explanatory empty states, not pretend live integrations.
7. Polish desktop widths (~1440/1280) and Android-like mobile (~390). No horizontal overflow. Keyboard navigation, legibility and loading/empty UI as relevant.
8. README developer instructions, lightweight tests for scoring/rank ordering and key UI interactions, lint/typecheck/build scripts.

## Critical design direction
Dark premium analytical cockpit. Use restrained high-contrast palette and superb typographic rhythm; premium hierarchy, non-decorative charts, small purposeful microinteractions, sophisticated data density. UI is in Russian; internal code can be in English. Keep demo labels obvious on metrics, leaderboards, "agent status" and charts. Do not assert real projects are currently making money.

## Exclusions (DO NOT BUILD)
- No PostgreSQL/backend/auth/payments or real GitHub API integrations.
- No real ChatGPT/Claude/Codex APIs, orchestrators, web crawlers or daily research jobs.
- No deploy, purchased services, automated messages or API keys.
- No user account management, multi-tenant SaaS, permissions or complex project management.
- Do not silently substitute speculative facts for citations or live usage metrics.

## Acceptance criteria
- Working local app: instructions in README; `npm install`, `npm run build`, `npm run lint`, `npm test` (or justified equivalent) verified.
- Sidebar/mobile nav and pages load; overview and radar detail linked.
- Search/filter/sort visibly work on local demo fixtures.
- Scores calculated from rubric and top-ten derived from complete demo list.
- Excellent responsive states, no horizontal scroll or visual collisions at 390px and 1440px; screenshots or documented manual QA.
- Useful test assertions for score math/ranking and functional interactions.
- Clear honesty about demo mode, no broken/inert controls purporting to do work.
- Handoff report committed on feature branch with actual checks (no invented pass).
- PR opened against main; **do not merge**.

## Deliverable
Branch + PR; code; visual evidence if available; `handoff/latest.md` with git SHAs, files, exact verification results, limitations and recommended VL-002. Make a purposeful design decision and explain why, without asking the founder endless micro-questions.
