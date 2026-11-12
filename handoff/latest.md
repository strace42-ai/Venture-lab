# Venture Lab — Latest handoff

**Task:** VL-003P / First Real Research Pilot (`tasks/current-task.md` v1.0) — research and verification only, no feature sprint
**Status:** RESEARCH PACKAGE READY FOR FOUNDER REVIEW. **Nothing was imported into REAL. No approval was given on the founder's behalf. Not merged.**
**As of:** 2026-11-12
**Implementer:** Claude Code
(The VL-003 handoff is in git history, merge commit `d7b43e2` and earlier.)

## Git
| | |
|---|---|
| Base | `main` @ `2987dce` (VL-003 merged, VL-003P docs, pilot recheck `1ef569d`) |
| Branch | `claude/vl-003p-first-real-research-pilot` |
| PR | to `main`, not merged (link in the PR list / final report) |

## Deliverables
| File | What it contains |
|---|---|
| `research/drafts/draft-2026-11-12-pilot-001.json` | **Unchanged.** The ChatGPT pilot: 3 candidates, 17 sources, 13 competitors (West + RU). Verified with the CLI (Step A). |
| `research/drafts/draft-2026-11-12-pilot-002.json` | **New.** 6 candidates, 16 sources, 18 competitors. `source: "ai-draft"`; every source `unreviewed`; no `reviewedBy` on sources; `assessment: null`; runId `draft-2026-11-12-pilot-002`. ExternalIds are new and stable, with no overlap with pilot-001. |
| `research/reviews/first-real-pilot-review.md` | Founder decision table for all **9** candidates, Step A findings, a claim-by-claim checklist, qualitative rationale without scores, and approval steps. |
| `research/reviews/first-real-pilot-source-index.csv` | UTF-8 table of all 33 sources: draft, run, idea, source id, URL, claim, publisher, type, independent/self-reported, dates, review status (`unreviewed`), priority (28 high). No personal data. |

No application code, configuration or schema was changed.

## Step A — the updated pilot (actual CLI output)
- `npm run research:draft-check -- research/drafts/draft-2026-11-12-pilot-001.json` → exit 0, «готов к проверке основателем (НЕ одобрен)». 3 ideas: sources 5 / 6 / 6, competitors 1+2 / 2+3 / 1+4. Each idea has only the expected warning «нет оценки».
- `npm run research:import -- research/drafts/draft-2026-11-12-pilot-001.json` (dry-run) → `ready`: +3 ideas, +17 sources, +13 competitors, 0 assessments. **⛔ The approval gate blocks it** (ai-draft, file in `research/drafts/`).
- Re-opened on 2026-11-12:
  - ВНИКЛИ: 2–3 offers, 990 / 1 290 ₽;
  - Vortholm: corporate platform, price after a meeting;
  - Aether Lab: AI agent, 1 990 / 3 990 ₽/month;
  - Cofocus: group format, 1 990 ₽/month;
  - StudyMates: free 45 min/day, Pro tier;
  - Mnesikles: Premium free until 31.12.2026.
- `beamai.ru` **did not resolve** from this session (DNS / network policy). It must be checked manually.
- Quote Compare: the hypothesis «no file-to-table SaaS in Russia» is **refuted**. The candidate is recommended for rejection as a generic product.

## Step B — new candidates (genuine web access; only pages actually opened are cited)
VAG Report, Guest Guide (short-stay), Client Room (solo), Pain Radar, Appliance self-diagnosis assistant, SMB sales gamification. **«AI micro-apps for groups (Bonds/Igray)» was dropped:** no product with that name was found, and the AI party-game category is crowded (App Store / RuStore results). **Result: 9 candidates, not 10.** No filler was added.
Pages that could not be opened, so nothing was claimed from them: drive2.ru (403), kontur.ru (403), a2is.ru (empty), beamai.ru (DNS). The pilot-002 `limitations` field lists them.

## Recommendations (details in the review)
| Recommendation | Candidates |
|---|---|
| Review further, then a commercial test | `str-guest-guide-ru` |
| Review further | `virtual-focus-coworking-ru`, `vag-autoscan-report`, `appliance-fix-assistant-ru` |
| Review further, low priority | `personal-crm-ru`, `solo-client-room` |
| Reject (now / as a generic product) | `pain-radar-ru`, `supplier-quote-compare`, `sales-gamification-smb` |

## Step D — the importer works without touching REAL
- `research:draft-check` pilot-002 → exit 0, ready for founder review; 6 «нет оценки» warnings.
- `research:import` pilot-002 (dry-run) → `ready`: +6 ideas, +16 sources, +18 competitors. **⛔ Blocked by the approval gate.**
- `research:validate` pilot-002 → ✔.
- TEST workflow on a throwaway database `vl_p3`, dropped afterwards:
  - migrate → synthetic-run-1 `--apply` → snapshot 2026-11-06 → synthetic-run-2 `--apply` → snapshot 2026-11-11 → `--apply` on both drafts **refused, nothing written**;
  - result: REAL ideas 0, TEST ideas 5, snapshots 2.
- Local development database: REAL ideas 0, `human-reviewed` import runs 0.
- `npm run lint` ✔, `npm run typecheck` ✔, `CI=true … npm test` ✔ 12 files / 166 tests. These were run even though no code changed.

## Factual caveats
- Every claim is an AI paraphrase of a page fetched with web tools. No human has checked any of them.
- Vendor numbers (Touch Stay «90% fewer guest questions», Focusmate «12M+ sessions», Spinify «#1 on G2») are self-reports.
- Skillbox prices for social-media monitoring are from March 2021 and are outdated.
- The GummySearch shutdown date comes from a post by an interested author.
- Russian prices for our candidates are hypotheses. No conversion, revenue or paying-customer counts were measured or claimed.

## Next steps (founder)
1. Go through the checklist in `research/reviews/first-real-pilot-review.md`, starting with the high-priority sources.
2. For approved ideas, prepare a `human-reviewed` file with your `approval` in `research/inbox/`, then dry-run, then `--apply`. Do not apply files from `research/drafts/`.
3. Customer outreach for the 7-day tests needs your explicit permission. None was sent.
