# Venture Lab — Latest handoff

**Task:** VL-003P / First Real Research Pilot (`tasks/current-task.md` v1.0) — research only, no feature sprint
**Status:** REVISION 2 AFTER CHATGPT AUDIT. Awaiting re-audit. **Nothing was imported into REAL, no approval was given on the founder's behalf, not merged.**
**As of:** 2026-11-12
**Implementer:** Claude Code

## How this PR fits the founder's v2.0 decision
`main` now contains `docs/no-vpn-automation-architecture.md` v2.0 and `tasks/backlog/VL-004A-autonomous-research-worker.md`: **daily research is fully autonomous, with no mandatory human step.** This PR is therefore:
1. a **legacy manual-import compatibility test** (the ai-draft → draft-check → dry-run → gate path still works, and the gate still refuses drafts);
2. a **source-rich corpus for the future zero-human VL-004A worker**: 41 sources, competitors, negative searches, and refuted hypotheses that can serve as challenger and quality-gate test cases.

Manual review of the links, manual approval and manual import are **not** preconditions for VL-004A or for future daily research. No `human-reviewed`, `checked` or `approval` values were added. VL-004A has **not** been started.

## Git
| | |
|---|---|
| Branch | `claude/vl-003p-first-real-research-pilot` (`origin/main` merged in, which brings in the v2.0 docs; nothing in them was reverted) |
| PR | https://github.com/strace42-ai/Venture-lab/pull/4 (not merged) |
| Audited commit | `f08f716` — review https://github.com/strace42-ai/Venture-lab/pull/4#pullrequestreview-5873369468 |

## Revision 2 — audit findings and fixes
| # | Finding | Fix |
|---|---|---|
| **P1** | Guest guide was wrongly presented as the favourite. The negative claim rested on an OTA overview article. | I opened the vendors' own pages and added sources r2–r8 and competitors rc3–rc8 to `pilot-002`. **RealtyCalendar «Автопилот»** has a «Цифровой гид для гостя» section; its auto-messages send check-in instructions, house rules and Wi-Fi. **RYNTO Guest Portal** offers a digital guide with a link and PIN per booking; it is free until 31.12.2027 and FREE for up to 3 units forever. **GuestCom** offers a Telegram/MAX check-in scenario: Free 0 ₽ for 1 property, Pro 498 ₽ per property per month. **Bnovo «Гости.Биново»** provides a guest cabinet. **TravelLine** has a guest cabinet without a guide. **Glamp Connect** did not load in the worker environment (503); it is listed as unconfirmed. `ruUnmetJob` now reads «ГИПОТЕЗА ОПРОВЕРГНУТА». The «cheap guide for 1–3 units» niche is already served by free tiers. Recommendation: **RESEARCH_HOLD → reject; not a favourite.** |
| **P2** | VAG Report missed VAGLOGS. | I read vaglogs.com through headless Chromium. It analyses CSV data logs from VCDS, ME7Logger, MHD, JB4 and others for free (injectors, boost, ignition), and AI plain-language explanations are «coming soon». Added as w4 / wp3. The idea is narrowed to **Auto-Scan / DTC interpretation in Russian**; dynamic-log analysis is already covered for free. Demand is unproven → **RESEARCH_HOLD**. |
| **P3** | Outdated mandatory-human-review language | The review package is reframed around the v2.0 states (`DISCOVERED` / `RESEARCH_HOLD`; nobody is `AUTOMATED_EVIDENCE_PASSED`). The checklist became an automated re-check queue. The legacy manual path is described as optional. 7-day tests are labelled as hypotheses for a separately commissioned future experiment, with no outreach. |
| note | beamai.ru | Marked «not fetched in worker environment (DNS)», not «unavailable». |

**Overall:** there is **no strong favourite** on current evidence. 9 candidates (not 10). The best targets for automated re-research are the 1-on-1 focus coworking and the appliance self-diagnosis assistant. This is a research priority, not a launch recommendation.

## Deliverables
| File | Content |
|---|---|
| `research/drafts/draft-2026-11-12-pilot-001.json` | ChatGPT pilot, 3 candidates. Content unchanged. |
| `research/drafts/draft-2026-11-12-pilot-002.json` | Revision 2: 6 candidates, **24 sources**, 24 competitors. ai-draft; every source unreviewed; `assessment: null`. |
| `research/reviews/first-real-pilot-review.md` | Rewritten for v2.0: summary table with proposed v2.0 states, changes in revision 2, automated re-check queue, no scores. |
| `research/reviews/first-real-pilot-source-index.csv` | **41 sources**. New columns: `machine_status` (not evaluated, pre VL-004A), `fetch_status`, `recheck_priority`. |

No application code changed. The `draft-check` «next steps» text still describes the legacy manual path. I left it as is on purpose, because changing code is out of scope here.

## Checks (revision 2)
- `research:draft-check` pilot-002 → exit 0, verdict «готов к проверке основателем (НЕ одобрен)», warnings only for missing assessments.
- `research:import` pilot-002 (dry-run) → ready, +6 ideas, +24 sources, +24 competitors. **⛔ The gate blocks apply.**
- `research:validate` on both drafts → ✔.
- REAL in the local database: 0 ideas, 0 `human-reviewed` runs.
- `npm run lint` ✔, `npm run typecheck` ✔, `CI=true … npm test` ✔ 12 files / 166 tests.
- `git diff origin/main -- docs tasks src server` is empty: the v2.0 docs on main are intact and no code changed.

## Factual caveats
- Every claim is an AI paraphrase of vendor pages. Vendor pages confirm that an offer exists; they say nothing about customers or revenue.
- Pages loaded with headless Chromium: vaglogs.com, rynto.io/ru/pricing.
- Pages that did not load in the worker environment: glampconnect.ru (503), beamai.ru (DNS), drive2.ru (403), kontur.ru (403), vaglogs.com/about_app (error).
- Skillbox prices date from 2021. The GummySearch shutdown date comes from an interested author.

## Next step
ChatGPT re-audit of PR #4. After the founder closes VL-003P, implement **VL-004A** (zero-human, fixture-first). It is not started in this PR.
