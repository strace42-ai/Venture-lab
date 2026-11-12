/**
 * npm run research:validate -- <file>            schema-only check, no database access
 * npm run research:import   -- <file>            DRY-RUN: diff against the DB, writes nothing
 * npm run research:import   -- <file> --apply    write everything in one transaction
 * npm run research:snapshot -- [--as-of YYYY-MM-DD] [--id top10-...] [--apply]
 *
 * Files are only read from inside research/ (e.g. research/inbox, research/examples).
 */
import { userInfo } from 'node:os';
import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { FileAccessError, readResearchFile } from '../research/files';
import { applyImport, dryRunImport, validateResearch, type Diagnostic, type ImportPlan } from '../research/importer';
import { createSnapshot } from '../research/snapshot';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const opt = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !['--as-of', '--id', '--actor'].includes(rest[i - 1] ?? ''));
const actor = opt('--actor') ?? process.env.VL_ACTOR ?? `local:${safeUser()}`;

function safeUser(): string {
  try {
    return userInfo().username.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'founder';
  } catch {
    return 'founder';
  }
}

function printDiagnostics(d: Diagnostic[]) {
  for (const x of d) console.log(`  ${x.level === 'error' ? '✖' : '⚠'} ${x.path}: ${x.message}`);
}

function printPlan(p: ImportPlan, mode: 'dry-run' | 'apply') {
  const c = p.counts;
  console.log(`Файл: ${p.fileName}  sha256 ${p.checksum.slice(0, 16)}…`);
  if (p.runId) console.log(`Прогон: ${p.runId}  ·  ${p.origin}${p.synthetic ? '  ·  СИНТЕТИЧЕСКИЕ ТЕСТОВЫЕ ДАННЫЕ' : ''}`);
  console.log(`Статус: ${p.status}${mode === 'dry-run' ? '  (dry-run: ничего не записано)' : ''}`);
  if (p.status === 'ready' || p.status === 'invalid') {
    console.log(`Идеи:        +${c.ideas.inserted} новых, ~${c.ideas.updated} обновлённых, =${c.ideas.unchanged} без изменений`);
    console.log(`Источники:   +${c.evidence.inserted} новых, =${c.evidence.unchanged} без изменений, ${c.evidence.reviewsAppended} смен статуса, ${c.evidence.downgraded} понижено до unreviewed`);
    console.log(`Конкуренты:  +${c.competitors.inserted}, =${c.competitors.unchanged}`);
    console.log(`Оценки:      +${c.assessments.inserted} ревизий, =${c.assessments.unchanged} без изменений`);
    console.log(`Стадии:      +${c.stageTransitions} переходов, отклонено идей: ${c.rejectedIdeas}`);
    for (const i of p.ideas) console.log(`  • ${i.externalId} [${i.change}]${i.notes.length ? ' — ' + i.notes.join('; ') : ''}`);
  }
  if (p.diagnostics.length) {
    console.log('Диагностика:');
    printDiagnostics(p.diagnostics);
  }
}

async function main() {
  if (cmd === 'validate') {
    const file = readResearchFile(positional[0] ?? '');
    const v = validateResearch(file.bytes);
    console.log(`Файл: ${file.name}  sha256 ${file.checksum.slice(0, 16)}…`);
    if (v.envelope) console.log(`Схема vl-research-1 ✔  прогон ${v.envelope.runId}, идей: ${v.envelope.ideas.length}${v.envelope.synthetic ? ' (синтетические)' : ''}`);
    printDiagnostics(v.diagnostics);
    if (!v.ok) {
      console.log('✖ Файл НЕ прошёл проверку.');
      process.exitCode = 1;
    } else console.log('✔ Файл валиден. Для сравнения с базой: npm run research:import -- <файл>');
    return;
  }

  const { databaseUrl } = loadConfig();
  const pool = createPool(databaseUrl);
  try {
    if (cmd === 'import') {
      const file = readResearchFile(positional[0] ?? '');
      if (flags.has('--apply')) {
        const r = await applyImport(pool, file, { actor });
        printPlan(r, 'apply');
        if (r.applied) console.log('✔ Импорт записан в базу (одна транзакция).');
        else if (r.status === 'already-imported') console.log('= Повторный импорт того же файла — ничего не изменено.');
        else {
          console.log('✖ Импорт отклонён — в базу ничего не записано.');
          process.exitCode = 1;
        }
      } else {
        const p = await dryRunImport(pool, file);
        printPlan(p, 'dry-run');
        if (p.status === 'ready') console.log('Для записи повторите с --apply.');
        else if (p.status !== 'already-imported') process.exitCode = 1;
      }
    } else if (cmd === 'snapshot') {
      const r = await createSnapshot(pool, { asOf: opt('--as-of'), id: opt('--id'), apply: flags.has('--apply'), actor });
      console.log(r.message);
      for (const e of r.entries.slice(0, 10)) console.log(`  #${e.rank}  ${String(e.score).padStart(3)}  ув.${String(e.confidence).padStart(3)}  ${e.title}`);
      if (r.entries.length > 10) console.log(`  … ещё ${r.entries.length - 10} позиций сохраняются для точного расчёта движения`);
      if (r.status === 'conflict' || r.status === 'invalid') process.exitCode = 1;
    } else {
      console.error('Команды: validate <file> | import <file> [--apply] | snapshot [--as-of YYYY-MM-DD] [--id ID] [--apply]');
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  if (e instanceof FileAccessError) console.error(`✖ ${e.message}`);
  else if ((e as { code?: string }).code === 'ECONNREFUSED') console.error('✖ Нет соединения с PostgreSQL. Запустите: docker compose up -d db && npm run db:migrate');
  else console.error(`✖ Ошибка: ${(e as Error).message}`);
  process.exitCode = 1;
});
