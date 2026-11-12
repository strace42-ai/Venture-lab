/**
 * Autonomous research worker CLI (VL-004A). No approval step, no human in the loop.
 *
 * npm run research:worker:run    -- --fixture --as-of YYYY-MM-DD [--budget N] [--monthly-budget N]
 * npm run research:worker:tick   -- --fixture [--now 2026-11-12T00:30:00Z]   (what a timer would call)
 * npm run research:worker:status -- --fixture
 *
 * `--fixture` = deterministic offline providers (emulation, NOT live research). Live providers are a
 * separately authorised VL-004B step and are refused here.
 */
import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { machineOverview } from '../machine/read';
import { dueRun } from '../machine/schedule';
import { WORKER_TIMEZONE, runWorkerJob, type RunResult } from '../machine/worker';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const opt = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const num = (name: string) => (opt(name) !== undefined ? Number(opt(name)) : undefined);

function print(r: RunResult) {
  const icon = r.status === 'succeeded' ? '✔' : r.status === 'already-succeeded' || r.status === 'already-running' ? '•' : '✖';
  console.log(`${icon} ${r.jobKey} · попытка ${r.attempt} · ${r.status}`);
  console.log(`  ${r.message}`);
  if (r.spent !== undefined) console.log(`  Расход попытки: ${r.spent} ед.`);
  if (r.snapshot) {
    console.log(`  Автоматический TOP-10 на ${r.snapshot.asOf}: ${r.snapshot.entries.length}/10 · прошли проверку ${r.snapshot.eligible} · отложено ${r.snapshot.held}`);
    for (const e of r.snapshot.entries) console.log(`   #${String(e.rank).padEnd(2)} ${String(e.score).padStart(3)}  ${e.externalId}`);
  }
}

async function main() {
  if (!flags.has('--fixture')) {
    console.error('Живые провайдеры (Yandex Search API / AI Studio) ещё не подключены — это отдельная задача VL-004B. Запустите с --fixture (эмуляция на фикстурах).');
    process.exitCode = 2;
    return;
  }
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  try {
    if (cmd === 'run') {
      const asOf = opt('--as-of');
      if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('Укажите --as-of YYYY-MM-DD');
      const r = await runWorkerJob(pool, { feed: 'fixture', asOf, budget: num('--budget'), monthlyBudget: num('--monthly-budget') });
      print(r);
      if (r.status === 'failed' || r.status === 'partial' || r.status === 'exhausted' || r.status === 'monthly-cap') process.exitCode = 1;
    } else if (cmd === 'tick') {
      const now = opt('--now') ? new Date(opt('--now')!) : new Date();
      const due = dueRun(now);
      if (!due) {
        console.log(`• ${WORKER_TIMEZONE}: ещё рано — ежедневный прогон начинается в 06:00 по местному времени.`);
        return;
      }
      const r = await runWorkerJob(pool, { feed: 'fixture', asOf: due.asOf });
      print(r);
      if (r.status === 'failed' || r.status === 'partial' || r.status === 'exhausted') process.exitCode = 1;
    } else if (cmd === 'status') {
      const o = await machineOverview(pool, 'fixture');
      console.log(`Лента: fixture (эмуляция) · часовой пояс ${o.timezone} · сегодня ${o.today}`);
      console.log(`Последний прогон: ${o.latestRun ? `${o.latestRun.asOf} · ${o.latestRun.status}` : '—'}; последний успешный: ${o.lastSuccess?.asOf ?? '—'}${o.stale ? ' (УСТАРЕЛ)' : ''}`);
      if (o.snapshot) for (const e of o.snapshot.entries) console.log(`  #${e.rank} ${e.marketScore} ${e.title}`);
      console.log(`Отложено/на наблюдении: ${o.watchlist.length}; расход за месяц: ${o.costs.month}`);
    } else {
      console.error('Команды: run --fixture --as-of YYYY-MM-DD | tick --fixture [--now ISO] | status --fixture');
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`✖ ${(e as Error).message}`);
  process.exitCode = 1;
});
