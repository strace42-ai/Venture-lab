// @vitest-environment node
/**
 * VL-004B evidence quality (audit of PR #12, 13.11.2026), formula unchanged:
 *  1. every execution judgement counted WITHOUT a proven source is marked as an unverified model judgement —
 *     in dimension notes, the machine dossier and the CSV export (not only a capped 5 → 4);
 *  2. a rival whose page matches the primary job only weakly is UNKNOWN (possible rival), never a proven
 *     direct competitor — stored as such (migration 010, history untouched).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadLiveConfig } from '../live/config';
import { buildLiveProviders } from '../live/providers';
import { RecordedProviders, RecordedWeb, TEST_ENV, toStrictAnalyst, virtualClock } from '../live/recordings/mock';
import { SEEDS } from '../live/recordings/world';
import { liveRunOptions } from '../live/run';
import { exportReviewCsv } from '../machine/export';
import { EVIDENCE_DIMENSIONS, researchCandidate } from '../machine/pipeline';
import { machineCandidate } from '../machine/read';
import { CallContext } from '../machine/types';
import { runWorkerJob } from '../machine/worker';
import { UNVERIFIED_JUDGEMENT_MARK, unverifiedJudgements } from '../../src/domain/machine';
import { DIMENSION_KEYS } from '../../src/domain/scoring';
import type { DimensionKey } from '../../src/domain/types';
import { createTestDb, describeDb, type TestDb } from './helpers';

const cfg = loadLiveConfig(TEST_ENV);
const JUDGEMENTS = DIMENSION_KEYS.filter((d) => !EVIDENCE_DIMENSIONS.has(d));
const providers = (hook?: ConstructorParameters<typeof RecordedProviders>[0]) => {
  const web = new RecordedWeb();
  return buildLiveProviders(cfg, { providerTransport: new RecordedProviders(hook), webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() }).providers;
};
const research = (hook?: ConstructorParameters<typeof RecordedProviders>[0]) => researchCandidate(SEEDS.guest!, true, '2026-11-12', providers(hook), new CallContext('t', 1, 10_000_000));
/** An analyst reply scoring every judgement 3 from prose (no claim) — a legitimate, unverified opinion. */
const proseJudgements = (value: number): ConstructorParameters<typeof RecordedProviders>[0] => ({
  llm: (task) =>
    task === 'analyse_candidate'
      ? {
          content: JSON.stringify(
            toStrictAnalyst({ claims: [], scores: Object.fromEntries(JUDGEMENTS.map((d) => [d, { value, claims: [] }])), founderFit: null, ruQueries: ['цифровой гид гостя'], rationale: 'Только экспертное мнение' }),
          ),
        }
      : undefined,
});

describe('unverified execution judgements are marked (every one, not only a capped 5)', () => {
  it('prose-only 3/5 on all six judgements: scores counted as before (formula unchanged), each marked', async () => {
    const r = await research(proseJudgements(3));
    for (const d of JUDGEMENTS) expect(r.assessment.scores[d], d).toBe(3); // unchanged formula: ≤ 4 accepted
    expect(unverifiedJudgements(r.assessment.dimensionNotes).sort()).toEqual([...JUDGEMENTS].sort());
    for (const d of JUDGEMENTS) expect(r.assessment.dimensionNotes).toContain(`${d}: 3 — ${UNVERIFIED_JUDGEMENT_MARK}`);
  });

  it('a 5 is capped to 4 (as before) AND marked; 0 is not marked (nothing claimed); evidence dimensions are never marked', async () => {
    const r = await research(proseJudgements(5));
    for (const d of JUDGEMENTS) {
      expect(r.assessment.scores[d], d).toBe(4);
      expect(r.assessment.dimensionNotes).toContain(`${d}: 4 — ${UNVERIFIED_JUDGEMENT_MARK}`);
    }
    const zero = await research(proseJudgements(0));
    expect(unverifiedJudgements(zero.assessment.dimensionNotes)).toEqual([]);
    expect(unverifiedJudgements(r.assessment.dimensionNotes).some((d) => EVIDENCE_DIMENSIONS.has(d))).toBe(false);
  });

  it('a judgement backed by a proven claim is NOT marked (the recorded corpus)', async () => {
    const r = await research();
    const marked = new Set(unverifiedJudgements(r.assessment.dimensionNotes));
    // marked ⇔ counted score > 0 and no supported claim among its citations
    for (const d of JUDGEMENTS) {
      const v = r.assessment.scores[d as DimensionKey];
      if (v === null || v === 0) expect(marked.has(d), d).toBe(false);
    }
  });
});

describeDb('marks reach the dossier and the CSV export; UNKNOWN primary job is stored; history untouched', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('dossier (machineCandidate) and CSV (judgement rows + assessment uncertainty) show the unverified judgements', async () => {
    const prov = new RecordedProviders(proseJudgements(3));
    const web = new RecordedWeb();
    const r = await runWorkerJob(db.pool, liveRunOptions(cfg, { providerTransport: prov, webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() }, { asOf: '2026-11-12', budgetKop: 20_000, now: () => new Date('2026-11-12T03:00:00Z') }));
    expect(r.status).toBe('succeeded');
    const d = await machineCandidate(db.pool, 'live', SEEDS.guest!.externalId);
    expect(d!.current.unverifiedJudgements!.sort()).toEqual([...JUDGEMENTS].sort());
    const { csv } = await exportReviewCsv(db.pool, { jobKey: r.jobKey });
    const lines = csv.split('\n');
    const judgementRows = lines.filter((l) => l.startsWith('judgement,') && l.includes(SEEDS.guest!.externalId));
    expect(judgementRows).toHaveLength(JUDGEMENTS.length);
    expect(judgementRows.every((l) => l.includes('unverified_model_judgement'))).toBe(true);
    expect(lines.find((l) => l.startsWith('assessment,') && l.includes(SEEDS.guest!.externalId))).toMatch(/экспертные оценки модели без подтверждённого источника/);
  });

  it('migration 010: a «direct» rival needs a proven primary job (new rows); historical NULL rows stay as they were', async () => {
    const job = (await db.pool.query("SELECT id FROM mr_jobs WHERE feed = 'live' LIMIT 1")).rows[0].id;
    const cand = (await db.pool.query("SELECT id FROM mr_candidates WHERE feed = 'live' LIMIT 1")).rows[0].id;
    const ins = (name: string, kind: string, status: string | null) =>
      db.pool.query(
        "INSERT INTO mr_competitors (job_id, candidate_id, feed, name, url, market, kind, found_by, source_key, note, classification_reason, market_verified, market_status, primary_job_status) VALUES ($1, $2, 'live', $3, 'https://x.example.ru/', 'ru', $4, 'skeptic', 's1', null, 'r', true, 'verified', $5)",
        [job, cand, name, kind, status],
      );
    await expect(ins('Unknown Direct', 'direct', 'unknown')).rejects.toThrow(/mr_competitors_direct_needs_proven_job/);
    await expect(ins('Proven Direct', 'direct', 'proven')).resolves.toBeTruthy();
    await expect(ins('Possible Adjacent', 'adjacent', 'unknown')).resolves.toBeTruthy();
    await expect(ins('Legacy Row', 'direct', null)).resolves.toBeTruthy(); // historical shape (not assessed)
    // every competitor the pipeline stored: direct ⇒ proven
    const rows = (await db.pool.query("SELECT kind, primary_job_status FROM mr_competitors WHERE classification_reason <> 'r'")).rows;
    for (const x of rows.filter((y) => y.kind === 'direct')) expect(x.primary_job_status).toBe('proven');
  });
});
