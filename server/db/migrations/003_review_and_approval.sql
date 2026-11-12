-- VL-003 — manual evidence review events and founder approval of REAL imports.
--
-- 1) evidence_reviews becomes the single append-only audit log of verification status for both
--    sources of truth:
--      origin = 'import' — status carried by a research import (run_id required);
--      origin = 'manual' — a human review made with `npm run research:review` (no run; actor + reason
--                          required). Rows are never updated or deleted (existing trigger).
--    Legacy rows keep origin 'import' (they were all created by imports); their actor is resolved
--    from research_runs.reviewed_by when displayed.
-- 2) import_runs records the founder approval of human-reviewed (REAL) imports. The CHECK is added
--    NOT VALID: it is enforced for every new row, while VL-002 rows imported before the approval gate
--    existed stay as they are (documented legacy limitation).

ALTER TABLE evidence_reviews ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE evidence_reviews
  ADD COLUMN origin text NOT NULL DEFAULT 'import' CHECK (origin IN ('import', 'manual')),
  ADD COLUMN actor  text CHECK (actor IS NULL OR char_length(actor) BETWEEN 1 AND 120),
  ADD COLUMN reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000);
ALTER TABLE evidence_reviews ADD CONSTRAINT evidence_reviews_origin_shape CHECK (
  (origin = 'import' AND run_id IS NOT NULL)
  OR (origin = 'manual' AND run_id IS NULL AND actor IS NOT NULL AND reason IS NOT NULL AND char_length(reason) >= 10)
);
CREATE INDEX evidence_reviews_manual_time ON evidence_reviews (reviewed_at) WHERE origin = 'manual';

ALTER TABLE import_runs
  ADD COLUMN approved_by        text CHECK (approved_by IS NULL OR char_length(approved_by) BETWEEN 1 AND 120),
  ADD COLUMN approved_at        date,
  ADD COLUMN approval_statement text CHECK (approval_statement IS NULL OR char_length(approval_statement) BETWEEN 20 AND 2000);
ALTER TABLE import_runs ADD CONSTRAINT import_runs_real_requires_approval
  CHECK (origin <> 'human-reviewed' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_statement IS NOT NULL)) NOT VALID;
