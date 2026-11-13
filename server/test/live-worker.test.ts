// @vitest-environment node
/**
 * VL-004B Case G — the live worker end-to-end on recorded HTTP and an isolated test database:
 * one published live snapshot, reconciled usage ledger (estimated vs observed), budget exhaustion,
 * timeouts/late responses, lease takeover without double charging, rotation with carried-forward
 * assessments, run diagnostics, and no leak between the fixture and live feeds.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadLiveConfig } from '../live/config';
import { RecordedProviders, RecordedWeb, TEST_ENV, virtualClock } from '../live/recordings/mock';
import { liveRunOptions } from '../live/run';
import { machineOverview, machineCandidate, runDiagnostics } from '../machine/read';
import { runWorkerJob } from '../machine/worker';
import { createTestDb, describeDb, type TestDb } from './helpers';

const cfg = loadLiveConfig(TEST_ENV);
/** Fixed «today» after every as_of used here (live runs may not be dated in the future). */
const NOW = () => new Date('2026-11-20T03:00:00Z');
const deps = (hooks: ConstructorParameters<typeof RecordedProviders>[0] = {}, webOver: ConstructorParameters<typeof RecordedWeb>[0] = {}) => {
  const web = new RecordedWeb(webOver);
  const prov = new RecordedProviders(hooks);
  return { web, prov, deps: { providerTransport: prov, webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() } };
};

