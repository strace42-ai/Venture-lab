// @vitest-environment node
/**
 * VL-004A review round 2 (ChatGPT, PR #5) — negative and integration tests:
 *  P1 phantom competitors: the skeptic may only classify rivals that search actually surfaced on a
 *     fetched page (same source, name and market). Invented or re-marketed rivals are dropped and
 *     cannot change scores, the gate or the TOP-10; verdicts that cite them are downgraded.
 *  P1 attempt budget: an attempt starts with a chunk and tops up while it owns a live lease, so a
 *     normal run can use the whole job budget; a stuck (superseded) attempt is refused further budget
 *     and its ledger row stays honest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { researchCandidate, type Providers } from '../machine/pipeline';
import { FixtureLLMProvider, FixtureSearchProvider, FixtureSkeptic, FixtureSourceReader, seedFor } from '../machine/providers/fixture';
import { CallContext, type SkepticFindings, type SkepticInput } from '../machine/types';
import { runWorkerJob, topUpAttempt } from '../machine/worker';
import { createTestDb, describeDb, type TestDb } from './helpers';

const DAY = '2026-11-10';
const FOCUS = 'focus-coworking-1on1';

type Challenge = (input: SkepticInput, ctx: CallContext) => Promise<SkepticFindings>;

const fixtureProviders = (asOf: string, challenge?: (real: SkepticFindings, input: SkepticInput) => SkepticFindings): Providers => {
  const real = new FixtureSkeptic();
  const skeptic = challenge
    ? Object.assign(Object.create(Object.getPrototypeOf(real)) as FixtureSkeptic, real, {
        challenge: (async (input, ctx) => {
          const f = await real.challenge(input, ctx);
          return input.seed.externalId === FOCUS ? challenge(f, input) : f;
        }) satisfies Challenge,
      })
    : real;
  return { search: new FixtureSearchProvider(asOf), reader: new FixtureSourceReader(asOf), llm: new FixtureLLMProvider(), skeptic };
};

const key = (input: SkepticInput, url: string) => input.sources.find((s) => s.url === url)!.key;

/** «RealtyCalendar» invented as a direct RU rival on the (real, fetched) Focusmate page. */
const phantom = (real: SkepticFindings, input: SkepticInput): SkepticFindings => ({
  ...real,
  competitors: [...real.competitors, { name: 'RealtyCalendar', market: 'ru', kind: 'direct', sourceKey: key(input, 'https://www.focusmate.com/'), reason: 'выдуманный прямой конкурент' }],
});
/** The real western offer on the Focusmate page re-labelled as a direct RU rival — market mismatch. */
const remarket = (real: SkepticFindings, input: SkepticInput): SkepticFindings => ({
  ...real,
  competitors: [...real.competitors, { name: 'Focusmate', market: 'ru', kind: 'direct', sourceKey: key(input, 'https://www.focusmate.com/'), reason: 'страница западная, рынок подменён' }],
});
/** Phantom rival + a refutation of the RU gap that cites only the phantom + a critical dispute. */
const phantomRefutation = (real: SkepticFindings, input: SkepticInput): SkepticFindings => {
  const p = phantom(real, input);
  const fm = key(input, 'https://www.focusmate.com/');
  return {
    ...p,
    claimVerdicts: p.claimVerdicts.map((v) => (v.claimKey === 'ru-weak' ? { claimKey: 'ru-weak', verdict: 'refuted', sourceKeys: [fm], reason: 'RealtyCalendar уже делает подбор пары' } : v)),
    disputes: [...p.disputes, { claimKey: 'ru-weak', severity: 'critical', reason: 'пробел опровергнут RealtyCalendar' }],
  };
};

