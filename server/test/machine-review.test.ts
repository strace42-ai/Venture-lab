// @vitest-environment node
/**
 * VL-004A review round 1 (ChatGPT, PR #5) — regression and adversarial tests:
 *  P1 hard monthly budget (just-below-cap, parallel dates, lease takeover ledger);
 *  P1 structured independent skeptic (verdicts, refutation beyond job-tag matching, invalid output);
 *  P1 evidence rules (empty/boilerplate/unrelated quotes, grade from supporting sources only, no 5/5
 *     from zero-hit searches, vendor-only evidence);
 *  P2 database feed/job/assessment integrity (direct SQL cross-feed writes refused).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimSupports, evidenceGrade, researchCandidate, type Providers } from '../machine/pipeline';
import { FixtureLLMProvider, FixtureSearchProvider, FixtureSkeptic, FixtureSourceReader } from '../machine/providers/fixture';
import { quoteProblem } from '../machine/schemas';
import { CallContext, type AnalystProposal, type ClaimRow, type DiscoverySeed, type SkepticFindings, type SourceRow } from '../machine/types';
import { runWorkerJob } from '../machine/worker';
import { createTestDb, describeDb, type TestDb } from './helpers';

const DAY = '2026-11-12';
const seed: DiscoverySeed = {
  externalId: 'adv-test',
  title: 'Состязательный тест',
  pitch: 'Тестовый кандидат для проверки правил доказательств.',
  segment: 'B2B',
  category: 'Finance',
  primaryJob: 'invoice-reminders',
  jobs: ['invoice-reminders'],
  westernProduct: 'Invoice Chaser',
};
const REVIEW = 'https://example.org/invoice-chaser-review'; // independent, relevant to westernNeed/westernPay
const PRICING = 'https://example.com/invoice-chaser/pricing'; // vendor
const SURVEY = 'https://example.org/ru-freelance-survey'; // independent RU
const CRM = 'https://example.com/ru-crm-lite'; // vendor RU

function proposal(over: Partial<AnalystProposal>): AnalystProposal {
  return {
    model: 'stub-analyst',
    claims: [{ key: 'w-need', dimension: 'westernNeed', text: 'Есть спрос на напоминания.', quote: 'send polite automatic payment reminders', sourceUrls: [REVIEW], highImpact: true }],
    scores: { westernNeed: { value: 4, claims: ['w-need'] } },
    founderFit: null,
    ruQueries: ['нет результатов один', 'нет результатов два', 'нет результатов три'],
    rationale: 'Состязательный сценарий.',
    ...over,
  };
}

function providers(p: unknown, skeptic?: Partial<Providers['skeptic']>): Providers {
  const fixtureSkeptic = new FixtureSkeptic();
  return {
    search: new FixtureSearchProvider(DAY),
    reader: new FixtureSourceReader(DAY),
    llm: Object.assign(new FixtureLLMProvider(), { analyse: async () => p as AnalystProposal }),
    skeptic: { name: fixtureSkeptic.name, model: fixtureSkeptic.model, counterQueries: (s: DiscoverySeed) => fixtureSkeptic.counterQueries(s), challenge: (i, c) => fixtureSkeptic.challenge(i, c), ...skeptic } as Providers['skeptic'],
  };
}

const research = (p: unknown, skeptic?: Partial<Providers['skeptic']>) => researchCandidate(seed, true, DAY, providers(p, skeptic), new CallContext('t', 1, 1_000_000));

describe('P1 evidence: quotes must be specific and relevant', () => {
  it('rejects empty, too-short, one-word and boilerplate quotes', () => {
    expect(quoteProblem('')).toMatch(/пустая/);
    expect(quoteProblem('   ')).toMatch(/пустая/);
    expect(quoteProblem('Pricing')).toMatch(/короткая/);
    expect(quoteProblem('Подробнее')).toMatch(/короткая|одного слова/);
    expect(quoteProblem('Начать бесплатно')).toMatch(/шаблонная/);
    expect(quoteProblem('Learn more')).toMatch(/короткая|шаблонная/);
    expect(quoteProblem('send polite automatic payment reminders')).toBeNull();
  });

  it('an empty quote never supports a claim (it used to match every page)', async () => {
    const r = await research(proposal({ claims: [{ key: 'w-need', dimension: 'westernNeed', text: 'Есть 100k платящих клиентов.', quote: '', sourceUrls: [REVIEW], highImpact: true }] }));
    const c = r.claims[0]!;
    expect(c.status).toBe('unknown');
    expect(c.reason).toMatch(/пустая цитата/);
    expect(c.supportingKeys).toEqual([]);
    expect(r.assessment.scores.westernNeed).toBeNull();
    expect(r.assessment.state).toBe('RESEARCH_HOLD');
  });

  it('a TRUE quote from an UNRELATED page does not support an arbitrary claim', async () => {
    const r = await research(
      proposal({
        claims: [
          { key: 'w-need', dimension: 'westernNeed', text: 'Есть спрос на напоминания.', quote: 'send polite automatic payment reminders', sourceUrls: [REVIEW], highImpact: true },
          // literally present on the review page, but that page is not evidence of distribution channels
          { key: 'dist', dimension: 'distribution', text: 'Есть дешёвый канал привлечения 10 000 клиентов в месяц.', quote: 'send polite automatic payment reminders', sourceUrls: [REVIEW] },
        ],
        scores: { westernNeed: { value: 4, claims: ['w-need'] }, distribution: { value: 5, claims: ['dist'] } },
      }),
    );
    const dist = r.claims.find((c) => c.key === 'dist')!;
    expect(dist.status).toBe('single_source'); // the code found the text …
    expect(dist.skepticVerdict).toBe('needs_more_evidence'); // … the skeptic says it does not support THIS claim
    expect(claimSupports(dist)).toBe(false);
    expect(r.assessment.scores.distribution).toBeNull();
  });

  it('grade comes only from sources that support scored claims — an unrelated independent page does not lift it', async () => {
    const r = await research(
      proposal({
        claims: [
          { key: 'w-need', dimension: 'westernNeed', text: 'Есть автоматические напоминания по счетам.', quote: 'Automatic reminder sequences for unpaid invoices', sourceUrls: [PRICING], highImpact: true },
          // fetched independent page, but its claim is not used in any score
          { key: 'side', dimension: 'retention', text: 'Самозанятые сталкиваются с задержками.', quote: '41% сталкивались с задержкой оплаты', sourceUrls: [SURVEY] },
        ],
        scores: { westernNeed: { value: 4, claims: ['w-need'] } },
      }),
    );
    expect(r.claims.find((c) => c.key === 'w-need')!.status).toBe('vendor_claim');
    expect(r.sources.some((s) => s.sourceType === 'independent' && s.fetchStatus === 'ok')).toBe(true);
    expect(r.assessment.evidenceGrade).toBe('C'); // the old rule gave B because ANY independent page was fetched
  });

  it('evidenceGrade(): vendor-only support is C; independent support of a scored claim is B', () => {
    const src: SourceRow[] = [
      { key: 's1', url: 'https://a.example', publisher: null, region: 'west', sourceType: 'company_self_report', fetchStatus: 'ok', httpStatus: 200, contentHash: null, excerpt: 'x', agent: 'analyst' },
      { key: 's2', url: 'https://b.example', publisher: null, region: 'west', sourceType: 'independent', fetchStatus: 'ok', httpStatus: 200, contentHash: null, excerpt: 'x', agent: 'analyst' },
    ];
    const claim = (key: string, supporting: string[], status: ClaimRow['status'] = 'single_source'): ClaimRow => ({ key, dimension: 'westernNeed', text: 't', quote: 'q', sourceKeys: supporting, supportingKeys: supporting, status, reason: 'r', highImpact: true, skepticVerdict: 'supported', skepticReason: null });
    expect(evidenceGrade([claim('a', ['s1'], 'vendor_claim')], src, new Set(['a']))).toBe('C');
    expect(evidenceGrade([claim('a', ['s2'])], src, new Set(['a']))).toBe('B');
    expect(evidenceGrade([claim('a', ['s2'])], src, new Set())).toBe('D'); // not used in any score
  });

  it('zero-hit Russian searches never give 5/5: cap 3, or 4 only with an independent Russian source', async () => {
    const vendorOnly = await research(
      proposal({
        claims: [
          { key: 'w-need', dimension: 'westernNeed', text: 'Есть спрос.', quote: 'send polite automatic payment reminders', sourceUrls: [REVIEW], highImpact: true },
          { key: 'ru-weak', dimension: 'ruWeakness', text: 'Российские CRM не автоматизируют напоминания.', quote: 'Счета выставляются вручную', sourceUrls: [CRM] },
        ],
        scores: { westernNeed: { value: 4, claims: ['w-need'] }, ruWeakness: { value: 5, claims: ['ru-weak'] } },
      }),
    );
    expect(vendorOnly.searches.filter((s) => s.region === 'ru').every((s) => s.resultCount === 0)).toBe(true);
    expect(vendorOnly.competitors).toEqual([]);
    expect(vendorOnly.assessment.scores.ruWeakness).toBe(3);
    expect(vendorOnly.assessment.dimensionNotes.join(' ')).toMatch(/отсутствие найденных ≠ отсутствие конкурентов/);

    const withIndependent = await research(
      proposal({
        claims: [
          { key: 'w-need', dimension: 'westernNeed', text: 'Есть спрос.', quote: 'send polite automatic payment reminders', sourceUrls: [REVIEW], highImpact: true },
          { key: 'ru-gap', dimension: 'ruUnmetJob', text: 'В РФ напоминания отправляют вручную.', quote: 'напоминания отправляют вручную', sourceUrls: [SURVEY] },
        ],
        scores: { westernNeed: { value: 4, claims: ['w-need'] }, ruUnmetJob: { value: 5, claims: ['ru-gap'] } },
      }),
    );
    expect(withIndependent.assessment.scores.ruUnmetJob).toBe(4);
  });

  it('an «absence» claim with zero rivals found is NOT supported without an independent source', async () => {
    const r = await research(
      proposal({
        claims: [
          { key: 'w-need', dimension: 'westernNeed', text: 'Есть спрос.', quote: 'send polite automatic payment reminders', sourceUrls: [REVIEW], highImpact: true },
          { key: 'ru-weak', dimension: 'ruWeakness', text: 'В РФ никто не делает напоминания.', quote: 'Счета выставляются вручную', sourceUrls: [CRM], highImpact: true, absence: { market: 'ru', job: 'invoice-reminders' } },
        ],
        scores: { westernNeed: { value: 4, claims: ['w-need'] }, ruWeakness: { value: 5, claims: ['ru-weak'] } },
      }),
    );
    const c = r.claims.find((x) => x.key === 'ru-weak')!;
    expect(c.skepticVerdict).toBe('needs_more_evidence');
    expect(c.skepticReason).toMatch(/не доказывает пробел/);
    expect(r.assessment.scores.ruWeakness).toBeNull();
  });
});

describe('P1 independent skeptic: structured challenge drives the gate', () => {
  const base = proposal({
    claims: [
      { key: 'w-need', dimension: 'westernNeed', text: 'Есть спрос.', quote: 'send polite automatic payment reminders', sourceUrls: [REVIEW], highImpact: true },
      { key: 'w-pay', dimension: 'westernPay', text: 'Пользователи платят от $12 в месяц.', quote: '$12 per month', sourceUrls: [REVIEW, PRICING] },
    ],
    scores: { westernNeed: { value: 4, claims: ['w-need'] }, westernPay: { value: 5, claims: ['w-pay'] } },
  });

  it('the fixture skeptic supports relevant, quoted claims (baseline)', async () => {
    const r = await research(base);
    expect(r.claims.map((c) => c.skepticVerdict)).toEqual(['supported', 'supported']);
    expect(r.claims.find((c) => c.key === 'w-pay')!.status).toBe('corroborated');
    expect(r.reviews.find((x) => x.reviewer === 'skeptic')!.model).toBe('fixture-skeptic-v1');
  });

  it('a skeptic refutation that is NOT a job-tag match (content judgement) contradicts the claim and holds the idea', async () => {
    const challenge = async (input: Parameters<Providers['skeptic']['challenge']>[0], ctx: CallContext): Promise<SkepticFindings> => {
      const real = await new FixtureSkeptic().challenge(input, ctx);
      const pricing = input.sources.find((s) => s.url === PRICING)!.key;
      return {
        ...real,
        model: 'stub-skeptic-v2',
        claimVerdicts: real.claimVerdicts.map((v) => (v.claimKey === 'w-pay' ? { claimKey: 'w-pay', verdict: 'refuted', sourceKeys: [pricing], reason: 'цена — прайс-лист, а не доказательство платящих пользователей' } : v)),
        disputes: [{ claimKey: 'w-pay', severity: 'critical', reason: 'готовность платить не доказана' }],
      };
    };
    const r = await research(base, { challenge });
    const pay = r.claims.find((c) => c.key === 'w-pay')!;
    expect(pay.status).toBe('contradicted');
    expect(pay.reason).toMatch(/прайс-лист/);
    expect(r.assessment.scores.westernPay).toBeNull(); // refuted basis is never counted
    expect(r.assessment.state).toBe('RESEARCH_HOLD');
    expect(r.assessment.holdReasons.join(' ')).toMatch(/критический спор скептика \(w-pay\)/);
    expect(r.assessment.models).toContain('stub-skeptic-v2');
  });

  it('a missing verdict means the claim is not counted', async () => {
    const challenge = async (input: Parameters<Providers['skeptic']['challenge']>[0], ctx: CallContext) => {
      const real = await new FixtureSkeptic().challenge(input, ctx);
      return { ...real, claimVerdicts: real.claimVerdicts.filter((v) => v.claimKey !== 'w-pay') };
    };
    const r = await research(base, { challenge });
    expect(r.claims.find((c) => c.key === 'w-pay')!.skepticVerdict).toBe('needs_more_evidence');
    expect(r.assessment.scores.westernPay).toBeNull();
  });

  it('invalid skeptic output (schema or dangling references) is never scored', async () => {
    const broken = await research(base, { challenge: async () => ({ model: 'x', claimVerdicts: 'nope' }) as unknown as SkepticFindings });
    expect(broken.assessment.state).toBe('DISCOVERED');
    expect(broken.assessment.rationale).toMatch(/Некорректный ответ модели: скептик/);
    const dangling = await research(base, {
      challenge: async (i, c) => {
        const real = await new FixtureSkeptic().challenge(i, c);
        return { ...real, claimVerdicts: [...real.claimVerdicts, { claimKey: 'w-need', verdict: 'supported', sourceKeys: ['s999'], reason: 'ссылка на несуществующий источник' }] };
      },
    });
    expect(dangling.assessment.state).toBe('DISCOVERED');
    expect(dangling.assessment.rationale).toMatch(/несуществующие/);
  });

  it('invalid analyst output is rejected at runtime (Zod), not trusted as a TypeScript type', async () => {
    const noRationale = await research({ ...base, rationale: undefined });
    expect(noRationale.assessment.state).toBe('DISCOVERED');
    const dangling = await research({ ...base, scores: { westernNeed: { value: 5, claims: ['ghost'] } } });
    expect(dangling.assessment.state).toBe('DISCOVERED');
    expect(dangling.assessment.rationale).toMatch(/несуществующее утверждение ghost/);
    const outOfRange = await research({ ...base, scores: { westernNeed: { value: 9, claims: ['w-need'] } } });
    expect(outOfRange.assessment.state).toBe('DISCOVERED');
  });

  it('skeptic usage is metered like any model call', async () => {
    const ctx = new CallContext('t', 1, 1_000_000);
    await researchCandidate(seed, true, DAY, providers(base), ctx);
    expect(ctx.usage.filter((u) => u.provider === 'fixture-skeptic')).toHaveLength(1);
  });
});

describeDb('P1 hard spend caps: monthly reservation ledger', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });
  const monthCommitted = async (month: string) =>
    (await db.pool.query<{ s: number }>("SELECT COALESCE(SUM(COALESCE(used, reserved)), 0)::int AS s FROM mr_attempts WHERE feed = 'fixture' AND month = $1", [month])).rows[0]!.s;

  it('(a) month spent just below the cap: the run gets only the remainder and stops «partial», cap never exceeded', async () => {
    expect((await runWorkerJob(db.pool, { feed: 'fixture', asOf: '2026-11-10' })).status).toBe('succeeded'); // registry to re-research
    await db.pool.query("INSERT INTO mr_jobs (job_key, feed, as_of, timezone, status, attempts, max_attempts, budget_limit, monthly_cap, spent, pipeline_version) VALUES ('daily:fixture:2026-12-01', 'fixture', '2026-12-01', 'Asia/Novokuznetsk', 'succeeded', 1, 1, 40000, 40000, 39950, 'x')");
    await db.pool.query("INSERT INTO mr_attempts (job_id, feed, attempt, month, reserved, used, status) SELECT id, 'fixture', 1, '2026-12-01', 39950, 39950, 'succeeded' FROM mr_jobs WHERE job_key = 'daily:fixture:2026-12-01'");
    const r = await runWorkerJob(db.pool, { feed: 'fixture', asOf: '2026-12-02', monthlyBudget: 40000 });
    expect(r.status).toBe('partial');
    expect(r.message).toMatch(/месячный лимит/);
    const att = (await db.pool.query("SELECT a.reserved, a.used FROM mr_attempts a JOIN mr_jobs j ON j.id = a.job_id WHERE j.job_key = 'daily:fixture:2026-12-02'")).rows[0];
    expect(att.reserved).toBe(50);
    expect(att.used).toBeLessThanOrEqual(50);
    expect(await monthCommitted('2026-12-01')).toBeLessThanOrEqual(40000);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM mr_snapshots WHERE as_of = '2026-12-02'")).rows[0].n).toBe(0);
  });

  it('(b) two different dates of one month started in parallel cannot jointly exceed the monthly cap', async () => {
    await runWorkerJob(db.pool, { feed: 'fixture', asOf: '2027-01-01', monthlyBudget: 900 }).catch(() => undefined); // warm registry
    const before = await monthCommitted('2027-01-01');
    const [x, y] = await Promise.all([
      runWorkerJob(db.pool, { feed: 'fixture', asOf: '2027-01-02', monthlyBudget: before + 900 }),
      runWorkerJob(db.pool, { feed: 'fixture', asOf: '2027-01-03', monthlyBudget: before + 900 }),
    ]);
    expect(await monthCommitted('2027-01-01')).toBeLessThanOrEqual(before + 900);
    expect([x.status, y.status].filter((s) => s === 'succeeded').length).toBeLessThanOrEqual(1);
    expect([x.status, y.status]).toEqual(expect.arrayContaining(['monthly-cap']));
    const usage = (await db.pool.query<{ s: number }>("SELECT COALESCE(SUM(u.cost), 0)::int AS s FROM mr_usage u JOIN mr_jobs j ON j.id = u.job_id WHERE j.as_of BETWEEN '2027-01-02' AND '2027-01-03'")).rows[0]!.s;
    expect(usage).toBeLessThanOrEqual(900);
  });

  it('(c) lease takeover: A expires, B takes over and publishes, A returns — both attempts are in the ledger, only B publishes', async () => {
    const t = await createTestDb();
    try {
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      let entered!: () => void;
      const inside = new Promise<void>((res) => (entered = res));
      const blocked = (asOf: string): Providers => {
        const llm = new FixtureLLMProvider();
        const analyse = llm.analyse.bind(llm);
        let first = true;
        llm.analyse = async (s, d, c) => {
          if (first) {
            first = false;
            entered();
            await gate;
          }
          return analyse(s, d, c);
        };
        return { search: new FixtureSearchProvider(asOf), reader: new FixtureSourceReader(asOf), llm, skeptic: new FixtureSkeptic() };
      };
      const a = runWorkerJob(t.pool, { feed: 'fixture', asOf: '2026-11-10', providers: blocked });
      await inside; // A holds the lease and is mid-pipeline
      await t.pool.query("UPDATE mr_jobs SET lease_until = now() - interval '1 minute' WHERE job_key = 'daily:fixture:2026-11-10'");
      const b = await runWorkerJob(t.pool, { feed: 'fixture', asOf: '2026-11-10' });
      expect(b).toMatchObject({ status: 'succeeded', attempt: 2 });
      release();
      const ra = await a;
      expect(ra.status).toBe('failed'); // A may not publish: it lost ownership
      const atts = (await t.pool.query('SELECT attempt, reserved, used, status FROM mr_attempts ORDER BY attempt')).rows;
      expect(atts.map((x) => x.status)).toEqual(['superseded', 'succeeded']);
      expect(atts.every((x) => x.used !== null && x.used > 0)).toBe(true);
      const job = (await t.pool.query("SELECT status, spent FROM mr_jobs WHERE job_key = 'daily:fixture:2026-11-10'")).rows[0];
      expect(job.status).toBe('succeeded');
      expect(job.spent).toBe(atts[0].used + atts[1].used);
      const byAttempt = (await t.pool.query('SELECT attempt, SUM(cost)::int AS s FROM mr_usage GROUP BY attempt ORDER BY attempt')).rows;
      expect(byAttempt.map((x) => x.s)).toEqual([atts[0].used, atts[1].used]);
      expect((await t.pool.query('SELECT count(*)::int AS n FROM mr_snapshots')).rows[0].n).toBe(1);
    } finally {
      await t.drop();
    }
  });

  it('a crashed attempt keeps its FULL reservation committed until it reports, and recorded usage cannot be rewritten', async () => {
    const att = (await db.pool.query("SELECT job_id, attempt FROM mr_attempts WHERE used IS NOT NULL LIMIT 1")).rows[0];
    await expect(db.pool.query('UPDATE mr_attempts SET used = 0 WHERE job_id = $1 AND attempt = $2', [att.job_id, att.attempt])).rejects.toThrow(/cannot be rewritten/);
    await expect(db.pool.query('UPDATE mr_attempts SET reserved = 1 WHERE job_id = $1 AND attempt = $2', [att.job_id, att.attempt])).rejects.toThrow();
    await expect(db.pool.query('DELETE FROM mr_attempts')).rejects.toThrow();
  });
});

describeDb('P2 database integrity: feed / job / assessment consistency', () => {
  let db: TestDb;
  let fx: { job: number; cand: number; passedA: number; heldA: number; snap: number };
  beforeAll(async () => {
    db = await createTestDb();
    const r = await runWorkerJob(db.pool, { feed: 'fixture', asOf: '2026-11-10' });
    expect(r.status).toBe('succeeded');
    const q = async (sql: string) => (await db.pool.query(sql)).rows[0];
    fx = {
      job: (await q("SELECT id FROM mr_jobs WHERE job_key = 'daily:fixture:2026-11-10'")).id,
      cand: (await q("SELECT id FROM mr_candidates WHERE external_id = 'invoice-reminders-smb'")).id,
      passedA: (await q("SELECT a.id FROM mr_assessments a JOIN mr_candidates c ON c.id = a.candidate_id WHERE c.external_id = 'invoice-reminders-smb'")).id,
      heldA: (await q("SELECT a.id FROM mr_assessments a JOIN mr_candidates c ON c.id = a.candidate_id WHERE c.external_id = 'str-guest-guide'")).id,
      snap: (await q('SELECT id FROM mr_snapshots LIMIT 1')).id,
    };
    await db.pool.query("INSERT INTO mr_jobs (job_key, feed, as_of, timezone, status, max_attempts, budget_limit, monthly_cap, pipeline_version) VALUES ('daily:live:2026-11-10', 'live', '2026-11-10', 'Asia/Novokuznetsk', 'queued', 3, 3000, 40000, 'x')");
    await db.pool.query("INSERT INTO mr_candidates (feed, external_id, first_job_id, first_seen, seed_title, seed_pitch, segment, category, primary_job, jobs, western_product) SELECT 'live', 'grade-test', id, '2026-11-10', 'Тест класса', 'p', 'B2B', 'c', 'job-a', '{job-a}', 'W' FROM mr_jobs WHERE feed = 'live'");
    await db.pool.query("INSERT INTO mr_candidates (feed, external_id, first_job_id, first_seen, seed_title, seed_pitch, segment, category, primary_job, jobs, western_product) SELECT 'live', 'backdate-test', id, '2026-11-10', 'Тест даты', 'p', 'B2B', 'c', 'job-a', '{job-a}', 'W' FROM mr_jobs WHERE feed = 'live'");
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('refuses a row whose feed differs from its job or candidate (direct SQL)', async () => {
    const live = (await db.pool.query("SELECT id FROM mr_jobs WHERE feed = 'live'")).rows[0].id;
    // fixture job, but labelled live
    await expect(db.pool.query("INSERT INTO mr_reviews (job_id, candidate_id, feed, reviewer, model, decision, summary) VALUES ($1, $2, 'live', 'skeptic', 'm', 'support', 'cross feed')", [fx.job, fx.cand])).rejects.toThrow(/foreign key/);
    // live job + fixture candidate
    await expect(db.pool.query("INSERT INTO mr_claims (job_id, candidate_id, feed, claim_key, dimension, text, status, status_reason, skeptic_verdict) VALUES ($1, $2, 'live', 'k', 'westernNeed', 'cross feed claim', 'unknown', 'r', 'not_reviewed')", [live, fx.cand])).rejects.toThrow(/foreign key/);
    await expect(db.pool.query("INSERT INTO mr_usage (job_id, feed, attempt, provider, operation, request_id, cost, price_version, estimated_cost) VALUES ($1, 'live', 1, 'p', 'llm', 'x-cross', 1, 'v', 1)", [fx.job])).rejects.toThrow(/foreign key/);
  });

  it('refuses snapshot entries from another job/candidate, for held ideas, or with forged frozen values', async () => {
    const heldCand = (await db.pool.query('SELECT candidate_id FROM mr_assessments WHERE id = $1', [fx.heldA])).rows[0].candidate_id;
    const ins = (snap: number, job: number, feed: string, cand: number, assessment: number, score: number | null, state = 'AUTOMATED_EVIDENCE_PASSED') =>
      db.pool.query(
        `INSERT INTO mr_snapshot_entries (snapshot_id, job_id, feed, rank, candidate_id, assessment_id, title, market_score, confidence, evidence_grade, state)
         SELECT $1, $2, $3, 9, $4, a.id, a.title, COALESCE($6, a.market_score), a.confidence, a.evidence_grade, $7 FROM mr_assessments a WHERE a.id = $5`,
        [snap, job, feed, cand, assessment, score, state],
      );
    // a held idea cannot be put into the TOP (its assessment is not AUTOMATED_EVIDENCE_PASSED)
    await expect(ins(fx.snap, fx.job, 'fixture', heldCand, fx.heldA, null)).rejects.toThrow(/foreign key/);
    // another candidate's assessment
    await expect(ins(fx.snap, fx.job, 'fixture', heldCand, fx.passedA, null)).rejects.toThrow(/foreign key/);

    // a clean live job with one passed assessment and an empty snapshot: frozen values must match exactly
    const live = (await db.pool.query("SELECT id FROM mr_jobs WHERE feed = 'live'")).rows[0].id;
    const cid = (await db.pool.query("SELECT id FROM mr_candidates WHERE external_id = 'grade-test'")).rows[0].id;
    const aid = (
      await db.pool.query(
        `INSERT INTO mr_assessments (job_id, candidate_id, feed, as_of, title, pitch, segment, category, rubric_version, conf_completeness, conf_corroboration, conf_recency, conf_reliability, conf_russia_validation, market_score, confidence, evidence_grade, state, rationale, pipeline_version, models)
         VALUES ($1, $2, 'live', '2026-11-10', 'Тест класса', 'p', 'B2B', 'c', 'v1.0', 0,0,0,0,0, 50, 50, 'C', 'AUTOMATED_EVIDENCE_PASSED', 'r', 'x', '{m}') RETURNING id`,
        [live, cid],
      )
    ).rows[0].id;
    const snap = (await db.pool.query("INSERT INTO mr_snapshots (job_id, feed, as_of, eligible_count, hold_count) VALUES ($1, 'live', '2026-11-10', 1, 0) RETURNING id", [live])).rows[0].id;
    await expect(ins(snap, live, 'live', cid, aid, 80)).rejects.toThrow(/foreign key/); // inflated frozen score
    await expect(ins(snap, fx.job, 'fixture', fx.cand, fx.passedA, null)).rejects.toThrow(/foreign key/); // entry of another job/feed
    await expect(ins(snap, live, 'live', cid, aid, null)).resolves.toBeDefined(); // exact copy is accepted
  });

  it('refuses assessments dated differently from their job and jobs whose identity changes', async () => {
    await expect(db.pool.query("UPDATE mr_jobs SET feed = 'live' WHERE id = $1", [fx.job])).rejects.toThrow();
    await expect(db.pool.query("UPDATE mr_jobs SET as_of = '2026-11-09' WHERE id = $1", [fx.job])).rejects.toThrow();
    await expect(db.pool.query('DELETE FROM mr_jobs WHERE id = $1', [fx.job])).rejects.toThrow();
    await expect(
      db.pool.query(
        `INSERT INTO mr_assessments (job_id, candidate_id, feed, as_of, title, pitch, segment, category, rubric_version, conf_completeness, conf_corroboration, conf_recency, conf_reliability, conf_russia_validation, market_score, confidence, evidence_grade, state, rationale, pipeline_version, models)
         VALUES ($1, $2, 'live', '2026-11-09', 'backdated', 'p', 'B2B', 'c', 'v1.0', 0,0,0,0,0, 50, 50, 'C', 'DISCOVERED', 'r', 'x', '{m}')`,
        [(await db.pool.query("SELECT id FROM mr_jobs WHERE feed = 'live'")).rows[0].id, (await db.pool.query("SELECT id FROM mr_candidates WHERE external_id = 'backdate-test'")).rows[0].id],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('refuses a passed assessment with grade D', async () => {
    const live = (await db.pool.query("SELECT id FROM mr_jobs WHERE feed = 'live'")).rows[0].id;
    const cid = (await db.pool.query("SELECT id FROM mr_candidates WHERE external_id = 'grade-test'")).rows[0].id;
    await expect(
      db.pool.query(
        `INSERT INTO mr_assessments (job_id, candidate_id, feed, as_of, title, pitch, segment, category, rubric_version, conf_completeness, conf_corroboration, conf_recency, conf_reliability, conf_russia_validation, market_score, confidence, evidence_grade, state, rationale, pipeline_version, models)
         VALUES ($1, $2, 'live', '2026-11-10', 'grade D passed', 'p', 'B2B', 'c', 'v1.0', 0,0,0,0,0, 50, 50, 'D', 'AUTOMATED_EVIDENCE_PASSED', 'r', 'x', '{m}')`,
        [live, cid],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
