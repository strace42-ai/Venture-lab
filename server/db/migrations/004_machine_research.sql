-- VL-004A — zero-human autonomous research worker: a SEPARATE machine-assessed dataset.
--
-- Nothing here touches the legacy tables (ideas, evidence, assessments, top10_*): human-reviewed and
-- synthetic-test research keep their own history. Machine rows can never be shown as «проверено
-- человеком»: the strongest machine state is AUTOMATED_EVIDENCE_PASSED («Проверено системой»).
--
-- `feed` separates deterministic fixture emulation ('fixture') from a future live worker ('live').
-- Integrity: every event row carries `feed` and references its job AND candidate through composite
-- foreign keys (id, feed), so a row can never mix feeds; snapshot entries must reference an assessment
-- of the SAME job and candidate with identical frozen values, and only AUTOMATED_EVIDENCE_PASSED ones.
-- Every table except mr_jobs / mr_attempts is append-only (vl_forbid_mutation trigger, migration 001).

CREATE TABLE mr_jobs (
  id               bigserial PRIMARY KEY,
  job_key          text NOT NULL UNIQUE CHECK (job_key ~ '^[a-z0-9][a-z0-9:._-]{2,119}$'),
  feed             text NOT NULL CHECK (feed IN ('fixture', 'live')),
  as_of            date NOT NULL,
  timezone         text NOT NULL,
  status           text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  attempts         int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     int  NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  lease_until      timestamptz,
  budget_limit     int  NOT NULL CHECK (budget_limit >= 0),   -- hard cap per job, all attempts (kopecks)
  monthly_cap      int  NOT NULL CHECK (monthly_cap >= 0),    -- month cap in force at the latest attempt
  -- committed spend of this job = Σ attempts (actual if known, else the full reservation); derived, recomputed
  spent            int  NOT NULL DEFAULT 0 CHECK (spent >= 0),
  pipeline_version text NOT NULL,
  error            text,
  partial_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  UNIQUE (id, feed),
  UNIQUE (id, feed, as_of),
  CHECK (spent <= budget_limit)
);
CREATE INDEX mr_jobs_feed_as_of_idx ON mr_jobs (feed, as_of DESC);

-- Spend ledger: one row per attempt. The attempt may only spend its reservation (enforced by the
-- CallContext). It starts with a chunk and tops up while it owns a live lease; until its actual usage is
-- recorded, the FULL reservation counts against job and month budgets — so a crashed or superseded
-- attempt can never make the ledger under-count, and it only ever holds what it already reserved.
CREATE TABLE mr_attempts (
  job_id           bigint NOT NULL,
  feed             text NOT NULL CHECK (feed IN ('fixture', 'live')),
  attempt          int  NOT NULL CHECK (attempt >= 1),
  month            date NOT NULL CHECK (month = date_trunc('month', month)::date),
  reserved         int  NOT NULL CHECK (reserved >= 0),
  used             int  CHECK (used IS NULL OR (used >= 0 AND used <= reserved)),
  status           text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'partial', 'superseded')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  PRIMARY KEY (job_id, attempt),
  FOREIGN KEY (job_id, feed) REFERENCES mr_jobs (id, feed)
);
CREATE INDEX mr_attempts_month_idx ON mr_attempts (feed, month);

-- Candidate registry (all-time, per feed). The registry row is immutable.
CREATE TABLE mr_candidates (
  id               bigserial PRIMARY KEY,
  feed             text NOT NULL CHECK (feed IN ('fixture', 'live')),
  external_id      text NOT NULL CHECK (external_id ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  first_job_id     bigint NOT NULL,
  first_seen       date NOT NULL,
  -- discovery seed (what the discovery pass found), immutable; current wording lives in assessments
  seed_title       text NOT NULL CHECK (length(seed_title) BETWEEN 3 AND 200),
  seed_pitch       text NOT NULL,
  segment          text NOT NULL CHECK (segment IN ('B2B', 'B2C')),
  category         text NOT NULL CHECK (length(category) BETWEEN 1 AND 60),
  primary_job      text NOT NULL CHECK (primary_job ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  jobs             text[] NOT NULL CHECK (cardinality(jobs) >= 1),
  western_product  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feed, external_id),
  UNIQUE (id, feed),
  FOREIGN KEY (first_job_id, feed, first_seen) REFERENCES mr_jobs (id, feed, as_of)
);

-- Every page read attempt (successful or not) with provenance.
CREATE TABLE mr_sources (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL,
  candidate_id     bigint NOT NULL,
  feed             text NOT NULL,
  source_key       text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 80),
  url              text NOT NULL CHECK (url ~ '^https?://'),
  publisher        text,
  region           text NOT NULL CHECK (region IN ('west', 'ru')),
  source_type      text NOT NULL CHECK (source_type IN ('independent', 'company_self_report', 'primary_data', 'unknown')),
  fetch_status     text NOT NULL CHECK (fetch_status IN ('ok', 'http_error', 'blocked', 'injection_suspected', 'rate_limited', 'budget_exhausted')),
  http_status      int,
  content_hash     text,
  excerpt          text CHECK (excerpt IS NULL OR length(excerpt) <= 2000),
  observed_at      date NOT NULL,
  agent            text NOT NULL CHECK (agent IN ('analyst', 'skeptic')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, candidate_id, source_key),
  -- a quarantined / failed read never stores usable text
  CHECK (fetch_status = 'ok' OR excerpt IS NULL),
  FOREIGN KEY (job_id, feed, observed_at) REFERENCES mr_jobs (id, feed, as_of),
  FOREIGN KEY (candidate_id, feed) REFERENCES mr_candidates (id, feed)
);

