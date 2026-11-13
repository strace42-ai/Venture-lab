-- VL-004B audit round 2: competitor market provenance as an explicit status.
-- `market_verified boolean NOT NULL DEFAULT true` (005) silently marked every PRE-EXISTING row as
-- «verified» although its market had never been checked. Event tables are append-only, so historical
-- rows are not rewritten: the new status column is NULL for them, which reads as «not assessed
-- (historical row)» — never as verified. Every new row must state its status explicitly.
--   verified    — market established by page signals (live);
--   declared    — fixture emulation: market written by hand in the test world;
--   conflicting — signals disagree;
--   unknown     — no availability signal.
ALTER TABLE mr_competitors ADD COLUMN market_status text CHECK (market_status IS NULL OR market_status IN ('verified', 'declared', 'conflicting', 'unknown'));
-- No more silent defaults: new rows must set both columns.
ALTER TABLE mr_competitors ALTER COLUMN market_verified DROP DEFAULT;
ALTER TABLE mr_competitors ALTER COLUMN market_verified DROP NOT NULL;
-- New rows: the two columns must agree (only verified/declared count as proven).
ALTER TABLE mr_competitors ADD CONSTRAINT mr_competitors_market_status_consistent CHECK (
  market_status IS NULL OR market_verified = (market_status IN ('verified', 'declared')));
-- Every NEW row must carry a status (NOT VALID: historical rows keep NULL = «not assessed»).
ALTER TABLE mr_competitors ADD CONSTRAINT mr_competitors_market_status_required CHECK (market_status IS NOT NULL) NOT VALID;
