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
import { EVIDENCE_DIMENSIONS, researchCandidate, type Providers } from '../machine/pipeline';
import { FixtureLLMProvider, FixtureSearchProvider, FixtureSkeptic, FixtureSourceReader } from '../machine/providers/fixture';
import { machineCandidate } from '../machine/read';
import { CallContext, type AnalystProposal, type DiscoverySeed, type PageRead, type SkepticFindings, type SkepticInput } from '../machine/types';
import { runWorkerJob } from '../machine/worker';
import { UNVERIFIED_JUDGEMENT_MARK, unverifiedJudgements } from '../../src/domain/machine';
import { DIMENSION_KEYS } from '../../src/domain/scoring';
import type { DimensionKey } from '../../src/domain/types';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { listMigrations, migrate } from '../db/migrate';
import { createPool } from '../db/pool';
import { createTestDb, describeDb, TEST_DATABASE_URL, type TestDb } from './helpers';

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

  it('migration 010: new rows refuse direct + unknown AND direct + NULL; other kinds may be unknown/NULL', async () => {
    const job = (await db.pool.query("SELECT id FROM mr_jobs WHERE feed = 'live' LIMIT 1")).rows[0].id;
    const cand = (await db.pool.query("SELECT id FROM mr_candidates WHERE feed = 'live' LIMIT 1")).rows[0].id;
    const ins = (name: string, kind: string, status: string | null) =>
      db.pool.query(
        "INSERT INTO mr_competitors (job_id, candidate_id, feed, name, url, market, kind, found_by, source_key, note, classification_reason, market_verified, market_status, primary_job_status) VALUES ($1, $2, 'live', $3, 'https://x.example.ru/', 'ru', $4, 'skeptic', 's1', null, 'r', true, 'verified', $5)",
        [job, cand, name, kind, status],
      );
    await expect(ins('Unknown Direct', 'direct', 'unknown')).rejects.toThrow(/mr_competitors_direct_needs_proven_job/);
    await expect(ins('Null Direct', 'direct', null)).rejects.toThrow(/mr_competitors_direct_needs_proven_job/);
    await expect(ins('Absent Direct', 'direct', 'absent')).rejects.toThrow(/mr_competitors_direct_needs_proven_job/);
    await expect(ins('Proven Direct', 'direct', 'proven')).resolves.toBeTruthy();
    await expect(ins('Possible Adjacent', 'adjacent', 'unknown')).resolves.toBeTruthy();
    await expect(ins('Substitute Null', 'substitute', null)).resolves.toBeTruthy();
    // UPDATE cannot turn a row into direct + NULL/unknown either (rows are append-only; the CHECK holds as well)
    await expect(db.pool.query("UPDATE mr_competitors SET kind = 'direct' WHERE name = 'Possible Adjacent'")).rejects.toThrow();
    await expect(db.pool.query("UPDATE mr_competitors SET primary_job_status = NULL WHERE name = 'Proven Direct'")).rejects.toThrow();
    // every competitor the pipeline stored: direct ⇒ proven
    const rows = (await db.pool.query("SELECT kind, primary_job_status FROM mr_competitors WHERE classification_reason <> 'r'")).rows;
    for (const x of rows.filter((y) => y.kind === 'direct')) expect(x.primary_job_status).toBe('proven');
  });
});

// ------------------------------------------------------------------ P1 (audit of PR #13): UNKNOWN rivals vs «no rivals»
const DAY = '2026-11-12';
const iSeed: DiscoverySeed = { externalId: 'unknown-rival', title: 'Тест UNKNOWN-конкурента', pitch: 'Тестовый кандидат.', segment: 'B2B', category: 'Finance', primaryJob: 'invoice-reminders', jobs: ['invoice-reminders'], westernProduct: 'Invoice Chaser' };
const REVIEW = 'https://example.org/invoice-chaser-review';
const SURVEY = 'https://example.org/ru-freelance-survey';
const RIVAL = 'https://rival.example.com/reminders';
type Rival = { market: 'ru' | 'west'; primary: 'proven' | 'unknown' } | null;

