-- VL-002 review fix: hard isolation of the REAL research dataset from synthetic TEST imports,
-- and fully frozen snapshot rows.
--
-- A «dataset» is identified by the boolean `synthetic` that every import run, research run and
-- idea already carries. This migration makes the database itself refuse cross-dataset links:
--   * an idea can only be created/updated by a research run of the same dataset;
--   * a snapshot belongs to exactly one dataset, and every entry must reference an idea of that
--     dataset (composite foreign keys) — a test idea can never appear in a REAL snapshot;
--   * one snapshot per (dataset, date) instead of one per date.
-- Snapshot entries additionally freeze the idea title/slug at snapshot time.

-- ---------------------------------------------------------------- run ↔ idea dataset consistency
ALTER TABLE research_runs ADD CONSTRAINT research_runs_run_dataset_key UNIQUE (run_id, synthetic);
ALTER TABLE ideas ADD CONSTRAINT ideas_id_dataset_key UNIQUE (id, synthetic);
ALTER TABLE ideas
  ADD CONSTRAINT ideas_first_run_dataset_fk FOREIGN KEY (first_run_id, synthetic) REFERENCES research_runs (run_id, synthetic),
  ADD CONSTRAINT ideas_last_run_dataset_fk  FOREIGN KEY (last_run_id,  synthetic) REFERENCES research_runs (run_id, synthetic);

-- ---------------------------------------------------------------- snapshots per dataset
-- Backfilling new columns is a one-off schema change, so the append-only guards are lifted for
-- the duration of this migration transaction only.
ALTER TABLE top10_snapshots DISABLE TRIGGER top10_snapshots_append_only;
ALTER TABLE top10_entries   DISABLE TRIGGER top10_entries_append_only;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM top10_entries t JOIN ideas i ON i.id = t.idea_id
     GROUP BY t.snapshot_id HAVING bool_and(i.synthetic) IS DISTINCT FROM bool_or(i.synthetic)
  ) THEN
    RAISE EXCEPTION 'A stored snapshot mixes synthetic and real ideas (created before dataset isolation). '
                    'This can only exist in a local development DB: rebuild it with `npm run db:reset -- --yes`.';
  END IF;
END
$$;

ALTER TABLE top10_snapshots ADD COLUMN synthetic boolean;
UPDATE top10_snapshots s
   SET synthetic = COALESCE((SELECT bool_and(i.synthetic) FROM top10_entries t JOIN ideas i ON i.id = t.idea_id WHERE t.snapshot_id = s.id), false);
ALTER TABLE top10_snapshots ALTER COLUMN synthetic SET NOT NULL;
ALTER TABLE top10_snapshots DROP CONSTRAINT top10_snapshots_as_of_key;
ALTER TABLE top10_snapshots ADD CONSTRAINT top10_snapshots_dataset_as_of_key UNIQUE (synthetic, as_of);
ALTER TABLE top10_snapshots ADD CONSTRAINT top10_snapshots_id_dataset_key UNIQUE (id, synthetic);

ALTER TABLE top10_entries ADD COLUMN synthetic boolean, ADD COLUMN title text, ADD COLUMN slug text;
-- Rows created before this migration get the title/slug current at migration time (best available).
UPDATE top10_entries t SET synthetic = i.synthetic, title = i.title, slug = i.slug FROM ideas i WHERE i.id = t.idea_id;
ALTER TABLE top10_entries
  ALTER COLUMN synthetic SET NOT NULL,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN slug SET NOT NULL,
  ADD CONSTRAINT top10_entries_snapshot_dataset_fk FOREIGN KEY (snapshot_id, synthetic) REFERENCES top10_snapshots (id, synthetic),
  ADD CONSTRAINT top10_entries_idea_dataset_fk FOREIGN KEY (idea_id, synthetic) REFERENCES ideas (id, synthetic);

ALTER TABLE top10_snapshots ENABLE TRIGGER top10_snapshots_append_only;
ALTER TABLE top10_entries   ENABLE TRIGGER top10_entries_append_only;

CREATE INDEX ideas_dataset ON ideas (synthetic, id);
CREATE INDEX research_runs_dataset ON research_runs (synthetic, researched_at);
