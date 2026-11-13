/**
 * Autonomous research worker CLI. No approval step, no human in the loop.
 *
 * Fixture (offline emulation):
 *   npm run research:worker:run    -- --fixture --as-of YYYY-MM-DD [--budget N] [--monthly-budget N]
 *   npm run research:worker:tick   -- --fixture [--now 2026-11-12T00:30:00Z]   (what a timer would call)
 *   npm run research:worker:status -- --fixture | --live
 *
 * Live (VL-004B):
 *   npm run research:worker:run -- --live --once --dry-run [--as-of D]
 *       configuration, readiness and worst-case cost plan — NO network request of any kind;
 *   npm run research:worker:run -- --live --once --execute --max-spend-rub N [--as-of D]
 *       Phase B ONLY (founder-authorised): real paid calls, hard ceiling N ₽ for this job. Requires
 *       VL_LIVE_PROVIDER=yandex, YANDEX_FOLDER_ID and YANDEX_API_KEY / YANDEX_IAM_TOKEN in the environment.
 *   There is no scheduled live run (tick --live is refused).
 */
import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { describeConfig, loadLiveConfig, readinessProblems } from '../live/config';
import { NodeTransport, systemResolver } from '../live/net/transport';
import { livePlan, liveRunOptions } from '../live/run';
import { machineOverview } from '../machine/read';
import { dueRun, localToday } from '../machine/schedule';
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
    for (const e of r.snapshot.entries) console.log(`   #${String(e.rank).padEnd(2)} ${String(e.score).padStart(3)}  ${e.externalId}${e.carriedFrom ? ` (оценка от ${e.carriedFrom})` : ''}`);
  }
}

const rub = (kop: number) => (Number.isFinite(kop) ? `${(kop / 100).toFixed(2)} ₽` : 'не ограничено (нет тарифа модели)');

/** --live: dry-run (no network) or Phase B execute. Returns true when handled. */
async function live(): Promise<void> {
  if (cmd !== 'run' && cmd !== 'status') {
    console.error('Живой режим: только разовый запуск `run --live --once --dry-run|--execute`. Расписания для live в Phase A нет.');
    process.exitCode = 2;
    return;
  }
  if (cmd === 'status') {
    const pool = createPool(loadConfig().databaseUrl);
    try {
      const o = await machineOverview(pool, 'live');
      console.log(`Лента: live · последний прогон: ${o.latestRun ? `${o.latestRun.asOf} · ${o.latestRun.status}` : '—'}`);
      if (o.snapshot) for (const e of o.snapshot.entries) console.log(`  #${e.rank} ${e.marketScore} ${e.title}${e.carried ? ` (оценка от ${e.assessedAsOf})` : ''}`);
    } finally {
      await pool.end();
    }
    return;
  }
  const dry = flags.has('--dry-run');
  const execute = flags.has('--execute');
  if (dry === execute || !flags.has('--once')) {
    console.error('Укажите ровно один режим: --live --once --dry-run (без сети) или --live --once --execute --max-spend-rub N (только Phase B).');
    process.exitCode = 2;
    return;
  }
  const cfg = loadLiveConfig();
  const problems = readinessProblems(cfg);
  const asOf = opt('--as-of') ?? localToday(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('Укажите --as-of YYYY-MM-DD');
  if (dry) {
    console.log('• DRY-RUN: сетевые запросы не выполняются (ни поиск, ни модели, ни страницы).');
    console.log('Конфигурация:');
    for (const [k, v] of Object.entries(describeConfig(cfg))) console.log(`  ${k}: ${v}`);
    const plan = livePlan(cfg);
    console.log(`Тарифы ${plan.tariffs.version}: поиск ${plan.tariffs.searchPerRequestKop} коп./запрос; аналитик ${plan.tariffs.analyst} ${JSON.stringify(plan.tariffs.analystTariff)} ₽/1000 токенов; скептик ${plan.tariffs.skeptic} ${JSON.stringify(plan.tariffs.skepticTariff)} ₽/1000 токенов`);
    console.log(`Границы прогона: кандидатов ≤ ${plan.bounds.candidates}, поисковых запросов ≤ ${plan.bounds.searches}, страниц ≤ ${plan.bounds.reads}, вызовов моделей ≤ ${plan.bounds.llmCalls}`);
    console.log(`Худший случай по лимитам: ${rub(plan.worstCaseKop)} (${plan.note})`);
    console.log(problems.length ? `✖ Платный запуск сейчас невозможен: ${problems.join('; ')}` : '✔ Конфигурация готова; платный запуск требует отдельного разрешения (Phase B) и --execute --max-spend-rub N.');
    return;
  }
  // ---- execute: Phase B only
  if (process.env.CI) throw new Error('Платные live-вызовы запрещены в CI.');
  // Separate fail-closed activation flag: credentials alone never enable paid calls.
  if (process.env.VL_LIVE_EXECUTE !== 'phase-b-authorized') throw new Error('Платный запуск не активирован: требуется VL_LIVE_EXECUTE=phase-b-authorized (ставится только после разрешения Phase B).');
  if (problems.length) throw new Error(`Платный запуск невозможен: ${problems.join('; ')}`);
  const maxRub = Number(opt('--max-spend-rub'));
  if (!Number.isFinite(maxRub) || maxRub <= 0 || maxRub > 100_000) throw new Error('Укажите --max-spend-rub N (0 < N ≤ 100000) — жёсткий потолок расходов этого задания.');
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const opts = liveRunOptions(cfg, { providerTransport: new NodeTransport(), webTransport: new NodeTransport(), resolver: systemResolver }, { asOf, budgetKop: Math.floor(maxRub * 100) });
    console.log(`• LIVE: ${asOf}, потолок задания ${maxRub} ₽, месячный лимит ${rub(cfg.monthlyBudgetKop)}; модели ${cfg.analystModel} / ${cfg.skepticModel}.`);
    const r = await runWorkerJob(pool, opts);
    print(r);
    if (r.spent !== undefined) console.log(`  Учтено в журнале: ${rub(r.spent)} (лимит приложения не заменяет бюджет и оповещения в Yandex Cloud Billing).`);
    if (r.status !== 'succeeded' && r.status !== 'already-succeeded') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function main() {
  if (flags.has('--live') && flags.has('--fixture')) {
    console.error('Выберите одну ленту: --fixture или --live.');
    process.exitCode = 2;
    return;
  }
  if (flags.has('--live')) return live();
  if (!flags.has('--fixture')) {
    console.error('Укажите ленту: --fixture (эмуляция на фикстурах) или --live --once --dry-run (проверка живой конфигурации без сети).');
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
