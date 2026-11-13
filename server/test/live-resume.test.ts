// @vitest-environment node
/**
 * VL-004B-resume — the whole path on real PostgreSQL:
 *   first stage2 (pre-009 code) → analyst HTTP 400 → job recorded «succeeded» → migration 009 →
 *   audited recovery (succeeded → incomplete) → explicitly authorised resume (--retry = new run) →
 *   full analysis AND skeptic → results stored; the old run, its attempts, ledger and assessment untouched.
 * Plus the NEW behaviour: an analyst failure now ends the job «incomplete», with the collected evidence kept.
 * Offline only: recorded providers and pages.
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listMigrations, migrate } from '../db/migrate';
import { createPool, type Pool } from '../db/pool';
import { loadLiveConfig } from '../live/config';
import { reclassifyIncompleteStage } from '../live/recover';
import { RecordedProviders, RecordedWeb, TEST_ENV, virtualClock } from '../live/recordings/mock';
import { SEEDS } from '../live/recordings/world';
import { runPaidStage } from '../live/run';
import { workerToday, type TrialSpec } from '../machine/worker';
import { describeDb, TEST_DATABASE_URL } from './helpers';

const ENV: NodeJS.ProcessEnv = { ...TEST_ENV, VL_LIVE_EXECUTE: 'phase-b-authorized' };
const cfg = loadLiveConfig(ENV);
const NOW = () => new Date('2026-11-20T03:00:00Z'); // a week after the first stage2 (same month)
const TODAY = workerToday(NOW());
const dir = mkdtempSync(join(tmpdir(), 'vl-resume-'));
const seed = SEEDS.guest!;
const stage = (s: TrialSpec['stage'], id: string, maxRub: number): { trial: TrialSpec; maxSpendKop: number } => ({
  trial: { id, budgetKop: 30_000, stage: s, stageCapKop: { probe: 500, stage2: 6_000, stage3: 23_500 }[s] },
  maxSpendKop: maxRub * 100,
});
const deps = (p: RecordedProviders, web = new RecordedWeb()) => ({ providerTransport: p, webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() });

async function freshSchema(): Promise<Pool> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  return createPool(TEST_DATABASE_URL!, schema);
}

/** Every row the first run wrote — to prove nothing of its history changes. */
async function history(pool: Pool, jobId: number) {
  const q = async (sql: string) => (await pool.query(sql, [jobId])).rows;
  return {
    attempts: await q('SELECT attempt, month::text, reserved, used, status FROM mr_attempts WHERE job_id = $1 ORDER BY attempt'),
    usage: await q('SELECT id, attempt, provider, operation, model, http_status, cost, estimated_cost, actual_cost, reconciliation FROM mr_usage WHERE job_id = $1 ORDER BY id'),
    assessments: await q('SELECT id, candidate_id, state, market_score, evidence_grade, rationale FROM mr_assessments WHERE job_id = $1 ORDER BY id'),
    reviews: await q('SELECT id, reviewer, decision, summary, findings FROM mr_reviews WHERE job_id = $1 ORDER BY id'),
    jobBudget: await q('SELECT budget_limit, spent, attempts, as_of::text FROM mr_jobs WHERE id = $1'),
  };
}

