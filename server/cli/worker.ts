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
 *   Phase B ONLY (founder-authorised), one gate for every paid action (server/live/gate.ts):
 *   npm run research:worker:run -- --live --once --execute --probe --max-spend-rub 5
 *   npm run research:worker:run -- --live --once --execute --stage stage2 --seeds research/phase-b/seeds-stage2.json --no-discovery --max-spend-rub 60
 *   npm run research:worker:run -- --live --once --execute --stage stage3 --seeds research/phase-b/seeds-stage3.json --no-discovery --max-spend-rub 235
 *       requires VL_LIVE_PROVIDER=yandex, YANDEX_FOLDER_ID, YANDEX_API_KEY|YANDEX_IAM_TOKEN, VL_LIVE_EXECUTE=phase-b-authorized,
 *       VL_TRIAL_ID, VL_TRIAL_BUDGET_RUB (≤ 300); never in CI; no --as-of (real date); exclusive (no parallel paid runs).
 *   npm run research:worker:export -- --live --trial <id> --out review.csv     (independent manual review, no network)
 *   npm run research:worker:recover -- --live --trial <id> --stage stage2 --mark-incomplete [--apply]
 *       audited reclassification of a technically unfinished stage «succeeded → incomplete» (DB only, no network);
 *       then `--execute --stage stage2 … --retry` starts a NEW run of the stage (separately authorised).
 *   There is no scheduled live run (tick --live is refused).
 */
