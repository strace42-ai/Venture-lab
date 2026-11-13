/**
 * VL-004A worker: durable job lifecycle around the pure pipeline.
 *
 *  - idempotent job key per feed+date (`daily:<feed>:<as_of>`); a succeeded job is never re-run;
 *  - lease-based ownership: a concurrent attempt sees «already running»; a crashed attempt's lease
 *    expires and a later attempt takes over (bounded by max_attempts);
 *  - hard spend caps (per job across attempts, and per month); exceeding → `partial`, nothing published;
 *  - ALL research rows + the automatic TOP-10 snapshot are committed in ONE transaction: a failure
 *    leaves the previous snapshot as the published one;
 *  - no human approval step exists.
 */
import { contribution, DIMENSION_KEYS } from '../../src/domain/scoring';
import type { DimensionKey, ISODate } from '../../src/domain/types';
import type { Pool, PoolClient } from '../db/pool';
import { PIPELINE_VERSION, runPipeline, type PipelineOptions, type Providers } from './pipeline';
import { FIXTURE_PRICES, FixtureLLMProvider, FixtureSearchProvider, FixtureSkeptic, FixtureSourceReader } from './providers/fixture';
import { BudgetExhausted, CallContext, type DiscoverySeed, type Feed, type UsageRecord } from './types';

export const WORKER_TIMEZONE = 'Asia/Novokuznetsk';
export const DEFAULT_JOB_BUDGET = 3_000; // units (kopecks) per daily job, all attempts together (≤ 1/3 per attempt)
export const DEFAULT_MONTHLY_BUDGET = 40_000;

export const DIM_COLUMN: Record<DimensionKey, string> = {
  westernNeed: 'score_western_need',
  westernPay: 'score_western_pay',
  ruWeakness: 'score_ru_weakness',
  ruUnmetJob: 'score_ru_unmet_job',
  monetization: 'score_monetization',
  speedToPilot: 'score_speed_to_pilot',
  mvpFeasible: 'score_mvp_feasible',
  fastTest: 'score_fast_test',
  distribution: 'score_distribution',
  retention: 'score_retention',
  defensibility: 'score_defensibility',
  riskManageable: 'score_risk_manageable',
};

export type TrialStage = 'probe' | 'stage2' | 'stage3';
export const TRIAL_STAGE_ORDER: TrialStage[] = ['probe', 'stage2', 'stage3'];

/** A bounded live trial (Phase B): one cumulative budget for all stages; one job per stage. */
export interface TrialSpec {
  id: string;
  /** Cumulative ceiling of the whole trial, kopecks (immutable once the trial exists). */
  budgetKop: number;
  stage: TrialStage;
}

export class TrialRefused extends Error {}

export interface RunOptions {
  feed: Feed;
  asOf: ISODate;
  /** Phase B trial binding (live only): cumulative trial ceiling, stage order, no snapshot publication. */
  trial?: TrialSpec;
  /** Research exactly these candidates (live trial); discovery is then never run. */
  seeds?: DiscoverySeed[];
  /** false = no discovery searches / model call at all. */
  discovery?: boolean;
  budget?: number;
  monthlyBudget?: number;
  maxAttempts?: number;
  leaseMs?: number;
  rateLimits?: CallContext['rateLimits'];
  providers?: (asOf: ISODate) => Providers;
  /** Live: how independent the machine passes are (recorded on the job). */
  independence?: 'independent' | 'single-model-degraded';
  /** Live bounds: new candidates per run, rotating incumbent rechecks, carry-forward window, pages per query. */
  maxNew?: number;
  maxRechecks?: number;
  carryDays?: number;
  pipeline?: PipelineOptions;
  now?: () => Date;
  /** Test-only fault injection. */
  failAt?: 'pipeline' | 'persist';
}

export type RunStatus = 'succeeded' | 'already-succeeded' | 'already-running' | 'partial' | 'failed' | 'exhausted' | 'monthly-cap';

export interface RunResult {
  status: RunStatus;
  jobKey: string;
  jobId: number;
  attempt: number;
  message: string;
  snapshot?: { asOf: ISODate; entries: { rank: number; externalId: string; score: number; carriedFrom?: ISODate }[]; eligible: number; held: number; carried: number };
  spent?: number;
}

export function jobKeyFor(feed: Feed, asOf: ISODate, trial?: Pick<TrialSpec, 'id' | 'stage'>): string {
  return trial ? `trial:${trial.id}:${trial.stage}` : `daily:${feed}:${asOf}`;
}

/** «Today» in the worker timezone (YYYY-MM-DD). */
export function workerToday(now: Date): ISODate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: WORKER_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function fixtureProviders(asOf: ISODate): Providers {
  return { search: new FixtureSearchProvider(asOf), reader: new FixtureSourceReader(asOf), llm: new FixtureLLMProvider(), skeptic: new FixtureSkeptic() };
}

interface JobRow {
  id: number;
  status: string;
  attempts: number;
  max_attempts: number;
  lease_until: Date | null;
  budget_limit: number;
}

export const monthOf = (asOf: ISODate) => `${asOf.slice(0, 7)}-01`;

