-- VL-004A — zero-human autonomous research worker: a SEPARATE machine-assessed dataset.
--
-- Nothing here touches the legacy tables (ideas, evidence, assessments, top10_*): human-reviewed and
-- synthetic-test research keep their own history. Machine rows can never be shown as «проверено
-- человеком»: the strongest machine state is AUTOMATED_EVIDENCE_PASSED («Проверено системой»).
--
-- `feed` separates deterministic fixture emulation ('fixture') from a future live worker ('live').
-- Every table except mr_jobs is append-only (vl_forbid_mutation trigger from migration 001).

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
  budget_limit     int  NOT NULL CHECK (budget_limit >= 0),   -- hard cap, cost units (kopecks)
  spent            int  NOT NULL DEFAULT 0 CHECK (spent >= 0),
  pipeline_version text NOT NULL,
  error            text,
  partial_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  UNIQUE (id, feed)
);
CREATE INDEX mr_jobs_feed_as_of_idx ON mr_jobs (feed, as_of DESC);

-- Candidate registry (all-time, per feed). Title may be refreshed only by a later run's assessment row;
-- the registry row itself is immutable.
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
  FOREIGN KEY (first_job_id, feed) REFERENCES mr_jobs (id, feed)
);

-- Every page read attempt (successful or not) with provenance.
CREATE TABLE mr_sources (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL REFERENCES mr_jobs (id),
  candidate_id     bigint NOT NULL REFERENCES mr_candidates (id),
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
  CHECK (fetch_status = 'ok' OR excerpt IS NULL)
);

-- Material claims and their machine verification state.
CREATE TABLE mr_claims (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL REFERENCES mr_jobs (id),
  candidate_id     bigint NOT NULL REFERENCES mr_candidates (id),
  claim_key        text NOT NULL CHECK (length(claim_key) BETWEEN 1 AND 80),
  dimension        text NOT NULL CHECK (dimension IN ('westernNeed','westernPay','ruWeakness','ruUnmetJob','monetization','speedToPilot','mvpFeasible','fastTest','distribution','retention','defensibility','riskManageable')),
  text             text NOT NULL CHECK (length(text) BETWEEN 3 AND 1000),
  quote            text,
  source_keys      text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL CHECK (status IN ('corroborated', 'vendor_claim', 'single_source', 'contradicted', 'unretrievable', 'unknown')),
  status_reason    text NOT NULL,
  high_impact      boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, candidate_id, claim_key)
);

