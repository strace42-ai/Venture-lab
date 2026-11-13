-- VL-004B evidence quality (audit 13.11.2026): does a rival's page PROVE the idea's primary job?
--   proven  — at least two distinct terms of the job in a verbatim quote found on the page;
--   unknown — the quote matches only one term (e.g. «идентификация гостей» for a guest guide): meaning not
--             established — a POSSIBLE rival, never a proven direct competitor, never evidence of absence;
--   absent  — no quote for the primary job.
-- Historical rows stay NULL («not assessed»); nothing is rewritten.
ALTER TABLE mr_competitors ADD COLUMN primary_job_status text CHECK (primary_job_status IS NULL OR primary_job_status IN ('proven', 'unknown', 'absent'));
-- a «direct» rival must have its primary job proven (new rows; NOT VALID keeps history as it is)
ALTER TABLE mr_competitors ADD CONSTRAINT mr_competitors_direct_needs_proven_job CHECK (kind <> 'direct' OR primary_job_status IS NULL OR primary_job_status = 'proven') NOT VALID;