-- Material claims, the deterministic check and the skeptic's verdict.
CREATE TABLE mr_claims (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL,
  candidate_id     bigint NOT NULL,
  feed             text NOT NULL,
  claim_key        text NOT NULL CHECK (length(claim_key) BETWEEN 1 AND 80),
  dimension        text NOT NULL CHECK (dimension IN ('westernNeed','westernPay','ruWeakness','ruUnmetJob','monetization','speedToPilot','mvpFeasible','fastTest','distribution','retention','defensibility','riskManageable')),
  text             text NOT NULL CHECK (length(text) BETWEEN 3 AND 1000),
  quote            text,
  source_keys      text[] NOT NULL DEFAULT '{}',
  supporting_source_keys text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL CHECK (status IN ('corroborated', 'vendor_claim', 'single_source', 'contradicted', 'unretrievable', 'unknown')),
  status_reason    text NOT NULL,
  skeptic_verdict  text NOT NULL CHECK (skeptic_verdict IN ('supported', 'refuted', 'needs_more_evidence', 'not_reviewed')),
  skeptic_reason   text,
  high_impact      boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, candidate_id, claim_key),
  CHECK (supporting_source_keys <@ source_keys),
  CHECK (status IN ('corroborated', 'vendor_claim', 'single_source') OR cardinality(supporting_source_keys) = 0 OR status = 'contradicted'),
  FOREIGN KEY (job_id, feed) REFERENCES mr_jobs (id, feed),
  FOREIGN KEY (candidate_id, feed) REFERENCES mr_candidates (id, feed)
);

-- Competitor-search coverage: every query is logged, with the number of hits (also zero).
CREATE TABLE mr_searches (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL,
  candidate_id     bigint,
  feed             text NOT NULL,
  agent            text NOT NULL CHECK (agent IN ('discovery', 'analyst', 'skeptic')),
  purpose          text NOT NULL CHECK (purpose IN ('discovery', 'ru_competitors', 'west_products', 'counterevidence')),
  region           text NOT NULL CHECK (region IN ('west', 'ru', 'world')),
  query            text NOT NULL CHECK (length(query) BETWEEN 1 AND 300),
  result_count     int  NOT NULL CHECK (result_count >= 0),
  status           text NOT NULL CHECK (status IN ('ok', 'rate_limited', 'budget_exhausted', 'error')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, feed) REFERENCES mr_jobs (id, feed),
  FOREIGN KEY (candidate_id, feed) REFERENCES mr_candidates (id, feed)
);

CREATE TABLE mr_competitors (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL,
  candidate_id     bigint NOT NULL,
  feed             text NOT NULL,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  url              text,
  market           text NOT NULL CHECK (market IN ('west', 'ru')),
  kind             text NOT NULL CHECK (kind IN ('direct', 'adjacent', 'substitute')),
  found_by         text NOT NULL CHECK (found_by IN ('analyst', 'skeptic')),
  source_key       text,
  note             text,
  classification_reason text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, candidate_id, market, name),
  FOREIGN KEY (job_id, feed) REFERENCES mr_jobs (id, feed),
  FOREIGN KEY (candidate_id, feed) REFERENCES mr_candidates (id, feed)
);

-- Separate machine passes (analyst, skeptic, quality gate). Never «human».
CREATE TABLE mr_reviews (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL,
  candidate_id     bigint NOT NULL,
  feed             text NOT NULL,
  reviewer         text NOT NULL CHECK (reviewer IN ('analyst', 'skeptic', 'claim_checker', 'quality_gate')),
  model            text NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('propose', 'support', 'challenge', 'pass', 'hold')),
  summary          text NOT NULL CHECK (length(summary) BETWEEN 3 AND 2000),
  findings         text[] NOT NULL DEFAULT '{}',
  cited_claims     text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, feed) REFERENCES mr_jobs (id, feed),
  FOREIGN KEY (candidate_id, feed) REFERENCES mr_candidates (id, feed)
);

