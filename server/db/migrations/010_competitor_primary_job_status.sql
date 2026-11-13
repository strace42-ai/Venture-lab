-- VL-004B evidence quality (audit 13.11.2026): does a rival's page PROVE the idea's primary job?
--   proven  — at least two distinct terms of the job in a verbatim quote found on the page;
--   unknown — the quote matches only one term (e.g. «идентификация гостей» for a guest guide): meaning not
--             established — a POSSIBLE rival, never a proven direct competitor, never evidence of absence;
--   absent  — no quote for the primary job.
-- Historical rows stay NULL («not assessed»); nothing is rewritten.
ALTER TABLE mr_competitors ADD COLUMN primary_job_status text CHECK (primary_job_status IS NULL OR primary_job_status IN ('proven', 'unknown', 'absent'));
-- A «direct» rival must have its primary job PROVEN: direct + NULL and direct + unknown are refused for every new
-- or updated row (NULL-safe: «IS NOT DISTINCT FROM», a plain «=» would let NULL through). NOT VALID: the
-- historical rows written before this migration (NULL = not assessed) are kept as they are, never rewritten.
ALTER TABLE mr_competitors ADD CONSTRAINT mr_competitors_direct_needs_proven_job CHECK (kind <> 'direct' OR primary_job_status IS NOT DISTINCT FROM 'proven') NOT VALID;