interface RivalOpts {
  /** ruWeakness says «existing services serve the need poorly» (no absence) instead of «no analogues». */
  weaknessNotAbsence?: boolean;
  /** The skeptic model drops every rival from its competitor list. */
  hideRivals?: boolean;
  /** The skeptic model gives no verdict on the absence claims at all. */
  noVerdicts?: boolean;
}
function rivalProviders(rival: Rival, o: RivalOpts = {}): Providers {
  const search = new FixtureSearchProvider(DAY);
  const reader = new FixtureSourceReader(DAY);
  const fs = new FixtureSkeptic();
  const quote = 'sends automatic payment reminders';
  const proposal: AnalystProposal = {
    model: 'stub-analyst',
    claims: [
      { key: 'w-need', dimension: 'westernNeed', text: 'Есть спрос.', quote: 'send polite automatic payment reminders', sourceUrls: [REVIEW], highImpact: true },
      { key: 'ru-gap', dimension: 'ruUnmetJob', text: 'В РФ нет сервиса напоминаний.', quote: 'напоминания отправляют вручную', sourceUrls: [SURVEY], highImpact: true, absence: { market: 'ru', job: 'invoice-reminders' } },
      o.weaknessNotAbsence
        ? { key: 'ru-weak', dimension: 'ruWeakness', text: 'Существующие способы неудобны: напоминания отправляют вручную.', quote: 'напоминания отправляют вручную', sourceUrls: [SURVEY], highImpact: true }
        : { key: 'ru-weak', dimension: 'ruWeakness', text: 'Российских аналогов нет.', quote: 'напоминания отправляют вручную', sourceUrls: [SURVEY], highImpact: true, absence: { market: 'ru', job: 'invoice-reminders' } },
    ],
    scores: { westernNeed: { value: 4, claims: ['w-need'] }, ruUnmetJob: { value: 5, claims: ['ru-gap'] }, ruWeakness: { value: 5, claims: ['ru-weak'] } },
    founderFit: null,
    ruQueries: ['нет результатов один', 'нет результатов два', 'нет результатов три'],
    rationale: 'Тест.',
  };
  // the skeptic model wrongly SUPPORTS both absence claims, citing exactly the source that contains the quote
  const supportGaps = (f: SkepticFindings, input: SkepticInput): SkepticFindings => ({
    ...f,
    claimVerdicts: o.noVerdicts
      ? f.claimVerdicts.filter((v) => v.claimKey !== 'ru-gap' && v.claimKey !== 'ru-weak')
      : f.claimVerdicts.map((v) => (v.claimKey === 'ru-gap' || v.claimKey === 'ru-weak' ? { ...v, verdict: 'supported', sourceKeys: input.claims.find((x) => x.key === v.claimKey)!.supportingKeys, reason: 'аналогов нет' } : v)),
    competitors: o.hideRivals ? [] : f.competitors,
    disputes: [],
  });
  return {
    search: { name: 'stub-search', search: async (q, region, ctx) => [...(await search.search(q, region, ctx)), ...(rival && region === 'ru' && q === 'нет результатов один' ? [{ url: RIVAL, title: 'Rival' }] : [])] },
    reader: {
      name: 'stub-reader',
      read: async (url, ctx): Promise<PageRead> =>
        url === RIVAL && rival
          ? {
              url, status: 'ok', httpStatus: 200, publisher: 'rival.example.com', sourceType: 'company_self_report', region: rival.market, contentHash: 'x',
              text: 'Rival Reminders sends automatic payment reminders to clients.',
              offer: {
                name: 'Rival Reminders', market: rival.market, jobs: rival.primary === 'proven' ? ['invoice-reminders'] : [],
                grounding: { level: 'partial', jobEvidence: rival.primary === 'proven' ? { 'invoice-reminders': quote } : {}, uncertain: [], extractor: 'm', marketVerified: true, marketStatus: 'verified', marketSignals: [], marketConflicts: [], ...(rival.primary === 'unknown' ? { uncertainJobs: { 'invoice-reminders': quote } } : {}) },
              },
            }
          : reader.read(url, ctx),
    },
    llm: Object.assign(new FixtureLLMProvider(), { analyse: async () => proposal }),
    skeptic: { name: fs.name, model: fs.model, counterQueries: (s: DiscoverySeed) => fs.counterQueries(s), challenge: async (i, c) => supportGaps(await fs.challenge(i, c), i) } as Providers['skeptic'],
  };
}
const runRival = (rival: Rival, o: RivalOpts = {}) => researchCandidate(iSeed, true, DAY, rivalProviders(rival, o), new CallContext('t', 1, 1_000_000));

