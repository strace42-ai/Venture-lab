import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
}

export function listMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return { id: f.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Forward-only, repeatable migrations. Each file runs in its own transaction; an applied file
 * whose content changed is a hard error (never silently re-run or skipped).
 * Rollback path for local development = `npm run db:reset` (drop + re-migrate).
 */
export async function migrate(pool: Pool, migrations = listMigrations()): Promise<MigrateResult> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['vl-migrate']);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.id, r.checksum]));
    const result: MigrateResult = { applied: [], alreadyApplied: [] };
    for (const m of migrations) {
      const prev = done.get(m.id);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`Migration ${m.id} was modified after being applied (checksum mismatch). Create a new migration instead.`);
        result.alreadyApplied.push(m.id);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [m.id, m.checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.id} failed: ${(e as Error).message}`);
      }
      result.applied.push(m.id);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['vl-migrate']).catch(() => undefined);
    client.release();
  }
}

/** Drop every object in the current schema and re-run all migrations (local development only). */
export async function resetSchema(pool: Pool): Promise<MigrateResult> {
  const { rows } = await pool.query<{ schema: string }>('SELECT current_schema() AS schema');
  const schema = rows[0]?.schema;
  if (!schema || !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Cannot determine current schema');
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  return migrate(pool);
}
