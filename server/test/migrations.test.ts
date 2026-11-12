// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listMigrations, migrate, resetSchema } from '../db/migrate';
import { applyImport } from '../research/importer';
import { ACTOR, ALL_TABLES, count, createTestDb, describeDb, exampleFile, type TestDb } from './helpers';

describeDb('migrations (integration, isolated schema)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('creates every table from a clean schema', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [db.schema]);
    const names = rows.map((r) => r.table_name);
    for (const t of [...ALL_TABLES, 'schema_migrations']) expect(names).toContain(t);
  });

  it('is repeatable: a second run applies nothing', async () => {
    const r = await migrate(db.pool);
    expect(r.applied).toEqual([]);
    expect(r.alreadyApplied).toEqual(listMigrations().map((m) => m.id));
  });

  it('refuses to continue when an applied migration file was modified', async () => {
    const tampered = listMigrations().map((m) => ({ ...m, checksum: m.checksum.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) }));
    await expect(migrate(db.pool, tampered)).rejects.toThrow(/checksum mismatch/);
  });

  it('enforces append-only tables with database triggers', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    await expect(db.pool.query("UPDATE assessments SET rationale = 'tampered rationale text'")).rejects.toThrow(/append-only/);
    await expect(db.pool.query('DELETE FROM evidence')).rejects.toThrow(/append-only/);
    await expect(db.pool.query("UPDATE stage_transitions SET stage = 'scored'")).rejects.toThrow(/append-only/);
    await expect(db.pool.query('DELETE FROM import_runs')).rejects.toThrow(/append-only/);
    await expect(db.pool.query('DELETE FROM ideas')).rejects.toThrow(/append-only/);
  });

  it('enforces value constraints at the database level as well', async () => {
    await expect(
      db.pool.query(`INSERT INTO evidence (idea_id, external_id, region, claim, url, source_type, run_id, content_hash)
                     SELECT id, 'x1', 'west', 'c', 'javascript:alert(1)', 'unknown', first_run_id, 'h' FROM ideas LIMIT 1`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.pool.query(`INSERT INTO assessments (idea_id, rubric_version, assessed_at, assessor, scores, confidence, rationale, evidence_refs, run_id, content_hash)
                     SELECT id, 'v2.0', now(), 'a', '{}', '{}', 'rationale long enough here', '{e}', first_run_id, 'h2' FROM ideas LIMIT 1`),
    ).rejects.toThrow(/check constraint/);
  });

  it('rebuild path: reset drops all data and re-migrates', async () => {
    expect(await count(db.pool, 'ideas')).toBeGreaterThan(0);
    const r = await resetSchema(db.pool);
    expect(r.applied.length).toBeGreaterThan(0);
    for (const t of ALL_TABLES) expect(await count(db.pool, t)).toBe(0);
  });
});