describe('P1: a possibly relevant rival in the market forbids SUPPORTING «no rivals there»; a proven rival of ANOTHER market does not', () => {
  it('baseline (no rival): the absence claims are supported; RU scores 4 (independent source, cap 4 — rule unchanged)', async () => {
    const r = await runRival(null);
    expect(r.claims.find((c) => c.key === 'ru-gap')!.skepticVerdict).toBe('supported');
    expect(r.assessment.scores.ruUnmetJob).toBe(4);
  });

  it('RU rival with primary job UNKNOWN + skeptic «no analogues in Russia» → needs_more_evidence, no score raise', async () => {
    const base = await runRival(null);
    const r = await runRival({ market: 'ru', primary: 'unknown' });
    const rival = r.competitors.find((c) => c.name === 'Rival Reminders')!;
    expect(rival).toMatchObject({ primaryJobStatus: 'unknown', market: 'ru' });
    expect(rival.kind).not.toBe('direct');
    for (const k of ['ru-gap', 'ru-weak']) {
      const c = r.claims.find((x) => x.key === k)!;
      expect(c.supportingKeys.length, k).toBeGreaterThan(0); // the quote IS on the page …
      expect(c.skepticVerdict, k).toBe('needs_more_evidence'); // … but «no rivals» is not accepted
      expect(c.skepticReason).toMatch(/отсутствие конкурентов \(РФ\) не может считаться подтверждённым: есть возможные конкуренты — Rival Reminders \(основная функция UNKNOWN\)/);
    }
    expect(r.assessment.scores.ruUnmetJob).toBeNull();
    expect(r.assessment.scores.ruWeakness).toBeNull();
    for (const d of ['ruUnmetJob', 'ruWeakness'] as const) expect(r.assessment.scores[d] ?? 0).toBeLessThanOrEqual(base.assessment.scores[d] ?? 0);
  });

  it('a PROVEN western rival does not by itself block the Russian conclusion (no over-blocking)', async () => {
    const r = await runRival({ market: 'west', primary: 'proven' });
    expect(r.competitors.find((c) => c.name === 'Rival Reminders')).toMatchObject({ market: 'west', kind: 'direct', primaryJobStatus: 'proven' });
    expect(r.claims.find((c) => c.key === 'ru-gap')!.skepticVerdict).toBe('supported');
    expect(r.assessment.scores.ruUnmetJob).toBe(4);
  });

  it('a western rival with primary job UNKNOWN does not block or cap the Russian conclusion either', async () => {
    const r = await runRival({ market: 'west', primary: 'unknown' });
    expect(r.claims.find((c) => c.key === 'ru-gap')!.skepticVerdict).toBe('supported');
    expect(r.assessment.scores.ruUnmetJob).toBe(4);
    expect(r.assessment.dimensionNotes.join(' ')).not.toMatch(/потолок 3/);
  });
});

