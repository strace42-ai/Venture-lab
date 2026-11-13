/**
 * Explicit, audited recovery of a trial stage recorded as `succeeded` although its research did not finish
 * (VL-004B-resume). This is the case of `trial:phase-b-pilot-01:stage2` on 13.11.2026: the analyst got
 * HTTP 400, the candidate was held and never assessed, yet the job was `succeeded` (pre-009 code).
 *
 * The operation (no network, no money):
 *  - inspects the LATEST run of the stage under the trial lock;
 *  - proves technical incompleteness from stored rows only:
 *    - a `quality_gate` hold review whose summary says the provider was unavailable or the model output
 *      was rejected;
 *    - no skeptic-reviewed claim;
 *    - no classified competitor;
 *    - no snapshot;
 *  - by default only REPORTS what it found (dry-run);
 *  - with `apply`, changes the job's status `succeeded → incomplete` and writes an append-only
 *    `mr_job_events` row with the evidence.
 *
 * It never deletes anything, never touches attempts, usage, sources or assessments, and never resets
 * spend. A job can never go back from `incomplete` to `succeeded` (DB trigger). Resuming is a separate,
 * paid, founder-approved step: a new run via `--retry`.
 */
import type { Pool } from '../db/pool';

/** Summaries written by the pipeline for a TECHNICAL hold (pipeline.ts invalidResult). */
const TECHNICAL_HOLD = /^(Провайдер недоступен|Ответ модели отклонён проверкой схемы)/;

export interface RecoveryReport {
  ok: boolean;
  applied: boolean;
  jobId: number | null;
  jobKey: string | null;
  run: number | null;
  from: string | null;
  problems: string[];
  evidence: {
    technicalHolds: { reviewId: number; candidate: string; summary: string; findings: string[] }[];
    reviewedClaims: number;
    competitors: number;
    snapshots: number;
    attempts: { attempt: number; status: string; reserved: number; used: number | null }[];
    usage: { rows: number; committedKop: number; unknownKop: number };
  } | null;
}

export async function reclassifyIncompleteStage(pool: Pool, trialId: string, stage: 'stage2' | 'stage3', opts: { apply: boolean; now?: Date }): Promise<RecoveryReport> {
  const c = await pool.connect();
  const report: RecoveryReport = { ok: false, applied: false, jobId: null, jobKey: null, run: null, from: null, problems: [], evidence: null };
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`vl-mr-trial:${trialId}`]);
    const job = (
      await c.query<{ id: number; job_key: string; status: string; trial_run: number; lease_until: Date | null }>(
        'SELECT id, job_key, status, trial_run, lease_until FROM mr_jobs WHERE trial_id = $1 AND trial_stage = $2 ORDER BY trial_run DESC LIMIT 1 FOR UPDATE',
        [trialId, stage],
      )
    ).rows[0];
    if (!job) {
      report.problems.push(`ступень ${stage} испытания ${trialId} не запускалась`);
      await c.query('ROLLBACK');
      return report;
    }
    Object.assign(report, { jobId: job.id, jobKey: job.job_key, run: job.trial_run, from: job.status });
    const holds = (
      await c.query<{ id: number; external_id: string; summary: string; findings: string[] }>(
        `SELECT r.id, k.external_id, r.summary, r.findings FROM mr_reviews r JOIN mr_candidates k ON k.id = r.candidate_id
          WHERE r.job_id = $1 AND r.reviewer = 'quality_gate' AND r.decision = 'hold' ORDER BY r.id`,
        [job.id],
      )
    ).rows.filter((r) => TECHNICAL_HOLD.test(r.summary));
    const one = async (sql: string) => (await c.query<{ n: number }>(sql, [job.id])).rows[0]!.n;
    const reviewedClaims = await one("SELECT count(*)::int AS n FROM mr_claims WHERE job_id = $1 AND skeptic_verdict <> 'not_reviewed'");
    const competitors = await one('SELECT count(*)::int AS n FROM mr_competitors WHERE job_id = $1');
    const snapshots = await one('SELECT count(*)::int AS n FROM mr_snapshots WHERE job_id = $1');
    const attempts = (await c.query<{ attempt: number; status: string; reserved: number; used: number | null }>('SELECT attempt, status, reserved, used FROM mr_attempts WHERE job_id = $1 ORDER BY attempt', [job.id])).rows;
    const usage = (
      await c.query<{ rows: number; committed: number; unknown: number }>(
        "SELECT count(*)::int AS rows, COALESCE(sum(cost), 0)::int AS committed, COALESCE(sum(cost) FILTER (WHERE reconciliation = 'unknown'), 0)::int AS unknown FROM mr_usage WHERE job_id = $1",
        [job.id],
      )
    ).rows[0]!;
    report.evidence = {
      technicalHolds: holds.map((h) => ({ reviewId: h.id, candidate: h.external_id, summary: h.summary, findings: h.findings })),
      reviewedClaims,
      competitors,
      snapshots,
      attempts,
      usage: { rows: usage.rows, committedKop: usage.committed, unknownKop: usage.unknown },
    };
    if (job.status !== 'succeeded') report.problems.push(`статус последнего прогона «${job.status}», а не «succeeded» — реклассифицировать нечего`);
    if (job.lease_until && job.lease_until > (opts.now ?? new Date())) report.problems.push('прогон выполняется (активная аренда)');
    if (holds.length === 0) report.problems.push('нет записи о техническом отказе (quality_gate: провайдер недоступен / ответ отклонён) — исследование могло завершиться по существу');
    if (reviewedClaims > 0) report.problems.push(`есть утверждения с вердиктом скептика (${reviewedClaims}) — скептик работал, это не технический обрыв`);
    if (competitors > 0) report.problems.push(`есть классифицированные конкуренты (${competitors}) — исследование дошло до скептика`);
    if (snapshots > 0) report.problems.push('у задания есть снимок рейтинга — реклассификация запрещена');
    report.ok = report.problems.length === 0;
    if (!report.ok || !opts.apply) {
      await c.query('ROLLBACK');
      return report;
    }
    const reason = `реклассифицировано «succeeded → incomplete»: исследование технически не завершено (${holds.map((h) => `${h.external_id}: ${h.findings.join('; ')}`).join(' | ')})`.slice(0, 2000);
    await c.query("UPDATE mr_jobs SET status = 'incomplete', error = $2 WHERE id = $1 AND status = 'succeeded'", [job.id, reason]);
    await c.query("INSERT INTO mr_job_events (job_id, kind, from_status, to_status, reason, evidence) VALUES ($1, 'reclassified_incomplete', 'succeeded', 'incomplete', $2, $3)", [job.id, reason, JSON.stringify(report.evidence)]);
    await c.query('COMMIT');
    report.applied = true;
    return report;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
