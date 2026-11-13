/**
 * Strict prohibition of PARALLEL paid execution (VL-004B-prep). The Search API quota (1 request/s) is
 * per folder, and two processes could each respect their own limiter yet exceed it together; budgets
 * are safe (ledger locks) but quota and spending visibility are not. So paid runs are exclusive:
 *  - host level: an O_EXCL lock file (pid inside; a stale file of a dead pid is reclaimed);
 *  - database level: a session advisory lock held for the whole run.
 * A second paid process is refused before it makes any request.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Pool } from '../db/pool';

export class PaidExecutionBusy extends Error {}

const DB_LOCK = 'vl-live-paid-execution';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLockFile(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = NaN;
      try {
        pid = Number(JSON.parse(readFileSync(path, 'utf8')).pid);
      } catch {
        /* unreadable lock: treat as held */
      }
      if (Number.isInteger(pid) && pid > 0 && !alive(pid)) {
        unlinkSync(path); // stale lock of a dead process
        continue;
      }
      throw new PaidExecutionBusy(`другой платный запуск уже выполняется на этом сервере (lock ${path}, pid ${Number.isNaN(pid) ? '?' : pid}) — параллельное платное исполнение запрещено`);
    }
  }
  throw new PaidExecutionBusy(`не удалось захватить ${path}`);
}

export async function withPaidExecutionLock<T>(pool: Pool, lockFile: string, fn: () => Promise<T>): Promise<T> {
  const releaseFile = acquireLockFile(lockFile);
  const client = await pool.connect();
  let dbLocked = false;
  try {
    dbLocked = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [DB_LOCK])).rows[0]!.ok;
    if (!dbLocked) throw new PaidExecutionBusy('другой платный запуск уже выполняется с этой базой данных — параллельное платное исполнение запрещено');
    return await fn();
  } finally {
    if (dbLocked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [DB_LOCK]).catch(() => undefined);
    client.release();
    releaseFile();
  }
}
