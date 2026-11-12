# ARCHIVED — VL-003P / First Real Research Pilot
Status: COMPLETED, PR #4 merged 2026-11-12
PR: https://github.com/strace42-ai/Venture-lab/pull/4

# VL-003P — First Real Research Pilot (historic specification)
Version: 1.0
Status: COMPLETED (historic specification, not active)
Date: 2026-11-12
Base: latest main including merged VL-003
Suggested branch: claude/vl-003p-first-real-research-pilot

## Goal
Run the first **real operational acceptance test** of Venture Lab with credible market research. Do not build another app feature until the data and review/import workflow work on a real research batch. Produce a **founder-review-ready package of up to 10 strong candidate opportunities** with Western analogues, named Russian competitors, original source URLs, concrete unmet use case, key technical/market risks and realistic validation plans. No synthetic market metrics, no fabricated TOP-10, no automated approvals.

## Read first
CLAUDE.md; docs/research-export-guide.md; docs/research-import-format.md; docs/scoring-model.md; docs/research-operations-vl003.md; docs/research-engine-contract.md; existing pilot `research/drafts/draft-2026-11-12-pilot-001.json`; `server/research/schema.ts`; `server/research/draft.ts`; `handoff/latest.md`.

## Step A — verify updated pilot (mandatory)
1. Pull latest main and inspect the latest pilot JSON committed on 2026-11-12. It contains **3 candidates**, source type `ai-draft`, 17 source records, 9 RU competitor records (existing and newly found); no scores, no approval, REAL untouched.
2. Run actual `npm run research:draft-check -- research/drafts/draft-2026-11-12-pilot-001.json` and `npm run research:import -- research/drafts/draft-2026-11-12-pilot-001.json` **DRY RUN ONLY**. Record results and warnings. Correct schema/format errors if any but NEVER set `human-reviewed`, `checked` or `approval` on behalf of founder.
3. Evaluate fresh Russian competitor overlap especially for Quote Compare: Vnikli, Vortholm, Aether Lab. Prior hypothesis `there is no file-to-table SaaS in Russia` is refuted by available product pages. Lower qualitative novelty assessment and mark that exact market gap unsupported; no scores before source review.
4. Do not treat visited URL as independent verification, and don't state actual market share or paying customer counts without evidence.

## Step B — expand to 10 candidates, evidence first
Research ~7 additional existing previously investigated opportunities without repeating the first three, e.g. VAG Report (professional VCDS CSV/TXT interpretation), Client Room for solo contractors, Pain Radar for market pain, Guest Guide short-stay, AI micro-apps for groups (Bonds / Igray), fixable appliance assistance, niche B2B gamified campaigns. Re-evaluate alternatives if a candidate has fatal blockers or very saturated RU competition.
For EACH:
- 1+ real Western source that demonstrates real existing product/use, and 1+ relevant RU direct or adjacent competitor source (or explicit documented negative-search coverage: queries, marketplaces and limitations).
- Confirm current source links and what the pages actually claim. Vendor claims are vendor claims, not independent proof.
- Capture target buyer, pain severity/frequency, narrow RU gap, what is different from existing tools, price hypothesis, first 10 customers distribution, cheap 7–14 day demand test, MVP technical feasibility and cost/API/legal constraints.
- Use genuine web access only. If unavailable, do NOT guess sources or metrics. Produce fewer candidates and document limitations.
- **Structured draft(s)** at `research/drafts/` strictly matching vl-research-1. No approval, no per-source checked status. Use stable externalIds and unique runIds. Avoid accidentally duplicating an idea that already appears in an earlier draft. Keep assessment: null until founder verifies evidence.
- Use source dates observed on lookup; no claims about actual transactions unless independently substantiated.

## Step C — founder review package
Create `research/reviews/first-real-pilot-review.md`: one compact decision table for ALL candidates: candidate, Western analogous product, named key RU rivals, concrete niche, evidence URLs, confidence/caveats, proposed 7-day proof test and recommendation `review further / reject / validate commercially`. Include claim-by-claim checklist so founder can approve high-impact claims without hunting through 10 JSON files.
Create `research/reviews/first-real-pilot-source-index.csv` (if useful; plain UTF-8) listing each source ID, idea ID, URL, claim, claimed publisher, observation date, independent vs self-reported, review status and review priority. No personal information.
Give `Research Opportunity` scoring as **proposed draft rationale only** if needed; don't materialize `assessment` until verified, and don't force unscored ideas into TOP-10. Existing score weight model must remain unchanged.

## Step D — prove importer works, WITHOUT inserting into REAL
- Run checks for each created draft, report warnings. Use dry-run import only.
- If local DB available, run validation/snapshot workflow with synthetic TEST fixture to confirm importer/history still works, but do not alter REAL.
- Run existing lint/typecheck/tests/build if code/config touched; otherwise running relevant research CLI validation is primary acceptance.
- No large UI/backend rewrite, no paid APIs, no cloud deploy, no unsolicited outreach, no scheduled jobs.
- No adding manual approval as if founder gave it. If actual 10 high-quality candidates unavailable, report honest smaller number.

## Delivery / approval gate
- New branch, PR to main; DO NOT MERGE.
- Handoff contains draft filenames, source coverage, factual caveats, CLI outputs, why candidates accepted/rejected, exact commands and known gaps.
- Once founder and ChatGPT audit the candidate research, founder separately approves specific ideas/source claims; only then does a future explicit command import them into REAL. Preserving an initially incomplete N/10 is correct.
- This is *research operations acceptance*, not the next large implementation sprint. The future authorized automation bridge may come only after this pilot validates a reliable manual path.