-- Competitor-search coverage: every query is logged, with the number of hits (also zero).
CREATE TABLE mr_searches (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL REFERENCES mr_jobs (id),
  candidate_id     bigint REFERENCES mr_candidates (id),
  agent            text NOT NULL CHECK (agent IN ('discovery', 'analyst', 'skeptic')),
  purpose          text NOT NULL CHECK (purpose IN ('discovery', 'ru_competitors', 'west_products', 'counterevidence')),
  region           text NOT NULL CHECK (region IN ('west', 'ru', 'world')),
  query            text NOT NULL CHECK (length(query) BETWEEN 1 AND 300),
  result_count     int  NOT NULL CHECK (result_count >= 0),
  status           text NOT NULL CHECK (status IN ('ok', 'rate_limited', 'budget_exhausted', 'error')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mr_competitors (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL REFERENCES mr_jobs (id),
  candidate_id     bigint NOT NULL REFERENCES mr_candidates (id),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  url              text,
  market           text NOT NULL CHECK (market IN ('west', 'ru')),
  kind             text NOT NULL CHECK (kind IN ('direct', 'adjacent', 'substitute')),
  found_by         text NOT NULL CHECK (found_by IN ('analyst', 'skeptic')),
  source_key       text,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, candidate_id, market, name)
);

-- Separate machine passes (analyst, skeptic, quality gate). Never «human».
CREATE TABLE mr_reviews (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL REFERENCES mr_jobs (id),
  candidate_id     bigint NOT NULL REFERENCES mr_candidates (id),
  reviewer         text NOT NULL CHECK (reviewer IN ('analyst', 'skeptic', 'claim_checker', 'quality_gate')),
  model            text NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('propose', 'support', 'challenge', 'pass', 'hold')),
  summary          text NOT NULL CHECK (length(summary) BETWEEN 3 AND 2000),
  findings         text[] NOT NULL DEFAULT '{}',
  cited_claims     text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Immutable machine assessments (one per candidate per successful job).
CREATE TABLE mr_assessments (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL REFERENCES mr_jobs (id),
  candidate_id     bigint NOT NULL REFERENCES mr_candidates (id),
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
  CHECK (state <> 'RESEARCH_HOLD' OR cardinality(hold_reasons) > 0),
  CHECK (
    (score_western_need IS NULL OR score_western_need BETWEEN 0 AND 5) AND (score_western_pay IS NULL OR score_western_pay BETWEEN 0 AND 5) AND
    (score_ru_weakness IS NULL OR score_ru_weakness BETWEEN 0 AND 5) AND (score_ru_unmet_job IS NULL OR score_ru_unmet_job BETWEEN 0 AND 5) AND
    (score_monetization IS NULL OR score_monetization BETWEEN 0 AND 5) AND (score_speed_to_pilot IS NULL OR score_speed_to_pilot BETWEEN 0 AND 5) AND
    (score_mvp_feasible IS NULL OR score_mvp_feasible BETWEEN 0 AND 5) AND (score_fast_test IS NULL OR score_fast_test BETWEEN 0 AND 5) AND
    (score_distribution IS NULL OR score_distribution BETWEEN 0 AND 5) AND (score_retention IS NULL OR score_retention BETWEEN 0 AND 5) AND
    (score_defensibility IS NULL OR score_defensibility BETWEEN 0 AND 5) AND (score_risk_manageable IS NULL OR score_risk_manageable BETWEEN 0 AND 5)
  )
);
CREATE INDEX mr_assessments_candidate_idx ON mr_assessments (candidate_id, as_of DESC, id DESC);

-- Automatic machine TOP-10 snapshots: one per feed and date, published only by a successful job.
CREATE TABLE mr_snapshots (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL UNIQUE REFERENCES mr_jobs (id),
  feed             text NOT NULL CHECK (feed IN ('fixture', 'live')),
  as_of            date NOT NULL,
  eligible_count   int NOT NULL CHECK (eligible_count >= 0),
  hold_count       int NOT NULL CHECK (hold_count >= 0),
  published_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feed, as_of)
);

CREATE TABLE mr_snapshot_entries (
  snapshot_id      bigint NOT NULL REFERENCES mr_snapshots (id),
  rank             int NOT NULL CHECK (rank BETWEEN 1 AND 10),
  candidate_id     bigint NOT NULL REFERENCES mr_candidates (id),
  assessment_id    bigint NOT NULL REFERENCES mr_assessments (id),
  title            text NOT NULL,
  market_score     int NOT NULL,
  confidence       int NOT NULL,
  evidence_grade   text NOT NULL,
  prev_rank        int,
  score_delta      int,
  PRIMARY KEY (snapshot_id, rank),
  UNIQUE (snapshot_id, candidate_id)
);

-- Provider telemetry and costs (fixture providers report deterministic units).
CREATE TABLE mr_usage (
  id               bigserial PRIMARY KEY,
  job_id           bigint NOT NULL REFERENCES mr_jobs (id),
  attempt          int NOT NULL,
  provider         text NOT NULL,
  operation        text NOT NULL CHECK (operation IN ('search', 'read', 'llm')),
  model            text,
  request_id       text NOT NULL,
  tokens_in        int NOT NULL DEFAULT 0,
  tokens_out       int NOT NULL DEFAULT 0,
  cost             int NOT NULL CHECK (cost >= 0),
  price_version    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
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
