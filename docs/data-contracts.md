# Venture Lab — Preliminary domain & data contracts

Initial UI uses *typed, clearly flagged demo fixtures*. This document is not a mandate to implement a database in sprint one.

## Core entities
**Idea**: id, slug, title, short_pitch, segment(B2B/B2C), category, geography, stage, creator, created_at, updated_at, primary_problem, target_persona, offer, next_action, demo_flag.
**Evidence**: id, idea_id, claim, source_url, source_title, publisher, published_at?, observed_at, independent_or_company_self_report, reliability, confidence, retrieval_note; link evidence to assessment dimensions.
**Competitor**: id, idea_id, brand, url, market, target_job, comparable_features, verified_at, relative_coverage, caveats.
**Assessment**: id, idea_id, model_version, assessed_at, assessor, raw 0–5 component scores for twelve dimensions, total 0–100, confidence 0–100, rationale, risks; append-only.
**FounderFit**: idea_id, assessed_at, five component scores, total 0–40, notes.
**ResearchRun**: id, timestamp, markets_examined, query_strategy, new_candidates, rejected_candidates, sources, key_changes, conclusion.
**Top10Snapshot**: run_id, as_of, rank, idea_id, score, confidence, previous_rank?, change_reason; preserve every snapshot.
**Experiment**: id, idea_id, hypothesis, offer, target_persona, channel, date_range, success_threshold, spend, status, result, next_decision.
**Signal**: experiment_id, kind(interview/offer/paid/refund/repeat), timestamp, count, provenance, verification_state; no simulated sales.
**BuildProject**: id, idea_id?, repo, stage, current_task_path, current_commit, last_pr_url?, last_ci_state?, last_handoff_at?.
**Decision**: id, subject_id, author, date, decision, evidence_refs, rationale, next_review_at.

## API integration phases
Phase 1: local mock demo fixtures with functional UI.
Phase 2: PostgreSQL migrations + CRUD / persistent scoring and evidence.
Phase 3: GitHub read-only project/PR/CI sync.
Phase 4: scheduled research ingestion, background jobs, deduplication, citations, provenance.
Phase 5: optional paid LLM orchestration with explicit budget, approval and audit.

## Data integrity rules
No score without versioned breakdown. Missing data => unknown, never zero by implication. Keep raw evidence, search date, competitor overlap and confidence separate. No overwriting historical assessments. Never include real API credentials or customer personal data in demo fixtures. Currency explicitly labeled RUB/USD and revenue vs GMV separated. Human-verified payment only.