/** Σ committed spend: actual usage where recorded, otherwise the full reservation (conservative). */
const COMMITTED = 'COALESCE(SUM(COALESCE(used, reserved)), 0)::int';

type Acquired = { job: JobRow; attempt: number; reserved: number; limitedBy: 'job' | 'month' | 'trial' };

/**
 * Take ownership of the day's job and RESERVE its spend. Serialised per feed+month (advisory lock), so
 * concurrent jobs of different dates in the same month can never jointly exceed the monthly cap:
 * reservation = min(job budget − job committed, month cap − month committed).
 */
/** Committed spend of every attempt of every job of a trial (actual where known, else the full reservation). */
const TRIAL_COMMITTED = `SELECT ${'COALESCE(SUM(COALESCE(a.used, a.reserved)), 0)::int'} AS s FROM mr_attempts a JOIN mr_jobs j ON j.id = a.job_id WHERE j.trial_id = $1`;

async function acquire(pool: Pool, o: Required<Pick<RunOptions, 'feed' | 'asOf' | 'budget' | 'monthlyBudget' | 'maxAttempts' | 'leaseMs'>> & { trial?: TrialSpec }, now: Date): Promise<Acquired | RunResult> {
  const key = jobKeyFor(o.feed, o.asOf, o.trial);
  const month = monthOf(o.asOf);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Lock order everywhere: trial → month → job.
    if (o.trial) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`vl-mr-trial:${o.trial.id}`]);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`vl-mr-month:${o.feed}:${month}`]);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    if (o.trial) {
      await c.query("INSERT INTO mr_trials (trial_id, feed, budget_limit) VALUES ($1, 'live', $2) ON CONFLICT (trial_id) DO NOTHING", [o.trial.id, o.trial.budgetKop]);
      const t = (await c.query<{ budget_limit: number }>('SELECT budget_limit FROM mr_trials WHERE trial_id = $1', [o.trial.id])).rows[0]!;
      if (t.budget_limit !== o.trial.budgetKop) throw new TrialRefused(`бюджет испытания ${o.trial.id} неизменяем: ${t.budget_limit} коп., запрошено ${o.trial.budgetKop} — для другого бюджета нужен новый идентификатор испытания`);
      const idx = TRIAL_STAGE_ORDER.indexOf(o.trial.stage);
      if (idx > 0) {
        const prev = TRIAL_STAGE_ORDER[idx - 1]!;
        const p = (await c.query<{ status: string }>('SELECT status FROM mr_jobs WHERE trial_id = $1 AND trial_stage = $2', [o.trial.id, prev])).rows[0];
        if (p?.status !== 'succeeded') throw new TrialRefused(`ступень ${o.trial.stage} испытания ${o.trial.id} возможна только после успешной ступени ${prev} (сейчас: ${p?.status ?? 'не запускалась'})`);
      }
    }
    await c.query(
      `INSERT INTO mr_jobs (job_key, feed, as_of, timezone, status, max_attempts, budget_limit, monthly_cap, pipeline_version, trial_id, trial_stage)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10) ON CONFLICT (job_key) DO NOTHING`,
      [key, o.feed, o.asOf, WORKER_TIMEZONE, o.maxAttempts, o.budget, o.monthlyBudget, PIPELINE_VERSION, o.trial?.id ?? null, o.trial?.stage ?? null],
    );
    const job = (await c.query<JobRow>('SELECT id, status, attempts, max_attempts, lease_until, budget_limit FROM mr_jobs WHERE job_key = $1 FOR UPDATE', [key])).rows[0]!;
    const done = (status: RunStatus, message: string): RunResult => ({ status, jobKey: key, jobId: job.id, attempt: job.attempts, message });
    if (job.status === 'succeeded') {
      await c.query('COMMIT');
      return done('already-succeeded', `Задание ${key} уже выполнено — повторный запуск ничего не меняет.`);
    }
    if (job.status === 'running' && job.lease_until && job.lease_until > now) {
      await c.query('COMMIT');
      return done('already-running', `Задание ${key} уже выполняется (аренда до ${job.lease_until.toISOString()}).`);
    }
    if (job.status === 'partial') {
      await c.query('COMMIT');
      return done('partial', `Задание ${key} остановлено лимитом расходов — повтор в тот же день не выполняется.`);
    }
    if (job.attempts >= job.max_attempts) {
      if (job.status !== 'failed') await c.query("UPDATE mr_jobs SET status = 'failed', lease_until = NULL, finished_at = $2, error = COALESCE(error, 'попытки исчерпаны') WHERE id = $1", [job.id, now]);
      await c.query('COMMIT');
      return done('exhausted', `Задание ${key}: попытки исчерпаны (${job.attempts}/${job.max_attempts}).`);
    }
    // A crashed/expired attempt is superseded; its reservation stays committed until it reports usage.
    if (job.status === 'running') await c.query("UPDATE mr_attempts SET status = 'superseded' WHERE job_id = $1 AND attempt = $2 AND status = 'running'", [job.id, job.attempts]);
    const jobCommitted = (await c.query<{ s: number }>(`SELECT ${COMMITTED} AS s FROM mr_attempts WHERE job_id = $1`, [job.id])).rows[0]!.s;
    const monthCommitted = (await c.query<{ s: number }>(`SELECT ${COMMITTED} AS s FROM mr_attempts WHERE feed = $1 AND month = $2`, [o.feed, month])).rows[0]!.s;
    const jobLeft = Math.max(0, job.budget_limit - jobCommitted);
    const monthLeft = Math.max(0, o.monthlyBudget - monthCommitted);
    const trialCommitted = o.trial ? (await c.query<{ s: number }>(TRIAL_COMMITTED, [o.trial.id])).rows[0]!.s : 0;
    const trialLeft = o.trial ? Math.max(0, o.trial.budgetKop - trialCommitted) : Number.POSITIVE_INFINITY;
    if (monthLeft === 0 || jobLeft === 0 || trialLeft === 0) {
      const reason =
        trialLeft === 0
          ? `общий бюджет испытания ${o.trial!.id} исчерпан (${trialCommitted} из ${o.trial!.budgetKop})`
          : monthLeft === 0
            ? `месячный лимит расходов исчерпан (${monthCommitted} из ${o.monthlyBudget})`
            : `бюджет задания исчерпан (${jobCommitted} из ${job.budget_limit})`;
      await c.query("UPDATE mr_jobs SET status = 'partial', partial_reason = $2, lease_until = NULL, finished_at = $3, monthly_cap = $4 WHERE id = $1", [job.id, reason, now, o.monthlyBudget]);
      await c.query('COMMIT');
      return done(monthLeft === 0 ? 'monthly-cap' : 'partial', `${reason[0]!.toUpperCase()}${reason.slice(1)} — прогон не выполнен, опубликован прежний TOP-10.`);
    }
    // The attempt starts with a CHUNK (budget ÷ max_attempts) and tops up on demand while it owns a live
    // lease (see topUpAttempt): a normal run can use the whole job budget, a crashed attempt only holds
    // the chunks it already reserved, so retries are never starved.
    const perAttempt = Math.ceil(job.budget_limit / job.max_attempts);
    const reserved = Math.min(jobLeft, monthLeft, trialLeft, perAttempt);
    const attempt = job.attempts + 1;
    await c.query("INSERT INTO mr_attempts (job_id, feed, attempt, month, reserved, status, started_at) VALUES ($1, $2, $3, $4, $5, 'running', $6)", [job.id, o.feed, attempt, month, reserved, now]);
    await c.query(
      `UPDATE mr_jobs SET status = 'running', attempts = $2, lease_until = $3, started_at = $4, error = NULL, monthly_cap = $5,
              spent = (SELECT ${COMMITTED} FROM mr_attempts WHERE job_id = $1) WHERE id = $1`,
      [job.id, attempt, new Date(now.getTime() + o.leaseMs), now, o.monthlyBudget],
    );
    await c.query('COMMIT');
    return { job: { ...job, attempts: attempt }, attempt, reserved, limitedBy: trialLeft < Math.min(jobLeft, monthLeft, perAttempt) ? 'trial' : monthLeft < Math.min(jobLeft, perAttempt) ? 'month' : 'job' };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Grant more budget to a running attempt — only while it still owns the job with a live lease, never
 * beyond the job budget or the month cap (serialised with every other reservation by the month lock).
 * A top-up also renews the lease (heartbeat). Returns the amount granted (0 = refused).
 */
