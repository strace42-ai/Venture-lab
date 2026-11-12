import pg from 'pg';

// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);
// BIGINT/BIGSERIAL ids fit comfortably in JS numbers for this local app.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

/**
 * @param schema optional search_path schema — used by integration tests to isolate each run.
 */
export function createPool(connectionString: string, schema?: string): pg.Pool {
  if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  return new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
}

export async function withTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    const result = await fn(client);
    await client.query(opts.readOnly ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