-- Immutable machine assessments (one per candidate per successful job).
CREATE TABLE mr_assessments (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL,
  candidate_id     bigint NOT NULL,
  feed             text NOT NULL,
  as_of            date NOT NULL,
  title            text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  pitch            text NOT NULL,
  segment          text NOT NULL CHECK (segment IN ('B2B', 'B2C')),
  category         text NOT NULL,
  rubric_version   text NOT NULL CHECK (rubric_version = 'v1.0'),
  -- 12 rubric values (0..5 or null) and their machine rationale; validated in code (Zod) before insert
  score_western_need int, score_western_pay int, score_ru_weakness int, score_ru_unmet_job int,
  score_monetization int, score_speed_to_pilot int, score_mvp_feasible int, score_fast_test int,
  score_distribution int, score_retention int, score_defensibility int, score_risk_manageable int,
  conf_completeness int NOT NULL, conf_corroboration int NOT NULL, conf_recency int NOT NULL,
  conf_reliability int NOT NULL, conf_russia_validation int NOT NULL,
  fit_skills int, fit_access int, fit_time_to_sale int, fit_motivation int, fit_synergy int,
  market_score     int NOT NULL CHECK (market_score BETWEEN 0 AND 100),
  confidence       int NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  founder_fit      int CHECK (founder_fit BETWEEN 0 AND 40),
  evidence_grade   text NOT NULL CHECK (evidence_grade IN ('A', 'B', 'C', 'D')),
  state            text NOT NULL CHECK (state IN ('DISCOVERED', 'AUTOMATED_EVIDENCE_PASSED', 'RESEARCH_HOLD')),
  hold_reasons     text[] NOT NULL DEFAULT '{}',
  rationale        text NOT NULL,
  dimension_notes  text[] NOT NULL DEFAULT '{}',
  pipeline_version text NOT NULL,
  models           text[] NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, candidate_id),
  -- target of the snapshot-entry consistency FK (frozen values must equal the assessment)
  UNIQUE (id, job_id, candidate_id, title, market_score, confidence, evidence_grade, state),
  CHECK (state <> 'RESEARCH_HOLD' OR cardinality(hold_reasons) > 0),
  CHECK (state <> 'AUTOMATED_EVIDENCE_PASSED' OR evidence_grade <> 'D'),
  CHECK (
    (score_western_need IS NULL OR score_western_need BETWEEN 0 AND 5) AND (score_western_pay IS NULL OR score_western_pay BETWEEN 0 AND 5) AND
    (score_ru_weakness IS NULL OR score_ru_weakness BETWEEN 0 AND 5) AND (score_ru_unmet_job IS NULL OR score_ru_unmet_job BETWEEN 0 AND 5) AND
    (score_monetization IS NULL OR score_monetization BETWEEN 0 AND 5) AND (score_speed_to_pilot IS NULL OR score_speed_to_pilot BETWEEN 0 AND 5) AND
    (score_mvp_feasible IS NULL OR score_mvp_feasible BETWEEN 0 AND 5) AND (score_fast_test IS NULL OR score_fast_test BETWEEN 0 AND 5) AND
    (score_distribution IS NULL OR score_distribution BETWEEN 0 AND 5) AND (score_retention IS NULL OR score_retention BETWEEN 0 AND 5) AND
    (score_defensibility IS NULL OR score_defensibility BETWEEN 0 AND 5) AND (score_risk_manageable IS NULL OR score_risk_manageable BETWEEN 0 AND 5)
  ),
  FOREIGN KEY (job_id, feed, as_of) REFERENCES mr_jobs (id, feed, as_of),
  FOREIGN KEY (candidate_id, feed) REFERENCES mr_candidates (id, feed)
);
CREATE INDEX mr_assessments_candidate_idx ON mr_assessments (candidate_id, as_of DESC, id DESC);

-- Automatic machine TOP-10 snapshots: one per feed and date, published only by a successful job.
CREATE TABLE mr_snapshots (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL UNIQUE,
  feed             text NOT NULL CHECK (feed IN ('fixture', 'live')),
  as_of            date NOT NULL,
  eligible_count   int NOT NULL CHECK (eligible_count >= 0),
  hold_count       int NOT NULL CHECK (hold_count >= 0),
  published_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feed, as_of),
  UNIQUE (id, job_id, feed),
  FOREIGN KEY (job_id, feed, as_of) REFERENCES mr_jobs (id, feed, as_of)
);

