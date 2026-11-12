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
import { PIPELINE_VERSION, runPipeline, type Providers } from './pipeline';
import { FIXTURE_PRICES, FixtureLLMProvider, FixtureSearchProvider, FixtureSkeptic, FixtureSourceReader } from './providers/fixture';
import { BudgetExhausted, CallContext, type CandidateResult, type DiscoverySeed, type Feed, type UsageRecord } from './types';

export const WORKER_TIMEZONE = 'Asia/Novokuznetsk';
export const DEFAULT_JOB_BUDGET = 2_000; // units (kopecks) per daily job, all attempts together
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

export interface RunOptions {
  feed: Feed;
  asOf: ISODate;
  budget?: number;
  monthlyBudget?: number;
  maxAttempts?: number;
  leaseMs?: number;
  rateLimits?: CallContext['rateLimits'];
  providers?: (asOf: ISODate) => Providers;
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
  snapshot?: { asOf: ISODate; entries: { rank: number; externalId: string; score: number }[]; eligible: number; held: number };
  spent?: number;
}

export function jobKeyFor(feed: Feed, asOf: ISODate): string {
  return `daily:${feed}:${asOf}`;
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
  spent: number;
  budget_limit: number;
}

async function acquire(pool: Pool, o: Required<Pick<RunOptions, 'feed' | 'asOf' | 'budget' | 'monthlyBudget' | 'maxAttempts' | 'leaseMs'>>, now: Date): Promise<{ job: JobRow; attempt: number } | RunResult> {
  const key = jobKeyFor(o.feed, o.asOf);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    await c.query(
      `INSERT INTO mr_jobs (job_key, feed, as_of, timezone, status, max_attempts, budget_limit, pipeline_version)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7) ON CONFLICT (job_key) DO NOTHING`,
      [key, o.feed, o.asOf, WORKER_TIMEZONE, o.maxAttempts, o.budget, PIPELINE_VERSION],
    );
    const job = (await c.query<JobRow>('SELECT id, status, attempts, max_attempts, lease_until, spent, budget_limit FROM mr_jobs WHERE job_key = $1 FOR UPDATE', [key])).rows[0]!;
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
    const month = (
      await c.query<{ s: number }>(
        `SELECT COALESCE(SUM(spent), 0)::int AS s FROM mr_jobs WHERE feed = $1 AND date_trunc('month', as_of) = date_trunc('month', $2::date)`,
        [o.feed, o.asOf],
      )
    ).rows[0]!.s;
    if (month >= o.monthlyBudget) {
      await c.query("UPDATE mr_jobs SET status = 'partial', partial_reason = $2, finished_at = $3 WHERE id = $1", [job.id, `месячный лимит расходов исчерпан (${month} из ${o.monthlyBudget})`, now]);
      await c.query('COMMIT');
      return done('monthly-cap', `Месячный лимит расходов исчерпан (${month} из ${o.monthlyBudget}) — прогон не выполнен, опубликован прежний TOP-10.`);
    }
    const attempt = job.attempts + 1;
    await c.query(
      "UPDATE mr_jobs SET status = 'running', attempts = $2, lease_until = $3, started_at = $4, error = NULL WHERE id = $1",
      [job.id, attempt, new Date(now.getTime() + o.leaseMs), now],
    );
    await c.query('COMMIT');
    return { job: { ...job, attempts: attempt }, attempt };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function insertUsage(c: PoolClient, jobId: number, attempt: number, usage: UsageRecord[]) {
  for (const u of usage) {
    await c.query(
      `INSERT INTO mr_usage (job_id, attempt, provider, operation, model, request_id, tokens_in, tokens_out, cost, price_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [jobId, attempt, u.provider, u.operation, u.model, u.requestId, u.tokensIn, u.tokensOut, u.cost, u.priceVersion],
    );
  }
}

/** Record a non-successful attempt (usage is always kept: real money would have been spent). */
async function finishUnsuccessful(pool: Pool, jobId: number, attempt: number, ctx: CallContext, status: 'failed' | 'partial', message: string, now: Date) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await insertUsage(c, jobId, attempt, ctx.usage);
    await c.query(
      `UPDATE mr_jobs SET status = $2, spent = spent + $3, lease_until = NULL, finished_at = $4,
              error = CASE WHEN $2 = 'failed' THEN $5 ELSE error END,
              partial_reason = CASE WHEN $2 = 'partial' THEN $5 ELSE partial_reason END
        WHERE id = $1 AND attempts = $6`,
      [jobId, status, ctx.spent, now, message.slice(0, 1000), attempt],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Machine ranking: passed candidates only; score → confidence → first-payment feasibility → id. */
function rankPassed(cands: CandidateResult[]): CandidateResult[] {
  return cands
    .filter((c) => c.assessment.state === 'AUTOMATED_EVIDENCE_PASSED')
    .sort(
      (a, b) =>
        b.assessment.marketScore - a.assessment.marketScore ||
        b.assessment.confidenceScore - a.assessment.confidenceScore ||
        contribution(10, b.assessment.scores.speedToPilot) - contribution(10, a.assessment.scores.speedToPilot) ||
        a.externalId.localeCompare(b.externalId),
    );
}

async function persist(pool: Pool, feed: Feed, asOf: ISODate, jobId: number, attempt: number, result: Awaited<ReturnType<typeof runPipeline>>, ctx: CallContext, now: Date, failAt?: RunOptions['failAt']) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const own = await c.query<{ attempts: number; status: string }>('SELECT attempts, status FROM mr_jobs WHERE id = $1 FOR UPDATE', [jobId]);
    if (own.rows[0]?.attempts !== attempt || own.rows[0]?.status !== 'running') throw new Error('задание перехвачено другой попыткой — результат не записан');

    for (const s of result.discoverySearches) {
      await c.query('INSERT INTO mr_searches (job_id, candidate_id, agent, purpose, region, query, result_count, status) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)', [jobId, s.agent, s.purpose, s.region, s.query, s.resultCount, s.status]);
    }

    const ids = new Map<string, number>();
    const assessmentIds = new Map<string, number>();
    for (const cand of result.candidates) {
      const seed = cand.seed;
      let id = (await c.query<{ id: number }>('SELECT id FROM mr_candidates WHERE feed = $1 AND external_id = $2', [feed, cand.externalId])).rows[0]?.id;
      if (!id) {
        id = (
          await c.query<{ id: number }>(
            `INSERT INTO mr_candidates (feed, external_id, first_job_id, first_seen, seed_title, seed_pitch, segment, category, primary_job, jobs, western_product)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [feed, cand.externalId, jobId, asOf, seed.title, seed.pitch, seed.segment, seed.category, seed.primaryJob, seed.jobs, seed.westernProduct],
          )
        ).rows[0]!.id;
      }
      ids.set(cand.externalId, id);
      for (const s of cand.sources) {
        await c.query(
          `INSERT INTO mr_sources (job_id, candidate_id, source_key, url, publisher, region, source_type, fetch_status, http_status, content_hash, excerpt, observed_at, agent)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [jobId, id, s.key, s.url, s.publisher, s.region, s.sourceType, s.fetchStatus, s.httpStatus, s.contentHash, s.excerpt, asOf, s.agent],
        );
      }
      for (const cl of cand.claims) {
        await c.query(
          `INSERT INTO mr_claims (job_id, candidate_id, claim_key, dimension, text, quote, source_keys, status, status_reason, high_impact)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [jobId, id, cl.key, cl.dimension, cl.text, cl.quote, cl.sourceKeys, cl.status, cl.reason, cl.highImpact],
        );
      }
      for (const s of cand.searches) {
        await c.query('INSERT INTO mr_searches (job_id, candidate_id, agent, purpose, region, query, result_count, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [jobId, id, s.agent, s.purpose, s.region, s.query, s.resultCount, s.status]);
      }
      for (const co of cand.competitors) {
        await c.query(
          'INSERT INTO mr_competitors (job_id, candidate_id, name, url, market, kind, found_by, source_key, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [jobId, id, co.name, co.url, co.market, co.kind, co.foundBy, co.sourceKey, co.note],
        );
      }
      for (const r of cand.reviews) {
        await c.query('INSERT INTO mr_reviews (job_id, candidate_id, reviewer, model, decision, summary, findings, cited_claims) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [jobId, id, r.reviewer, r.model, r.decision, r.summary, r.findings, r.citedClaims]);
      }
      const a = cand.assessment;
      const scoreCols = DIMENSION_KEYS.map((d) => DIM_COLUMN[d]);
      const values: unknown[] = [
        jobId, id, asOf, a.title, a.pitch, a.segment, a.category, 'v1.0',
        ...DIMENSION_KEYS.map((d) => a.scores[d]),
        a.confidence.completeness, a.confidence.corroboration, a.confidence.recency, a.confidence.reliability, a.confidence.russiaValidation,
        a.founderFit?.skills ?? null, a.founderFit?.access ?? null, a.founderFit?.timeToSale ?? null, a.founderFit?.motivation ?? null, a.founderFit?.synergy ?? null,
        a.marketScore, a.confidenceScore, a.founderFitScore, a.evidenceGrade, a.state, a.holdReasons, a.rationale, a.dimensionNotes, PIPELINE_VERSION, a.models,
      ];
      const cols = [
        'job_id', 'candidate_id', 'as_of', 'title', 'pitch', 'segment', 'category', 'rubric_version', ...scoreCols,
        'conf_completeness', 'conf_corroboration', 'conf_recency', 'conf_reliability', 'conf_russia_validation',
        'fit_skills', 'fit_access', 'fit_time_to_sale', 'fit_motivation', 'fit_synergy',
        'market_score', 'confidence', 'founder_fit', 'evidence_grade', 'state', 'hold_reasons', 'rationale', 'dimension_notes', 'pipeline_version', 'models',
      ];
      const aid = (await c.query<{ id: number }>(`INSERT INTO mr_assessments (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, values)).rows[0]!.id;
      assessmentIds.set(cand.externalId, aid);
      if (failAt === 'persist') throw new Error('injected persist failure (test)');
    }

    // Automatic machine TOP-10 (N/10 when fewer pass; never padded)
    const ranked = rankPassed(result.candidates);
    const top = ranked.slice(0, 10);
    const prev = await c.query<{ candidate_id: number; rank: number; market_score: number }>(
      `SELECT e.candidate_id, e.rank, e.market_score FROM mr_snapshot_entries e
         JOIN mr_snapshots s ON s.id = e.snapshot_id
        WHERE s.id = (SELECT id FROM mr_snapshots WHERE feed = $1 AND as_of < $2 ORDER BY as_of DESC LIMIT 1)`,
      [feed, asOf],
    );
    const prevBy = new Map(prev.rows.map((r) => [r.candidate_id, r]));
    const held = result.candidates.filter((x) => x.assessment.state !== 'AUTOMATED_EVIDENCE_PASSED').length;
    const snap = (await c.query<{ id: number }>('INSERT INTO mr_snapshots (job_id, feed, as_of, eligible_count, hold_count, published_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [jobId, feed, asOf, ranked.length, held, now])).rows[0]!.id;
    for (const [i, cand] of top.entries()) {
      const cid = ids.get(cand.externalId)!;
      const p = prevBy.get(cid);
      await c.query(
        `INSERT INTO mr_snapshot_entries (snapshot_id, rank, candidate_id, assessment_id, title, market_score, confidence, evidence_grade, prev_rank, score_delta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [snap, i + 1, cid, assessmentIds.get(cand.externalId), cand.assessment.title, cand.assessment.marketScore, cand.assessment.confidenceScore, cand.assessment.evidenceGrade, p?.rank ?? null, p ? cand.assessment.marketScore - p.market_score : null],
      );
    }
    await insertUsage(c, jobId, attempt, ctx.usage);
    await c.query("UPDATE mr_jobs SET status = 'succeeded', spent = spent + $2, lease_until = NULL, finished_at = $3, error = NULL WHERE id = $1", [jobId, ctx.spent, now]);
    await c.query('COMMIT');
    return { asOf, entries: top.map((t, i) => ({ rank: i + 1, externalId: t.externalId, score: t.assessment.marketScore })), eligible: ranked.length, held };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function knownSeeds(pool: Pool, feed: Feed, asOf: ISODate): Promise<DiscoverySeed[]> {
  const r = await pool.query<{ external_id: string; seed_title: string; seed_pitch: string; segment: 'B2B' | 'B2C'; category: string; primary_job: string; jobs: string[]; western_product: string }>(
    'SELECT external_id, seed_title, seed_pitch, segment, category, primary_job, jobs, western_product FROM mr_candidates WHERE feed = $1 AND first_seen <= $2 ORDER BY id',
    [feed, asOf],
  );
  return r.rows.map((x) => ({ externalId: x.external_id, title: x.seed_title, pitch: x.seed_pitch, segment: x.segment, category: x.category, primaryJob: x.primary_job, jobs: x.jobs, westernProduct: x.western_product }));
}

/** Run (or resume) the daily autonomous job for `feed` / `asOf`. Never asks for approval. */
export async function runWorkerJob(pool: Pool, opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  if (opts.feed === 'live' && !opts.providers) {
    throw new Error('Живые провайдеры не настроены (VL-004B). Используйте --fixture.');
  }
  const o = {
    feed: opts.feed,
    asOf: opts.asOf,
    budget: opts.budget ?? DEFAULT_JOB_BUDGET,
    monthlyBudget: opts.monthlyBudget ?? DEFAULT_MONTHLY_BUDGET,
    maxAttempts: opts.maxAttempts ?? 3,
    leaseMs: opts.leaseMs ?? 10 * 60_000,
  };
  const got = await acquire(pool, o, now());
  if (!('job' in got)) return got;
  const { job, attempt } = got;
  const key = jobKeyFor(o.feed, o.asOf);
  const ctx = new CallContext(key, attempt, Math.max(0, job.budget_limit - job.spent), opts.rateLimits ?? {});
  const providers = (opts.providers ?? fixtureProviders)(o.asOf);
  const known = await knownSeeds(pool, o.feed, o.asOf);
  try {
    if (opts.failAt === 'pipeline') throw new Error('injected pipeline failure (test)');
    const result = await runPipeline(o.asOf, known, providers, ctx);
    const snapshot = await persist(pool, o.feed, o.asOf, job.id, attempt, result, ctx, now(), opts.failAt);
    return { status: 'succeeded', jobKey: key, jobId: job.id, attempt, spent: ctx.spent, snapshot, message: `Опубликован автоматический TOP-${snapshot.entries.length} на ${o.asOf} (${snapshot.entries.length}/10; отложено: ${snapshot.held}).` };
  } catch (e) {
    const msg = (e as Error).message;
    if (e instanceof BudgetExhausted) {
      await finishUnsuccessful(pool, job.id, attempt, ctx, 'partial', msg, now());
      return { status: 'partial', jobKey: key, jobId: job.id, attempt, spent: ctx.spent, message: `Прогон остановлен лимитом расходов: ${msg}. Опубликованный TOP-10 не изменён.` };
    }
    await finishUnsuccessful(pool, job.id, attempt, ctx, 'failed', msg, now()).catch(() => undefined);
    return { status: 'failed', jobKey: key, jobId: job.id, attempt, spent: ctx.spent, message: `Попытка ${attempt}/${job.max_attempts} завершилась ошибкой: ${msg}. Опубликованный TOP-10 не изменён.` };
  }
}

export { FIXTURE_PRICES };
