# Venture Lab — Latest implementation handoff

**Task:** VL-001 / Dashboard Foundation (`tasks/current-task.md`, Version 1.0)
**Status:** IMPLEMENTED. Awaiting independent review and founder approval. **Not merged.**
**As of:** 2026-11-12
**Implementer:** Claude Code

## Git
| | |
|---|---|
| Base | `main` @ `79cc6328fc45510461dcb47a89ccf29e4d0ae38a` |
| Feature branch | `claude/vl-001-dashboard-foundation` |
| Implementation commit | `89d4c43fd4047805eda9a9dc0f4d76c2336c20f2` |
| Handoff commit | the next commit on the same branch, which adds this file |
| PR | https://github.com/strace42-ai/Venture-lab/pull/1 |

## What was built
**Stack:** React 18.3, TypeScript 5.6 (strict, with `noUncheckedIndexedAccess`) and Vite 8. Also React Router 7, Lucide icons and Inter Variable (self-hosted through @fontsource, Cyrillic included). Styles are hand-written CSS built on design tokens (`src/styles/tokens.css`). There is no UI kit and no chart library: the chart is hand-built SVG. The app has 5 runtime dependencies.

1. **App shell**
   - Desktop sidebar that collapses. Its state is kept in localStorage, and every access is wrapped in try/catch.
   - Sticky topbar showing the date context, the scoring model version, a global search and a «Демо-данные» marker. The search is focused with the `/` hotkey and opens Radar with `?q=`.
   - Below 1024px, a hamburger drawer and a bottom tab bar (Обзор, Радар, Валидация, Ещё). The drawer traps focus, closes on Esc, locks page scroll and restores focus when it closes.
   - Skip link, visible focus rings, reduced-motion support.
   - Routes are lazy-loaded and show a skeleton while loading.
2. **Overview** (`/`)
   - Editorial headline computed from the data: «13 идей в рейтинге. 2 сильные и обоснованные, ни одной подтверждённой оплаты.»
   - Hero «Сильнейшая находка дня»: the highest-ranked idea that has no critical risk flag.
   - Research pulse with a freshness indicator.
   - 5 KPI tiles: ideas on radar, strong and well-evidenced, live experiments, active builds, verified payments. Every tile is labelled «демо».
   - **Top-10 leaderboard.** Each row shows rank, movement vs the previous snapshot, a score bar, a 5-segment confidence meter, a score sparkline and a risk count. It has a B2B/B2C filter and re-sorts by rank, confidence or movement. The whole row opens the dossier.
   - **Opportunity map** (score × evidence confidence) with thresholds at 70/60. Points can be focused with the keyboard and open the dossier. Ideas with a critical risk are drawn with a dashed red outline.
   - Idea pipeline by stage.
   - Validation funnel with the denominator for each step and a «pending ≠ paid» note.
   - Build status with a checklist.
   - Demo agent journal, labelled «не live-статусы».
3. **Radar** (`/radar`)
   - Search over title, pitch, category and persona. Category and stage filters. Sort by score, confidence or recency. Table ↔ cards toggle.
   - All of this state is kept in the URL (`q`, `cat`, `stage`, `sort`, `view`).
   - Results count, plus an empty state with a reset button.
   - Below 900px the table collapses into cards.
   - Rejected ideas are shown dimmed and are not ranked.
4. **Idea dossier** (`/ideas/:slug`)
   - Thesis, problem, persona, offer, why now.
   - A scorecard that keeps three numbers apart: **market score**, **evidence confidence**, and **founder fit** (0–40, not used in ranking).
   - All **12 dimensions**, each with raw 0–5 pips, weighted points out of the maximum, and the rubric question. An unknown (`null`) component is shown as «?» with an explanation.
   - Confidence breakdown with its weights.
   - Risk flags. A critical flag adds «Требует ревью».
   - Western and Russian evidence placeholders, each marked «источник не привязан».
   - Russian competitor matrix described by category (no company names), with «проверено: нет».
   - First validation plan with a success threshold and a stop rule.
   - Append-only assessment history with deltas.
   - A not-found state for unknown slugs.