CREATE TABLE mr_snapshot_entries (
  snapshot_id      bigint NOT NULL,
  job_id           bigint NOT NULL,
  feed             text NOT NULL,
  rank             int NOT NULL CHECK (rank BETWEEN 1 AND 10),
  candidate_id     bigint NOT NULL,
  assessment_id    bigint NOT NULL,
  title            text NOT NULL,
  market_score     int NOT NULL,
  confidence       int NOT NULL,
  evidence_grade   text NOT NULL,
  state            text NOT NULL DEFAULT 'AUTOMATED_EVIDENCE_PASSED' CHECK (state = 'AUTOMATED_EVIDENCE_PASSED'),
  prev_rank        int,
  score_delta      int,
  PRIMARY KEY (snapshot_id, rank),
  UNIQUE (snapshot_id, candidate_id),
  -- the entry belongs to the snapshot's own job and feed
  FOREIGN KEY (snapshot_id, job_id, feed) REFERENCES mr_snapshots (id, job_id, feed),
  FOREIGN KEY (candidate_id, feed) REFERENCES mr_candidates (id, feed),
  -- …and freezes exactly the values of an assessment of THAT job and candidate that passed the gate
  FOREIGN KEY (assessment_id, job_id, candidate_id, title, market_score, confidence, evidence_grade, state)
    REFERENCES mr_assessments (id, job_id, candidate_id, title, market_score, confidence, evidence_grade, state)
);

-- Provider telemetry and costs (fixture providers report deterministic units), per attempt.
CREATE TABLE mr_usage (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL,
  feed             text NOT NULL,
  attempt          int NOT NULL,
  provider         text NOT NULL,
  operation        text NOT NULL CHECK (operation IN ('search', 'read', 'llm')),
  model            text,
  request_id       text NOT NULL UNIQUE,
  tokens_in        int NOT NULL DEFAULT 0,
  tokens_out       int NOT NULL DEFAULT 0,
  cost             int NOT NULL CHECK (cost >= 0),
  price_version    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, feed) REFERENCES mr_jobs (id, feed),
  FOREIGN KEY (job_id, attempt) REFERENCES mr_attempts (job_id, attempt)
);

CREATE TRIGGER mr_candidates_append_only       BEFORE UPDATE OR DELETE ON mr_candidates       FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER mr_sources_append_only          BEFORE UPDATE OR DELETE ON mr_sources          FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER mr_claims_append_only           BEFORE UPDATE OR DELETE ON mr_claims           FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER mr_searches_append_only         BEFORE UPDATE OR DELETE ON mr_searches         FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER mr_competitors_append_only      BEFORE UPDATE OR DELETE ON mr_competitors      FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER mr_reviews_append_only          BEFORE UPDATE OR DELETE ON mr_reviews          FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER mr_assessments_append_only      BEFORE UPDATE OR DELETE ON mr_assessments      FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER mr_snapshots_append_only        BEFORE UPDATE OR DELETE ON mr_snapshots        FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER mr_snapshot_entries_append_only BEFORE UPDATE OR DELETE ON mr_snapshot_entries FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER mr_usage_append_only            BEFORE UPDATE OR DELETE ON mr_usage            FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();

-- Jobs and attempts are mutable state machines, but never deletable, and their identity never changes.
CREATE FUNCTION mr_jobs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mr_jobs: DELETE forbidden'; END IF;
  IF NEW.job_key <> OLD.job_key OR NEW.feed <> OLD.feed OR NEW.as_of <> OLD.as_of THEN
    RAISE EXCEPTION 'mr_jobs identity (job_key, feed, as_of) is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION mr_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mr_attempts: DELETE forbidden'; END IF;
  IF NEW.month <> OLD.month OR NEW.feed <> OLD.feed OR NEW.job_id <> OLD.job_id OR NEW.attempt <> OLD.attempt
     OR (OLD.used IS NOT NULL AND NEW.used IS DISTINCT FROM OLD.used) THEN
    RAISE EXCEPTION 'mr_attempts: identity is immutable and recorded usage cannot be rewritten';
  END IF;
  -- A reservation can only GROW (top-up), and only while the attempt is running and unsettled.
  IF NEW.reserved <> OLD.reserved AND (NEW.reserved < OLD.reserved OR OLD.status <> 'running' OR OLD.used IS NOT NULL) THEN
    RAISE EXCEPTION 'mr_attempts: a reservation may only grow while its attempt is running';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mr_jobs_identity     BEFORE UPDATE OR DELETE ON mr_jobs     FOR EACH ROW EXECUTE FUNCTION mr_jobs_guard();
CREATE TRIGGER mr_attempts_identity BEFORE UPDATE OR DELETE ON mr_attempts FOR EACH ROW EXECUTE FUNCTION mr_attempts_guard();
