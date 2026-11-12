// @vitest-environment node
/**
 * Regression tests for the ChatGPT review of VL-002 (PR #2):
 *  P1a dataset isolation (synthetic vs real), P1b movement baseline, P1c PATCH semantics,
 *  plus migration 002 backfill. UI part (P2, stale Radar) is in src/test/real-mode.test.tsx.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fullRanking } from '../../src/domain/selectors';
import { buildApp } from '../api/app';
import { listMigrations, migrate, resetSchema } from '../db/migrate';
import { applyImport, dryRunImport } from '../research/importer';
import { loadDataset, loadIdeas, loadSnapshot } from '../research/repository';
import { createSnapshot } from '../research/snapshot';
import { ACTOR, count, createTestDb, describeDb, envelope, exampleFile, ideaJson, jsonFile, type TestDb } from './helpers';

const YESTERDAY = '2026-11-11';
const TODAY = '2026-11-12';

describeDb('VL-002 review fixes (integration, PostgreSQL)', () => {
  let db: TestDb;
  let app: FastifyInstance;
  const api = async (url: string) => (await app.inject({ method: 'GET', url })).json();

  beforeAll(async () => {
    db = await createTestDb();
    app = await buildApp({ pool: db.pool, today: () => TODAY });
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await resetSchema(db.pool);
  });

  // ---------------------------------------------------------------- P1a isolation
  describe('P1a: synthetic and real research are isolated datasets', () => {
    async function importBoth() {
      // Synthetic sample: scores 64–75 — would outrank the real ideas if mixed.
      expect((await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR)).applied).toBe(true);
      const real = envelope('real-run-1', '2026-11-05', [ideaJson('real-alpha', { score: 2 }), ideaJson('real-beta', { score: 1 }), ideaJson('real-gamma', { assessment: false })]);
      expect((await applyImport(db.pool, jsonFile(real), ACTOR)).applied).toBe(true);
    }

    it('REAL ranking, KPIs, research runs and evidence contain no synthetic rows', async () => {
      await importBoth();
      const real = await loadDataset(db.pool, 'real', TODAY);
      expect(real.ideas.map((i) => i.id).sort()).toEqual(['real-alpha', 'real-beta', 'real-gamma']);
      expect(real.ideas.every((i) => !i.synthetic)).toBe(true);
      expect(real.researchRuns.map((r) => r.id)).toEqual(['real-run-1']);
      expect(fullRanking(real).map((e) => e.idea.id)).toEqual(['real-alpha', 'real-beta']);

      const test = await loadDataset(db.pool, 'test', TODAY);
      expect(test.ideas.every((i) => i.synthetic)).toBe(true);
      expect(test.ideas.map((i) => i.id)).not.toContain('real-alpha');
    });

    it('REAL snapshots contain only real ideas; TEST snapshots are separate (same date allowed)', async () => {
      await importBoth();
      const r = await createSnapshot(db.pool, { asOf: '2026-11-06', apply: true, actor: 't', today: TODAY });
      expect(r.entries.map((e) => e.ideaId)).toEqual(['real-alpha', 'real-beta']);
      const t = await createSnapshot(db.pool, { asOf: '2026-11-06', apply: true, actor: 't', today: TODAY, dataset: 'test' });
      expect(t.applied).toBe(true);
      expect(t.id).toBe('test-top10-2026-11-06');
      expect(t.entries.every((e) => e.ideaId.startsWith('test-'))).toBe(true);
      const stored = await loadSnapshot(db.pool, 'real', { id: 'top10-2026-11-06' });
      expect(stored!.entries.map((e) => e.ideaId)).toEqual(['real-alpha', 'real-beta']);
      // A snapshot id of the other dataset is not visible from REAL.
      expect(await loadSnapshot(db.pool, 'real', { id: 'test-top10-2026-11-06' })).toBeNull();
    });

    it('the API defaults to REAL and never returns synthetic rows there', async () => {
      await importBoth();
      await createSnapshot(db.pool, { asOf: '2026-11-06', apply: true, actor: 't', today: TODAY });
      expect((await api('/api/health')).ideas).toEqual({ real: 3, test: 4 });
      const o = await api('/api/overview');
      expect(o.mode).toBe('real');
      expect(o.kpis).toMatchObject({ totalIdeas: 3, rankable: 2, unscored: 1, evidenceChecked: 3 });
      expect(o.syntheticIdeas).toBe(0);
      expect(o.researchRuns.map((x: { id: string }) => x.id)).toEqual(['real-run-1']);
      const t10 = await api('/api/top10');
      expect(t10.current.map((e: { ideaId: string }) => e.ideaId)).toEqual(['real-alpha', 'real-beta']);
      expect(t10.snapshots.map((s: { id: string }) => s.id)).toEqual(['top10-2026-11-06']);
      expect((await api('/api/ideas')).totalAll).toBe(3);
      expect((await app.inject({ method: 'GET', url: '/api/ideas/test-invoice-reminders' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/ideas/test-invoice-reminders?dataset=test' })).statusCode).toBe(200);
      expect((await api('/api/research-runs')).imports.map((i: { runId: string }) => i.runId)).toEqual(['real-run-1']);
      expect((await app.inject({ method: 'GET', url: '/api/overview?dataset=all' })).statusCode).toBe(400);
    });

    it('the database itself refuses cross-dataset links (composite foreign keys)', async () => {
      await importBoth();
      await createSnapshot(db.pool, { asOf: '2026-11-06', apply: true, actor: 't', today: TODAY });
      // A synthetic idea inside a REAL snapshot is impossible…
      await expect(
        db.pool.query(`INSERT INTO top10_entries (snapshot_id, rank, idea_id, score, confidence, synthetic, title, slug)
                       SELECT 'top10-2026-11-06', 99, id, 1, 1, false, title, slug FROM ideas WHERE external_id = 'test-invoice-reminders'`),
      ).rejects.toThrow(/foreign key/);
      await expect(
        db.pool.query(`INSERT INTO top10_entries (snapshot_id, rank, idea_id, score, confidence, synthetic, title, slug)
                       SELECT 'top10-2026-11-06', 99, id, 1, 1, true, title, slug FROM ideas WHERE external_id = 'test-invoice-reminders'`),
      ).rejects.toThrow(/foreign key/);
      // …and a real idea cannot be attributed to a synthetic research run.
      await expect(db.pool.query("UPDATE ideas SET last_run_id = 'synthetic-example-2026-11-05' WHERE external_id = 'real-alpha'")).rejects.toThrow(/foreign key/);
    });
  });

  // ---------------------------------------------------------------- P1b movement baseline
  describe('P1b: movement is measured against the PREVIOUS stored snapshot', () => {
    it('yesterday snapshot → reorder + new idea → today snapshot: movement stays vs yesterday (DB, API)', async () => {
      await applyImport(db.pool, jsonFile(envelope('real-day-1', '2026-11-10', [ideaJson('id-a', { score: 4, assessedAt: '2026-11-10' }), ideaJson('id-b', { score: 3, assessedAt: '2026-11-10' }), ideaJson('id-c', { score: 2, assessedAt: '2026-11-10' })])), ACTOR);
      await createSnapshot(db.pool, { asOf: YESTERDAY, apply: true, actor: 't', today: TODAY });

      // Today: b overtakes a, a new idea d appears, c drops.
      await applyImport(db.pool, jsonFile(envelope('real-day-2', TODAY, [ideaJson('id-b', { score: 5, assessedAt: TODAY }), ideaJson('id-d', { score: 3, assessedAt: TODAY })])), ACTOR);

      const expectMoves = async () => {
        const data = await loadDataset(db.pool, 'real', TODAY);
        expect(data.baseline).toMatchObject({ kind: 'stored', snapshotId: `top10-${YESTERDAY}`, asOf: YESTERDAY });
        const now = fullRanking(data).map((e) => [e.idea.id, e.movement]);
        expect(now).toEqual([
          ['id-b', { kind: 'up', by: 1, previousRank: 2 }],
          ['id-a', { kind: 'down', by: 1, previousRank: 1 }],
          ['id-d', { kind: 'new' }],
          ['id-c', { kind: 'down', by: 1, previousRank: 3 }],
        ]);
      };
      await expectMoves(); // before today's snapshot

      const today = await createSnapshot(db.pool, { asOf: TODAY, apply: true, actor: 't', today: TODAY });
      expect(today.entries.map((e) => e.ideaId)).toEqual(['id-b', 'id-a', 'id-d', 'id-c']);
      await expectMoves(); // after today's snapshot — NOT reset to «same»

      const t10 = await api('/api/top10');
      expect(t10.baseline).toEqual({ kind: 'stored', asOf: YESTERDAY, snapshotId: `top10-${YESTERDAY}` });
      expect(t10.current.map((e: { ideaId: string; movement: { kind: string } }) => [e.ideaId, e.movement.kind])).toEqual([
        ['id-b', 'up'],
        ['id-a', 'down'],
        ['id-d', 'new'],
        ['id-c', 'down'],
      ]);
      // The stored TODAY snapshot is also compared with the snapshot before it.
      expect(t10.latestSnapshot.id).toBe(`top10-${TODAY}`);
      expect(t10.latestSnapshot.comparedTo).toEqual({ id: `top10-${YESTERDAY}`, asOf: YESTERDAY });
      expect(t10.latestSnapshot.entries.map((e: { ideaId: string; movement: { kind: string } }) => [e.ideaId, e.movement.kind])).toEqual([
        ['id-b', 'up'],
        ['id-a', 'down'],
        ['id-d', 'new'],
        ['id-c', 'down'],
      ]);
      expect((await api('/api/overview')).baseline).toEqual({ kind: 'stored', asOf: YESTERDAY, snapshotId: `top10-${YESTERDAY}` });

      // A later import the same day: still compared with yesterday; today's snapshot unchanged.
      await applyImport(db.pool, jsonFile(envelope('real-day-2-pm', TODAY, [ideaJson('id-c', { score: 5, assessedAt: `${TODAY}T15:00:00Z` })])), ACTOR);
      const later = fullRanking(await loadDataset(db.pool, 'real', TODAY)).map((e) => [e.idea.id, e.movement.kind]);
      expect(later).toEqual([
        ['id-b', 'up'],
        ['id-c', 'up'],
        ['id-a', 'down'],
        ['id-d', 'new'],
      ]);
      expect((await loadSnapshot(db.pool, 'real', { id: `top10-${TODAY}` }))!.entries.map((e) => e.ideaId)).toEqual(['id-b', 'id-a', 'id-d', 'id-c']);
    });

    it('a snapshot freezes title/slug: later renames do not rewrite history', async () => {
      await applyImport(db.pool, jsonFile(envelope('real-r1', '2026-11-10', [ideaJson('ren', { title: 'Старое название' })])), ACTOR);
      await createSnapshot(db.pool, { asOf: YESTERDAY, apply: true, actor: 't', today: TODAY });
      await applyImport(db.pool, jsonFile(envelope('real-r2', TODAY, [ideaJson('ren', { title: 'Новое название', assessment: false })])), ACTOR);
      expect((await loadIdeas(db.pool, 'real'))[0]!.title).toBe('Новое название');
      expect((await loadSnapshot(db.pool, 'real', { id: `top10-${YESTERDAY}` }))!.entries[0]!.title).toBe('Старое название');
    });
  });

  // ---------------------------------------------------------------- P1c PATCH semantics
  describe('P1c: partial updates never silently erase an accumulated dossier', () => {
    const full = ideaJson('patch-me', {
      assessedAt: '2026-11-05',
      extra: {
        geography: 'Россия, СНГ',
        targetPersona: 'Владелец малого бизнеса',
        problem: 'Проблема',
        ruUnmetJob: 'Пробел в РФ',
        whyNow: 'Почему сейчас',
        thesis: 'Тезис',
        monetization: 'Подписка',
        priceHypothesis: '990 ₽/мес (гипотеза)',
        distribution: 'Сообщества',
        mvp: 'MVP',
        nextAction: 'Интервью',
        riskFlags: ['legal', 'coldStart'],
        originMarkets: ['US'],
        excludedFeatures: ['мобильное приложение'],
      },
    });

    it('absent optional fields keep stored values (and the idea counts as unchanged)', async () => {
      await applyImport(db.pool, jsonFile(envelope('real-p1', '2026-11-05', [full])), ACTOR);
      const short = { externalId: 'patch-me', title: full.title, pitch: full.pitch, segment: 'B2B', category: 'Test', assessment: { ...full.assessment!, assessedAt: '2026-11-10', scores: { ...full.assessment!.scores, distribution: 5 } } };
      const plan = await dryRunImport(db.pool, jsonFile(envelope('real-p2', '2026-11-10', [short])));
      expect(plan.status).toBe('ready');
      expect(plan.counts.ideas).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
      expect(plan.counts.assessments.inserted).toBe(1);
      expect((await applyImport(db.pool, jsonFile(envelope('real-p2', '2026-11-10', [short])), ACTOR)).applied).toBe(true);

      const idea = (await loadIdeas(db.pool, 'real'))[0]!;
      expect(idea).toMatchObject({ geography: 'Россия, СНГ', targetPersona: 'Владелец малого бизнеса', primaryProblem: 'Проблема', whyNow: 'Почему сейчас', thesis: 'Тезис', nextAction: 'Интервью' });
      expect(idea.riskFlags.sort()).toEqual(['coldStart', 'legal']);
      expect(idea.assessments).toHaveLength(2);
      const row = (await db.pool.query('SELECT origin_markets, excluded_features, distribution, mvp FROM ideas')).rows[0];
      expect(row).toEqual({ origin_markets: ['US'], excluded_features: ['мобильное приложение'], distribution: 'Сообщества', mvp: 'MVP' });
      expect(await count(db.pool, 'idea_revisions')).toBe(1);
    });

    it('only an explicit null / [] clears a field — with a warning — and the old value stays in history', async () => {
      await applyImport(db.pool, jsonFile(envelope('real-p1', '2026-11-05', [full])), ACTOR);
      const edit = { externalId: 'patch-me', title: full.title, pitch: full.pitch, segment: 'B2B', category: 'Test', whyNow: null, riskFlags: [], thesis: 'Новый тезис' };
      const r = await applyImport(db.pool, jsonFile(envelope('real-p3', '2026-11-10', [edit])), ACTOR);
      expect(r.applied).toBe(true);
      expect(r.counts.ideas.updated).toBe(1);
      expect(r.diagnostics.some((d) => d.level === 'warning' && /явно очищены поля досье/.test(d.message) && /whyNow/.test(d.message) && /riskFlags/.test(d.message))).toBe(true);

      const idea = (await loadIdeas(db.pool, 'real'))[0]!;
      expect(idea.whyNow).toBeNull();
      expect(idea.riskFlags).toEqual([]);
      expect(idea.thesis).toBe('Новый тезис');
      expect(idea).toMatchObject({ primaryProblem: 'Проблема', targetPersona: 'Владелец малого бизнеса', geography: 'Россия, СНГ' });
      const revs = (await db.pool.query<{ content: { whyNow: string | null; thesis: string } }>('SELECT content FROM idea_revisions ORDER BY id')).rows;
      expect(revs.map((x) => [x.content.whyNow, x.content.thesis])).toEqual([
        ['Почему сейчас', 'Тезис'],
        [null, 'Новый тезис'],
      ]);
    });

    it('a new idea without optional fields gets explicit empty defaults', async () => {
      await applyImport(db.pool, jsonFile(envelope('real-n1', '2026-11-05', [ideaJson('fresh')])), ACTOR);
      const idea = (await loadIdeas(db.pool, 'real'))[0]!;
      expect(idea).toMatchObject({ geography: 'Россия', whyNow: null, thesis: null, riskFlags: [] });
    });
  });
});

// ---------------------------------------------------------------- migration 002 backfill
describeDb('migration 002 on a database created before dataset isolation', () => {
  let db: TestDb | null = null;
  afterAll(async () => {
    await db?.drop();
  });

  async function legacyDb() {
    await db?.drop();
    db = await createTestDb();
    const { rows } = await db.pool.query<{ s: string }>('SELECT current_schema() AS s');
    await db.pool.query(`DROP SCHEMA ${rows[0]!.s} CASCADE`);
    await db.pool.query(`CREATE SCHEMA ${rows[0]!.s}`);
    await migrate(db.pool, listMigrations().slice(0, 1)); // 001 only
    return db;
  }

  /** Rows exactly as the 001 schema stored them (written with SQL: today's importer targets 003). */
  async function legacyIdeas(pool: TestDb['pool'], runId: string, synthetic: boolean, ideas: { ext: string; title: string }[]) {
    await pool.query(
      `INSERT INTO import_runs (run_id, checksum, schema_version, file_name, origin, actor, counts, started_at)
       VALUES ($1, repeat('a', 64), 'vl-research-1', 'legacy.json', $2, 'legacy', '{}', now())`,
      [runId, synthetic ? 'synthetic-test' : 'human-reviewed'],
    );
    await pool.query(
      `INSERT INTO research_runs (run_id, researched_at, origin, synthetic, reviewed_by, discovered_count, updated_count, rejected_count, sources_count)
       VALUES ($1, '2026-11-05', $2, $3, 'legacy', $4, 0, 0, 0)`,
      [runId, synthetic ? 'synthetic-test' : 'human-reviewed', synthetic, ideas.length],
    );
    for (const i of ideas) {
      await pool.query(
        `INSERT INTO ideas (external_id, slug, title, pitch, segment, category, geography, synthetic, first_run_id, last_run_id, content_hash)
         VALUES ($1, $1, $2, 'pitch', 'B2B', 'Test', 'Россия', $3, $4, $4, 'h')`,
        [i.ext, i.title, synthetic, runId],
      );
    }
  }

  async function legacySnapshot(pool: TestDb['pool'], externalIds: string[]) {
    await pool.query("INSERT INTO top10_snapshots (id, as_of, rubric_version, created_by, entry_count) VALUES ('top10-2026-11-06', '2026-11-06', 'v1.0', 'legacy', $1)", [externalIds.length]);
    for (const [i, ext] of externalIds.entries()) {
      await pool.query("INSERT INTO top10_entries (snapshot_id, rank, idea_id, score, confidence) SELECT 'top10-2026-11-06', $1, id, 50, 50 FROM ideas WHERE external_id = $2", [i + 1, ext]);
    }
  }

  it('backfills dataset and frozen titles for existing snapshots', async () => {
    const d = await legacyDb();
    await legacyIdeas(d.pool, 'synthetic-legacy-run', true, [
      { ext: 'test-invoice-reminders', title: 'Тест: напоминания об оплате счетов для фрилансеров' },
      { ext: 'test-tutor-groups', title: 'Тест: групповые занятия для частных репетиторов' },
    ]);
    await legacySnapshot(d.pool, ['test-invoice-reminders', 'test-tutor-groups']);
    const r = await migrate(d.pool);
    expect(r.applied).toEqual(listMigrations().slice(1).map((m) => m.id));
    expect((await d.pool.query('SELECT synthetic FROM top10_snapshots')).rows).toEqual([{ synthetic: true }]);
    const snap = await loadSnapshot(d.pool, 'test', { id: 'top10-2026-11-06' });
    expect(snap!.entries.map((e) => e.title)).toEqual(['Тест: напоминания об оплате счетов для фрилансеров', 'Тест: групповые занятия для частных репетиторов']);
    expect(await loadSnapshot(d.pool, 'real', { id: 'top10-2026-11-06' })).toBeNull();
    // Append-only guards are active again after the migration.
    await expect(d.pool.query('DELETE FROM top10_entries')).rejects.toThrow(/append-only/);
  });

  it('refuses to migrate a legacy snapshot that mixes synthetic and real ideas', async () => {
    const d = await legacyDb();
    await legacyIdeas(d.pool, 'synthetic-legacy-run', true, [{ ext: 'test-invoice-reminders', title: 'Тест A' }]);
    await legacyIdeas(d.pool, 'real-legacy-run', false, [{ ext: 'real-x', title: 'Real X' }]);
    await legacySnapshot(d.pool, ['test-invoice-reminders', 'real-x']);
    await expect(migrate(d.pool)).rejects.toThrow(/mixes synthetic and real/);
  });
});
