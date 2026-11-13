-- VL-004B-prep: bounded live TRIALS (Phase B) with ONE cumulative spend ceiling across all stages.
--  - a trial has an immutable total budget (kopecks); every stage is its own job `trial:<id>:<stage>`
--    dated with the real day it runs (no artificial future dating to «free» a job key);
--  - the cumulative committed spend of all attempts of all jobs of a trial can never exceed the trial
--    budget (enforced in code under a per-trial advisory lock, recorded here for audit);
--  - trial jobs never publish a snapshot into the live TOP-10 (isolation of test runs).
CREATE TABLE mr_trials (
  trial_id     text PRIMARY KEY CHECK (trial_id ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  feed         text NOT NULL CHECK (feed = 'live'),
  budget_limit int  NOT NULL CHECK (budget_limit > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mr_trials_append_only BEFORE UPDATE OR DELETE ON mr_trials FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();

ALTER TABLE mr_jobs
  ADD COLUMN trial_id    text REFERENCES mr_trials (trial_id),
  ADD COLUMN trial_stage text CHECK (trial_stage IS NULL OR trial_stage IN ('probe', 'stage2', 'stage3'));
-- NULL-safe: both set or both unset; trials are live only; one job per trial stage.
ALTER TABLE mr_jobs ADD CONSTRAINT mr_jobs_trial_pair CHECK ((trial_id IS NULL) = (trial_stage IS NULL));
ALTER TABLE mr_jobs ADD CONSTRAINT mr_jobs_trial_live CHECK (trial_id IS NULL OR feed = 'live');
CREATE UNIQUE INDEX mr_jobs_trial_stage_uq ON mr_jobs (trial_id, trial_stage) WHERE trial_id IS NOT NULL;

-- A trial job never owns a snapshot (isolation from the published live TOP-10).
CREATE FUNCTION mr_snapshots_no_trial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mr_jobs WHERE id = NEW.job_id AND trial_id IS NOT NULL) THEN
    RAISE EXCEPTION 'mr_snapshots: a trial job never publishes a snapshot';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mr_snapshots_no_trial BEFORE INSERT ON mr_snapshots FOR EACH ROW EXECUTE FUNCTION mr_snapshots_no_trial();

-- Job identity now includes the trial binding.
CREATE OR REPLACE FUNCTION mr_jobs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mr_jobs: DELETE forbidden'; END IF;
  IF NEW.job_key <> OLD.job_key OR NEW.feed <> OLD.feed OR NEW.as_of <> OLD.as_of
     OR NEW.trial_id IS DISTINCT FROM OLD.trial_id OR NEW.trial_stage IS DISTINCT FROM OLD.trial_stage THEN
    RAISE EXCEPTION 'mr_jobs identity (job_key, feed, as_of, trial) is immutable';
  END IF;
  RETURN NEW;
END $$;