export async function topUpAttempt(pool: Pool, feed: Feed, asOf: ISODate, jobId: number, attempt: number, want: number, leaseMs: number, monthlyCap: number, now: Date): Promise<number> {
  const month = monthOf(asOf);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // trial binding is immutable — read it first to take the locks in the global order trial → month → job
    const trialId = (await c.query<{ trial_id: string | null }>('SELECT trial_id FROM mr_jobs WHERE id = $1', [jobId])).rows[0]?.trial_id ?? null;
    if (trialId) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`vl-mr-trial:${trialId}`]);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`vl-mr-month:${feed}:${month}`]);
    const job = (await c.query<{ status: string; attempts: number; lease_until: Date | null; budget_limit: number }>('SELECT status, attempts, lease_until, budget_limit FROM mr_jobs WHERE id = $1 FOR UPDATE', [jobId])).rows[0];
    if (!job || job.status !== 'running' || job.attempts !== attempt || !job.lease_until || job.lease_until <= now) {
      await c.query('ROLLBACK');
      return 0; // lost ownership or lease expired: a zombie attempt gets nothing more
    }
    const jobCommitted = (await c.query<{ s: number }>(`SELECT ${COMMITTED} AS s FROM mr_attempts WHERE job_id = $1`, [jobId])).rows[0]!.s;
    const monthCommitted = (await c.query<{ s: number }>(`SELECT ${COMMITTED} AS s FROM mr_attempts WHERE feed = $1 AND month = $2`, [feed, month])).rows[0]!.s;
    let trialLeft = Number.POSITIVE_INFINITY;
    if (trialId) {
      const t = (await c.query<{ budget_limit: number }>('SELECT budget_limit FROM mr_trials WHERE trial_id = $1', [trialId])).rows[0]!;
      trialLeft = t.budget_limit - (await c.query<{ s: number }>(TRIAL_COMMITTED, [trialId])).rows[0]!.s;
    }
    const grant = Math.max(0, Math.min(want, job.budget_limit - jobCommitted, monthlyCap - monthCommitted, trialLeft));
    if (grant > 0) {
      await c.query("UPDATE mr_attempts SET reserved = reserved + $3 WHERE job_id = $1 AND attempt = $2 AND status = 'running' AND used IS NULL", [jobId, attempt, grant]);
      await c.query(`UPDATE mr_jobs SET lease_until = $2, spent = (SELECT ${COMMITTED} FROM mr_attempts WHERE job_id = $1) WHERE id = $1`, [jobId, new Date(now.getTime() + leaseMs)]);
    }
    await c.query('COMMIT');
    return grant;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function insertUsage(c: PoolClient, feed: Feed, jobId: number, attempt: number, usage: UsageRecord[]) {
  for (const u of usage) {
    await c.query(
      `INSERT INTO mr_usage (job_id, feed, attempt, provider, operation, model, request_id, tokens_in, tokens_out, cost, price_version, estimated_cost, actual_cost, reconciliation, provider_request_id, http_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [jobId, feed, attempt, u.provider, u.operation, u.model, u.requestId, u.tokensIn, u.tokensOut, u.cost, u.priceVersion, u.estimatedCost ?? u.cost, u.actualCost ?? null, u.reconciliation ?? 'emulated', u.providerRequestId?.slice(0, 200) ?? null, u.httpStatus ?? null],
    );
  }
}

/** Settle an attempt in the ledger (actual usage replaces the reservation) and recompute the job's spend. */
async function settleAttempt(c: PoolClient, feed: Feed, jobId: number, attempt: number, ctx: CallContext, status: 'succeeded' | 'failed' | 'partial', now: Date) {
  await insertUsage(c, feed, jobId, attempt, ctx.usage);
  // A superseded attempt keeps its status; only its actual usage is recorded.
  await c.query(
    "UPDATE mr_attempts SET used = $3, finished_at = $4, status = CASE WHEN status = 'superseded' THEN status ELSE $5 END WHERE job_id = $1 AND attempt = $2",
    [jobId, attempt, ctx.spent, now, status],
  );
  await c.query(`UPDATE mr_jobs SET spent = (SELECT ${COMMITTED} FROM mr_attempts WHERE job_id = $1) WHERE id = $1`, [jobId]);
}

/**
 * Record a non-successful attempt. Its usage is ALWAYS settled in the ledger (real money would have been
 * spent), even when another attempt has taken the job over meanwhile; the job status is only changed by
 * the attempt that still owns it.
 */
async function finishUnsuccessful(pool: Pool, feed: Feed, jobId: number, attempt: number, ctx: CallContext, status: 'failed' | 'partial', message: string, now: Date) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await settleAttempt(c, feed, jobId, attempt, ctx, status, now);
    await c.query(
      `UPDATE mr_jobs SET status = $2, lease_until = NULL, finished_at = $3,
              error = CASE WHEN $2 = 'failed' THEN $4 ELSE error END,
              partial_reason = CASE WHEN $2 = 'partial' THEN $4 ELSE partial_reason END
        WHERE id = $1 AND attempts = $5 AND status = 'running'`,
      [jobId, status, now, message.slice(0, 1000), attempt],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

interface Rankable {
  externalId: string;
  title: string;
  marketScore: number;
  confidence: number;
  grade: string;
  speedToPilot: number | null;
  /** Set for an assessment carried forward from an earlier job (not re-researched this run). */
  carried?: { assessmentId: number; jobId: number; asOf: ISODate };
}

/** Machine ranking: passed candidates only; score → confidence → first-payment feasibility → id. */
function rankPassed(xs: Rankable[]): Rankable[] {
  return [...xs].sort(
    (a, b) =>
      b.marketScore - a.marketScore ||
      b.confidence - a.confidence ||
      contribution(10, b.speedToPilot as never) - contribution(10, a.speedToPilot as never) ||
      a.externalId.localeCompare(b.externalId),
  );
}

export interface CarryOptions {
  /** Incumbents NOT re-researched this run. */
  notRechecked: string[];
  days: number;
}

/** Latest PASSED assessment (≤ `days` old) of each incumbent that was not re-researched this run. */
async function carriedForward(c: PoolClient, feed: Feed, asOf: ISODate, carry: CarryOptions | undefined): Promise<(Rankable & { candidateId: number })[]> {
  if (!carry || carry.notRechecked.length === 0 || carry.days <= 0) return [];
  const r = await c.query<{ id: number; job_id: number; as_of: string; state: string; title: string; market_score: number; confidence: number; evidence_grade: string; score_speed_to_pilot: number | null; external_id: string; candidate_id: number }>(
    `SELECT DISTINCT ON (a.candidate_id) a.id, a.job_id, to_char(a.as_of, 'YYYY-MM-DD') AS as_of, a.state, a.title, a.market_score, a.confidence, a.evidence_grade, a.score_speed_to_pilot, c.external_id, a.candidate_id
       FROM mr_assessments a JOIN mr_candidates c ON c.id = a.candidate_id
      WHERE a.feed = $1 AND a.as_of < $2 AND c.external_id = ANY($3)
      ORDER BY a.candidate_id, a.as_of DESC, a.id DESC`,
    [feed, asOf, carry.notRechecked],
  );
  const oldest = new Date(`${asOf}T00:00:00Z`).getTime() - Math.min(carry.days, 30) * 86_400_000;
  return r.rows
    .filter((x) => x.state === 'AUTOMATED_EVIDENCE_PASSED' && new Date(`${x.as_of}T00:00:00Z`).getTime() >= oldest)
    .map((x) => ({ externalId: x.external_id, candidateId: x.candidate_id, title: x.title, marketScore: x.market_score, confidence: x.confidence, grade: x.evidence_grade, speedToPilot: x.score_speed_to_pilot, carried: { assessmentId: x.id, jobId: x.job_id, asOf: x.as_of } }));
}

async function persist(pool: Pool, feed: Feed, asOf: ISODate, jobId: number, attempt: number, result: Awaited<ReturnType<typeof runPipeline>>, ctx: CallContext, now: Date, failAt?: RunOptions['failAt'], carry?: CarryOptions, publish = true) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const own = await c.query<{ attempts: number; status: string }>('SELECT attempts, status FROM mr_jobs WHERE id = $1 FOR UPDATE', [jobId]);
    if (own.rows[0]?.attempts !== attempt || own.rows[0]?.status !== 'running') throw new Error('задание перехвачено другой попыткой — результат не записан');

    for (const s of result.discoverySearches) {
      await c.query('INSERT INTO mr_searches (job_id, candidate_id, feed, agent, purpose, region, query, result_count, status) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8)', [jobId, feed, s.agent, s.purpose, s.region, s.query, s.resultCount, s.status]);
    }

    const ids = new Map<string, number>();
    const assessmentIds = new Map<string, number>();
    for (const cand of result.candidates) {
      const seed = cand.seed;
      let id = (await c.query<{ id: number }>('SELECT id FROM mr_candidates WHERE feed = $1 AND external_id = $2', [feed, cand.externalId])).rows[0]?.id;
      if (!id) {
        id = (
          await c.query<{ id: number }>(
            `INSERT INTO mr_candidates (feed, external_id, first_job_id, first_seen, seed_title, seed_pitch, segment, category, primary_job, jobs, western_product, ru_keywords, source_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
            [feed, cand.externalId, jobId, asOf, seed.title, seed.pitch, seed.segment, seed.category, seed.primaryJob, seed.jobs, seed.westernProduct, seed.ruKeywords ?? [], seed.sourceUrl ?? null],
          )
        ).rows[0]!.id;
      }
      ids.set(cand.externalId, id);
      for (const s of cand.sources) {
        await c.query(
          `INSERT INTO mr_sources (job_id, candidate_id, feed, source_key, url, publisher, region, source_type, fetch_status, http_status, content_hash, excerpt, observed_at, agent,
                                   canonical_url, fetched_at, page_title, content_type, failure, offer, extraction_model, provenance)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [
            jobId, id, feed, s.key, s.url, s.publisher, s.region, s.sourceType, s.fetchStatus, s.httpStatus, s.contentHash, s.excerpt, asOf, s.agent,
            s.canonicalUrl ?? null, s.fetchedAt ?? null, s.title?.slice(0, 500) ?? null, s.contentType?.slice(0, 200) ?? null, s.failure?.slice(0, 500) ?? null,
            s.offer ? JSON.stringify(s.offer) : null, s.offer?.grounding?.extractor ?? null, s.provenance ? JSON.stringify(s.provenance) : null,
          ],
        );
      }
      for (const cl of cand.claims) {
        await c.query(
          `INSERT INTO mr_claims (job_id, candidate_id, feed, claim_key, dimension, text, quote, source_keys, supporting_source_keys, status, status_reason, skeptic_verdict, skeptic_reason, high_impact, quote_locations)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [jobId, id, feed, cl.key, cl.dimension, cl.text, cl.quote, cl.sourceKeys, cl.supportingKeys, cl.status, cl.reason, cl.skepticVerdict, cl.skepticReason, cl.highImpact, JSON.stringify(cl.quoteLocations ?? [])],
        );
      }
      for (const s of cand.searches) {
        await c.query('INSERT INTO mr_searches (job_id, candidate_id, feed, agent, purpose, region, query, result_count, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [jobId, id, feed, s.agent, s.purpose, s.region, s.query, s.resultCount, s.status]);
      }
      for (const co of cand.competitors) {
        await c.query(
          'INSERT INTO mr_competitors (job_id, candidate_id, feed, name, url, market, kind, found_by, source_key, note, classification_reason, market_verified, market_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [jobId, id, feed, co.name, co.url, co.market, co.kind, co.foundBy, co.sourceKey, co.note, co.reason, co.marketVerified !== false, co.marketStatus ?? (co.marketVerified === false ? 'unknown' : 'declared')],
        );
      }
      for (const r of cand.reviews) {
        await c.query('INSERT INTO mr_reviews (job_id, candidate_id, feed, reviewer, model, decision, summary, findings, cited_claims) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [jobId, id, feed, r.reviewer, r.model, r.decision, r.summary, r.findings, r.citedClaims]);
      }
      const a = cand.assessment;
      const scoreCols = DIMENSION_KEYS.map((d) => DIM_COLUMN[d]);
      const values: unknown[] = [
        jobId, id, feed, asOf, a.title, a.pitch, a.segment, a.category, 'v1.0',
        ...DIMENSION_KEYS.map((d) => a.scores[d]),
        a.confidence.completeness, a.confidence.corroboration, a.confidence.recency, a.confidence.reliability, a.confidence.russiaValidation,
        a.founderFit?.skills ?? null, a.founderFit?.access ?? null, a.founderFit?.timeToSale ?? null, a.founderFit?.motivation ?? null, a.founderFit?.synergy ?? null,
        a.marketScore, a.confidenceScore, a.founderFitScore, a.evidenceGrade, a.state, a.holdReasons, a.rationale, a.dimensionNotes, PIPELINE_VERSION, a.models,
      ];
      const cols = [
        'job_id', 'candidate_id', 'feed', 'as_of', 'title', 'pitch', 'segment', 'category', 'rubric_version', ...scoreCols,
        'conf_completeness', 'conf_corroboration', 'conf_recency', 'conf_reliability', 'conf_russia_validation',
        'fit_skills', 'fit_access', 'fit_time_to_sale', 'fit_motivation', 'fit_synergy',
        'market_score', 'confidence', 'founder_fit', 'evidence_grade', 'state', 'hold_reasons', 'rationale', 'dimension_notes', 'pipeline_version', 'models',
      ];
      const aid = (await c.query<{ id: number }>(`INSERT INTO mr_assessments (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, values)).rows[0]!.id;
      assessmentIds.set(cand.externalId, aid);
      if (failAt === 'persist') throw new Error('injected persist failure (test)');
    }

    if (!publish) {
      // Trial stage: research is stored for review, but nothing is published into the live TOP-10.
      await settleAttempt(c, feed, jobId, attempt, ctx, 'succeeded', now);
      await c.query("UPDATE mr_jobs SET status = 'succeeded', lease_until = NULL, finished_at = $2, error = NULL WHERE id = $1", [jobId, now]);
      await c.query('COMMIT');
      return null;
    }
    // Automatic machine TOP-10 (N/10 when fewer pass; never padded). Incumbents not re-researched this run
    // (live rotation) keep their latest PASSED assessment if it is recent — shown with its own date.
    const fresh: Rankable[] = result.candidates
      .filter((x) => x.assessment.state === 'AUTOMATED_EVIDENCE_PASSED')
      .map((x) => ({ externalId: x.externalId, title: x.assessment.title, marketScore: x.assessment.marketScore, confidence: x.assessment.confidenceScore, grade: x.assessment.evidenceGrade, speedToPilot: x.assessment.scores.speedToPilot }));
    const carried = await carriedForward(c, feed, asOf, carry);
    for (const x of carried) ids.set(x.externalId, x.candidateId);
    const ranked = rankPassed([...fresh, ...carried]);
    const top = ranked.slice(0, 10);
    const prev = await c.query<{ candidate_id: number; rank: number; market_score: number }>(
      `SELECT e.candidate_id, e.rank, e.market_score FROM mr_snapshot_entries e
         JOIN mr_snapshots s ON s.id = e.snapshot_id
        WHERE s.id = (SELECT id FROM mr_snapshots WHERE feed = $1 AND as_of < $2 ORDER BY as_of DESC LIMIT 1)`,
      [feed, asOf],
    );
    const prevBy = new Map(prev.rows.map((r) => [r.candidate_id, r]));
    const held = result.candidates.filter((x) => x.assessment.state !== 'AUTOMATED_EVIDENCE_PASSED').length;
    const snap = (
      await c.query<{ id: number }>('INSERT INTO mr_snapshots (job_id, feed, as_of, eligible_count, hold_count, published_at, carried_count) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [
        jobId, feed, asOf, ranked.length, held, now, top.filter((t) => t.carried).length,
      ])
    ).rows[0]!.id;
    for (const [i, cand] of top.entries()) {
      const cid = ids.get(cand.externalId)!;
      const p = prevBy.get(cid);
      await c.query(
        `INSERT INTO mr_snapshot_entries (snapshot_id, job_id, feed, rank, candidate_id, assessment_id, title, market_score, confidence, evidence_grade, prev_rank, score_delta, assessment_job_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [snap, jobId, feed, i + 1, cid, cand.carried?.assessmentId ?? assessmentIds.get(cand.externalId), cand.title, cand.marketScore, cand.confidence, cand.grade, p?.rank ?? null, p ? cand.marketScore - p.market_score : null, cand.carried?.jobId ?? null],
      );
    }
    await settleAttempt(c, feed, jobId, attempt, ctx, 'succeeded', now);
    await c.query("UPDATE mr_jobs SET status = 'succeeded', lease_until = NULL, finished_at = $2, error = NULL WHERE id = $1", [jobId, now]);
    await c.query('COMMIT');
    return { asOf, entries: top.map((t, i) => ({ rank: i + 1, externalId: t.externalId, score: t.marketScore, ...(t.carried ? { carriedFrom: t.carried.asOf } : {}) })), eligible: ranked.length, held, carried: top.filter((t) => t.carried).length };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function knownSeeds(pool: Pool, feed: Feed, asOf: ISODate): Promise<(DiscoverySeed & { lastAssessed: string | null })[]> {
  const r = await pool.query<{ external_id: string; seed_title: string; seed_pitch: string; segment: 'B2B' | 'B2C'; category: string; primary_job: string; jobs: string[]; western_product: string; ru_keywords: string[]; source_url: string | null; last_assessed: string | null }>(
    `SELECT c.external_id, c.seed_title, c.seed_pitch, c.segment, c.category, c.primary_job, c.jobs, c.western_product, c.ru_keywords, c.source_url,
            (SELECT to_char(max(a.as_of), 'YYYY-MM-DD') FROM mr_assessments a WHERE a.candidate_id = c.id AND a.as_of < $2) AS last_assessed
       FROM mr_candidates c WHERE c.feed = $1 AND c.first_seen <= $2 ORDER BY c.id`,
    [feed, asOf],
  );
  return r.rows.map((x) => ({
    externalId: x.external_id,
    title: x.seed_title,
    pitch: x.seed_pitch,
    segment: x.segment,
    category: x.category,
    primaryJob: x.primary_job,
    jobs: x.jobs,
    westernProduct: x.western_product,
    ...(x.ru_keywords.length ? { ruKeywords: x.ru_keywords } : {}),
    ...(x.source_url ? { sourceUrl: x.source_url } : {}),
    lastAssessed: x.last_assessed,
  }));
}

/** Rotation: the incumbents assessed longest ago (never assessed first) are re-researched; ties by id order. */
export function selectRechecks<T extends { externalId: string; lastAssessed: string | null }>(known: T[], max: number | undefined): T[] {
  if (max === undefined) return known;
  return [...known]
    .map((k, i) => ({ k, i }))
    .sort((a, b) => (a.k.lastAssessed ?? '') .localeCompare(b.k.lastAssessed ?? '') || a.i - b.i)
    .slice(0, max)
    .map((x) => x.k);
}

/** Run (or resume) the daily autonomous job for `feed` / `asOf`. Never asks for approval. */
/** Mark a ledgered non-pipeline job (trial probe) as succeeded; usage is settled in the same transaction. */
async function finishSucceeded(pool: Pool, feed: Feed, jobId: number, attempt: number, ctx: CallContext, now: Date) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const own = await c.query<{ attempts: number; status: string }>('SELECT attempts, status FROM mr_jobs WHERE id = $1 FOR UPDATE', [jobId]);
    if (own.rows[0]?.attempts !== attempt || own.rows[0]?.status !== 'running') throw new Error('задание перехвачено другой попыткой — результат не записан');
    await settleAttempt(c, feed, jobId, attempt, ctx, 'succeeded', now);
    await c.query("UPDATE mr_jobs SET status = 'succeeded', lease_until = NULL, finished_at = $2, error = NULL WHERE id = $1", [jobId, now]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Run (or resume) the daily autonomous job for `feed` / `asOf` — or one stage of a live trial. Never asks for approval. */
/** Outcome of a trial probe: the job succeeds ONLY when every required check passed. */
export interface ProbeOutcome {
  passed: boolean;
  report: unknown;
  failure?: string;
}

export async function runWorkerJob(pool: Pool, opts: RunOptions & { probe?: (ctx: CallContext) => Promise<ProbeOutcome> }): Promise<RunResult & { probe?: unknown }> {
  const now = opts.now ?? (() => new Date());
  if (opts.feed === 'live' && !opts.providers && !opts.probe) {
    throw new Error('Живые провайдеры не настроены (VL-004B). Используйте --fixture.');
  }
  if (opts.trial && opts.feed !== 'live') throw new TrialRefused('испытание (trial) возможно только для ленты live');
  if (opts.probe && !opts.trial) throw new TrialRefused('пробный вызов выполняется только как ступень испытания');
  // No artificial dating: a live run is dated with the day it actually runs on (or earlier for replays), never the future.
  if (opts.feed === 'live' && opts.asOf > workerToday(now())) throw new TrialRefused(`дата исследования ${opts.asOf} в будущем (сегодня ${workerToday(now())}) — датирование будущим днём запрещено`);
  if (opts.seeds && opts.discovery !== false) throw new TrialRefused('заданные кандидаты (--seeds) запускаются только без discovery (--no-discovery)');
  const o = {
    feed: opts.feed,
    asOf: opts.asOf,
    budget: opts.budget ?? DEFAULT_JOB_BUDGET,
    monthlyBudget: opts.monthlyBudget ?? DEFAULT_MONTHLY_BUDGET,
    maxAttempts: opts.maxAttempts ?? 3,
    leaseMs: opts.leaseMs ?? 10 * 60_000,
    trial: opts.trial,
  };
  const got = await acquire(pool, o, now());
  if (!('job' in got)) return got;
  const { job, attempt, reserved, limitedBy } = got;
  const key = jobKeyFor(o.feed, o.asOf, o.trial);
  // The attempt can never spend more than it reserved; it tops up chunk by chunk while it owns a live
  // lease — the hard caps hold even if it outlives its lease (top-ups are then refused).
  const chunk = Math.ceil(job.budget_limit / job.max_attempts);
  const ctx = new CallContext(key, attempt, reserved, opts.rateLimits ?? {}, (want) => topUpAttempt(pool, o.feed, o.asOf, job.id, attempt, want, o.leaseMs, o.monthlyBudget, now()), chunk);
  await pool.query('UPDATE mr_jobs SET independence = $2 WHERE id = $1 AND independence IS NULL', [job.id, opts.independence ?? (o.feed === 'fixture' ? 'emulated' : null)]);
  try {
    if (opts.failAt === 'pipeline') throw new Error('injected pipeline failure (test)');
    if (opts.probe) {
      const out = await opts.probe(ctx);
      if (!out.passed) {
        // A failed probe is a FAILED job: its real usage is settled in the ledger and the next stage stays blocked.
        const msg = `проба не пройдена: ${out.failure ?? 'обязательная проверка не прошла'}`;
        await finishUnsuccessful(pool, o.feed, job.id, attempt, ctx, 'failed', msg, now());
        return { status: 'failed', jobKey: key, jobId: job.id, attempt, spent: ctx.spent, probe: out.report, message: `Пробный вызов не пройден (${key}): ${msg}. Следующая ступень заблокирована; повтор — только явно (--retry).` };
      }
      await finishSucceeded(pool, o.feed, job.id, attempt, ctx, now());
      return { status: 'succeeded', jobKey: key, jobId: job.id, attempt, spent: ctx.spent, probe: out.report, message: `Пробный вызов выполнен (${key}); в рейтинг ничего не публикуется.` };
    }
    const providers = (opts.providers ?? fixtureProviders)(o.asOf);
    const noDiscovery = opts.discovery === false;
    const knownRows = await knownSeeds(pool, o.feed, o.asOf);
    const known: DiscoverySeed[] = knownRows.map((k) => {
      const { lastAssessed, ...seed } = k;
      void lastAssessed;
      return seed;
    });
    const recheckIds = new Set(selectRechecks(knownRows, opts.maxRechecks).map((k) => k.externalId));
    // Trial stages research exactly their seeds: no incumbent rechecks.
    const recheck = opts.seeds ? [] : known.filter((k) => recheckIds.has(k.externalId));
    const carry: CarryOptions | undefined = opts.maxRechecks === undefined || opts.trial ? undefined : { notRechecked: known.filter((k) => !recheckIds.has(k.externalId)).map((k) => k.externalId), days: opts.carryDays ?? 7 };
    const result = await runPipeline(o.asOf, known, providers, ctx, { ...opts.pipeline, maxNew: opts.maxNew, recheck, discovery: !noDiscovery, seeds: opts.seeds });
    const snapshot = await persist(pool, o.feed, o.asOf, job.id, attempt, result, ctx, now(), opts.failAt, carry, !o.trial);
    if (!snapshot) {
      const held = result.candidates.filter((x) => x.assessment.state !== 'AUTOMATED_EVIDENCE_PASSED').length;
      return { status: 'succeeded', jobKey: key, jobId: job.id, attempt, spent: ctx.spent, message: `Ступень испытания выполнена (${key}): кандидатов ${result.candidates.length}, отложено ${held}. В живой TOP-10 не публикуется.` };
    }
    return {
      status: 'succeeded',
      jobKey: key,
      jobId: job.id,
      attempt,
      spent: ctx.spent,
      snapshot,
      message: `Опубликован автоматический TOP-${snapshot.entries.length} на ${o.asOf} (${snapshot.entries.length}/10; отложено: ${snapshot.held}${snapshot.carried ? `; перенесено без перепроверки: ${snapshot.carried}` : ''}).`,
    };
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof BudgetExhausted) {
      const why = limitedBy === 'trial' ? `общий бюджет испытания: зарезервировано ${reserved} из остатка испытания` : limitedBy === 'month' ? `месячный лимит: зарезервировано ${reserved} из остатка месяца` : `бюджет задания: зарезервировано ${reserved}`;
      await finishUnsuccessful(pool, o.feed, job.id, attempt, ctx, 'partial', `${msg} (${why})`, now());
      return { status: 'partial', jobKey: key, jobId: job.id, attempt, spent: ctx.spent, message: `Прогон остановлен лимитом расходов: ${msg} (${why}). Опубликованный TOP-10 не изменён.` };
    }
    await finishUnsuccessful(pool, o.feed, job.id, attempt, ctx, 'failed', msg, now()).catch(() => undefined);
    return { status: 'failed', jobKey: key, jobId: job.id, attempt, spent: ctx.spent, message: `Попытка ${attempt}/${job.max_attempts} завершилась ошибкой: ${msg}. Опубликованный TOP-10 не изменён.` };
  }
}

export { FIXTURE_PRICES };