describeDb('migration 010 on a database that already holds historical «direct» rivals (written before 010)', () => {
  it('history is kept as it is (NULL = not assessed, never rewritten); the CHECK binds new rows; the CHECK alone also refuses an UPDATE', async () => {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    const pool = createPool(TEST_DATABASE_URL!, schema);
    try {
      await migrate(pool, listMigrations().filter((m) => m.id <= '009_trial_runs_incomplete'));
      const job = (await pool.query("INSERT INTO mr_jobs (job_key, feed, as_of, timezone, status, attempts, max_attempts, budget_limit, monthly_cap, spent, pipeline_version) VALUES ('daily:live:2026-11-12', 'live', '2026-11-12', 'Asia/Novokuznetsk', 'succeeded', 1, 2, 20000, 40000, 0, 'v') RETURNING id")).rows[0].id;
      const cand = (await pool.query("INSERT INTO mr_candidates (feed, external_id, first_job_id, first_seen, seed_title, seed_pitch, segment, category, primary_job, jobs, western_product) VALUES ('live', 'old-cand', $1, '2026-11-12', 'Старый', 'p', 'B2B', 'X', 'job-a', '{job-a}', 'W') RETURNING id", [job])).rows[0].id;
      await pool.query("INSERT INTO mr_competitors (job_id, candidate_id, feed, name, url, market, kind, found_by, source_key, note, classification_reason, market_status, market_verified) VALUES ($1, $2, 'live', 'Old Direct', 'https://old.example.ru/', 'ru', 'direct', 'skeptic', 's1', null, 'r', 'verified', true)", [job, cand]);
      const before = (await pool.query("SELECT * FROM mr_competitors WHERE name = 'Old Direct'")).rows[0];
      expect((await migrate(pool)).applied).toEqual(['010_competitor_primary_job_status']);
      const after = (await pool.query("SELECT * FROM mr_competitors WHERE name = 'Old Direct'")).rows[0];
      expect(after).toEqual({ ...before, primary_job_status: null }); // historical row unchanged, «not assessed»
      await expect(pool.query("INSERT INTO mr_competitors (job_id, candidate_id, feed, name, url, market, kind, found_by, source_key, note, classification_reason, market_status, market_verified) VALUES ($1, $2, 'live', 'New Direct', 'https://new.example.ru/', 'ru', 'direct', 'skeptic', 's2', null, 'r', 'verified', true)", [job, cand])).rejects.toThrow(/mr_competitors_direct_needs_proven_job/);
      // the CHECK itself (not only the append-only trigger) refuses an UPDATE to direct + unknown
      await pool.query('ALTER TABLE mr_competitors DISABLE TRIGGER mr_competitors_append_only');
      await pool.query("INSERT INTO mr_competitors (job_id, candidate_id, feed, name, url, market, kind, found_by, source_key, note, classification_reason, market_status, market_verified, primary_job_status) VALUES ($1, $2, 'live', 'Adj', 'https://adj.example.ru/', 'ru', 'adjacent', 'skeptic', 's3', null, 'r', 'verified', true, 'unknown')", [job, cand]);
      await expect(pool.query("UPDATE mr_competitors SET kind = 'direct' WHERE name = 'Adj'")).rejects.toThrow(/mr_competitors_direct_needs_proven_job/);
      await pool.query('ALTER TABLE mr_competitors ENABLE TRIGGER mr_competitors_append_only');
    } finally {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    }
  });
});