5. **Demo data** (`src/data/demo.ts`)
   - `isDemo: true`, `asOf: '2026-11-12'`.
   - 14 distinct synthetic ideas across 10 categories: one rejected, one paused, and one with an unknown component.
   - Each idea has 1–3 append-only assessments.
   - 3 research runs, 2 experiments (0 verified payments, 1 pending), 1 build spec, 6 activity entries.
   - **No totals, ranks, movement or KPIs are stored.** All of them are derived in `src/domain/scoring.ts` and `selectors.ts`.
6. **Scoring model v1.0** (`src/domain/scoring.ts`)
   - Fixed weights; a test asserts they sum to 100.
   - Contribution = max × raw / 5. Only the final total is rounded.
   - An unknown component counts as 0 points but is flagged.
   - Confidence weights are 30/25/15/20/10. Founder fit is capped at 0–40.
   - Tie-break order: score → confidence → first-payment feasibility (speedToPilot) → id.
   - A snapshot's ranking uses each idea's latest assessment on or before that date.
   - Movement is shown only against a stored previous snapshot. Otherwise the idea is shown as «Новая».
7. **Placeholders** for Validation, Build Studio, Portfolio, Research Journal and Settings. Each page explains what will appear, in which sprint, and the honesty rule that applies, and says «намеренная заглушка, а не сломанная функция». Each also has a hatched structure sketch labelled «макет». There is also a 404 page.
8. A developer section in the README, and lint, typecheck, test and build scripts.

