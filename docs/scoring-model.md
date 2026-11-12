# Venture Lab — Evidence-based scoring model v1.0

The overall **Market Opportunity Score = 0–100**. Weights are fixed and sum to 100:
| Dimension | Max |
|---|---:|
| Verified Western user need | 12 |
| Western willingness to pay | 8 |
| Weakness of Russian alternatives | 12 |
| Unmet use case in Russia | 8 |
| Monetization feasibility | 10 |
| Speed to first paid pilot | 10 |
| MVP feasible for solo builder + AI | 10 |
| Testable in 7–14 days | 8 |
| Accessible first-user distribution | 8 |
| Retention / repetition potential | 6 |
| Defensible differentiation | 4 |
| Manageable legal / operational risk | 4 |
| **TOTAL** | **100** |

## Scale and calculations
Score each criterion 0–5 with a written rationale and independent evidence. Weighted contribution = max_points × criterion_score/5. Sum and round **only the final total** to nearest integer. Never award full points to an unverified claim. Store raw component values, sources, evidence confidence and scoring model version. No arbitrary manual boosts.

### Anchors for 0–5
0 = no evidence / fatal failure; 1 = speculative weak; 2 = plausible but substantial doubt; 3 = credible, limited evidence; 4 = strong documented evidence; 5 = very strong relevant independent and recent evidence. Treat lack of evidence as unknown and penalize confidence; don't imply it proves market absence.

### Specific rubric questions
1. Western need: real repeat use, problem frequency, retention, independent testimonials?
2. Western pay: actual paid users, verifiable revenue or renewal, vs price-list only?
3. Russian weakness: search direct/adjacent competitors, user complaints, feature gaps, prices, actual access?
4. Russia unmet job: can you name exact underserved user/persona/use case and why alternatives fail?
5. Monetization: who pays, value metric, unit economics, plausible budget and procurement friction?
6. First sale: warm reach, urgent problem, workable concierge/pre-sale, sales cycle?
7. MVP: one developer with available tools, dependencies, technical risk, cost, testing?
8. Fast test: measurable test with credible users, concrete stopping rules and no full build?
9. Distribution: identifiable communities, reachable audience, inexpensive channels, repeatable outreach?
10. Retention: ongoing workflow, switching costs, recurring pain vs one-off tool?
11. Defensibility: proprietary legal distribution/data/workflow/brand advantage not simply 'has AI'?
12. Risks: manageable compliance, APIs, trust/safety, vendor dependence and operating cost?

## Separate metrics (NOT added to 100)
**Evidence confidence** 0–100: evidence completeness 30%, independent corroboration 25%, recency 15%, source reliability 20%, Russia-specific validation 10%; publish unknowns and sample limits.
**Founder Fit** 0–40: own skills/experience 10; access to first users 10; time to first sale 10; personal motivation 5; reusable assets/synergy 5.
**Risk flags**: fatal/legal, locked APIs, demand unverified, distribution cold start, network effect, low retention, data privacy, high COGS, unverified competitive landscape.
**Market vs founder suitability:** show both scores separately. Do not silently change rank formula.

## Gatekeeping and stage labels
- Kill / hold: unlawful or disallowed use, inaccessible critical licensed data/API, prohibitive up-front infrastructure, impossible safe MVP, no identifiable payer and no credible way to test (not always fatal for consumer/social models).
- High score does not override critical risk; flagged idea remains review-required.
- `Discovered` needs a dated source; `Scored` requires evidence links and rationale; `Build candidate` needs explicit validation decision; `Paid signal` needs independently verified real payment, not survey intent.

## Sources and dates
For every major claim store source URL, title, publisher, publication/observation date, accessed date, claim and support type. Label company self-report versus independent data; investments ≠ revenue; GMV ≠ revenue; product pricing ≠ paid conversions.
No competitor found after search = "не обнаружен в проверенных источниках", never "конкурентов нет". Record searched names, categories, dates and coverage.

## Revision/history
Every scoring revision is an append-only assessment with time, assessor, model_version, component scores, changed evidence and reason. The top-ten snapshot is derived from ALL assessed ideas each run and retains ranks for comparison. New ideas enter only if their total score justifies it. Rank ties: higher confidence then stronger first-payment feasibility, otherwise same score and stable ID. Do not claim rank movement without previous stored snapshot.

## Validation evidence
Track contacted, replied, demoed, interviews, offers sent, payments completed/refunded, repeat use, cost, conversion denominator, dates, interview consent where appropriate. A verbal promise ≠ confirmed sale. Keep experiment quality/confidence separate.

## Evidence integrity of the current assessment (VL-003 corrective pass)
A derived, **current** flag (`src/domain/integrity.ts`), never stored and never changing score or confidence:

| Status | Condition (cited = `assessment.evidenceIds`) | Effect |
|---|---|---|
| `needs-review` | at least one cited source is manually **rejected**, or a cited id no longer resolves | «Оценка требует пересмотра» on Overview, Radar, Dossier and the evidence queue, with the source ids. The idea **stays in the ranking with its stored score** but is excluded from «сильнейшая находка» and «сильные и обоснованные» (KPI `assessmentsNeedingReview`). |
| `unverified` | no rejection, but some cited sources are not yet checked (unreviewed / unattributed) | weak support, already reflected in confidence; **not** excluded |
| `verified` | every cited source is checked by a human | — |
| `unlinked` | the assessment cites nothing (DEMO fixture / legacy) | — |

Historical assessments and frozen snapshots are never modified. The flag is lifted by importing a **new assessment
revision** (with `revisionReason`) that does not cite the rejected sources, or by reversing a mistaken rejection with
`research:review … --status checked`. A revision that still cites a rejected source stays flagged.
