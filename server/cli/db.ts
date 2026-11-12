/**
 * npm run db:migrate   — apply pending migrations (forward-only, checksum-verified)
 * npm run db:reset     — DROP the schema and re-migrate (local databases only, requires --yes)
 * npm run db:status    — list applied migrations
 */
import { assertLocalDatabase, loadConfig } from '../config';
import { listMigrations, migrate, resetSchema } from '../db/migrate';
import { createPool } from '../db/pool';

const [cmd, ...args] = process.argv.slice(2);
const { databaseUrl } = loadConfig();
const pool = createPool(databaseUrl);
const safeUrl = databaseUrl.replace(/\/\/([^:@/]+):[^@/]+@/, '//$1:***@');

try {
  if (cmd === 'migrate') {
    const r = await migrate(pool);
    console.log(`DB ${safeUrl}`);
    console.log(r.applied.length ? `Применены миграции: ${r.applied.join(', ')}` : 'Новых миграций нет.');
    if (r.alreadyApplied.length) console.log(`Уже были применены: ${r.alreadyApplied.join(', ')}`);
  } else if (cmd === 'reset') {
    assertLocalDatabase(databaseUrl);
    if (!args.includes('--yes')) {
      console.error(`Это удалит ВСЕ данные в ${safeUrl}. Повторите с --yes: npm run db:reset -- --yes`);
      process.exitCode = 2;
    } else {
      const r = await resetSchema(pool);
      console.log(`Схема пересоздана, применены: ${r.applied.join(', ')}`);
    }
  } else if (cmd === 'status') {
    const known = listMigrations();
    const { rows } = await pool.query<{ id: string; applied_at: Date }>('SELECT id, applied_at FROM schema_migrations ORDER BY id').catch(() => ({ rows: [] as { id: string; applied_at: Date }[] }));
    const applied = new Map(rows.map((r) => [r.id, r.applied_at]));
    for (const m of known) console.log(`${applied.has(m.id) ? '✔' : '·'} ${m.id}${applied.has(m.id) ? `  (${applied.get(m.id)!.toISOString()})` : '  — не применена'}`);
  } else {
    console.error('Использование: tsx server/cli/db.ts <migrate|reset|status>');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`Ошибка: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