describe('P1 phantom competitors (pipeline, unit)', () => {
  const run = async (challenge?: (real: SkepticFindings, input: SkepticInput) => SkepticFindings) => researchCandidate(seedFor(FOCUS)!, true, DAY, fixtureProviders(DAY, challenge), new CallContext('t', 1, 1_000_000));

  it('an invented direct rival on an existing sourceKey is dropped and changes nothing', async () => {
    const base = await run();
    const r = await run(phantom);
    expect(r.competitors.map((c) => c.name)).not.toContain('RealtyCalendar');
    expect(r.competitors).toEqual(base.competitors);
    expect(r.assessment.scores).toEqual(base.assessment.scores);
    expect(r.assessment.marketScore).toBe(base.assessment.marketScore);
    expect(r.assessment.state).toBe(base.assessment.state);
    const sk = r.reviews.find((x) => x.reviewer === 'skeptic')!;
    expect(sk.findings.join(' ')).toMatch(/отклонено: конкурент «RealtyCalendar» \(РФ\) не найден на загруженной странице/);
  });

  it('a market mismatch (western rival relabelled as a direct RU rival) is dropped', async () => {
    const base = await run();
    const r = await run((f, i) => remarket(f, i));
    expect(r.competitors.filter((c) => c.market === 'ru' && c.kind === 'direct').map((c) => c.name)).not.toContain('Focusmate');
    expect(r.assessment.scores).toEqual(base.assessment.scores);
    expect(r.assessment.marketScore).toBe(base.assessment.marketScore);
    expect(r.reviews.find((x) => x.reviewer === 'skeptic')!.findings.join(' ')).toMatch(/«Focusmate» \(РФ\) не найден/);
  });

  it('a rival on a page that was not fetched OK is dropped even if search surfaced the URL', async () => {
    const r = await run((real, input) => ({ ...real, competitors: [...real.competitors, { name: 'drive2', market: 'ru', kind: 'direct', sourceKey: input.sources.find((s) => s.fetchStatus !== 'ok')?.key ?? key(input, 'https://www.focusmate.com/'), reason: 'страница не загружена' }] }));
    expect(r.competitors.map((c) => c.name)).not.toContain('drive2');
  });

  it('a refutation that cites only a phantom rival is downgraded; its critical dispute cannot hold the idea', async () => {
    const base = await run();
    const r = await run(phantomRefutation);
    const weak = r.claims.find((c) => c.key === 'ru-weak')!;
    expect(weak.status).not.toBe('contradicted');
    expect(weak.skepticVerdict).toBe('needs_more_evidence');
    expect(weak.skepticReason).toMatch(/отклонён кодом/);
    expect(r.assessment.holdReasons.join(' ')).not.toMatch(/КРИТИЧЕСКИЙ|критический спор скептика \(ru-weak\)/);
    expect(r.assessment.marketScore).toBeLessThanOrEqual(base.assessment.marketScore!);
  });

  it('a «supported» verdict that cites a source without the quote is downgraded', async () => {
    const r = await run((real, input) => ({
      ...real,
      claimVerdicts: real.claimVerdicts.map((v) => (v.claimKey === 'w-need' ? { ...v, verdict: 'supported', sourceKeys: [key(input, 'https://cofocus.ru/club')] } : v)),
    }));
    const need = r.claims.find((c) => c.key === 'w-need')!;
    expect(need.skepticVerdict).toBe('needs_more_evidence');
    expect(r.assessment.scores.westernNeed).toBeNull();
    expect(r.assessment.state).toBe('RESEARCH_HOLD');
  });
});

describeDb('P1 phantom competitors (worker integration: scores, ranking, stored rows)', () => {
  let base: TestDb;
  let hacked: TestDb;
  beforeAll(async () => {
    [base, hacked] = await Promise.all([createTestDb(), createTestDb()]);
  });
  afterAll(async () => {
    await Promise.all([base?.drop(), hacked?.drop()]);
  });
  const top = async (db: TestDb) => (await db.pool.query('SELECT rank, title, market_score, confidence, evidence_grade FROM mr_snapshot_entries ORDER BY rank')).rows;

  it('a run with invented and re-marketed direct rivals publishes exactly the baseline TOP-10', async () => {
    expect((await runWorkerJob(base.pool, { feed: 'fixture', asOf: DAY })).status).toBe('succeeded');
    const r = await runWorkerJob(hacked.pool, { feed: 'fixture', asOf: DAY, providers: (d) => fixtureProviders(d, (f, i) => remarket(phantom(f, i), i)) });
    expect(r.status).toBe('succeeded');
    expect(await top(hacked)).toEqual(await top(base));
    const names = (await hacked.pool.query("SELECT name, market, kind FROM mr_competitors WHERE name IN ('RealtyCalendar', 'Focusmate')")).rows;
    expect(names.find((x) => x.name === 'RealtyCalendar')).toBeUndefined();
    expect(names.every((x) => !(x.name === 'Focusmate' && x.market === 'ru'))).toBe(true);
    const ranked = (await hacked.pool.query("SELECT a.market_score, a.state FROM mr_assessments a JOIN mr_candidates c ON c.id = a.candidate_id WHERE c.external_id = $1", [FOCUS])).rows;
    const baseline = (await base.pool.query("SELECT a.market_score, a.state FROM mr_assessments a JOIN mr_candidates c ON c.id = a.candidate_id WHERE c.external_id = $1", [FOCUS])).rows;
    expect(ranked).toEqual(baseline);
  });

  it('a refutation resting only on a phantom rival neither contradicts the claim nor holds the idea (fail-closed: no support either)', async () => {
    const t = await createTestDb();
    try {
      const r = await runWorkerJob(t.pool, { feed: 'fixture', asOf: DAY, providers: (d) => fixtureProviders(d, phantomRefutation) });
      expect(r.status).toBe('succeeded');
      const claim = (await t.pool.query("SELECT cl.status, cl.skeptic_verdict FROM mr_claims cl JOIN mr_candidates c ON c.id = cl.candidate_id WHERE c.external_id = $1 AND cl.claim_key = 'ru-weak'", [FOCUS])).rows[0];
      expect(claim).toEqual({ status: expect.not.stringMatching(/contradicted/), skeptic_verdict: 'needs_more_evidence' });
      const titles = (await t.pool.query('SELECT title FROM mr_snapshot_entries ORDER BY rank')).rows.map((x) => x.title);
      expect(titles).toEqual((await top(base)).map((x) => x.title)); // still published, same order
    } finally {
      await t.drop();
    }
  });
});