describe('P1 (audit of c965198): a PROVEN direct rival in the market REFUTES «no analogues», by code, whatever the skeptic says', () => {
  const RIVAL_CITE = /Rival Reminders \[s\d+\] https:\/\/rival\.example\.com\/reminders/;

  it('RU direct/proven/verified + skeptic wrongly SUPPORTS absence → both absence claims contradicted (citing the real source); RU scores 0, not raised', async () => {
    const base = await runRival(null);
    const r = await runRival({ market: 'ru', primary: 'proven' });
    const rival = r.competitors.find((c) => c.name === 'Rival Reminders')!;
    expect(rival).toMatchObject({ market: 'ru', kind: 'direct', marketVerified: true, primaryJobStatus: 'proven' });
    for (const k of ['ru-gap', 'ru-weak']) {
      const c = r.claims.find((x) => x.key === k)!;
      expect(c.status, k).toBe('contradicted');
      expect(c.reason).toMatch(/опровергнуто кодом: в РФ есть подтверждённый прямой конкурент/);
      expect(c.reason).toMatch(RIVAL_CITE);
      expect(c.reason).toContain(rival.sourceKey!); // the rival's REAL source key
      expect(c.skepticVerdict).toBe('needs_more_evidence');
      expect(c.skepticReason).toMatch(/вердикт скептика «подтверждено» отклонён кодом/);
    }
    expect(r.assessment.scores.ruUnmetJob).toBe(0);
    expect(r.assessment.scores.ruWeakness).toBe(0);
    for (const d of ['ruUnmetJob', 'ruWeakness'] as const) expect(r.assessment.scores[d]!).toBeLessThan(base.assessment.scores[d]!);
    // the reason reaches the dossier: the skeptic review findings
    expect(r.reviews.find((x) => x.reviewer === 'skeptic')!.findings.join(' ')).toMatch(/опровергнуто кодом: ru-gap \(«подтверждено» у скептика\) — в РФ есть подтверждённый прямой конкурент: Rival Reminders/);
    // the refuted absence claims do not raise the overall score (selection rules unchanged: one rival alone is not a hold)
    expect(r.assessment.marketScore).toBeLessThan(base.assessment.marketScore);
  });

  it('…also when the skeptic gives NO verdict, and when it hides the rival: the proven rival stays «direct» and the claim is refuted', async () => {
    for (const o of [{ noVerdicts: true }, { hideRivals: true }, { hideRivals: true, noVerdicts: true }]) {
      const r = await runRival({ market: 'ru', primary: 'proven' }, o);
      expect(r.competitors.find((c) => c.name === 'Rival Reminders'), JSON.stringify(o)).toMatchObject({ kind: 'direct', primaryJobStatus: 'proven' });
      expect(r.claims.find((c) => c.key === 'ru-gap')!.status, JSON.stringify(o)).toBe('contradicted');
      expect(r.assessment.scores.ruUnmetJob, JSON.stringify(o)).toBe(0);
    }
  });

  it('RU UNKNOWN + the same wrong support → not refuted, not supported: needs_more_evidence (null scores)', async () => {
    const r = await runRival({ market: 'ru', primary: 'unknown' });
    const c = r.claims.find((x) => x.key === 'ru-gap')!;
    expect(c.status).not.toBe('contradicted');
    expect(c.skepticVerdict).toBe('needs_more_evidence');
    expect(r.assessment.scores.ruUnmetJob).toBeNull();
    expect(r.assessment.scores.ruWeakness).toBeNull();
  });

  it('WEST direct/proven/verified + absence claimed ONLY for Russia → not refuted; RU conclusion kept (4)', async () => {
    const r = await runRival({ market: 'west', primary: 'proven' });
    expect(r.competitors.find((c) => c.name === 'Rival Reminders')).toMatchObject({ market: 'west', kind: 'direct', primaryJobStatus: 'proven' });
    for (const k of ['ru-gap', 'ru-weak']) {
      expect(r.claims.find((x) => x.key === k)!.status, k).not.toBe('contradicted');
      expect(r.claims.find((x) => x.key === k)!.skepticVerdict, k).toBe('supported');
    }
    expect(r.assessment.scores.ruUnmetJob).toBe(4);
  });

  it('«existing services serve the need poorly» (NOT an absence claim) is not refuted by the rival\'s existence — only capped as before', async () => {
    const r = await runRival({ market: 'ru', primary: 'proven' }, { weaknessNotAbsence: true });
    const weak = r.claims.find((x) => x.key === 'ru-weak')!;
    expect(weak.status).not.toBe('contradicted');
    expect(weak.skepticVerdict).toBe('supported');
    expect(r.assessment.scores.ruWeakness).toBe(2); // one proven direct RU rival → cap 2 (rule unchanged), not 0
    expect(r.claims.find((x) => x.key === 'ru-gap')!.status).toBe('contradicted'); // the absence claim still is
  });
});
