-- VL-004B (Phase A): live-provider provenance, cost reconciliation, rotation with carried-forward
-- assessments. Forward-only; historical rows are not rewritten (new columns are NULL / default for them).

-- 1. Source provenance for real pages ---------------------------------------------------------------
ALTER TABLE mr_sources DROP CONSTRAINT mr_sources_fetch_status_check;
ALTER TABLE mr_sources ADD CONSTRAINT mr_sources_fetch_status_check CHECK (fetch_status IN (
  'ok', 'http_error', 'blocked', 'injection_suspected', 'rate_limited', 'budget_exhausted',
  'robots_disallowed', 'unsafe_url', 'unsupported_content', 'too_large', 'timeout'));
ALTER TABLE mr_sources
  ADD COLUMN canonical_url    text CHECK (canonical_url IS NULL OR canonical_url ~ '^https?://'),
  ADD COLUMN fetched_at       timestamptz,
  ADD COLUMN page_title       text CHECK (page_title IS NULL OR length(page_title) <= 500),
  ADD COLUMN content_type     text CHECK (content_type IS NULL OR length(content_type) <= 200),
  ADD COLUMN failure          text CHECK (failure IS NULL OR length(failure) <= 500),
  -- grounded offer (name/market/jobs with verbatim evidence/price) + what the model claimed but code could not ground
  ADD COLUMN offer            jsonb,
  ADD COLUMN extraction_model text;

-- 1b. Live discovery context of a candidate (needed to re-research it with the same Russian synonyms)
ALTER TABLE mr_candidates
  ADD COLUMN ru_keywords text[] NOT NULL DEFAULT '{}',
  ADD COLUMN source_url  text CHECK (source_url IS NULL OR source_url ~ '^https?://');

-- 2. Where each quote was found -----------------------------------------------------------------------
ALTER TABLE mr_claims ADD COLUMN quote_locations jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 3. Cost reconciliation: reserved worst case vs observed provider usage --------------------------------
ALTER TABLE mr_usage
  ADD COLUMN estimated_cost      int CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  ADD COLUMN actual_cost         int CHECK (actual_cost IS NULL OR actual_cost >= 0),
  ADD COLUMN reconciliation      text NOT NULL DEFAULT 'emulated' CHECK (reconciliation IN ('emulated', 'estimate_only', 'reconciled', 'tariff', 'not_billed', 'unknown', 'anomaly_over_estimate')),
  ADD COLUMN provider_request_id text CHECK (provider_request_id IS NULL OR length(provider_request_id) <= 200),
  ADD COLUMN http_status         int;
-- The ledger never counts less than the reserved worst case unless the provider reported the real cost.
ALTER TABLE mr_usage ADD CONSTRAINT mr_usage_cost_bound CHECK (
  estimated_cost IS NULL
  OR (reconciliation IN ('reconciled', 'tariff', 'not_billed') AND cost = actual_cost AND actual_cost <= estimated_cost)
  OR (reconciliation IN ('estimate_only', 'unknown', 'anomaly_over_estimate') AND cost = estimated_cost)
  OR (reconciliation = 'emulated' AND cost = estimated_cost));

-- 4. Which machine passes produced a run (independent second model or degraded) ----------------------
ALTER TABLE mr_jobs ADD COLUMN independence text CHECK (independence IS NULL OR independence IN ('emulated', 'independent', 'single-model-degraded'));

-- 5. Rotation: a snapshot may carry forward a recent PASSED assessment of a candidate that was not
--    re-researched in this run. The entry still freezes exactly that assessment's values; its own job
--    is recorded, and it must be older than the snapshot and at most 30 days old.
ALTER TABLE mr_snapshot_entries
  ADD COLUMN assessment_job_id bigint,
  ADD COLUMN src_job_id bigint GENERATED ALWAYS AS (COALESCE(assessment_job_id, job_id)) STORED;
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'mr_snapshot_entries'::regclass AND contype = 'f' AND confrelid = 'mr_assessments'::regclass LOOP
    EXECUTE format('ALTER TABLE mr_snapshot_entries DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE mr_snapshot_entries ADD CONSTRAINT mr_snapshot_entries_assessment_fk
  FOREIGN KEY (assessment_id, src_job_id, candidate_id, title, market_score, confidence, evidence_grade, state)
  REFERENCES mr_assessments (id, job_id, candidate_id, title, market_score, confidence, evidence_grade, state);
ALTER TABLE mr_snapshot_entries ADD CONSTRAINT mr_snapshot_entries_carry_other_job CHECK (assessment_job_id IS NULL OR assessment_job_id <> job_id);

CREATE FUNCTION mr_entries_carry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a_as_of date; s_as_of date;
BEGIN
  IF NEW.assessment_job_id IS NULL THEN RETURN NEW; END IF;
  SELECT as_of INTO a_as_of FROM mr_assessments WHERE id = NEW.assessment_id;
  SELECT as_of INTO s_as_of FROM mr_snapshots WHERE id = NEW.snapshot_id;
  IF a_as_of IS NULL OR s_as_of IS NULL OR a_as_of >= s_as_of OR a_as_of < s_as_of - 30 THEN
    RAISE EXCEPTION 'mr_snapshot_entries: a carried-forward assessment must be older than the snapshot and at most 30 days old';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mr_snapshot_entries_carry BEFORE INSERT ON mr_snapshot_entries FOR EACH ROW EXECUTE FUNCTION mr_entries_carry_guard();
ALTER TABLE mr_snapshots ADD COLUMN carried_count int NOT NULL DEFAULT 0 CHECK (carried_count >= 0);
