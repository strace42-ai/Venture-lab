// @vitest-environment node
/**
 * VL-004B audit round 2 — upgrading an EXISTING database (migrated to 005, with competitor rows) to 006:
 * historical rows must not become «verified» competitors; new rows must state their market status.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { listMigrations, migrate } from '../db/migrate';
import { createPool, type Pool } from '../db/pool';
import { runDiagnostics } from '../machine/read';
import { describeDb, TEST_DATABASE_URL } from './helpers';

describeDb('migration 006 on a database that already ran 005', () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  let pool: Pool;
  let jobId = 0;
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = createPool(TEST_DATABASE_URL!, schema);
    // state of a database migrated by the previous PR head (001–005) …
    const upTo005 = listMigrations().filter((m) => m.id <= '005_live_providers');
    expect(upTo005.map((m) => m.id).at(-1)).toBe('005_live_providers');
    await migrate(pool, upTo005);
    // … holding competitor rows written before the market status existed
    jobId = (
      await pool.query(
        "INSERT INTO mr_jobs (job_key, feed, as_of, timezone, status, attempts, max_attempts, budget_limit, monthly_cap, spent, pipeline_version) VALUES ('daily:live:2026-11-12', 'live', '2026-11-12', 'Asia/Novokuznetsk', 'succeeded', 1, 2, 20000, 40000, 0, 'vl-004b-pipeline-1') RETURNING id",
      )
    ).rows[0].id;
    const cand = (
      await pool.query(
        "INSERT INTO mr_candidates (feed, external_id, first_job_id, first_seen, seed_title, seed_pitch, segment, category, primary_job, jobs, western_product) VALUES ('live', 'old-candidate', $1, '2026-11-12', 'Старый кандидат', 'p', 'B2B', 'X', 'job-a', '{job-a}', 'W') RETURNING id",
        [jobId],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO mr_competitors (job_id, candidate_id, feed, name, url, market, kind, found_by, source_key, note, classification_reason) VALUES ($1, $2, 'live', 'Old Rival', 'https://old.example.com/', 'ru', 'direct', 'skeptic', 's1', null, 'r')",
      [jobId, cand],
    );
    expect((await pool.query("SELECT market_verified FROM mr_competitors WHERE name = 'Old Rival'")).rows[0].market_verified).toBe(true); // the 005 default
    // upgrade
    const r = await migrate(pool);
    expect(r.applied).toEqual(['006_competitor_market_status']);
  });
  afterAll(async () => {
    await pool?.end();
    const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
    await c.end();
  });

  it('historical rows are kept as they were and read as «not assessed», never as verified competitors', async () => {
    const row = (await pool.query("SELECT market_status, market_verified FROM mr_competitors WHERE name = 'Old Rival'")).rows[0];
    expect(row).toEqual({ market_status: null, market_verified: true }); // not rewritten (append-only history)
    const d = (await runDiagnostics(pool, jobId))!;
    expect(d.competitors.ruDirect).toBe(0);
    expect(d.competitors.marketUnverified).toBe(1);
  });

  it('new rows must state a status, and status / verified must agree', async () => {
    const cand = (await pool.query("SELECT id FROM mr_candidates WHERE external_id = 'old-candidate'")).rows[0].id;
    let n = 0;
    const ins = (cols: string, vals: string) =>
      pool.query(`INSERT INTO mr_competitors (job_id, candidate_id, feed, name, url, market, kind, found_by, source_key, note, classification_reason${cols}) VALUES ($1, $2, 'live', $3, null, 'ru', 'direct', 'skeptic', 's2', null, 'r'${vals})`, [jobId, cand, `New Rival ${++n}`]);
    await expect(ins('', '')).rejects.toThrow(/market_status_required/);
    await expect(ins(', market_verified, market_status', ", true, 'unknown'")).rejects.toThrow(/market_status_consistent/);
    await expect(ins(', market_verified, market_status', ", false, 'banana'")).rejects.toThrow(/check/i);
    await ins(', market_verified, market_status', ", false, 'conflicting'");
    await ins(', market_verified, market_status', ", true, 'verified'");
  });

  it('a fresh database gets the same schema (001–006) and the worker writes explicit statuses', async () => {
    const cols = (await pool.query("SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'mr_competitors' AND column_name IN ('market_verified', 'market_status') ORDER BY 1", [schema])).rows;
    expect(cols).toEqual([
      { column_name: 'market_status', is_nullable: 'YES', column_default: null },
      { column_name: 'market_verified', is_nullable: 'YES', column_default: null },
    ]);
  });
});
