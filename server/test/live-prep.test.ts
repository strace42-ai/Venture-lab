// @vitest-environment node
/**
 * VL-004B-prep — guards for the bounded Phase B trial, all offline (recorded HTTP, virtual time):
 *  - Search API limiter: ≤ 1 request / 1.1 s for every attempt (retries and 429 included), concurrent callers;
 *  - one paid gate for --probe and stage runs; no paid request without permission;
 *  - strict prohibition of parallel paid execution (host lock file + DB advisory lock);
 *  - trial ledger: ONE cumulative ceiling (300 ₽ = 5 + 60 + 235), stage order, immutable budget,
 *    no snapshot publication, real dating only, no discovery with seeds;
 *  - probe = transport + minimal schema; raw responses outside git, redacted; CSV export for review.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadLiveConfig } from '../live/config';
import { paidRunGate, STAGE_CAPS_RUB, TRIAL_BUDGET_RUB, type PaidFlags } from '../live/gate';
import { MinIntervalLimiter } from '../live/net/rate-limit';
import { acquireLockFile, PaidExecutionBusy, withPaidExecutionLock } from '../live/paid-lock';
import { ProviderCaller } from '../live/provider-http';
import { assertOutsideRepo, CapturingTransport, redact, repoRootOf } from '../live/raw-capture';
import { RecordedProviders, RecordedWeb, TEST_ENV, virtualClock } from '../live/recordings/mock';
import { SEEDS } from '../live/recordings/world';
import { parseSeeds, runPaidStage } from '../live/run';
import { YandexSearchProvider } from '../live/yandex-search';
import { csvCell, exportReviewCsv } from '../machine/export';
import { CallContext, type DiscoverySeed } from '../machine/types';
import { runWorkerJob, workerToday, type TrialSpec } from '../machine/worker';
import { createTestDb, describeDb, type TestDb } from './helpers';

const ENV: NodeJS.ProcessEnv = { ...TEST_ENV, VL_LIVE_EXECUTE: 'phase-b-authorized', VL_TRIAL_ID: 'phase-b-test', VL_TRIAL_BUDGET_RUB: '300' };
const cfg = loadLiveConfig(ENV);
const NOW = () => new Date('2026-11-20T03:00:00Z');
const TODAY = workerToday(NOW());
const tmp = () => mkdtempSync(join(tmpdir(), 'vl-prep-'));

describe('Search API limiter (virtual time)', () => {
  it('spaces sequential and CONCURRENT acquisitions by ≥ 1100 ms', async () => {
    const clock = virtualClock(1_000_000);
    const l = new MinIntervalLimiter(1100, clock);
    for (let i = 0; i < 3; i++) await l.acquire();
    await Promise.all([l.acquire(), l.acquire(), l.acquire()]);
    const gaps = l.granted.slice(1).map((t, i) => t - l.granted[i]!);
    expect(l.granted).toHaveLength(6);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1100);
  });

  it('every HTTP attempt — including retries after 429 — passes the limiter; Retry-After adds on top', async () => {
    const clock = virtualClock(0);
    const sent: number[] = [];
    const t = new RecordedProviders({ search: (_q, n) => (sent.push(clock.now()), n <= 2 ? { status: 429, headers: { 'retry-after': '0' } } : undefined) });
    const limiter = new MinIntervalLimiter(1100, clock);
    const caller = new ProviderCaller({ transport: t, sleep: clock.sleep, random: () => 0, limiter, policy: { maxRetries: 3, baseDelayMs: 1 } });
    const p = new YandexSearchProvider(caller, { url: cfg.searchUrl, folderId: cfg.folderId!, authHeader: cfg.authHeader, pages: 1, groupsOnPage: 10 });
    const ctx = new CallContext('t', 1, 1_000_000);
    await p.search('Touch Stay', 'world', ctx);
    await p.search('Touch Stay pricing', 'world', ctx);
    expect(sent).toHaveLength(4); // 2 × 429, then success, then the next query
    const gaps = sent.slice(1).map((x, i) => x - sent[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1100);
  });

  it('a full live pipeline run never sends two searches less than 1100 ms apart', async () => {
    const clock = virtualClock(0);
    const web = new RecordedWeb();
    const prov = new RecordedProviders();
    const { buildLiveProviders } = await import('../live/providers');
    const b = buildLiveProviders(cfg, { providerTransport: prov, webTransport: web, resolver: web, sleep: clock.sleep, clock });
    const { runPipeline } = await import('../machine/pipeline');
    await runPipeline('2026-11-12', [], b.providers, new CallContext('t', 1, 10_000_000), { discovery: false, seeds: [SEEDS.guest!], evidenceHits: 2, hitsPerQuery: 2 });
    const g = b.searchLimiter.granted;
    expect(g.length).toBe(prov.searchCalls.length);
    expect(g.length).toBeGreaterThan(5);
    expect(Math.min(...g.slice(1).map((x, i) => x - g[i]!))).toBeGreaterThanOrEqual(1100);
  });

  it('the interval can never be configured below 1000 ms (quota 1 request/s)', () => {
    expect(() => loadLiveConfig({ ...ENV, VL_SEARCH_MIN_INTERVAL_MS: '500' })).toThrow(/VL_SEARCH_MIN_INTERVAL_MS/);
    expect(loadLiveConfig(ENV).searchMinIntervalMs).toBe(1100);
  });
});

describe('one paid gate for --probe and stage runs', () => {
  const ok: PaidFlags = { once: true, execute: true, probe: true, noDiscovery: false, maxSpendRub: 5 };
  const stage2: PaidFlags = { once: true, execute: true, probe: false, stage: 'stage2', seedsFile: 's.json', noDiscovery: true, maxSpendRub: 60 };
  const problems = (env: NodeJS.ProcessEnv, f: PaidFlags, c: typeof cfg | null = cfg) => {
    const g = paidRunGate(env, f, c);
    return g.ok ? [] : g.problems.join(' | ');
  };

  it('stage ceilings add up to the single trial ceiling: 5 + 60 + 235 = 300 ₽', () => {
    expect(STAGE_CAPS_RUB.probe + STAGE_CAPS_RUB.stage2 + STAGE_CAPS_RUB.stage3).toBe(TRIAL_BUDGET_RUB);
    expect(STAGE_CAPS_RUB).toEqual({ probe: 5, stage2: 60, stage3: 235 });
  });

  it('allowed: probe and stage 2 with everything in place', () => {
    expect(paidRunGate(ENV, ok, cfg)).toMatchObject({ ok: true, trial: { id: 'phase-b-test', budgetKop: 30_000, stage: 'probe' }, maxSpendKop: 500 });
    expect(paidRunGate(ENV, stage2, cfg)).toMatchObject({ ok: true, trial: { stage: 'stage2' }, maxSpendKop: 6_000 });
  });

  it.each([
    ['--probe without --execute', ENV, { ...ok, execute: false }, /требует --execute/],
    ['no activation flag', { ...ENV, VL_LIVE_EXECUTE: undefined }, ok, /VL_LIVE_EXECUTE/],
    ['in CI', { ...ENV, CI: 'true' }, ok, /в CI/],
    ['no trial id', { ...ENV, VL_TRIAL_ID: undefined }, ok, /VL_TRIAL_ID/],
    ['trial budget above 300 ₽', { ...ENV, VL_TRIAL_BUDGET_RUB: '301' }, ok, /VL_TRIAL_BUDGET_RUB/],
    ['no --max-spend-rub', ENV, { ...ok, maxSpendRub: undefined }, /--max-spend-rub/],
    ['probe above 5 ₽', ENV, { ...ok, maxSpendRub: 6 }, /потолка ступени probe \(5 ₽\)/],
    ['stage 2 above 60 ₽', ENV, { ...stage2, maxSpendRub: 61 }, /stage2 \(60 ₽\)/],
    ['stage 3 above 235 ₽', ENV, { ...stage2, stage: 'stage3', maxSpendRub: 240 }, /stage3 \(235 ₽\)/],
    ['stage without seeds', ENV, { ...stage2, seedsFile: undefined }, /--seeds/],
    ['stage without --no-discovery', ENV, { ...stage2, noDiscovery: false }, /--no-discovery/],
    ['artificial dating', ENV, { ...stage2, asOf: '2026-11-21' }, /--as-of запрещён/],
    ['probe + stage', ENV, { ...ok, stage: 'stage2' }, /несовместимы/],
    ['no stage at all', ENV, { ...ok, probe: false }, /укажите ступень/],
  ])('refused: %s', (_n, env, f, re) => {
    expect(problems(env as NodeJS.ProcessEnv, f as PaidFlags)).toMatch(re);
  });

  it('refused: a model without a pinned tariff, a same-family pair, missing credentials', () => {
    expect(problems(ENV, ok, loadLiveConfig({ ...ENV, VL_ANALYST_MODEL: 'yandexgpt-5.1' }))).toMatch(/не разрешена: нет закреплённого тарифа/);
    expect(problems(ENV, ok, loadLiveConfig({ ...ENV, VL_SKEPTIC_MODEL: 'qwen3.6-35b-a3b' }))).toMatch(/одного семейства/);
    expect(problems(ENV, ok, loadLiveConfig({ ...ENV, YANDEX_API_KEY: undefined }))).toMatch(/YANDEX_API_KEY/);
  });

  it('fail-closed: cfg = null is refused with AND without a cfgError', () => {
    for (const err of [undefined, 'Некорректная конфигурация live: X']) {
      const g = paidRunGate(ENV, ok, null, err);
      expect(g.ok).toBe(false);
      if (!g.ok) {
        expect(g.problems.length).toBeGreaterThan(0);
        expect(g.problems.join(' | ')).toMatch(/конфигурация live не загружена/);
      }
    }
  });

  it('Phase B forbids a same-family analyst/skeptic even with VL_ALLOW_SINGLE_MODEL=true (degraded mode is not allowed for paid runs)', () => {
    const degraded = loadLiveConfig({ ...ENV, VL_SKEPTIC_MODEL: 'qwen3.6-35b-a3b', VL_ALLOW_SINGLE_MODEL: 'true' });
    const g = paidRunGate(ENV, ok, degraded);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.problems.join(' | ')).toMatch(/VL_ALLOW_SINGLE_MODEL здесь не действует/);
    expect(paidRunGate(ENV, stage2, degraded).ok).toBe(false);
  });
});

describe('the CLI makes no paid request without permission (real process, no network)', () => {
  const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--import', 'tsx', 'server/cli/worker.ts', ...args], { env: { PATH: process.env.PATH, HOME: tmp(), ...env }, encoding: 'utf8', timeout: 60_000 });
  it('--probe without --execute, without the flag, or in CI → exit 2, «ни одного запроса не сделано»', () => {
    for (const [args, env] of [
      [['run', '--live', '--once', '--probe', '--max-spend-rub', '5'], ENV],
      [['run', '--live', '--once', '--execute', '--probe', '--max-spend-rub', '5'], { ...ENV, VL_LIVE_EXECUTE: '' }],
      [['run', '--live', '--once', '--execute', '--probe', '--max-spend-rub', '5'], { ...ENV, CI: 'true' }],
      [['run', '--live', '--once', '--execute', '--stage', 'stage2', '--max-spend-rub', '60'], ENV],
    ] as const) {
      const r = run([...args], { ...env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/ни одного запроса не сделано/);
    }
  }, 120_000);
});

describe('parallel paid execution is refused', () => {
  it('host lock file: a live holder blocks, a dead holder\'s stale file is reclaimed', () => {
    const f = join(tmp(), 'live-paid.lock');
    const release = acquireLockFile(f);
    expect(() => acquireLockFile(f)).toThrow(PaidExecutionBusy);
    release();
    writeFileSync(f, JSON.stringify({ pid: 2 ** 22 + 12345 })); // no such process
    const r2 = acquireLockFile(f);
    expect(existsSync(f)).toBe(true);
    r2();
    expect(existsSync(f)).toBe(false);
  });
});

describe('raw responses: outside git, redacted', () => {
  it('redacts keys, IAM tokens, folder ids, Authorization values, e-mails and phones', () => {
    const t = redact('Api-Key AQVNabcdefghijklmnopqrstu t1.abcdefghijklmnopqrstuvwxyz gpt://b1gtestfolder000000/qwen key=test-key-not-a-secret-000 mail a.b@example.ru tel +7 (495) 123-45-67', ['test-key-not-a-secret-000', 'b1gtestfolder000000']);
    expect(t).not.toMatch(/AQVN|t1\.abc|b1gtestfolder|test-key-not|a\.b@example|123-45-67/);
    expect(t).toMatch(/Api-Key <redacted>/);
  });

  it('refuses any directory inside the git working tree', () => {
    const root = repoRootOf()!;
    expect(() => assertOutsideRepo(join(root, 'research', 'raw'))).toThrow(/внутри репозитория/);
    expect(() => assertOutsideRepo(join(root, 'node_modules', '.cache', 'x'))).toThrow(/внутри репозитория/); // ignored ≠ allowed
    expect(() => assertOutsideRepo(tmp())).not.toThrow();
  });

  it('symlinks are resolved: a directory outside the repo that REALLY points inside it is refused', () => {
    const root = repoRootOf()!;
    const base = tmp();
    symlinkSync(join(root, 'research'), join(base, 'looks-outside'));
    expect(() => assertOutsideRepo(join(base, 'looks-outside'))).toThrow(/фактически .*research/);
    expect(() => assertOutsideRepo(join(base, 'looks-outside', 'not-yet', 'raw'))).toThrow(/внутри репозитория/); // non-existent tail
    symlinkSync(root, join(base, 'repo-link'));
    expect(() => new CapturingTransport(new RecordedProviders(), join(base, 'repo-link', 'tmp-raw'), [])).toThrow(/внутри репозитория/);
    expect(existsSync(join(root, 'tmp-raw'))).toBe(false); // refused BEFORE anything was created
  });

  it('a record is never overwritten: the same ledger id twice → the original stays, the clash is kept separately', async () => {
    const d = tmp();
    const t = new CapturingTransport(new RecordedProviders(), d, []);
    const req = { method: 'POST' as const, url: new URL('https://searchapi.api.cloud.yandex.net/v2/web/search'), address: null, headers: { 'x-client-request-id': 'trial:t1:probe#1#1' }, body: JSON.stringify({ query: { queryText: 'Touch Stay', searchType: 'SEARCH_TYPE_COM', page: '0' } }), timeoutMs: 1000, maxBytes: 1e6 };
    await t.request(req);
    const first = t.files[0]!;
    const before = readFileSync(first, 'utf8');
    await t.request(req);
    expect(readFileSync(first, 'utf8')).toBe(before);
    expect(t.clashes).toHaveLength(1);
    expect(t.files[1]).not.toBe(first);
    expect(first).toMatch(/trial_t1_probe\/attempt-1\/00001-searchapi\.api\.cloud\.yandex\.net-200\.json$/);
  });
});

describeDb('trial ledger, probe, seeds, isolation, export (recorded HTTP + PostgreSQL)', () => {
  let db: TestDb;
  const dir = tmp();
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });
  const deps = (p = new RecordedProviders(), web = new RecordedWeb()) => ({ prov: p, web, deps: { providerTransport: p, webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() } });
  const gate = (stage: TrialSpec['stage'], rub: number, budgetRub = 300, id = 'phase-b-test') => ({ trial: { id, budgetKop: budgetRub * 100, stage }, maxSpendKop: rub * 100 });
  const committed = async (trial: string) =>
    (await db.pool.query<{ s: number }>('SELECT COALESCE(SUM(COALESCE(a.used, a.reserved)), 0)::int AS s FROM mr_attempts a JOIN mr_jobs j ON j.id = a.job_id WHERE j.trial_id = $1', [trial])).rows[0]!.s;

  it('stage order: stage 2 before a successful probe is refused', async () => {
    const d = deps();
    await expect(runPaidStage(db.pool, cfg, gate('stage2', 60), d.deps, { seeds: [SEEDS.guest!], lockFile: join(dir, 'l1'), now: NOW })).rejects.toThrow(/только после успешной ступени probe/);
    expect(d.prov.requests).toHaveLength(0);
  });

  it('probe: 2 searches + transport and minimal-schema checks per model, ≤ 5 ₽, no page reads, nothing published; raw saved redacted outside git', async () => {
    const p = new RecordedProviders();
    const rawDir = join(dir, 'raw');
    const capture = new CapturingTransport(p, rawDir, [ENV.YANDEX_API_KEY, ENV.YANDEX_FOLDER_ID]);
    const web = new RecordedWeb();
    const r = await runPaidStage(db.pool, cfg, gate('probe', 5), { providerTransport: capture, webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() }, { lockFile: join(dir, 'l2'), now: NOW });
    expect(r.status).toBe('succeeded');
    expect(r.probe!.map((c) => `${c.check}:${c.ok}`)).toEqual([
      'search:ru:true', 'search:world:true',
      'transport:analyst:qwen3.6-35b-a3b:true', 'mini-schema:analyst:qwen3.6-35b-a3b:true',
      'transport:skeptic:deepseek-v4.1-flash:true', 'mini-schema:skeptic:deepseek-v4.1-flash:true',
    ]);
    expect(p.searchCalls).toHaveLength(2);
    expect(p.llmCalls).toHaveLength(4);
    expect(p.llmCalls.every((x) => (x.body as { max_tokens: number }).max_tokens <= 60)).toBe(true);
    expect(web.requests).toHaveLength(0);
    expect(r.spent!).toBeLessThanOrEqual(500);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM mr_snapshots')).rows[0].n).toBe(0);
    const job = (await db.pool.query("SELECT job_key, as_of::text, trial_stage, status FROM mr_jobs WHERE trial_stage = 'probe'")).rows[0];
    expect(job).toEqual({ job_key: 'trial:phase-b-test:probe', as_of: TODAY, trial_stage: 'probe', status: 'succeeded' });
    // raw capture: <raw>/trial_phase-b-test_probe/attempt-1/<seq>-<host>-<status>.json
    const files = capture.files;
    expect(files).toHaveLength(6);
    expect(readdirSync(join(rawDir, 'trial_phase-b-test_probe', 'attempt-1'))).toHaveLength(6);
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      expect(t).not.toContain(ENV.YANDEX_API_KEY!);
      expect(t).not.toContain(ENV.YANDEX_FOLDER_ID!);
      expect(statSync(f).mode & 0o077).toBe(0);
      expect(JSON.parse(t)).toMatchObject({ jobKey: 'trial:phase-b-test:probe', attempt: 1 });
    }
    expect(readFileSync(files[0]!, 'utf8')).toMatch(/decodedRawData.*yandexsearch/s);
  });

  it('stage 2 with seeds: NO discovery at all (no discovery search, no discovery model call), real date, no snapshot', async () => {
    const d = deps();
    const r = await runPaidStage(db.pool, cfg, gate('stage2', 60), d.deps, { seeds: [SEEDS.guest!], lockFile: join(dir, 'l3'), now: NOW });
    expect(r.status).toBe('succeeded');
    expect(r.message).toMatch(/В живой TOP-10 не публикуется/);
    expect(d.prov.llmCalls.some((x) => x.task === 'discover_seeds')).toBe(false);
    expect(d.prov.searchCalls.some((x) => /saas|product hunt/i.test(JSON.stringify(x.body)))).toBe(false);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM mr_searches WHERE agent = 'discovery'")).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM mr_snapshots')).rows[0].n).toBe(0);
    const jobs = (await db.pool.query("SELECT job_key, as_of::text FROM mr_jobs WHERE trial_id = 'phase-b-test' ORDER BY id")).rows;
    expect(jobs).toEqual([{ job_key: 'trial:phase-b-test:probe', as_of: TODAY }, { job_key: 'trial:phase-b-test:stage2', as_of: TODAY }]); // same real day, distinct stages
    expect(await committed('phase-b-test')).toBeLessThanOrEqual(6_500);
  });

  it('stage 3 the same day, then the cumulative ledger: total ≤ 300 ₽; a repeat of a finished stage costs nothing', async () => {
    const d = deps();
    const r = await runPaidStage(db.pool, cfg, gate('stage3', 235), d.deps, { seeds: [SEEDS.vag!, SEEDS.quotes!], lockFile: join(dir, 'l4'), now: NOW });
    expect(r.status).toBe('succeeded');
    expect(await committed('phase-b-test')).toBeLessThanOrEqual(30_000);
    const again = deps();
    expect((await runPaidStage(db.pool, cfg, gate('stage3', 235), again.deps, { seeds: [SEEDS.vag!], lockFile: join(dir, 'l5'), now: NOW })).status).toBe('already-succeeded');
    expect(again.prov.requests).toHaveLength(0);
  });

  it('the CUMULATIVE trial ceiling binds even when stage ceilings would allow more (adversarial: 10 ₽ trial)', async () => {
    await runPaidStage(db.pool, cfg, gate('probe', 5, 10, 'tiny-trial'), deps().deps, { lockFile: join(dir, 'l6'), now: NOW });
    const before = await committed('tiny-trial');
    expect(before).toBeGreaterThan(0);
    const r = await runPaidStage(db.pool, cfg, gate('stage2', 60, 10, 'tiny-trial'), deps().deps, { seeds: [SEEDS.guest!], lockFile: join(dir, 'l7'), now: NOW });
    expect(r.status).toBe('partial');
    expect(r.message).toMatch(/испытания/);
    expect(await committed('tiny-trial')).toBeLessThanOrEqual(1_000);
    const att = (await db.pool.query("SELECT j.trial_stage, a.reserved, a.used FROM mr_attempts a JOIN mr_jobs j ON j.id = a.job_id WHERE j.trial_id = 'tiny-trial' ORDER BY a.job_id")).rows;
    expect(att.every((a) => a.used <= a.reserved)).toBe(true);
    // stage 2 could only ever reserve what the probe left of the 10 ₽ trial (not its own 60 ₽ ceiling)
    expect(att[1].reserved).toBeLessThanOrEqual(1_000 - att[0].used);
  });

  it('the trial budget is immutable: a stage with another budget for the same trial is refused before any request', async () => {
    const d = deps();
    await expect(runPaidStage(db.pool, cfg, gate('stage3', 235, 299, 'tiny-trial'), d.deps, { seeds: [SEEDS.vag!], lockFile: join(dir, 'l8'), now: NOW })).rejects.toThrow(/неизменяем/);
    expect(d.prov.requests).toHaveLength(0);
    await expect(db.pool.query("UPDATE mr_trials SET budget_limit = 999999 WHERE trial_id = 'tiny-trial'")).rejects.toThrow();
  });

  it('isolation: the DB refuses a snapshot for a trial job; a live run cannot be dated in the future', async () => {
    const j = (await db.pool.query("SELECT id, as_of FROM mr_jobs WHERE job_key = 'trial:phase-b-test:stage2'")).rows[0];
    await expect(db.pool.query("INSERT INTO mr_snapshots (job_id, feed, as_of, eligible_count, hold_count) VALUES ($1, 'live', $2, 0, 0)", [j.id, j.as_of])).rejects.toThrow(/trial job never publishes/);
    const d = deps();
    await expect(runWorkerJob(db.pool, { feed: 'live', asOf: '2026-11-21', providers: () => ({}) as never, now: NOW })).rejects.toThrow(/в будущем/);
    expect(d.prov.requests).toHaveLength(0);
  });

  it('parallel paid execution against the same database is refused (advisory lock), even with different lock files', async () => {
    let release!: () => void;
    const held = withPaidExecutionLock(db.pool, join(dir, 'p1'), () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    await expect(withPaidExecutionLock(db.pool, join(dir, 'p2'), async () => 'second')).rejects.toThrow(PaidExecutionBusy);
    release();
    await held;
    expect(await withPaidExecutionLock(db.pool, join(dir, 'p2'), async () => 'after')).toBe('after');
  });

  it('CSV export carries sources, quotes, competitor classes, market status and uncertainty for an independent review', async () => {
    const { csv, rows } = await exportReviewCsv(db.pool, { trialId: 'phase-b-test' });
    expect(rows).toBeGreaterThan(20);
    const header = csv.split('\n')[0]!;
    expect(header).toMatch(/^kind,job_key,trial_stage,candidate_id,item,url,source_keys,quote,machine_label,machine_status,market,market_status,signals,uncertainty,source_type,provenance,machine_reason,reviewer_/);
    expect(csv).toMatch(/^competitor,trial:phase-b-test:stage2,stage2,str-guest-guide,GuestCom,https:\/\/gcom\.host\/,s\d+,"?guest-guide: «/m);
    expect(csv).toMatch(/competitor,[^\n]*RYNTO[^\n]*,unknown,/);
    expect(csv).toMatch(/^claim,[^\n]*w-pay[^\n]*\$9 per month per guidebook/m);
    expect(csv).toMatch(/^source,[^\n]*str-review\.example\.org[^\n]*verified: независимая публикация/m);
    expect(csv).toMatch(/^assessment,[^\n]*RESEARCH_HOLD/m);
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('seeds files of the plan are valid (1 + 4 candidates, unique ids)', () => {
    const root = repoRootOf()!;
    expect(parseSeeds(JSON.parse(readFileSync(join(root, 'research/phase-b/seeds-stage2.json'), 'utf8')))).toHaveLength(1);
    expect(parseSeeds(JSON.parse(readFileSync(join(root, 'research/phase-b/seeds-stage3.json'), 'utf8')))).toHaveLength(4);
    expect(() => parseSeeds([SEEDS.guest, SEEDS.guest])).toThrow(/повторяющиеся/);
  });
});

describeDb('audit P1: a failed probe blocks stage 2; raw records survive every stage', () => {
  let db: TestDb;
  const dir = tmp();
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });
  const mk = (hooks: ConstructorParameters<typeof RecordedProviders>[0] = {}) => {
    const prov = new RecordedProviders(hooks);
    const web = new RecordedWeb();
    return { prov, web, deps: { providerTransport: prov, webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() } };
  };
  const gate = (id: string, stage: TrialSpec['stage'], rub: number) => ({ trial: { id, budgetKop: 30_000, stage }, maxSpendKop: rub * 100 });
  const usage = async (jobKey: string) =>
    (await db.pool.query<{ n: number; s: number }>('SELECT count(*)::int AS n, COALESCE(sum(u.cost), 0)::int AS s FROM mr_usage u JOIN mr_jobs j ON j.id = u.job_id WHERE j.job_key = $1', [jobKey])).rows[0]!;

  it('bad XML in the probe (0 documents) → probe FAILED with its real costs in the ledger; stage 2 is refused and sends nothing', async () => {
    const empty = mk({ search: (q) => (q.type === 'SEARCH_TYPE_RU' ? { results: [] } : undefined) }); // XML with no <doc>
    const r = await runPaidStage(db.pool, cfg, gate('bad-xml', 'probe', 5), empty.deps, { lockFile: join(dir, 'a'), now: NOW });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/проба не пройдена: search:ru/);
    expect(r.probe!.find((c) => c.check === 'search:ru')!.ok).toBe(false);
    const job = (await db.pool.query("SELECT status, attempts, error FROM mr_jobs WHERE job_key = 'trial:bad-xml:probe'")).rows[0];
    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    const u = await usage('trial:bad-xml:probe');
    expect(u.n).toBe(empty.prov.requests.length); // every real call is in the ledger
    expect(u.s).toBeGreaterThan(0);
    const att = (await db.pool.query("SELECT a.status, a.used FROM mr_attempts a JOIN mr_jobs j ON j.id = a.job_id WHERE j.job_key = 'trial:bad-xml:probe'")).rows[0];
    expect(att).toEqual({ status: 'failed', used: u.s });
    // stage 2 is blocked — before any provider request
    const s2 = mk();
    await expect(runPaidStage(db.pool, cfg, gate('bad-xml', 'stage2', 60), s2.deps, { seeds: [SEEDS.guest!], lockFile: join(dir, 'b'), now: NOW })).rejects.toThrow(/только после успешной ступени probe \(сейчас: failed\)/);
    expect(s2.prov.requests).toHaveLength(0);
    expect(s2.web.requests).toHaveLength(0);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM mr_jobs WHERE job_key = 'trial:bad-xml:stage2'")).rows[0].n).toBe(0);
  });

  it('invalid model JSON in the probe → FAILED; no implicit re-run; an explicit --retry is a NEW attempt in the same 5 ₽ budget, costs kept', async () => {
    const bad = mk({ llm: (task) => (task === 'probe_schema' ? { content: '{"ok": tru' } : undefined) });
    const r1 = await runPaidStage(db.pool, cfg, gate('bad-json', 'probe', 5), bad.deps, { lockFile: join(dir, 'c'), now: NOW });
    expect(r1.status).toBe('failed');
    expect(r1.probe!.filter((c) => !c.ok).map((c) => c.check)).toEqual(['mini-schema:analyst:qwen3.6-35b-a3b', 'mini-schema:skeptic:deepseek-v4.1-flash']);
    const spentFirst = (await usage('trial:bad-json:probe')).s;
    expect(spentFirst).toBeGreaterThan(0);
    // stage 2 blocked
    const s2 = mk();
    await expect(runPaidStage(db.pool, cfg, gate('bad-json', 'stage2', 60), s2.deps, { seeds: [SEEDS.guest!], lockFile: join(dir, 'd'), now: NOW })).rejects.toThrow(/сейчас: failed/);
    expect(s2.prov.requests).toHaveLength(0);
    // re-running the probe WITHOUT --retry is refused, nothing sent
    const again = mk();
    await expect(runPaidStage(db.pool, cfg, gate('bad-json', 'probe', 5), again.deps, { lockFile: join(dir, 'e'), now: NOW })).rejects.toThrow(/повтор — только явно с --retry/);
    expect(again.prov.requests).toHaveLength(0);
    // explicit retry with healthy providers: attempt 2, first attempt's costs stay
    const good = mk();
    const r2 = await runPaidStage(db.pool, cfg, gate('bad-json', 'probe', 5), good.deps, { lockFile: join(dir, 'f'), now: NOW, retry: true });
    expect(r2).toMatchObject({ status: 'succeeded', attempt: 2 });
    const atts = (await db.pool.query("SELECT a.attempt, a.status, a.used FROM mr_attempts a JOIN mr_jobs j ON j.id = a.job_id WHERE j.job_key = 'trial:bad-json:probe' ORDER BY attempt")).rows;
    expect(atts.map((a) => a.status)).toEqual(['failed', 'succeeded']);
    expect(atts[0].used).toBe(spentFirst);
    expect(atts[0].used + atts[1].used).toBeLessThanOrEqual(500); // one 5 ₽ stage budget across attempts
    // now stage 2 is allowed
    const ok2 = mk();
    expect((await runPaidStage(db.pool, cfg, gate('bad-json', 'stage2', 60), ok2.deps, { seeds: [SEEDS.guest!], lockFile: join(dir, 'g'), now: NOW })).status).toBe('succeeded');
    // --retry on a succeeded stage is refused
    await expect(runPaidStage(db.pool, cfg, gate('bad-json', 'probe', 5), mk().deps, { lockFile: join(dir, 'h'), now: NOW, retry: true })).rejects.toThrow(/повторять нечего/);
  });

  it('raw records of probe, stage 2 and stage 3 (same hosts, HTTP 200) all survive; earlier files are byte-identical afterwards', async () => {
    const raw = join(tmp(), 'raw'); // the SAME directory for all stages, as defaultRawDir() gives
    const hashes = new Map<string, string>();
    const snapshot = () => {
      for (const [f, h] of hashes) expect(createHash('sha256').update(readFileSync(f)).digest('hex'), f).toBe(h);
    };
    let total = 0;
    const stages: [TrialSpec['stage'], number, DiscoverySeed[] | undefined][] = [['probe', 5, undefined], ['stage2', 60, [SEEDS.guest!]], ['stage3', 235, [SEEDS.quotes!]]];
    for (const [stage, rub, seeds] of stages) {
      const prov = new RecordedProviders();
      const web = new RecordedWeb();
      const cap = new CapturingTransport(prov, raw, [ENV.YANDEX_API_KEY]); // a fresh transport per stage = a fresh CLI process
      const r = await runPaidStage(db.pool, cfg, gate('raw-keep', stage, rub), { providerTransport: cap, webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() }, { seeds, lockFile: join(dir, `r-${stage}`), now: NOW });
      expect(r.status).toBe('succeeded');
      expect(cap.files).toHaveLength(prov.requests.length);
      expect(cap.clashes).toHaveLength(0);
      snapshot(); // nothing written earlier changed
      for (const f of cap.files) {
        expect(hashes.has(f)).toBe(false); // never the same path as an earlier record
        hashes.set(f, createHash('sha256').update(readFileSync(f)).digest('hex'));
        expect(JSON.parse(readFileSync(f, 'utf8')).jobKey).toBe(`trial:raw-keep:${stage}`);
      }
      total += prov.requests.length;
    }
    expect(hashes.size).toBe(total);
    expect(readdirSync(raw).sort()).toEqual(['trial_raw-keep_probe', 'trial_raw-keep_stage2', 'trial_raw-keep_stage3']);
    // every record links to exactly one usage row (same ledger id)
    const ids = (await db.pool.query<{ request_id: string }>("SELECT u.request_id FROM mr_usage u JOIN mr_jobs j ON j.id = u.job_id WHERE j.trial_id = 'raw-keep' AND u.operation <> 'read'")).rows.map((x) => x.request_id).sort();
    const recIds = [...hashes.keys()].map((f) => JSON.parse(readFileSync(f, 'utf8')).ledgerId as string).sort();
    expect(recIds).toEqual(ids);
  });
});
