-- VL-004B audit round 3: NULL-safe CHECK constraints.
-- A CHECK passes when its expression is NULL (UNKNOWN). Two constraints of 005/006 could therefore be
-- bypassed with NULLs; they are replaced by NULL-safe versions. Historical rows are unaffected (the new
-- constraints are satisfied by every row the code ever wrote; legacy-only gaps use NOT VALID).

-- 1. mr_competitors: «market_verified = (market_status IN (…))» was NULL — i.e. accepted — when
--    market_verified IS NULL (e.g. status 'verified' + verified NULL). Now IS NOT DISTINCT FROM:
--    a row WITH a status must carry the matching non-NULL boolean. Historical rows (status NULL) pass.
ALTER TABLE mr_competitors DROP CONSTRAINT mr_competitors_market_status_consistent;
ALTER TABLE mr_competitors ADD CONSTRAINT mr_competitors_market_status_consistent CHECK (
  market_status IS NULL OR market_verified IS NOT DISTINCT FROM (market_status IN ('verified', 'declared')));

-- 2. mr_usage: with reconciliation 'reconciled'/'tariff'/'not_billed' and actual_cost NULL, both
--    «cost = actual_cost» and «actual_cost <= estimated_cost» were NULL → the row was accepted, i.e. the
--    ledger could claim an observed cost without one. Now every comparison is NULL-safe and explicit.
ALTER TABLE mr_usage DROP CONSTRAINT mr_usage_cost_bound;
ALTER TABLE mr_usage ADD CONSTRAINT mr_usage_cost_bound CHECK (
  estimated_cost IS NULL
  OR (reconciliation IN ('reconciled', 'tariff', 'not_billed') AND actual_cost IS NOT NULL AND cost IS NOT DISTINCT FROM actual_cost AND actual_cost <= estimated_cost)
  OR (reconciliation IN ('estimate_only', 'unknown', 'anomaly_over_estimate') AND cost IS NOT DISTINCT FROM estimated_cost)
  OR (reconciliation = 'emulated' AND cost IS NOT DISTINCT FROM estimated_cost));
-- …and «estimated_cost IS NULL» must not be a way around it for NEW rows (rows written before 005 have
-- no estimate — NOT VALID keeps them as they are).
ALTER TABLE mr_usage ADD CONSTRAINT mr_usage_estimate_required CHECK (estimated_cost IS NOT NULL) NOT VALID;