describeDb('the real case: a «succeeded» stage2 with an analyst HTTP 400, resumed safely', () => {
  let pool: Pool;
  let oldJob = 0;
  let before: Awaited<ReturnType<typeof history>>;
  const TRIAL = 'phase-b-resume-test';

  beforeAll(async () => {
    pool = await freshSchema();
    // 1. a database in the state of 13.11.2026: migrated to 008, written by the pre-009 code
    await migrate(pool, listMigrations().filter((m) => m.id <= '008_live_trials'));
    await pool.query("INSERT INTO mr_trials (trial_id, feed, budget_limit) VALUES ($1, 'live', 30000)", [TRIAL]);
    const probe = (
      await pool.query(
        `INSERT INTO mr_jobs (job_key, feed, as_of, timezone, status, attempts, max_attempts, budget_limit, monthly_cap, spent, pipeline_version, independence, trial_id, trial_stage)
         VALUES ($1, 'live', '2026-11-13', 'Asia/Novokuznetsk', 'succeeded', 1, 3, 500, 40000, 107, 'vl-004b-pipeline-1', 'independent', $2, 'probe') RETURNING id`,
        [`trial:${TRIAL}:probe`, TRIAL],
      )
    ).rows[0].id;
    await pool.query("INSERT INTO mr_attempts (job_id, feed, attempt, month, reserved, used, status) VALUES ($1, 'live', 1, '2026-11-01', 500, 107, 'succeeded')", [probe]);
    // the stage2 job exactly as the pre-009 code left it: «succeeded», 11.88 ₽ committed, 7.79 ₽ of it unknown
    oldJob = (
      await pool.query(
        `INSERT INTO mr_jobs (job_key, feed, as_of, timezone, status, attempts, max_attempts, budget_limit, monthly_cap, spent, pipeline_version, independence, trial_id, trial_stage)
         VALUES ($1, 'live', '2026-11-13', 'Asia/Novokuznetsk', 'succeeded', 1, 2, 6000, 40000, 1188, 'vl-004b-pipeline-1', 'independent', $2, 'stage2') RETURNING id`,
        [`trial:${TRIAL}:stage2`, TRIAL],
      )
    ).rows[0].id;
    await pool.query("INSERT INTO mr_attempts (job_id, feed, attempt, month, reserved, used, status) VALUES ($1, 'live', 1, '2026-11-01', 3000, 1188, 'succeeded')", [oldJob]);
    const usage: [string, string, string | null, number, number, number | null, string, number | null][] = [
      ['yandex-search-api', 'search', null, 49, 49, null, 'unknown', 502], // agent-proxy 502 (no Yandex request id)
      ['yandex-search-api', 'search', null, 49, 49, 49, 'tariff', 200],
      ['yandex-search-api', 'search', null, 49, 49, 49, 'tariff', 200],
      ['yandex-search-api', 'search', null, 49, 49, 49, 'tariff', 200],
      ['yandex-search-api', 'search', null, 49, 49, 49, 'tariff', 200],
      ['yandex-ai-studio', 'llm', 'qwen3.6-35b-a3b', 213, 1142, 213, 'reconciled', 200], // 7 × extract_offer
      ['yandex-ai-studio', 'llm', 'qwen3.6-35b-a3b', 730, 730, null, 'unknown', 400], // analyse_candidate: strict schema rejected
    ];
    for (const [i, [provider, op, model, cost, est, actual, rec, http]] of usage.entries()) {
      await pool.query(
        "INSERT INTO mr_usage (job_id, feed, attempt, provider, operation, model, request_id, cost, price_version, estimated_cost, actual_cost, reconciliation, http_status) VALUES ($1, 'live', 1, $2, $3, $4, $5, $6, 'yandex-2026-11-12', $7, $8, $9, $10)",
        [oldJob, provider, op, model, `trial:${TRIAL}:stage2#1#${i + 1}`, cost, est, actual, rec, http],
      );
    }
    const cand = (
      await pool.query(
        `INSERT INTO mr_candidates (feed, external_id, first_job_id, first_seen, seed_title, seed_pitch, segment, category, primary_job, jobs, western_product, ru_keywords, source_url)
         VALUES ('live', $1, $2, '2026-11-13', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [seed.externalId, oldJob, seed.title, seed.pitch, seed.segment, seed.category, seed.primaryJob, seed.jobs, seed.westernProduct, seed.ruKeywords ?? [], seed.sourceUrl ?? null],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO mr_assessments (job_id, candidate_id, feed, as_of, title, pitch, segment, category, rubric_version, conf_completeness, conf_corroboration, conf_recency, conf_reliability, conf_russia_validation, market_score, confidence, evidence_grade, state, rationale, pipeline_version, models)
       VALUES ($1, $2, 'live', '2026-11-13', $3, $4, 'B2B', 'Hospitality', 'v1.0', 0,0,0,0,0, 0, 0, 'D', 'DISCOVERED', 'Провайдер недоступен: аналитик: yandex-ai-studio: HTTP 400', 'vl-004b-pipeline-1', '{qwen3.6-35b-a3b,deepseek-v4.1-flash}')`,
      [oldJob, cand, seed.title, seed.pitch],
    );
    await pool.query(
      "INSERT INTO mr_reviews (job_id, candidate_id, feed, reviewer, model, decision, summary, findings, cited_claims) VALUES ($1, $2, 'live', 'quality_gate', 'vl-004b-pipeline-1', 'hold', $3, $4, '{}')",
      [oldJob, cand, 'Провайдер недоступен — кандидат не оценивается в этом прогоне: аналитик: yandex-ai-studio: HTTP 400', ['аналитик: yandex-ai-studio: HTTP 400']],
    );
    // 2. upgrade to 009: history is not rewritten, the job keeps its status
    const up = await migrate(pool);
    expect(up.applied).toContain('009_trial_runs_incomplete');
    expect((await pool.query('SELECT status, trial_run FROM mr_jobs WHERE id = $1', [oldJob])).rows[0]).toEqual({ status: 'succeeded', trial_run: 1 });
    before = await history(pool, oldJob);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('before recovery: a «succeeded» stage cannot be retried and a plain run is a no-op (the defect: no way to resume)', async () => {
    const p = new RecordedProviders();
    await expect(runPaidStage(pool, cfg, stage('stage2', TRIAL, 60), deps(p), { seeds: [seed], lockFile: join(dir, 'a'), now: NOW, retry: true })).rejects.toThrow(/не завершалась неуспешно/);
    const r = await runPaidStage(pool, cfg, stage('stage2', TRIAL, 60), deps(p), { seeds: [seed], lockFile: join(dir, 'b'), now: NOW });
    expect(r.status).toBe('already-succeeded');
    expect(p.requests).toHaveLength(0);
  });

  it('recovery: dry-run reports the evidence and changes nothing; --apply reclassifies once, with an audit event', async () => {
    const dry = await reclassifyIncompleteStage(pool, TRIAL, 'stage2', { apply: false, now: NOW() });
    expect(dry).toMatchObject({ ok: true, applied: false, jobId: oldJob, from: 'succeeded' });
    expect(dry.evidence).toMatchObject({ reviewedClaims: 0, competitors: 0, snapshots: 0, usage: { rows: 7, committedKop: 1188, unknownKop: 779 } });
    expect(dry.evidence!.technicalHolds[0]!.findings).toEqual(['аналитик: yandex-ai-studio: HTTP 400']);
    expect((await pool.query('SELECT status FROM mr_jobs WHERE id = $1', [oldJob])).rows[0].status).toBe('succeeded');

    const applied = await reclassifyIncompleteStage(pool, TRIAL, 'stage2', { apply: true, now: NOW() });
    expect(applied).toMatchObject({ ok: true, applied: true });
    expect((await pool.query('SELECT status FROM mr_jobs WHERE id = $1', [oldJob])).rows[0].status).toBe('incomplete');
    const ev = (await pool.query('SELECT kind, from_status, to_status, evidence FROM mr_job_events WHERE job_id = $1', [oldJob])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'reclassified_incomplete', from_status: 'succeeded', to_status: 'incomplete' });
    expect(ev[0].evidence.usage).toEqual({ rows: 7, committedKop: 1188, unknownKop: 779 });

    // not twice; never back; the audit row is append-only
    expect((await reclassifyIncompleteStage(pool, TRIAL, 'stage2', { apply: true, now: NOW() })).ok).toBe(false);
    await expect(pool.query("UPDATE mr_jobs SET status = 'succeeded' WHERE id = $1", [oldJob])).rejects.toThrow(/incomplete job cannot become succeeded/);
    await expect(pool.query('DELETE FROM mr_job_events')).rejects.toThrow();
    // history untouched: attempts, ledger (incl. 7.79 ₽ unknown), assessment, reviews, budget
    expect(await history(pool, oldJob)).toEqual(before);
  });

  it('after recovery: stage3 is blocked; stage2 without --retry is refused; nothing is sent', async () => {
    const p = new RecordedProviders();
    await expect(runPaidStage(pool, cfg, stage('stage3', TRIAL, 235), deps(p), { seeds: [seed], lockFile: join(dir, 'c'), now: NOW })).rejects.toThrow(/только после успешной ступени stage2 \(сейчас: incomplete\)/);
    await expect(runPaidStage(pool, cfg, stage('stage2', TRIAL, 60), deps(p), { seeds: [seed], lockFile: join(dir, 'd'), now: NOW })).rejects.toThrow(/технически не завершена.*--retry/);
    expect(p.requests).toHaveLength(0);
  });

  it('authorised resume (--retry): a NEW run r2 with the stage cap left (48.12 ₽), full analysis + skeptic, results stored; old run unchanged', async () => {
    const p = new RecordedProviders();
    const r = await runPaidStage(pool, cfg, stage('stage2', TRIAL, 60), deps(p), { seeds: [seed], lockFile: join(dir, 'e'), now: NOW, retry: true });
    expect(r.status).toBe('succeeded');
    expect(r.jobKey).toBe(`trial:${TRIAL}:stage2:r2`);
    const job = (await pool.query('SELECT id, status, trial_run, budget_limit, as_of::text, spent FROM mr_jobs WHERE job_key = $1', [r.jobKey])).rows[0];
    expect(job).toMatchObject({ status: 'succeeded', trial_run: 2, budget_limit: 6000 - 1188, as_of: TODAY });
    expect(job.spent).toBeLessThanOrEqual(4812);
    const started = (await pool.query("SELECT evidence FROM mr_job_events WHERE job_id = $1 AND kind = 'run_started'", [job.id])).rows[0];
    expect(started.evidence).toMatchObject({ resumesJobId: oldJob, run: 2, budgetKop: 4812, stageCapKop: 6000 });
    // the analyst (strict schema) and the skeptic both ran
    const tasks = p.llmCalls.map((c) => c.task);
    expect(tasks).toContain('analyse_candidate');
    expect(tasks).toContain('skeptic_challenge');
    const reviewed = (await pool.query("SELECT count(*)::int AS n FROM mr_claims WHERE job_id = $1 AND skeptic_verdict <> 'not_reviewed'", [job.id])).rows[0].n;
    expect(reviewed).toBeGreaterThan(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM mr_competitors WHERE job_id = $1', [job.id])).rows[0].n).toBeGreaterThan(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM mr_sources WHERE job_id = $1 AND attempt = 1', [job.id])).rows[0].n).toBeGreaterThan(0);
    // trial ledger is cumulative: probe 1.07 + old run 11.88 + the new run
    const trialSpent = (await pool.query('SELECT sum(COALESCE(a.used, a.reserved))::int AS s FROM mr_attempts a JOIN mr_jobs j ON j.id = a.job_id WHERE j.trial_id = $1', [TRIAL])).rows[0].s;
    expect(trialSpent).toBe(107 + 1188 + job.spent);
    // nothing published; the old run's history identical
    expect((await pool.query('SELECT count(*)::int AS n FROM mr_snapshots')).rows[0].n).toBe(0);
    expect(await history(pool, oldJob)).toEqual(before);
    expect((await pool.query('SELECT status FROM mr_jobs WHERE id = $1', [oldJob])).rows[0].status).toBe('incomplete');
    // done: nothing more to retry
    await expect(runPaidStage(pool, cfg, stage('stage2', TRIAL, 60), deps(new RecordedProviders()), { seeds: [seed], lockFile: join(dir, 'f'), now: NOW, retry: true })).rejects.toThrow(/не завершалась неуспешно/);
  });
});

