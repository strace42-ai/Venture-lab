# Venture Lab — Premium product design brief v1

## Aesthetic positioning
**An executive founder cockpit, not a game UI or generic admin panel.**
Rich dark neutral canvas, carefully restrained cool accent, excellent typography, dense yet legible analysis, deliberate whitespace, subtle depth, professional editorial hierarchy. The visual should feel credible at first glance and delightful with real information. No neon cyberpunk, excessive gradients, generic glass overload, decorative charts without meaning.

## Visual system
- Dark default; make contrast accessible (WCAG AA where practical).
- Background around near-black/navy, layered charcoal panels, fine hairline borders, one strategic blue/cyan highlight plus neutral success/warn/danger semantics.
- Desktop: 240–264px collapsible sidebar, compact topbar, content maximum around 1480px; mobile-first responsive flows, no horizontal page overflow.
- Typography: readable system/available open-source web font; distinct oversized strategic headline, smaller editorial labels, tabular numeric data. Respect language strings in Russian in first version.
- Rhythm: 8px grid, intentional 16/24/32px intervals, 12–18px card radius, restrained shadow and animation (respect reduced-motion).
- High information density where appropriate but avoid cramped metric cards on mobile.
- **Key visual moment:** Top opportunities leaderboard with scores/confidence and movement; opportunity signals, funnel and AI pipeline should feel as one coherent product.

## Dashboard modules
1. Brand/sidebar and date/context header.
2. Hero message with one **strongest opportunity** + why now, explicit demo marker.
3. KPI strip: total ideas, high-confidence leads, live experiments, active builds, confirmed paid signals (mock).
4. Top-10 preview table with ranking, score, evidence confidence, trend and risk; click-through to idea.
5. Research pulse / recent discoveries, freshness indication.
6. Validation funnel / pipeline with meaningful denominators.
7. Builds and AI activity. No invented agent live statuses; initial version labeled demo.
8. One meaningful chart (score movement or portfolio distribution), avoid decorative fake data.
9. Empty state and action cues.

## Interaction quality
- Sidebar routing works for implemented areas; other routes should display polished deliberate coming-soon states rather than dead links.
- Filter, search, tabs, sorting for Top 10 and cards should work locally on demo dataset.
- Detailed idea view from leaderboard; clear evidence and risk labels.
- Loading/empty/error/success UI conventions; keyboard navigation and visible focus states.
- Functional responsive menu; mobile touch targets >=44px.
- Use meaningful iconography (Lucide), no fake charts as screenshots.

## Demo integrity
Use `DemoData` typed fixture; visible “Демонстрационные данные” label on all simulated metrics and activities. Even previously discussed numeric scores are provisional hypotheses; do not depict as actual market facts without verifiable source records. Real provider/API integrations not in initial scope.

## Acceptance for beauty
Designer/engineer should supply desktop AND mobile screenshots in PR when feasible and self-critique the visual hierarchy, alignment, spacing, states and responsiveness before declaring ready.
