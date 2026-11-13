-- VL-004B-resume: technically incomplete research is NOT success; a trial stage can be resumed as a new
-- RUN, never by rewriting history. Forward-only; existing rows are not rewritten.
--
-- 1. Status `incomplete`
--    A job whose research stopped for a technical reason before the evidence chain finished (analyst or
--    skeptic unavailable, the model output rejected) is `incomplete`. It differs from:
--      - `succeeded`: the research ran to its end. It may end in RESEARCH_HOLD for evidence reasons, which
--        is a legitimate RESULT;
--      - `failed`: an exception, with nothing persisted.
--    An attempt that persisted such a result is `incomplete` too.
ALTER TABLE mr_jobs DROP CONSTRAINT mr_jobs_status_check;
ALTER TABLE mr_jobs ADD CONSTRAINT mr_jobs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'incomplete'));
ALTER TABLE mr_attempts DROP CONSTRAINT mr_attempts_status_check;
ALTER TABLE mr_attempts ADD CONSTRAINT mr_attempts_status_check CHECK (status IN ('running', 'succeeded', 'failed', 'partial', 'superseded', 'incomplete'));

-- 2. Runs of a trial stage
--    A stage can have several RUNS: run 1 has key `trial:<id>:<stage>`, run n > 1 has `trial:<id>:<stage>:r<n>`.
--    - A new run starts only after an `incomplete` run, explicitly (--retry). The old run and everything it
--      wrote stay as they were.
--    - The stage budget cap and the trial budget are cumulative over all runs (enforced in code under the
--      trial lock).
ALTER TABLE mr_jobs ADD COLUMN trial_run int;
UPDATE mr_jobs SET trial_run = 1 WHERE trial_id IS NOT NULL;
ALTER TABLE mr_jobs ADD CONSTRAINT mr_jobs_trial_run CHECK ((trial_id IS NULL) = (trial_run IS NULL) AND (trial_run IS NULL OR trial_run BETWEEN 1 AND 5));
DROP INDEX mr_jobs_trial_stage_uq;
CREATE UNIQUE INDEX mr_jobs_trial_stage_run_uq ON mr_jobs (trial_id, trial_stage, trial_run) WHERE trial_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mr_jobs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mr_jobs: DELETE forbidden'; END IF;
  IF NEW.job_key <> OLD.job_key OR NEW.feed <> OLD.feed OR NEW.as_of <> OLD.as_of
     OR NEW.trial_id IS DISTINCT FROM OLD.trial_id OR NEW.trial_stage IS DISTINCT FROM OLD.trial_stage
     OR NEW.trial_run IS DISTINCT FROM OLD.trial_run THEN
    RAISE EXCEPTION 'mr_jobs identity (job_key, feed, as_of, trial, run) is immutable';
  END IF;
  -- An incomplete trial job is never silently turned back into a success.
  IF OLD.status = 'incomplete' AND NEW.status = 'succeeded' THEN
    RAISE EXCEPTION 'mr_jobs: an incomplete job cannot become succeeded (start a new run instead)';
  END IF;
  RETURN NEW;
END $$;

-- 3. Audit log of explicit operations on jobs (append-only)
CREATE TABLE mr_job_events (
  id          bigserial PRIMARY KEY,
  job_id      bigint NOT NULL REFERENCES mr_jobs (id),
  kind        text NOT NULL CHECK (kind IN ('reclassified_incomplete', 'run_started')),
  from_status text,
  to_status   text,
  reason      text NOT NULL CHECK (length(reason) BETWEEN 3 AND 2000),
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mr_job_events_append_only BEFORE UPDATE OR DELETE ON mr_job_events FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();

-- 4. Evidence ↔ attempt binding
--    New rows record the attempt that wrote them; legacy rows stay NULL, meaning «not recorded».
--    A NOT VALID check requires it for every new row.
ALTER TABLE mr_sources  ADD COLUMN attempt int CHECK (attempt IS NULL OR attempt >= 1);
ALTER TABLE mr_searches ADD COLUMN attempt int CHECK (attempt IS NULL OR attempt >= 1);
ALTER TABLE mr_reviews  ADD COLUMN attempt int CHECK (attempt IS NULL OR attempt >= 1);
ALTER TABLE mr_sources  ADD CONSTRAINT mr_sources_attempt_required  CHECK (attempt IS NOT NULL) NOT VALID;
ALTER TABLE mr_searches ADD CONSTRAINT mr_searches_attempt_required CHECK (attempt IS NOT NULL) NOT VALID;
ALTER TABLE mr_reviews  ADD CONSTRAINT mr_reviews_attempt_required  CHECK (attempt IS NOT NULL) NOT VALID;
