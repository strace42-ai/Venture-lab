/**
 * Integration-test harness: every test file gets its own PostgreSQL schema inside the isolated
 * TEST database (TEST_DATABASE_URL), migrated from scratch and dropped afterwards.
 * Never point TEST_DATABASE_URL at a database with real research.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { describe } from 'vitest';
import { migrate } from '../db/migrate';
import { createPool, type Pool } from '../db/pool';
import { RESEARCH_ROOT, sha256 } from '../research/files';
import type { ImportFile } from '../research/importer';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL && process.env.CI) {
  throw new Error('TEST_DATABASE_URL must be set in CI: database integration tests may not be skipped there.');
}

/** `describe` that skips (with a visible reason) when no test database is configured locally. */
export const describeDb: typeof describe = TEST_DATABASE_URL ? describe : (describe.skip as typeof describe);

export interface TestDb {
  pool: Pool;
  schema: string;
  /** A second pool on the same schema — simulates an application restart. */
  reconnect(): Pool;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const url = TEST_DATABASE_URL!;
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = createPool(url, schema);
  await migrate(pool);
  const extra: Pool[] = [];
  return {
    pool,
    schema,
    reconnect() {
      const p = createPool(url, schema);
      extra.push(p);
      return p;
    },
    async drop() {
      await Promise.all([pool.end(), ...extra.map((p) => p.end())]);
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    },
  };
}

export function exampleFile(name: string): ImportFile {
  const bytes = readFileSync(join(RESEARCH_ROOT, 'examples', name));
  return { bytes, checksum: sha256(bytes), name };
}

/** Build an in-memory import file from a JS object (tests). */
export function jsonFile(obj: unknown, name = 'test.json'): ImportFile {
  const bytes = Buffer.from(JSON.stringify(obj, null, 2));
  return { bytes, checksum: sha256(bytes), name };
}

export function loadExample(name: string): Record<string, unknown> & { ideas: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(join(RESEARCH_ROOT, 'examples', name), 'utf8'));
}

export async function count(pool: Pool, table: string): Promise<number> {
  if (!/^[a-z_0-9]+$/.test(table)) throw new Error('bad table');
  const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return r.rows[0]!.n;
}

export const ALL_TABLES = ['import_runs', 'research_runs', 'ideas', 'idea_revisions', 'stage_transitions', 'evidence', 'evidence_reviews', 'competitors', 'assessments', 'top10_snapshots', 'top10_entries'];

export async function counts(pool: Pool): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ALL_TABLES) out[t] = await count(pool, t);
  return out;
}

export const ACTOR = { actor: 'test-suite' };