import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeConfig, loadLiveConfig, readinessProblems, type LiveConfig } from '../live/config';
import { paidRunGate, STAGE_CAPS_RUB, TRIAL_BUDGET_RUB } from '../live/gate';
import { NodeTransport, systemResolver } from '../live/net/transport';
import { describeProviderRoute, providerTransportFromEnv, proxyFromEnv, type ProviderTransport } from '../live/net/provider-proxy';
import { CapturingTransport, defaultRawDir } from '../live/raw-capture';
import { livePlan, parseSeeds, runPaidStage } from '../live/run';
import { reclassifyIncompleteStage } from '../live/recover';
import { exportReviewCsv } from '../machine/export';
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
  const icon = r.status === 'succeeded' ? '✔' : r.status === 'already-succeeded' || r.status === 'already-running' ? '•' : r.status === 'incomplete' || r.status === 'already-incomplete' ? '⚠' : '✖';
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
  if (cmd === 'export') return exportCsv();
  if (cmd === 'recover') return recover();
  if (cmd !== 'run' && cmd !== 'status') {
    console.error('Живой режим: только разовый запуск `run --live --once --dry-run|--execute`. Расписания для live нет.');
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
  if (dry && (flags.has('--execute') || flags.has('--probe'))) {
    console.error('--dry-run несовместим с --execute/--probe.');
    process.exitCode = 2;
    return;
  }
  if (dry) {
    if (!flags.has('--once')) {
      console.error('Укажите --live --once --dry-run.');
      process.exitCode = 2;
      return;
    }
    const cfg = loadLiveConfig();
    const problems = readinessProblems(cfg);
    console.log('• DRY-RUN: сетевые запросы не выполняются (ни поиск, ни модели, ни страницы).');
    console.log('Конфигурация:');
    for (const [k, v] of Object.entries(describeConfig(cfg))) console.log(`  ${k}: ${v}`);
    const plan = livePlan(cfg);
    console.log(`Тарифы ${plan.tariffs.version}: поиск ${plan.tariffs.searchPerRequestKop} коп./запрос; аналитик ${plan.tariffs.analyst} ${JSON.stringify(plan.tariffs.analystTariff)} ₽/1000 токенов; скептик ${plan.tariffs.skeptic} ${JSON.stringify(plan.tariffs.skepticTariff)} ₽/1000 токенов`);
    console.log(`Границы прогона: кандидатов ≤ ${plan.bounds.candidates}, поисковых запросов ≤ ${plan.bounds.searches}, страниц ≤ ${plan.bounds.reads}, вызовов моделей ≤ ${plan.bounds.llmCalls}`);
    console.log(`Худший случай по лимитам: ${rub(plan.worstCaseKop)} (${plan.note})`);
    console.log(`Испытание Phase B: общий потолок ${TRIAL_BUDGET_RUB} ₽; ступени probe ${STAGE_CAPS_RUB.probe} ₽ · stage2 ${STAGE_CAPS_RUB.stage2} ₽ · stage3 ${STAGE_CAPS_RUB.stage3} ₽; поиск не чаще 1 запроса в ${cfg.searchMinIntervalMs} мс.`);
    try {
      console.log(`Маршрут платных запросов: ${describeProviderRoute(proxyFromEnv(process.env))}`);
    } catch (e) {
      problems.push((e as Error).message);
    }
    console.log(problems.length ? `✖ Платный запуск сейчас невозможен: ${problems.join('; ')}` : '✔ Конфигурация готова; платный запуск требует отдельного разрешения (Phase B), VL_LIVE_EXECUTE и --execute.');
    return;
  }
  // ---- paid execution (probe or stage): Phase B only — one gate for both, before any DB or network I/O
  let cfg: LiveConfig | null = null;
  let cfgError: string | undefined;
  try {
    cfg = loadLiveConfig();
  } catch (e) {
    cfgError = (e as Error).message;
  }
  const maxSpend = opt('--max-spend-rub');
  const gate = paidRunGate(process.env, {
    once: flags.has('--once'),
    execute: flags.has('--execute'),
    probe: flags.has('--probe'),
    stage: opt('--stage'),
    maxSpendRub: maxSpend === undefined ? undefined : Number(maxSpend),
    asOf: opt('--as-of'),
    seedsFile: opt('--seeds'),
    noDiscovery: flags.has('--no-discovery'),
    retry: flags.has('--retry'),
  }, cfg, cfgError);
  if (!gate.ok) {
    console.error('✖ Платный запуск отклонён (ни одного запроса не сделано):');
    for (const p of gate.problems) console.error(`  - ${p}`);
    process.exitCode = 2;
    return;
  }
  // Provider route (HTTPS_PROXY tunnel for the two paid endpoints, else direct). Fail closed before any I/O.
  let providerTransport: ProviderTransport;
  try {
    providerTransport = providerTransportFromEnv(process.env);
  } catch (e) {
    console.error('✖ Платный запуск отклонён (ни одного запроса не сделано):');
    console.error(`  - ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const seeds = opt('--seeds') ? parseSeeds(JSON.parse(readFileSync(opt('--seeds')!, 'utf8'))) : undefined;
  const rawDir = defaultRawDir(gate.trial.id); // records go to <rawDir>/<trial_id_stage>/attempt-<n>/ — never overwritten
  const lockFile = process.env.VL_LOCK_FILE ?? join(homedir(), '.venture-lab', 'live-paid.lock');
  const capture = new CapturingTransport(providerTransport, rawDir, [process.env.YANDEX_API_KEY, process.env.YANDEX_IAM_TOKEN, cfg!.folderId]);
  const pool = createPool(loadConfig().databaseUrl);
  try {
    console.log(`• Маршрут платных запросов: ${describeProviderRoute(providerTransport.proxy)}`);
    console.log(`• LIVE ${gate.trial.stage}: испытание ${gate.trial.id}, потолок ступени ${gate.maxSpendKop / 100} ₽, общий потолок ${gate.trial.budgetKop / 100} ₽; модели ${cfg!.analystModel} / ${cfg!.skepticModel}; сырые ответы → ${rawDir}`);
    const r = await runPaidStage(pool, cfg!, gate, { providerTransport: capture, webTransport: new NodeTransport(), resolver: systemResolver }, { seeds, lockFile, retry: flags.has('--retry') });
    print(r);
    if (r.probe) for (const c of r.probe) console.log(`  ${c.required ? (c.ok ? '✔' : '✖') : c.ok ? 'ℹ✔' : 'ℹ'} ${c.check}: ${c.detail}`);
    if (r.spent !== undefined) console.log(`  Учтено в журнале: ${rub(r.spent)} (лимит приложения не заменяет бюджет и оповещения в Yandex Cloud Billing).`);
    console.log(`  Сырые ответы (без секретов): ${capture.files.length} файлов в ${rawDir}`);
    if (r.status !== 'succeeded' || (r.probe && r.probe.some((c) => c.required && !c.ok))) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

/** export --live --trial <id> | --job <key> --out <file>: CSV for an independent manual review (no network). */
async function exportCsv(): Promise<void> {
  const out = opt('--out');
  if (!out) throw new Error('Укажите --out <файл.csv>');
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const r = await exportReviewCsv(pool, { trialId: opt('--trial'), jobKey: opt('--job') });
    writeFileSync(out, r.csv, { mode: 0o600 });
    console.log(`✔ ${r.rows} строк → ${out}`);
  } finally {
    await pool.end();
  }
}

/** Audited reclassification `succeeded → incomplete` of a technically unfinished trial stage (DB only, no network). */
async function recover(): Promise<void> {
  const trial = opt('--trial');
  const stage = opt('--stage');
  if (!trial || (stage !== 'stage2' && stage !== 'stage3') || !flags.has('--mark-incomplete')) {
    console.error('Укажите: recover --live --trial <id> --stage stage2|stage3 --mark-incomplete [--apply]  (без --apply — только проверка)');
    process.exitCode = 2;
    return;
  }
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const r = await reclassifyIncompleteStage(pool, trial, stage, { apply: flags.has('--apply') });
    console.log(`${r.applied ? '✔ ПРИМЕНЕНО' : r.ok ? '• ПРОВЕРКА (без --apply ничего не изменено)' : '✖ ОТКАЗ'}: ${r.jobKey ?? '—'} (прогон ${r.run ?? '—'}), статус «${r.from ?? '—'}»${r.applied ? ' → «incomplete»' : ''}`);
    for (const p of r.problems) console.log(`  - ${p}`);
    if (r.evidence) {
      for (const h of r.evidence.technicalHolds) console.log(`  технический отказ: ${h.candidate} — ${h.findings.join('; ')}`);
      console.log(`  утверждений со скептиком: ${r.evidence.reviewedClaims}; конкурентов: ${r.evidence.competitors}; снимков: ${r.evidence.snapshots}`);
      console.log(`  попытки: ${r.evidence.attempts.map((a) => `#${a.attempt} ${a.status} (${a.used ?? a.reserved} коп.)`).join(', ')}; журнал: ${r.evidence.usage.rows} записей, ${rub(r.evidence.usage.committedKop)}, из них unknown ${rub(r.evidence.usage.unknownKop)} — не изменяется`);
    }
    if (!r.ok) process.exitCode = 2;
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