### Design decisions and why
- **One accent colour (cyan-blue #5cc8ff) on near-black layered panels**, with hairline borders and neutral semantic colours. The demo marker uses its own muted lilac with a dashed border. It is easy to spot everywhere and can't be confused with success, warning or danger.
- **Score and confidence use visibly different instruments**: a continuous bar vs a 5-segment meter. This is the product's core distinction. The opportunity map shows the «high score, thin evidence» quadrant explicitly.
- **A computed editorial headline instead of a generic «Welcome back».** It states the honest situation up front, including 0 verified payments.
- **No chart library.** One meaningful chart does not justify about 100 kB. Hand-built SVG stays accessible and easy to theme.

## Intentionally NOT built (per exclusions)
- Backend, database, auth, payments.
- GitHub API, any LLM or agent API, crawlers or research jobs, deployment.
- Saved views, editing settings, experiment CRUD.
- Persistence of anything except the sidebar-collapsed preference.

## Files
- **New:** `package.json`, `package-lock.json`, `index.html`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.js`, `.gitignore`, `public/favicon.svg`, `src/**` (domain, data, components, pages, styles, tests), `docs/screenshots/*.png` (12 files).
- **Modified:** `README.md` (state + developer section), `handoff/latest.md` (this file).

## Verification actually run (Node v22.23.4, npm 10.9.9, Linux container)
| Command | Result |
|---|---|
| `rm -rf node_modules dist && npm ci` | ✅ installed (with an audit notice, see Known limitations) |
| `npm run lint` (`eslint . --max-warnings=0`) | ✅ exit 0, 0 warnings |
| `npm run typecheck` (`tsc -b`) | ✅ exit 0 |
| `npm test` (`vitest run`) | ✅ **2 files, 30 tests passed** |
| `npm run build` | ✅ exit 0. Main chunk 251 kB (81.5 kB gzip); pages are split into lazy chunks |

**Domain tests cover:**
- Weights sum to 100.
- Contribution math, including the RangeError for out-of-range input.
- Rounding only the final total, in a case where rounding each component would give a different result.
- Unknown-component handling.
- Confidence weights.
- Founder fit cap, and that founder fit stays out of the score.
- The full tie-break chain.
- Rejected ideas and ideas not yet assessed are excluded from ranking.
- Movement: new, same, up, down, and «no previous snapshot ⇒ no movement claimed».
- Dataset integrity: at least 12 ideas with unique ids and slugs, demo flags, chronological assessments.
- Top-10 equals the first 10 of the full ranking.
- Strongest find skips ideas with a critical risk.
- Radar filters and sorts.

**UI tests cover:**
- Top-10 renders in the computed order, with demo labels.
- Segment filter, and re-sorting by confidence.
- Arrow-key navigation in the segmented controls.
- Leaderboard → dossier navigation.
- Radar: search (and that the URL updates); category + stage filters leading to the empty state and reset; recent-sort order; query read from the URL.
- Dossier: 12 dimensions, the three separate metrics, the unknown marker, unattached sources.
- Not-found state; placeholder route.
- Mobile drawer opens and closes on Esc.
- Sidebar navigation.
- Global search lands on Radar.

### Responsive and visual QA (Playwright + Chromium, production build via `vite preview`)
- **Automated sweep: 11 routes × 5 widths (390, 768, 1024, 1280, 1440), 55 page loads.**
  - `documentElement.scrollWidth == clientWidth` on all 55: no horizontal overflow.
  - No page or console errors.
  - On mobile, buttons, inputs and tab items are at least 44px tall.
  - The sweep found one real overflow, at 1280px in the KPI tile header. It was fixed before the commit.
- **Manual review of the screenshots found these issues, all fixed:**
  - Hamburger button visible on desktop (CSS specificity).
  - Sidebar «скоро» pills clipped.
  - Leaderboard titles truncated too aggressively.
  - «Новая» badge colliding with titles.
  - KPI demo badge overlapping the labels.
  - Empty space under the map (a pipeline panel was added there).
- **Screenshots in `docs/screenshots/`:**
  - Desktop: `overview-1440-full`, `overview-1440-viewport`, `overview-1280-viewport`, `radar-1440-table`, `radar-1440-cards-filtered`, `dossier-1440`, `placeholder-portfolio-1440`.
  - Mobile: `overview-390`, `overview-390-top10`, `radar-390`, `dossier-390`, `drawer-390`.

**Not run / not verified:**
- Real devices (iOS Safari, Android Chrome).
- Firefox and WebKit engines.
- Screen-reader pass (NVDA/VoiceOver).
- Automated axe or Lighthouse audit.
- Contrast measurement. Tokens were chosen to meet AA on the panel background, but nothing was measured.
- CI (the repository has no CI config).

## Known limitations and risks
- `npm audit`: **runtime dependencies are clean.** One moderate advisory chain remains in dev-only lint tooling (`minimatch` via `@typescript-eslint/typescript-estree`). npm's only offered fix is a downgrade, so it was left as is.
- React 18.3 was kept because it is stable with the current testing libraries. Upgrading to React 19 is a separate decision.
- The data provider is a static fixture behind `DataProvider` / `useData()`. That is the seam for VL-002 persistence. There are no async loading or error states yet beyond route-level lazy loading.
- When the Top-10 is sorted by «Движение», ideas marked «Новая» come first, by convention.
- On mobile, the topbar hides the global «Демо-данные» pill to make room for search. Every page and panel still has its own demo badge, and the drawer shows a demo-mode notice.
- Dates and «сегодня/вчера» are computed relative to the fixture's `asOf`, not the real clock. This is intentional for a dated demo snapshot.
- Commits are authored as `Claude <noreply@anthropic.com>`, because the repository had no git identity configured.

## Recommended next task (VL-002)
**Opportunity intelligence persistence (a Sprint 1 slice):**
- A local API with PostgreSQL (or SQLite for development) for Idea, Assessment (append-only), Evidence (with source URL and dates) and Top10Snapshot.
- Replace the fixture behind `useData()` with async loading plus error states.
- An evidence attach UI in the dossier. A claim counts as attached only when it has a URL, a publisher and an observed date.
- CSV/JSON import of human-reviewed research, with deduplication.
- Keep `src/domain` as the single source of truth for scoring logic, for example by moving it into a shared package that the API also uses.
- Add CI (lint, typecheck, test, build) on PRs, plus an axe accessibility check.