/** Fixture providers with a surcharge per search, so a normal run costs more than one chunk. */
const pricey = (asOf: string, extra: number): Providers => {
  const search = new FixtureSearchProvider(asOf);
  const orig = search.search.bind(search);
  search.search = async (q, region, ctx) => {
    await ctx.charge({ provider: 'fixture-search', operation: 'search', model: null, tokensIn: 0, tokensOut: 0, cost: extra, priceVersion: 'fixture-surcharge' });
    return orig(q, region, ctx);
  };
  return { search, reader: new FixtureSourceReader(asOf), llm: new FixtureLLMProvider(), skeptic: new FixtureSkeptic() };
};

describeDb('P1 attempt budget: chunk + top-up under a live lease', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });
  const attempts = async (pool: TestDb['pool'], asOf: string) =>
    (await pool.query("SELECT a.attempt, a.reserved, a.used, a.status FROM mr_attempts a JOIN mr_jobs j ON j.id = a.job_id WHERE j.as_of = $1 AND j.feed = 'fixture' ORDER BY a.attempt", [asOf])).rows;

  it('job budget 3000, max_attempts 3: a normal run costing >1000 completes in ONE attempt without overspend', async () => {
    const r = await runWorkerJob(db.pool, { feed: 'fixture', asOf: DAY, budget: 3000, maxAttempts: 3, monthlyBudget: 40_000, providers: (d) => pricey(d, 40) });
    expect(r.status).toBe('succeeded');
    const [a, ...rest] = await attempts(db.pool, DAY);
    expect(rest).toHaveLength(0);
    expect(a.used).toBeGreaterThan(1000); // more than the first chunk (3000 / 3)
    expect(a.used).toBeLessThanOrEqual(3000);
    expect(a.reserved).toBeGreaterThan(1000);
    expect(a.reserved).toBeLessThanOrEqual(3000);
    expect(a.used).toBeLessThanOrEqual(a.reserved);
    const usage = (await db.pool.query<{ s: number }>("SELECT SUM(u.cost)::int AS s FROM mr_usage u JOIN mr_jobs j ON j.id = u.job_id WHERE j.as_of = $1", [DAY])).rows[0]!.s;
    expect(usage).toBe(a.used);
    expect((await db.pool.query("SELECT spent, status FROM mr_jobs WHERE as_of = $1 AND feed = 'fixture'", [DAY])).rows[0]).toEqual({ spent: a.used, status: 'succeeded' });
  });

  it('top-ups never exceed the job budget: a run that needs more than the budget stops «partial» at the cap', async () => {
    const r = await runWorkerJob(db.pool, { feed: 'fixture', asOf: '2026-11-11', budget: 700, maxAttempts: 3, providers: (d) => pricey(d, 40) });
    expect(r.status).toBe('partial');
    const [a] = await attempts(db.pool, '2026-11-11');
    expect(a.reserved).toBeLessThanOrEqual(700);
    expect(a.used).toBeLessThanOrEqual(a.reserved);
  });

  it('top-ups never exceed the monthly cap', async () => {
    const monthBefore = (await db.pool.query<{ s: number }>("SELECT COALESCE(SUM(COALESCE(used, reserved)), 0)::int AS s FROM mr_attempts WHERE feed = 'fixture' AND month = '2026-11-01'")).rows[0]!.s;
    const r = await runWorkerJob(db.pool, { feed: 'fixture', asOf: '2026-11-12', budget: 3000, maxAttempts: 3, monthlyBudget: monthBefore + 500, providers: (d) => pricey(d, 40) });
    expect(r.status).toBe('partial');
    const monthAfter = (await db.pool.query<{ s: number }>("SELECT COALESCE(SUM(COALESCE(used, reserved)), 0)::int AS s FROM mr_attempts WHERE feed = 'fixture' AND month = '2026-11-01'")).rows[0]!.s;
    expect(monthAfter).toBeLessThanOrEqual(monthBefore + 500);
  });

  it('a stuck attempt is refused top-ups after takeover: it holds only its first chunk, the retry succeeds, the ledger is honest', async () => {
    const t = await createTestDb();
    try {
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      let entered!: () => void;
      const inside = new Promise<void>((res) => (entered = res));
      const blocked = (asOf: string): Providers => {
        const p = pricey(asOf, 0);
        const analyse = p.llm.analyse.bind(p.llm);
        let first = true;
        p.llm.analyse = async (s, d, c) => {
          if (first) {
            first = false;
            entered();
            await gate;
          }
          return analyse(s, d, c);
        };
        return p;
      };
      const opts = { feed: 'fixture' as const, asOf: DAY, budget: 1500, maxAttempts: 3 };
      const a = runWorkerJob(t.pool, { ...opts, providers: blocked });
      await inside; // A holds the lease with its first chunk (500) and is stuck mid-pipeline
      await t.pool.query("UPDATE mr_jobs SET lease_until = now() - interval '1 minute' WHERE job_key = 'daily:fixture:2026-11-10'");
      const b = await runWorkerJob(t.pool, opts); // normal fixture run ≈ 650 > one chunk: needs top-ups
      expect(b).toMatchObject({ status: 'succeeded', attempt: 2 });
      release();
      const ra = await a;
      expect(ra.status).toBe('partial'); // its top-up was refused — it could not spend beyond its chunk
      const [sa, sb] = await attempts(t.pool, DAY);
      expect(sa).toMatchObject({ attempt: 1, status: 'superseded', reserved: 500 });
      expect(sa.used).toBeLessThanOrEqual(sa.reserved);
      expect(sb).toMatchObject({ attempt: 2, status: 'succeeded' });
      expect(sb.reserved).toBeGreaterThan(500); // B topped up
      expect(sb.used).toBeLessThanOrEqual(sb.reserved);
      expect(sa.reserved + sb.reserved).toBeLessThanOrEqual(1500);
      const job = (await t.pool.query("SELECT status, spent FROM mr_jobs WHERE job_key = 'daily:fixture:2026-11-10'")).rows[0];
      expect(job).toEqual({ status: 'succeeded', spent: sa.used + sb.used });
      const byAttempt = (await t.pool.query('SELECT attempt, SUM(cost)::int AS s FROM mr_usage GROUP BY attempt ORDER BY attempt')).rows;
      expect(byAttempt.map((x) => x.s)).toEqual([sa.used, sb.used]);
      expect((await t.pool.query('SELECT count(*)::int AS n FROM mr_snapshots')).rows[0].n).toBe(1);
    } finally {
      await t.drop();
    }
  });

  it('topUpAttempt grants nothing to a non-owner, an expired lease or a settled attempt', async () => {
    const job = (await db.pool.query("SELECT id, attempts FROM mr_jobs WHERE as_of = $1 AND feed = 'fixture'", [DAY])).rows[0];
    const now = new Date();
    expect(await topUpAttempt(db.pool, 'fixture', DAY, job.id, job.attempts, 100, 60_000, 1_000_000, now)).toBe(0); // job already succeeded
    expect(await topUpAttempt(db.pool, 'fixture', DAY, job.id, job.attempts + 1, 100, 60_000, 1_000_000, now)).toBe(0); // not the owner
  });

  it('the ledger trigger lets a reservation only GROW, and only while the attempt runs unsettled', async () => {
    const att = (await db.pool.query("SELECT job_id, attempt FROM mr_attempts WHERE used IS NOT NULL LIMIT 1")).rows[0];
    await expect(db.pool.query('UPDATE mr_attempts SET reserved = reserved + 1 WHERE job_id = $1 AND attempt = $2', [att.job_id, att.attempt])).rejects.toThrow(/only grow while its attempt is running/);
    await expect(db.pool.query('UPDATE mr_attempts SET reserved = reserved - 1 WHERE job_id = $1 AND attempt = $2', [att.job_id, att.attempt])).rejects.toThrow(/only grow/);
    // a running, unsettled attempt: growth allowed, shrinking refused
    await db.pool.query("INSERT INTO mr_jobs (job_key, feed, as_of, timezone, status, attempts, max_attempts, budget_limit, monthly_cap, spent, pipeline_version) VALUES ('daily:fixture:2027-03-01', 'fixture', '2027-03-01', 'Asia/Novokuznetsk', 'running', 1, 3, 900, 40000, 0, 'x')");
    await db.pool.query("INSERT INTO mr_attempts (job_id, feed, attempt, month, reserved, status) SELECT id, 'fixture', 1, '2027-03-01', 300, 'running' FROM mr_jobs WHERE job_key = 'daily:fixture:2027-03-01'");
    const id = (await db.pool.query("SELECT id FROM mr_jobs WHERE job_key = 'daily:fixture:2027-03-01'")).rows[0].id;
    await db.pool.query('UPDATE mr_attempts SET reserved = 600 WHERE job_id = $1', [id]);
    await expect(db.pool.query('UPDATE mr_attempts SET reserved = 100 WHERE job_id = $1', [id])).rejects.toThrow(/only grow/);
  });
});
