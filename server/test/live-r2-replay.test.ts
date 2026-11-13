// @vitest-environment node
/**
 * Before stage2 r3 (audit of the r2 report, 13.11.2026). Offline only.
 *  1. claim-key normalisation in analystFromWire, proven on the REAL Qwen reply of r2;
 *  2. bounded word forms of short terms (гид → гидов, never гидравлика), on every saved page of r1 and r2;
 *  3. a full offline replay of r2 through the pipeline into PostgreSQL.
 * REAL in the replay: 4 Search API result sets, 7 extract_offer replies (+ the page texts Qwen saw), the
 * analyse_candidate reply. SIMULATED: the skeptic (no real DeepSeek reply for a full research exists) and the
 * results of the Russian competitor/counter queries (they reuse the one recorded Russian result set).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analystFromWire, analystStrictWire, normalizeClaimKey } from '../live/ai-studio';
import { loadLiveConfig } from '../live/config';
import { groundOffer, jobQuoteSupport, type ExtractedOffer } from '../live/grounding';
import { TEST_ENV, virtualClock } from '../live/recordings/mock';
import { R2, replayR2 } from '../live/recordings/replay-r2';
import { runPaidStage } from '../live/run';
import { analystProposalSchema } from '../machine/schemas';
import { InvalidModelOutput, type DiscoverySeed } from '../machine/types';
import { createTestDb, describeDb, type TestDb } from './helpers';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SEED = JSON.parse(readFileSync(join(__dirname, '../../research/phase-b/seeds-stage2.json'), 'utf8'))[0] as DiscoverySeed;
type Raw = { claims: { key: string; dimension: string; text: string; quote: string; sourceUrls: string[]; highImpact: boolean; absence: unknown }[]; scores: Record<string, { value: number | null; claims: string[] }> };
const RAW = JSON.parse(R2.analyst.content) as Raw;

describe('1. claim-key normalisation (identifier only)', () => {
  it('deterministic mapping; refusals for what cannot be mapped unambiguously', () => {
    expect(normalizeClaimKey('westernNeed')).toBe('western-need');
    expect(normalizeClaimKey('ruUnmetJob')).toBe('ru-unmet-job');
    expect(normalizeClaimKey('speedToPilot')).toBe('speed-to-pilot');
    expect(normalizeClaimKey('Western-Need-1')).toBe('western-need-1');
    expect(normalizeClaimKey('ru gap 1')).toBe('ru-gap-1');
    expect(normalizeClaimKey('ru_gap.1')).toBe('ru_gap.1');
    expect(normalizeClaimKey('western-need-1')).toBe('western-need-1'); // already valid: unchanged
    for (const bad of ['', '   ', '---', 'утверждение-1', 'гид', 'x'.repeat(81)]) expect(normalizeClaimKey(bad), bad).toBeNull();
  });

  const wire = (claims: { key: string }[], scores: Record<string, { value: number | null; claims: string[] }>) =>
    analystStrictWire.parse({
      claims: claims.map((c) => ({ key: c.key, dimension: 'westernNeed', text: 'ttt', quote: 'quote text long enough', sourceUrls: ['https://x.example.com/'], highImpact: false, absence: null })),
      scores: Object.fromEntries(['westernNeed', 'westernPay', 'ruWeakness', 'ruUnmetJob', 'monetization', 'speedToPilot', 'mvpFeasible', 'fastTest', 'distribution', 'retention', 'defensibility', 'riskManageable'].map((d) => [d, scores[d] ?? { value: null, claims: [] }])),
      founderFit: null,
      ruQueries: [],
      rationale: 'rrr',
    });

  it('collisions, duplicates, unmappable keys and dangling references are REFUSED (never repaired, never invented)', () => {
    expect(() => analystFromWire(wire([{ key: 'westernNeed' }, { key: 'western-need' }], {}), 'm')).toThrow(/после нормализации совпадают/);
    expect(() => analystFromWire(wire([{ key: 'a-1' }, { key: 'a-1' }], {}), 'm')).toThrow(/повтор ключа/);
    expect(() => analystFromWire(wire([{ key: 'спрос' }], {}), 'm')).toThrow(InvalidModelOutput);
    expect(() => analystFromWire(wire([{ key: 'a-1' }], { westernNeed: { value: 4, claims: ['b-1'] } }), 'm')).toThrow(/ссылается на несуществующее утверждение/);
    // references go through the SAME mapping
    const p = analystFromWire(wire([{ key: 'westernNeed' }], { westernNeed: { value: 4, claims: ['westernNeed'] } }), 'm');
    expect(p.scores.westernNeed).toEqual({ value: 4, claims: ['western-need'] });
  });

  it('REAL r2 reply: rejected before (the r2 failure), accepted after normalisation — facts untouched', () => {
    // what r2 did: the raw keys fail the internal format
    const asIs = analystProposalSchema.safeParse({ model: 'm', ...RAW, scores: Object.fromEntries(Object.entries(RAW.scores).map(([d, s]) => [d, s])), founderFit: null, ruQueries: [], rationale: 'r' });
    expect(asIs.success).toBe(false);
    expect(JSON.stringify(asIs.error!.issues)).toMatch(/must match pattern/);

    const p = analystFromWire(analystStrictWire.parse(RAW), 'qwen3.6-35b-a3b');
    expect(analystProposalSchema.safeParse(p).success).toBe(true);
    expect(p.claims.map((c) => c.key)).toEqual(['western-need', 'western-pay', 'ru-weakness', 'ru-unmet-job', 'monetization', 'speed-to-pilot', 'mvp-feasible', 'fast-test', 'distribution', 'retention', 'defensibility', 'risk-manageable']);
    RAW.claims.forEach((raw, i) => {
      const c = p.claims[i]!;
      expect({ dimension: c.dimension, text: c.text, quote: c.quote, sourceUrls: c.sourceUrls, highImpact: c.highImpact }).toEqual({ dimension: raw.dimension, text: raw.text, quote: raw.quote, sourceUrls: raw.sourceUrls, highImpact: raw.highImpact });
    });
    for (const [d, s] of Object.entries(RAW.scores)) {
      expect(p.scores[d as keyof typeof p.scores]!.value, d).toBe(s.value);
      expect(p.scores[d as keyof typeof p.scores]!.claims, d).toEqual(s.claims.map((k) => normalizeClaimKey(k)));
    }
  });
});

describe('2. bounded word forms of short terms', () => {
  it('BnBuddy «платформа для создания цифровых гидов» proves the guest guide (real r2 quote)', () => {
    const q = (R2.extractions.find((e) => e.url.includes('bnbuddy'))!.reply as unknown as ExtractedOffer).jobs.find((j) => j.job === 'guest-guide')!.quote;
    expect(q).toMatch(/цифровых гидов/);
    expect(jobQuoteSupport(q, 'guest-guide', SEED).level).toBe('proven');
  });

  it('negative: accidental prefixes never match a short term; registration/identification stays UNKNOWN', () => {
    for (const q of ['Цифровая гидравлика для гостей', 'гидроизоляция для гостевых домов', 'Цифровая регистрация гостей', 'Подключите быструю идентификацию гостей', 'Гидрант и гидрометр для гостей']) {
      expect(jobQuoteSupport(q, 'guest-guide', SEED).level, q).not.toBe('proven');
    }
    for (const q of ['Цифровые гиды для гостей', 'Цифровой гид гостя', 'электронным гидом для гостей']) expect(jobQuoteSupport(q, 'guest-guide', SEED).level, q).toBe('proven');
  });

  it('every saved page of r1 and r2: proven / UNKNOWN per job (Touch Stay, RealtyCalendar, BnBuddy, E-regcard)', () => {
    const R1 = JSON.parse(readFileSync(join(__dirname, '../live/recordings/stage2-extractions-2026-11-13.json'), 'utf8')).calls as { url: string; title: string | null; text: string; reply: ExtractedOffer }[];
    const table = (run: string, xs: { url: string; title: string | null; text: string; reply: unknown }[]) =>
      xs.map((c) => {
        const g = groundOffer(c.reply as ExtractedOffer, { url: c.url, title: c.title, lang: null, text: c.text }, SEED, 'q');
        return `${run} ${c.url.replace('https://', '')} proven=[${g.offer?.jobs.join(',') ?? ''}] unknown=[${Object.keys(g.offer?.grounding?.uncertainJobs ?? {}).join(',')}]`;
      });
    expect([...table('r1', R1), ...table('r2', R2.extractions)]).toEqual([
      'r1 touchstay.com/ proven=[guest-guide,checkin-instructions] unknown=[]',
      'r1 touchstay.com/about proven=[] unknown=[guest-guide]',
      'r1 touchstay.com/pricing proven=[] unknown=[]',
      'r1 strstack.co/tools/touch-stay/pricing proven=[] unknown=[guest-guide]',
      'r1 eregcard-id.ru/ proven=[] unknown=[guest-guide]',
      'r1 new.realtycalendar.ru/products/autopilot proven=[guest-guide,checkin-instructions] unknown=[]',
      'r1 perchance-ai.net/ru/free-ai-tools/bnbuddy proven=[guest-guide] unknown=[]',
      'r2 touchstay.com/ proven=[guest-guide,checkin-instructions] unknown=[]',
      'r2 touchstay.com/about proven=[] unknown=[guest-guide]',
      'r2 touchstay.com/pricing proven=[] unknown=[]',
      'r2 www.spotsaas.com/product/touch-stay/pricing proven=[guest-guide] unknown=[]',
      'r2 eregcard-id.ru/ proven=[] unknown=[guest-guide]', // guest identification ≠ guest guide
      'r2 new.realtycalendar.ru/products/autopilot proven=[checkin-instructions] unknown=[guest-guide]', // r2 quote: «Страница брони для гостя»
      'r2 perchance-ai.net/ru/free-ai-tools/bnbuddy proven=[guest-guide] unknown=[]', // was a false UNKNOWN
    ]);
  });
});

describeDb('3. full offline replay of r2 → pipeline → skeptic (SIMULATED) → PostgreSQL', () => {
  let db: TestDb;
  const TRIAL = 'phase-b-r2-replay';
  beforeAll(async () => {
    db = await createTestDb();
    // the trial as it was before r2: probe succeeded (so stage2 may run); stage2 starts fresh here
    await db.pool.query("INSERT INTO mr_trials (trial_id, feed, budget_limit) VALUES ($1, 'live', 30000)", [TRIAL]);
    const probe = (
      await db.pool.query(
        `INSERT INTO mr_jobs (job_key, feed, as_of, timezone, status, attempts, max_attempts, budget_limit, monthly_cap, spent, pipeline_version, independence, trial_id, trial_stage, trial_run)
         VALUES ($1, 'live', '2026-11-13', 'Asia/Novokuznetsk', 'succeeded', 1, 3, 500, 40000, 107, 'vl-004b-pipeline-1', 'independent', $2, 'probe', 1) RETURNING id`,
        [`trial:${TRIAL}:probe`, TRIAL],
      )
    ).rows[0].id;
    await db.pool.query("INSERT INTO mr_attempts (job_id, feed, attempt, month, reserved, used, status) VALUES ($1, 'live', 1, '2026-11-01', 500, 107, 'succeeded')", [probe]);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('the real r2 data now runs to the end: 12 claims stored, 4 stay unproven, rivals classified by code, nothing published', async () => {
    const cfg = loadLiveConfig({ ...TEST_ENV, VL_LIVE_EXECUTE: 'phase-b-authorized' });
    const { providers, web } = replayR2();
    const r = await runPaidStage(
      db.pool,
      cfg,
      { trial: { id: TRIAL, budgetKop: 30_000, stage: 'stage2', stageCapKop: 6000 }, maxSpendKop: 6000 },
      { providerTransport: providers, webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() },
      { seeds: [SEED], lockFile: join(mkdtempSync(join(tmpdir(), 'vl-r2-')), 'lock'), now: () => new Date('2026-11-13T05:00:00Z') },
    );
    expect(r.status).toBe('succeeded'); // technically complete — NOT a statement that the idea is good
    const tasks = providers.llmCalls.map((c) => c.task);
    expect(tasks.filter((t) => t === 'analyse_candidate')).toHaveLength(1);
    expect(tasks.filter((t) => t === 'skeptic_challenge')).toHaveLength(1); // the (simulated) skeptic ran
    const job = (await db.pool.query('SELECT id FROM mr_jobs WHERE job_key = $1', [r.jobKey])).rows[0].id;

    const claims = (await db.pool.query('SELECT claim_key, dimension, status, status_reason, skeptic_verdict, quote FROM mr_claims WHERE job_id = $1 ORDER BY id', [job])).rows;
    expect(claims.map((c) => c.claim_key)).toEqual(['western-need', 'western-pay', 'ru-weakness', 'ru-unmet-job', 'monetization', 'speed-to-pilot', 'mvp-feasible', 'fast-test', 'distribution', 'retention', 'defensibility', 'risk-manageable']);
    // facts untouched: quotes exactly as Qwen wrote them
    expect(claims.map((c) => c.quote)).toEqual(RAW.claims.map((c) => c.quote));
    const by = Object.fromEntries(claims.map((c) => [c.claim_key, c]));
    // the three unconfirmed quotes stay unconfirmed (+ «AI chatbot», below the 12-character rule)
    expect(by['ru-weakness']).toMatchObject({ status: 'unknown', skeptic_verdict: 'needs_more_evidence' });
    expect(by['ru-weakness'].status_reason).toMatch(/цитата не найдена/);
    expect(by['ru-unmet-job']).toMatchObject({ status: 'unknown' });
    expect(by['ru-unmet-job'].status_reason).toMatch(/утверждение без источника — не доказательство/);
    expect(by['mvp-feasible']).toMatchObject({ status: 'unknown' });
    expect(by['mvp-feasible'].status_reason).toMatch(/утверждение без источника/);
    expect(by['defensibility']).toMatchObject({ status: 'unknown' });
    expect(by['defensibility'].status_reason).toMatch(/слишком короткая цитата/);
    // the rest: the vendor's own pages — counted only as company self-reports
    for (const k of ['western-need', 'western-pay', 'monetization', 'speed-to-pilot', 'fast-test', 'distribution', 'retention', 'risk-manageable']) expect(by[k].status, k).toBe('vendor_claim');

    const rivals = (await db.pool.query('SELECT name, market, kind, market_status, primary_job_status FROM mr_competitors WHERE job_id = $1 ORDER BY name', [job])).rows;
    expect(rivals).toEqual([
      { name: 'BnBuddy', market: 'ru', kind: 'direct', market_status: 'unknown', primary_job_status: 'proven' }, // market not proven → possible
      { name: 'E-regcard', market: 'ru', kind: 'substitute', market_status: 'verified', primary_job_status: 'unknown' },
      { name: 'Автопилот', market: 'ru', kind: 'adjacent', market_status: 'verified', primary_job_status: 'unknown' },
    ]);
    const a = (await db.pool.query('SELECT state, market_score, evidence_grade, score_ru_weakness, score_ru_unmet_job, dimension_notes FROM mr_assessments WHERE job_id = $1', [job])).rows[0];
    expect(a.score_ru_weakness).toBeNull(); // no proven Russian claim → not scored
    expect(a.score_ru_unmet_job).toBeNull();
    expect((a.dimension_notes as string[]).join('\n')).toMatch(/defensibility: 4 — не подтверждено источником: экспертная оценка модели/);
    // documented outcome WITH THE SIMULATED SKEPTIC (lenient): see the report — this is not a verdict on the idea
    expect({ state: a.state, score: a.market_score, grade: a.evidence_grade }).toEqual({ state: 'AUTOMATED_EVIDENCE_PASSED', score: 76, grade: 'C' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM mr_snapshots')).rows[0].n).toBe(0);
  });
});
