// @vitest-environment node
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../api/app';
import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { applyImport } from '../research/importer';
import { createSnapshot } from '../research/snapshot';
import { ACTOR, createTestDb, describeDb, exampleFile, type TestDb } from './helpers';

const TODAY = '2026-11-12';
const ORIGIN = 'http://localhost:5173';

describe('server config (local-only)', () => {
  it('refuses to bind the API to a non-loopback host', () => {
    expect(() => loadConfig({ API_HOST: '0.0.0.0' })).toThrow(/local-only/);
    expect(loadConfig({}).host).toBe('127.0.0.1');
  });
});

describe('API with the database down', () => {
  it('answers 503 with a safe message (no stack trace)', async () => {
    const pool = createPool('postgres://nobody:nothing@127.0.0.1:1/none');
    const app = await buildApp({ pool, today: () => TODAY });
    const res = await app.inject({ method: 'GET', url: '/api/overview' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: 'db_unavailable', message: expect.stringMatching(/недоступна/) } });
    expect(res.body).not.toMatch(/at .*\.ts/);
    await app.close();
    await pool.end();
  });
});

describeDb('local read API (integration)', () => {
  let db: TestDb;
  let app: FastifyInstance;
  const get = async (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

  beforeAll(async () => {
    db = await createTestDb();
    app = await buildApp({ pool: db.pool, allowedOrigins: [ORIGIN], today: () => TODAY });
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('empty database: health ok, overview honestly empty', async () => {
    const h = await get('/api/health');
    expect(h.statusCode).toBe(200);
    expect(h.json()).toMatchObject({ status: 'ok', db: 'up', ideas: 0, migrations: ['001_research_engine'] });
    const o = (await get('/api/overview')).json();
    expect(o).toMatchObject({ mode: 'real', ranking: [], lead: null, baseline: null, experiments: [], activity: [] });
    expect(o.kpis).toMatchObject({ totalIdeas: 0, verifiedPaidSignals: 0 });
    expect((await get('/api/top10')).json()).toMatchObject({ current: [], latestSnapshot: null, snapshots: [] });
  });

  it('after import: overview, radar list with filters/sort/pagination and detail with provenance', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    await createSnapshot(db.pool, { asOf: '2026-11-06', apply: true, actor: 't', today: TODAY });
    await applyImport(db.pool, exampleFile('synthetic-run-2.json'), ACTOR);

    const o = (await get('/api/overview')).json();
    expect(o.kpis).toMatchObject({ totalIdeas: 5, rankable: 3, unscored: 1 });
    expect(o.lead.idea.id).toBe('test-invoice-reminders');
    expect(o.baseline).toEqual({ kind: 'stored', asOf: '2026-11-06', snapshotId: 'top10-2026-11-06' });
    expect(o.syntheticIdeas).toBe(5);

    const list = (await get('/api/ideas?sort=score&pageSize=2&page=1')).json();
    expect(list).toMatchObject({ total: 5, totalAll: 5, page: 1, pageSize: 2 });
    expect(list.rows.map((r: { idea: { id: string } }) => r.idea.id)).toEqual(['test-invoice-reminders', 'test-coffee-waste']);
    const page3 = (await get('/api/ideas?sort=score&pageSize=2&page=3')).json();
    expect(page3.rows).toHaveLength(1);

    const unscored = (await get('/api/ideas?q=%D1%84%D0%BE%D1%82%D0%BE')).json(); // «фото»
    expect(unscored.rows).toHaveLength(1);
    expect(unscored.rows[0]).toMatchObject({ score: null, confidence: null, rank: null });

    expect((await get('/api/ideas?category=HoReCa')).json().total).toBe(1);
    expect((await get('/api/ideas?stage=rejected')).json().rows[0].idea.id).toBe('test-tutor-groups');

    const d = (await get('/api/ideas/test-invoice-reminders')).json();
    expect(d.entry).toMatchObject({ rank: 1, score: 75 });
    const w1 = d.idea.evidence.find((e: { id: string }) => e.id === 'w1');
    expect(w1).toMatchObject({ url: 'https://example.org/synthetic/invoice-category', publisher: 'example.org (тест)', observedAt: '2026-11-04', verificationStatus: 'checked' });
    expect(d.idea.competitors.length).toBe(2);
  });

  it('top10: current ranking plus the latest stored snapshot (TOP-10 only)', async () => {
    const t = (await get('/api/top10')).json();
    expect(t.rankAsOf).toBe(TODAY);
    expect(t.current[0]).toMatchObject({ slug: 'test-invoice-reminders', score: 75, movement: { kind: 'same' } });
    expect(t.latestSnapshot.id).toBe('top10-2026-11-06');
    expect(t.latestSnapshot.entries.every((e: { rank: number }) => e.rank <= 10)).toBe(true);
    expect(t.snapshots).toHaveLength(1);
  });

  it('research runs expose import provenance', async () => {
    const r = (await get('/api/research-runs')).json();
    expect(r.runs.map((x: { id: string }) => x.id)).toEqual(['synthetic-example-2026-11-10', 'synthetic-example-2026-11-05']);
    expect(r.imports[0]).toMatchObject({ origin: 'synthetic-test', actor: 'test-suite' });
    expect(r.imports[0].checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('validates input: bad params → 400, unknown idea → 404, malformed id → 400', async () => {
    expect((await get('/api/ideas?pageSize=1000')).statusCode).toBe(400);
    expect((await get('/api/ideas?stage=hacked')).statusCode).toBe(400);
    expect((await get('/api/ideas?sort=evil')).statusCode).toBe(400);
    expect((await get('/api/ideas?unknown=1')).statusCode).toBe(400);
    expect((await get(`/api/ideas?q=${'x'.repeat(101)}`)).statusCode).toBe(400);
    expect((await get('/api/ideas/not-there')).statusCode).toBe(404);
    expect((await get('/api/ideas/BAD%20ID')).statusCode).toBe(400);
    expect((await get('/api/nope')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/ideas', payload: {} })).statusCode).toBe(404);
  });

  it('restricts CORS to the local UI origins and sets safe headers', async () => {
    const ok = await get('/api/health', { origin: ORIGIN });
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    const evil = await get('/api/health', { origin: 'https://evil.example' });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('serves fresh data after a new import without restart', async () => {
    const before = (await get('/api/overview')).json().kpis.totalIdeas;
    const { jsonFile, loadExample } = await import('./helpers');
    const env = loadExample('synthetic-run-2.json');
    env.runId = 'synthetic-freshness';
    env.ideas = [{ ...env.ideas[2]!, externalId: 'test-fresh-idea', title: 'Тест: свежая идея' }];
    expect((await applyImport(db.pool, jsonFile(env), ACTOR)).applied).toBe(true);
    expect((await get('/api/overview')).json().kpis.totalIdeas).toBe(before + 1);
  });
});