describeDb('VL-004B live worker on recorded HTTP (Case G)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('a live run publishes exactly one LIVE snapshot; fixture feed untouched; usage is reconciled in the ledger', async () => {
    const d = deps();
    const r = await runWorkerJob(db.pool, liveRunOptions(cfg, d.deps, { asOf: '2026-11-12', budgetKop: 20_000, now: NOW }));
    expect(r.status).toBe('succeeded');
    expect(r.snapshot!.entries.map((e) => e.externalId).sort()).toEqual(['meeting-notes-ai', 'vag-autoscan-report']);
    const snaps = (await db.pool.query('SELECT feed, count(*)::int AS n FROM mr_snapshots GROUP BY feed')).rows;
    expect(snaps).toEqual([{ feed: 'live', n: 1 }]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM mr_candidates WHERE feed = 'fixture'")).rows[0].n).toBe(0);
    const job = (await db.pool.query("SELECT independence, spent, budget_limit FROM mr_jobs WHERE feed = 'live'")).rows[0];
    expect(job.independence).toBe('independent');
    const usage = (await db.pool.query("SELECT reconciliation, count(*)::int AS n, sum(cost)::int AS cost, sum(estimated_cost)::int AS est FROM mr_usage WHERE feed = 'live' GROUP BY reconciliation ORDER BY 1")).rows;
    expect(usage.map((u) => u.reconciliation)).toEqual(['reconciled', 'tariff']);
    const total = usage.reduce((a, u) => a + u.cost, 0);
    expect(total).toBe(job.spent);
    expect(total).toBeLessThan(usage.reduce((a, u) => a + u.est, 0)); // observed < reserved worst case
    expect((await db.pool.query("SELECT count(*)::int AS n FROM mr_usage WHERE feed = 'live' AND provider_request_id IS NOT NULL AND operation <> 'read'")).rows[0].n).toBe(d.prov.requests.length);
  });

  it('stored provenance: grounded offers, uncertain fields, fetch metadata, quote locations', async () => {
    const det = (await machineCandidate(db.pool, 'live', 'str-guest-guide'))!;
    const rynto = det.sources.find((s) => s.url === 'https://rynto.io/ru/guest-portal')!;
    expect(rynto.fetchedAt).toMatch(/^2\d{3}-/);
    expect(rynto.offerUncertain!.join(' ')).toMatch(/рынок не подтверждён/);
    expect(det.competitors.filter((c) => c.market === 'ru' && c.kind === 'direct' && c.marketVerified)).toHaveLength(2);
    expect(det.competitors.find((c) => c.name === 'RYNTO')!.marketVerified).toBe(false);
    const mv = (await db.pool.query("SELECT name, market_verified FROM mr_competitors WHERE feed = 'live' AND name IN ('RYNTO', 'GuestCom') ORDER BY name LIMIT 2")).rows;
    expect(mv).toEqual([{ name: 'GuestCom', market_verified: true }, { name: 'RYNTO', market_verified: false }]);
    const off = (await db.pool.query("SELECT offer, extraction_model FROM mr_sources WHERE url = 'https://new.realtycalendar.ru/products/autopilot' LIMIT 1")).rows[0];
    expect(off.extraction_model).toBe('qwen3.6-35b-a3b');
    expect(off.offer.grounding.jobEvidence['guest-guide']).toMatch(/цифровой гид гостя/);
    const loc = (await db.pool.query("SELECT quote_locations FROM mr_claims WHERE claim_key = 'w-pay' AND feed = 'live' LIMIT 1")).rows[0].quote_locations;
    expect(loc[0]).toMatchObject({ sourceKey: expect.any(String), offset: expect.any(Number) });
    const robots = (await db.pool.query("SELECT fetch_status, excerpt, failure FROM mr_sources WHERE url = 'https://callpilot.example.com/' LIMIT 1")).rows[0];
    expect(robots).toMatchObject({ fetch_status: 'robots_disallowed', excerpt: null });
  });

  it('run diagnostics: searches by region, pages, validated RU rivals, contradictions, cost estimated vs charged', async () => {
    const o = await machineOverview(db.pool, 'live', new Date('2026-11-12T05:00:00Z'));
    const g = o.diagnostics!;
    expect(g.independence).toBe('independent');
    expect(g.searches.ru).toBeGreaterThan(10);
    expect(g.searches.world).toBeGreaterThan(5);
    expect(g.pages.ok).toBeGreaterThan(10);
    expect(g.pages.byStatus.robots_disallowed).toBe(2);
    expect(g.competitors.ruDirect).toBe(4); // RealtyCalendar + GuestCom, ВНИКЛИ + Vortholm (market proven)
    expect(g.competitors.ruAdjacent).toBe(0);
    expect(g.competitors.marketUnverified).toBe(2); // RYNTO, VAGLOGS: shown, not counted
    expect(g.contradictions).toBe(2);
    expect(g.cost.charged).toBeLessThan(g.cost.estimated);
    expect(g.cost.unknownCalls).toBe(0);
    expect(o.costs.priceVersion).toBe('yandex-2026-11-12');
  });

  it('a re-run of the same day is idempotent (no new calls, no double charge)', async () => {
    const d = deps();
    const r = await runWorkerJob(db.pool, liveRunOptions(cfg, d.deps, { asOf: '2026-11-12', budgetKop: 20_000, now: NOW }));
    expect(r.status).toBe('already-succeeded');
    expect(d.prov.requests).toHaveLength(0);
  });

  it('rotation: the next day re-researches only the oldest incumbents and carries recent PASSED ones forward (with their date)', async () => {
    const d = deps();
    const c2 = loadLiveConfig({ ...TEST_ENV, VL_LIVE_MAX_NEW: '0', VL_LIVE_MAX_RECHECKS: '2', VL_LIVE_CARRY_DAYS: '7' });
    const r = await runWorkerJob(db.pool, liveRunOptions(c2, d.deps, { asOf: '2026-11-13', budgetKop: 20_000, now: NOW }));
    expect(r.status).toBe('succeeded');
    const researched = (await db.pool.query("SELECT c.external_id FROM mr_assessments a JOIN mr_candidates c ON c.id = a.candidate_id JOIN mr_jobs j ON j.id = a.job_id WHERE j.as_of = '2026-11-13' AND a.feed = 'live' ORDER BY 1")).rows.map((x) => x.external_id);
    expect(researched).toEqual(['str-guest-guide', 'vag-autoscan-report']); // first two by registry order (all assessed 11-12)
    // a re-researched incumbent keeps its discovery context (RU synonyms, source URL): same evidence → same score
    const scores = (await db.pool.query("SELECT j.as_of::text AS d, a.market_score FROM mr_assessments a JOIN mr_candidates c ON c.id = a.candidate_id JOIN mr_jobs j ON j.id = a.job_id WHERE c.external_id = 'vag-autoscan-report' AND a.feed = 'live' ORDER BY 1")).rows;
    expect(scores[0].market_score).toBe(scores[1].market_score);
    expect((await db.pool.query("SELECT ru_keywords, source_url FROM mr_candidates WHERE external_id = 'vag-autoscan-report'")).rows[0]).toEqual({ ru_keywords: ['расшифровка автоскан vcds', 'анализ логов vcds'], source_url: 'https://www.ross-tech.com/vcds/tour/autoscan.php' });
    const carried = r.snapshot!.entries.filter((e) => e.carriedFrom);
    expect(carried.map((e) => [e.externalId, e.carriedFrom])).toEqual([['meeting-notes-ai', '2026-11-12']]);
    const o = await machineOverview(db.pool, 'live', new Date('2026-11-13T05:00:00Z'));
    expect(o.snapshot!.entries.find((e) => e.externalId === 'meeting-notes-ai')).toMatchObject({ carried: true, assessedAsOf: '2026-11-12' });
    expect(o.diagnostics!.carried).toBe(1);
  });

  it('the DB refuses a carried entry from the same day or older than 30 days', async () => {
    const e = (await db.pool.query("SELECT e.* FROM mr_snapshot_entries e JOIN mr_snapshots s ON s.id = e.snapshot_id WHERE s.as_of = '2026-11-13' AND e.assessment_job_id IS NOT NULL")).rows[0];
    const s12 = (await db.pool.query("SELECT id, job_id FROM mr_snapshots WHERE feed = 'live' AND as_of = '2026-11-12'")).rows[0];
    // carry an assessment from the SAME job as the snapshot → refused (must be another, older job)
    await expect(
      db.pool.query(
        `INSERT INTO mr_snapshot_entries (snapshot_id, job_id, feed, rank, candidate_id, assessment_id, title, market_score, confidence, evidence_grade, assessment_job_id)
         VALUES ($1,$2,'live',9,$3,$4,$5,$6,$7,$8,$9)`,
        [s12.id, s12.job_id, e.candidate_id, e.assessment_id, e.title, e.market_score, e.confidence, e.evidence_grade, e.assessment_job_id],
      ),
    ).rejects.toThrow(/older than the snapshot|carry|violates/);
    // frozen values must still equal the assessment
    const s13 = (await db.pool.query("SELECT id, job_id FROM mr_snapshots WHERE feed = 'live' AND as_of = '2026-11-13'")).rows[0];
    await expect(
      db.pool.query(
        `INSERT INTO mr_snapshot_entries (snapshot_id, job_id, feed, rank, candidate_id, assessment_id, title, market_score, confidence, evidence_grade, assessment_job_id)
         VALUES ($1,$2,'live',9,$3,$4,$5,$6,$7,$8,$9)`,
        [s13.id, s13.job_id, e.candidate_id, e.assessment_id, e.title, e.market_score + 30, e.confidence, e.evidence_grade, e.assessment_job_id],
      ),
    ).rejects.toThrow(/foreign key|unique|duplicate/);
  });

  it('budget exhaustion: the run stops «partial», nothing is published, the ledger never exceeds the cap', async () => {
    const d = deps();
    const r = await runWorkerJob(db.pool, liveRunOptions(cfg, d.deps, { asOf: '2026-11-14', budgetKop: 600, now: NOW }));
    expect(r.status).toBe('partial');
    expect((await db.pool.query("SELECT count(*)::int AS n FROM mr_snapshots WHERE feed = 'live' AND as_of = '2026-11-14'")).rows[0].n).toBe(0);
    const att = (await db.pool.query("SELECT a.reserved, a.used FROM mr_attempts a JOIN mr_jobs j ON j.id = a.job_id WHERE j.as_of = '2026-11-14' AND j.feed = 'live'")).rows[0];
    expect(att.used).toBeLessThanOrEqual(600);
    expect(att.used).toBeLessThanOrEqual(att.reserved);
    const o = await machineOverview(db.pool, 'live', new Date('2026-11-14T05:00:00Z'));
    expect(o.snapshot!.asOf).toBe('2026-11-13'); // previous TOP stays published
    expect(o.diagnostics!.partialReason).toMatch(/бюджет/);
  });

  it('timeouts: an LLM call with no response keeps its worst-case cost («unknown»), and the run still completes honestly', async () => {
    const t = await createTestDb();
    try {
      let n = 0;
      const d = deps({ llm: (task) => (task === 'extract_offer' && ++n === 2 ? { timeout: true } : undefined) });
      const r = await runWorkerJob(t.pool, liveRunOptions(cfg, d.deps, { asOf: '2026-11-12', budgetKop: 20_000, now: NOW }));
      expect(r.status).toBe('succeeded');
      const u = (await t.pool.query("SELECT cost, estimated_cost, actual_cost FROM mr_usage WHERE reconciliation = 'unknown'")).rows;
      expect(u).toHaveLength(1);
      expect(u[0].cost).toBe(u[0].estimated_cost);
      expect(u[0].actual_cost).toBeNull();
      expect((await runDiagnostics(t.pool, r.jobId))!.cost.unknownCalls).toBe(1);
    } finally {
      await t.drop();
    }
  });

  it('a billing anomaly (usage above the bound) stops paid calls and fails the attempt; nothing is published', async () => {
    const t = await createTestDb();
    try {
      const d = deps({ llm: (task) => (task === 'discover_seeds' ? undefined : task === 'extract_offer' ? { usage: { prompt_tokens: 50_000_000, completion_tokens: 1 } } : undefined) });
      const r = await runWorkerJob(t.pool, liveRunOptions(cfg, d.deps, { asOf: '2026-11-12', budgetKop: 20_000, now: NOW }));
      expect(r.status).toBe('failed');
      expect(r.message).toMatch(/превысила верхнюю оценку/);
      expect((await t.pool.query('SELECT count(*)::int AS n FROM mr_snapshots')).rows[0].n).toBe(0);
      expect((await t.pool.query("SELECT count(*)::int AS n FROM mr_usage WHERE reconciliation = 'anomaly_over_estimate'")).rows[0].n).toBe(1);
    } finally {
      await t.drop();
    }
  });

  it('auth failure (401) is not retried and fails the run without publishing', async () => {
    const t = await createTestDb();
    try {
      const d = deps({ search: () => ({ status: 401, headers: { 'x-request-id': 'yandex-401' } }) }); // Yandex itself answered
      const r = await runWorkerJob(t.pool, liveRunOptions(cfg, d.deps, { asOf: '2026-11-12', budgetKop: 20_000, now: NOW }));
      expect(r.status).toBe('failed');
      expect(r.message).toMatch(/доступ отклонён/);
      expect(d.prov.searchCalls).toHaveLength(1);
      expect((await t.pool.query("SELECT reconciliation, cost FROM mr_usage")).rows).toEqual([{ reconciliation: 'not_billed', cost: 0 }]);
    } finally {
      await t.drop();
    }
  });

  it('late response after lease takeover: only the owner publishes; both attempts are in the ledger once', async () => {
    const t = await createTestDb();
    try {
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      let entered!: () => void;
      const inside = new Promise<void>((res) => (entered = res));
      let first = true;
      const slow = deps({ llm: () => undefined });
      const orig = slow.prov.request.bind(slow.prov);
      slow.prov.request = async (req) => {
        if (first && req.url.hostname === 'ai.api.cloud.yandex.net') {
          first = false;
          entered();
          await gate; // the «late» response
        }
        return orig(req);
      };
      const a = runWorkerJob(t.pool, liveRunOptions(cfg, slow.deps, { asOf: '2026-11-12', budgetKop: 20_000, now: NOW }));
      await inside;
      await t.pool.query("UPDATE mr_jobs SET lease_until = now() - interval '1 minute' WHERE feed = 'live'");
      const b = await runWorkerJob(t.pool, liveRunOptions(cfg, deps().deps, { asOf: '2026-11-12', budgetKop: 20_000, now: NOW }));
      expect(b).toMatchObject({ status: 'succeeded', attempt: 2 });
      release();
      const ra = await a;
      expect(['failed', 'partial']).toContain(ra.status);
      const atts = (await t.pool.query('SELECT attempt, status, reserved, used FROM mr_attempts ORDER BY attempt')).rows;
      expect(atts.map((x) => x.status)).toEqual(['superseded', 'succeeded']);
      expect(atts.every((x) => x.used !== null && x.used <= x.reserved)).toBe(true);
      expect((await t.pool.query('SELECT count(*)::int AS n FROM mr_snapshots')).rows[0].n).toBe(1);
      const dup = (await t.pool.query('SELECT request_id, count(*)::int AS n FROM mr_usage GROUP BY request_id HAVING count(*) > 1')).rows;
      expect(dup).toEqual([]);
      const job = (await t.pool.query('SELECT spent FROM mr_jobs')).rows[0];
      expect(job.spent).toBe(atts[0].used + atts[1].used);
    } finally {
      await t.drop();
    }
  });

  it('audit P1: an unproven-market «direct» rival and an unverified «independent» page do not change the published TOP; both are stored as such', async () => {
    const t = await createTestDb();
    try {
      const RIVAL = 'https://autoscanreader.example.com/';
      const d = deps(
        {
          search: (q) => (q.type === 'SEARCH_TYPE_RU' && /автоскан/i.test(q.text) ? { appendResults: [{ url: RIVAL, title: 'AutoScan Reader', passage: 'Auto-Scan' }] } : undefined),
          llm: (task, data) =>
            task === 'extract_offer' && (data.page as { url: string }).url === RIVAL
              ? { content: JSON.stringify({ isProductPage: true, name: 'AutoScan Reader', market: 'ru', jobs: [{ job: 'vag-autoscan-dtc-report', quote: 'turns a VCDS Auto-Scan into a plain report' }], price: null, pageKind: 'vendor' }) }
              : task === 'extract_offer' && (data.page as { url: string }).url === 'https://forum.tdi.example.org/autoscan-help'
                ? { content: JSON.stringify({ isProductPage: false, name: null, market: 'west', jobs: [], price: null, pageKind: 'independent' }) } // forum page without publication markup
                : undefined,
        },
        { dns: { 'autoscanreader.example.com': ['151.101.99.1'] }, pages: { [RIVAL]: { status: 200, body: '<html lang="en"><body><p>AutoScan Reader turns a VCDS Auto-Scan into a plain report for car owners everywhere.</p></body></html>' } } },
      );
      const r = await runWorkerJob(t.pool, liveRunOptions(cfg, d.deps, { asOf: '2026-11-12', budgetKop: 20_000, now: NOW }));
      expect(r.status).toBe('succeeded');
      const top = (pool: TestDb['pool']) => pool.query("SELECT e.rank, e.title, e.market_score, e.confidence, e.evidence_grade FROM mr_snapshot_entries e JOIN mr_snapshots s ON s.id = e.snapshot_id WHERE s.feed = 'live' AND s.as_of = '2026-11-12' ORDER BY e.rank").then((x) => x.rows);
      expect(await top(t.pool)).toEqual(await top(db.pool));
      const rival = (await t.pool.query("SELECT market, kind, market_verified FROM mr_competitors WHERE name = 'AutoScan Reader'")).rows[0];
      // audit 13.11.2026 (P2): the model's «ru» is not kept as a label on an English page with no RU signal; still a possible direct rival
      expect(rival).toEqual({ market: 'west', kind: 'direct', market_verified: false });
      const forum = (await t.pool.query("SELECT source_type, provenance FROM mr_sources WHERE url = 'https://forum.tdi.example.org/autoscan-help' LIMIT 1")).rows[0];
      expect(forum.source_type).toBe('unknown');
      expect(forum.provenance.independence).toBe('unverified');
      const g = (await runDiagnostics(t.pool, r.jobId))!;
      expect(g.competitors.marketUnverified).toBe(3); // RYNTO, VAGLOGS, AutoScan Reader
      expect(g.independenceUnverified).toBe(1);
    } finally {
      await t.drop();
    }
  });

  it('the usage ledger refuses a row that under-counts a call whose cost was not observed', async () => {
    const j = (await db.pool.query("SELECT a.job_id, a.attempt FROM mr_attempts a JOIN mr_jobs j ON j.id = a.job_id WHERE j.feed = 'live' LIMIT 1")).rows[0];
    await expect(
      db.pool.query(
        `INSERT INTO mr_usage (job_id, feed, attempt, provider, operation, model, request_id, cost, price_version, estimated_cost, actual_cost, reconciliation)
         VALUES ($1, 'live', $2, 'x', 'llm', null, 'forged-1', 1, 'v', 500, null, 'unknown')`,
        [j.job_id, j.attempt],
      ),
    ).rejects.toThrow(/mr_usage_cost_bound/);
  });
});