describeDb('new behaviour: an analyst failure ends the trial job «incomplete» and keeps the collected evidence', () => {
  let pool: Pool;
  const TRIAL = 'phase-b-incomplete-test';
  beforeAll(async () => {
    pool = await freshSchema();
    await migrate(pool);
    const probe = new RecordedProviders();
    expect((await runPaidStage(pool, cfg, stage('probe', TRIAL, 5), deps(probe), { lockFile: join(dir, 'p'), now: NOW })).status).toBe('succeeded');
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('analyst HTTP 400 → job and attempt «incomplete»; sources, searches and the reason are stored with the attempt and URL; no score, no rival, no snapshot', async () => {
    const p = new RecordedProviders({ llm: (task) => (task === 'analyse_candidate' ? { status: 400 } : undefined) });
    const r = await runPaidStage(pool, cfg, stage('stage2', TRIAL, 60), deps(p), { seeds: [seed], lockFile: join(dir, 'g'), now: NOW });
    expect(r.status).toBe('incomplete');
    expect(r.message).toMatch(/технически НЕ завершена/);
    const job = (await pool.query("SELECT id, status, error FROM mr_jobs WHERE job_key = $1", [`trial:${TRIAL}:stage2`])).rows[0];
    expect(job.status).toBe('incomplete');
    expect(job.error).toMatch(/аналитик: yandex-ai-studio: HTTP 400/);
    expect((await pool.query('SELECT status FROM mr_attempts WHERE job_id = $1', [job.id])).rows[0].status).toBe('incomplete');
    const src = (await pool.query('SELECT url, attempt, fetch_status, offer IS NOT NULL AS has_offer FROM mr_sources WHERE job_id = $1 ORDER BY id', [job.id])).rows;
    expect(src.length).toBeGreaterThan(0);
    expect(src.every((s) => s.attempt === 1 && /^https?:\/\//.test(s.url))).toBe(true);
    expect(src.some((s) => s.has_offer)).toBe(true); // extracted (grounded) data kept
    const searches = (await pool.query('SELECT attempt, purpose FROM mr_searches WHERE job_id = $1', [job.id])).rows;
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((s) => s.attempt === 1)).toBe(true);
    const gate = (await pool.query("SELECT summary, findings, attempt FROM mr_reviews WHERE job_id = $1 AND reviewer = 'quality_gate'", [job.id])).rows[0];
    expect(gate.summary).toMatch(/технически не завершено; сохранено: источников \d+, поисков \d+/);
    expect(gate.attempt).toBe(1);
    // not an assessed candidate
    expect((await pool.query("SELECT count(*)::int AS n FROM mr_claims WHERE job_id = $1 AND skeptic_verdict <> 'not_reviewed'", [job.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM mr_competitors WHERE job_id = $1', [job.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT state, market_score, evidence_grade FROM mr_assessments WHERE job_id = $1', [job.id])).rows).toEqual([{ state: 'DISCOVERED', market_score: 0, evidence_grade: 'D' }]);
    expect((await pool.query('SELECT count(*)::int AS n FROM mr_snapshots')).rows[0].n).toBe(0);
    // the 400 carried no Yandex request id in this recording → its worst case stays «unknown» in the ledger
    expect((await pool.query("SELECT reconciliation, http_status FROM mr_usage WHERE job_id = $1 AND http_status = 400", [job.id])).rows).toEqual([{ reconciliation: 'unknown', http_status: 400 }]);
  });

  it('--retry starts run r2 which completes; the incomplete run stays as it was', async () => {
    const oldId = (await pool.query("SELECT id FROM mr_jobs WHERE job_key = $1", [`trial:${TRIAL}:stage2`])).rows[0].id;
    const snap = async () => (await pool.query('SELECT (SELECT count(*) FROM mr_sources WHERE job_id = $1)::int AS s, (SELECT count(*) FROM mr_usage WHERE job_id = $1)::int AS u, (SELECT status FROM mr_jobs WHERE id = $1) AS st', [oldId])).rows[0];
    const was = await snap();
    const r = await runPaidStage(pool, cfg, stage('stage2', TRIAL, 60), deps(new RecordedProviders()), { seeds: [seed], lockFile: join(dir, 'h'), now: NOW, retry: true });
    expect(r.status).toBe('succeeded');
    expect(r.jobKey).toBe(`trial:${TRIAL}:stage2:r2`);
    expect(await snap()).toEqual(was);
  });
});
