-- VL-002 Research Engine Foundation — initial schema.
-- Principles: append-only history (assessments, stage transitions, evidence, reviews, snapshots),
-- explicit constraints instead of a generic JSON blob, provenance via import/research runs.

-- Generic guard: rows of append-only tables can never be updated or deleted.
CREATE FUNCTION vl_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table "%": % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

-- ---------------------------------------------------------------- provenance
CREATE TABLE import_runs (
  id              bigserial PRIMARY KEY,
  run_id          text NOT NULL UNIQUE CHECK (run_id ~ '^[a-z0-9][a-z0-9._-]{2,99}$'),
  checksum        text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  schema_version  text NOT NULL CHECK (schema_version = 'vl-research-1'),
  file_name       text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  origin          text NOT NULL CHECK (origin IN ('human-reviewed', 'synthetic-test')),
  actor           text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 120),
  counts          jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  diagnostics     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(diagnostics) = 'array'),
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE research_runs (
  run_id           text PRIMARY KEY REFERENCES import_runs (run_id),
  researched_at    date NOT NULL,
  origin           text NOT NULL CHECK (origin IN ('human-reviewed', 'synthetic-test')),
  synthetic        boolean NOT NULL,
  reviewed_by      text NOT NULL,
  title            text,
  coverage         text,
  limitations      text,
  markets          text[] NOT NULL DEFAULT '{}',
  source_refs      text[] NOT NULL DEFAULT '{}',
  discovered_count integer NOT NULL CHECK (discovered_count >= 0),
  updated_count    integer NOT NULL CHECK (updated_count >= 0),
  rejected_count   integer NOT NULL CHECK (rejected_count >= 0),
  sources_count    integer NOT NULL CHECK (sources_count >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (synthetic = (origin = 'synthetic-test'))
);

-- ---------------------------------------------------------------- ideas
CREATE TABLE ideas (
  id                bigserial PRIMARY KEY,
  external_id       text NOT NULL UNIQUE CHECK (external_id ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  pitch             text NOT NULL CHECK (char_length(pitch) BETWEEN 1 AND 1000),
  segment           text NOT NULL CHECK (segment IN ('B2B', 'B2C')),
  category          text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 60),
  geography         text NOT NULL,
  target_persona    text,
  problem           text,
  ru_unmet_job      text,
  why_now           text,
  monetization      text,
  price_hypothesis  text,
  distribution      text,
  mvp               text,
  next_action       text,
  thesis            text,
  excluded_features text[] NOT NULL DEFAULT '{}',
  origin_markets    text[] NOT NULL DEFAULT '{}',
  risk_flags        text[] NOT NULL DEFAULT '{}',
  synthetic         boolean NOT NULL,
  first_run_id      text NOT NULL REFERENCES research_runs (run_id),
  last_run_id       text NOT NULL REFERENCES research_runs (run_id),
  content_hash      text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Descriptive fields may be refreshed by a later reviewed run (every version is kept in
-- idea_revisions); ideas themselves are never deleted.
CREATE TRIGGER ideas_no_delete BEFORE DELETE ON ideas FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();

CREATE TABLE idea_revisions (
  id         bigserial PRIMARY KEY,
  idea_id    bigint NOT NULL REFERENCES ideas (id),
  run_id     text NOT NULL REFERENCES research_runs (run_id),
  content    jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idea_id, run_id)
);

CREATE TABLE stage_transitions (
  id           bigserial PRIMARY KEY,
  idea_id      bigint NOT NULL REFERENCES ideas (id),
  stage        text NOT NULL CHECK (stage IN ('discovered','researching','scored','validation_planned','validating','paid_signal',
                                              'build_candidate','building','launched','monetizing','paused','rejected')),
  effective_at timestamptz NOT NULL,
  actor        text NOT NULL,
  reason       text,
  run_id       text NOT NULL REFERENCES research_runs (run_id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stage_transitions_idea ON stage_transitions (idea_id, effective_at, id);

-- ---------------------------------------------------------------- evidence
CREATE TABLE evidence (
  id            bigserial PRIMARY KEY,
  idea_id       bigint NOT NULL REFERENCES ideas (id),
  external_id   text NOT NULL CHECK (external_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  region        text NOT NULL CHECK (region IN ('west', 'ru')),
  claim         text NOT NULL CHECK (char_length(claim) BETWEEN 1 AND 1000),
  url           text CHECK (url ~ '^https?://' AND char_length(url) <= 2048),
  title         text,
  publisher     text,
  source_type   text NOT NULL CHECK (source_type IN ('independent', 'company_self_report', 'primary_data', 'unknown')),
  language      text CHECK (language ~ '^[a-z]{2}$'),
  published_at  date,
  observed_at   date,
  retrieved_at  date,
  dimensions    text[] NOT NULL DEFAULT '{}',
  support_note  text,
  run_id        text NOT NULL REFERENCES research_runs (run_id),
  content_hash  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idea_id, external_id)
);

-- Verification status changes are appended, never edited in place.
CREATE TABLE evidence_reviews (
  id           bigserial PRIMARY KEY,
  evidence_id  bigint NOT NULL REFERENCES evidence (id),
  status       text NOT NULL CHECK (status IN ('unreviewed', 'checked', 'rejected')),
  run_id       text NOT NULL REFERENCES research_runs (run_id),
  note         text,
  reviewed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_reviews_evidence ON evidence_reviews (evidence_id, id);

CREATE TABLE competitors (
  id            bigserial PRIMARY KEY,
  idea_id       bigint NOT NULL REFERENCES ideas (id),
  external_id   text NOT NULL CHECK (external_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  market        text NOT NULL CHECK (market IN ('west', 'ru')),
  url           text CHECK (url ~ '^https?://' AND char_length(url) <= 2048),
  kind          text NOT NULL CHECK (kind IN ('direct', 'adjacent', 'substitute')),
  coverage      text NOT NULL CHECK (coverage IN ('high', 'partial', 'low', 'unknown')),
  functions     text,
  gap           text,
  observed_at   date,
  evidence_refs text[] NOT NULL DEFAULT '{}',
  run_id        text NOT NULL REFERENCES research_runs (run_id),
  content_hash  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idea_id, external_id)
);

-- ---------------------------------------------------------------- assessments
CREATE TABLE assessments (
  id              bigserial PRIMARY KEY,
  idea_id         bigint NOT NULL REFERENCES ideas (id),
  rubric_version  text NOT NULL CHECK (rubric_version = 'v1.0'),
  assessed_at     timestamptz NOT NULL,
  assessor        text NOT NULL CHECK (char_length(assessor) BETWEEN 1 AND 120),
  -- Raw 0–5|null per dimension; validated by the importer's Zod schema. Totals are NEVER stored:
  -- they are always recomputed by src/domain/scoring.ts.
  scores          jsonb NOT NULL CHECK (jsonb_typeof(scores) = 'object'),
  confidence      jsonb NOT NULL CHECK (jsonb_typeof(confidence) = 'object'),
  founder_fit     jsonb CHECK (founder_fit IS NULL OR jsonb_typeof(founder_fit) = 'object'),
  rationale       text NOT NULL CHECK (char_length(rationale) BETWEEN 20 AND 4000),
  evidence_refs   text[] NOT NULL CHECK (cardinality(evidence_refs) >= 1),
  unknowns        text[] NOT NULL DEFAULT '{}',
  revision_reason text,
  run_id          text NOT NULL REFERENCES research_runs (run_id),
  content_hash    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idea_id, content_hash)
);
CREATE INDEX assessments_idea ON assessments (idea_id, assessed_at, id);

-- ---------------------------------------------------------------- snapshots
CREATE TABLE top10_snapshots (
  id             text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{2,79}$'),
  as_of          date NOT NULL UNIQUE,
  rubric_version text NOT NULL CHECK (rubric_version = 'v1.0'),
  -- Latest import run at creation time (provenance of the data the snapshot was computed from).
  source_run_id  text REFERENCES import_runs (run_id),
  created_by     text NOT NULL,
  entry_count    integer NOT NULL CHECK (entry_count >= 1),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Full ordered ranking at as_of (TOP-10 = rank <= 10); storing all ranks keeps movement exact.
CREATE TABLE top10_entries (
  snapshot_id text NOT NULL REFERENCES top10_snapshots (id),
  rank        integer NOT NULL CHECK (rank >= 1),
  idea_id     bigint NOT NULL REFERENCES ideas (id),
  score       integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  confidence  integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  PRIMARY KEY (snapshot_id, rank),
  UNIQUE (snapshot_id, idea_id)
);

-- ---------------------------------------------------------------- append-only guards
CREATE TRIGGER import_runs_append_only      BEFORE UPDATE OR DELETE ON import_runs       FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER research_runs_append_only    BEFORE UPDATE OR DELETE ON research_runs     FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER idea_revisions_append_only   BEFORE UPDATE OR DELETE ON idea_revisions    FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER stage_transitions_append_only BEFORE UPDATE OR DELETE ON stage_transitions FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER evidence_append_only         BEFORE UPDATE OR DELETE ON evidence          FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER evidence_reviews_append_only BEFORE UPDATE OR DELETE ON evidence_reviews  FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER competitors_append_only      BEFORE UPDATE OR DELETE ON competitors       FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER assessments_append_only      BEFORE UPDATE OR DELETE ON assessments       FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER top10_snapshots_append_only  BEFORE UPDATE OR DELETE ON top10_snapshots   FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
CREATE TRIGGER top10_entries_append_only    BEFORE UPDATE OR DELETE ON top10_entries     FOR EACH ROW EXECUTE FUNCTION vl_forbid_mutation();
