/**
 * npm run research:validate -- <file>            schema-only check, no database access
 * npm run research:import   -- <file>            DRY-RUN: diff against the DB, writes nothing
 * npm run research:import   -- <file> --apply    write everything in one transaction
 * npm run research:snapshot -- [--as-of YYYY-MM-DD] [--id top10-...] [--dataset real|test] [--apply]
 * npm run research:draft-check -- <file>         draft structure/coverage/duplicates (never «truth»)
 * npm run research:review -- --dataset real|test --idea <id> --evidence <id> --status checked|rejected|unreviewed
 *                             --reason "что проверено" [--actor "Имя"] [--apply]
 *   (default dataset: real — synthetic test imports are snapshotted only with --dataset test)
 *
 * Files are only read from inside research/ (e.g. research/inbox, research/examples).
 */
import { userInfo } from 'node:os';
import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { FileAccessError, readResearchFile } from '../research/files';
import { checkDraft } from '../research/draft';
import { applyGate, applyImport, dryRunImport, validateResearch, type Diagnostic, type ImportPlan } from '../research/importer';
import { reviewEvidence } from '../research/review';
import { createSnapshot } from '../research/snapshot';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const opt = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const VALUE_FLAGS = ['--as-of', '--id', '--actor', '--dataset', '--idea', '--evidence', '--status', '--reason'];
const positional = rest.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(rest[i - 1] ?? ''));
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
        if (r.status === 'blocked') {
          console.log('⛔ Импорт заблокирован шлюзом одобрения — в базу ничего не записано.');
          process.exitCode = 1;
        } else if (r.applied) {
          console.log('✔ Импорт записан в базу (одна транзакция).');
          if (r.synthetic) console.log('ℹ Синтетические данные изолированы: они видны только в режиме «Тестовые импорты» и никогда не попадают в REAL-рейтинг, KPI и срезы.');
        }
        else if (r.status === 'already-imported') console.log('= Повторный импорт того же файла — ничего не изменено.');
        else {
          console.log('✖ Импорт отклонён — в базу ничего не записано.');
          process.exitCode = 1;
        }
      } else {
        const p = await dryRunImport(pool, file);
        printPlan(p, 'dry-run');
        const gate = applyGate(p.envelope, file);
        if (p.status === 'ready' && !gate.allowed) {
          console.log('⛔ Этот файл НЕЛЬЗЯ применить (шлюз одобрения):');
          for (const r of gate.reasons) console.log(`  • ${r}`);
        } else if (p.status === 'ready') console.log('Для записи повторите с --apply.');
        else if (p.status !== 'already-imported') process.exitCode = 1;
      }
    } else if (cmd === 'draft-check') {
      const file = readResearchFile(positional[0] ?? '');
      let report;
      try {
        report = await checkDraft(file.bytes, pool);
      } catch {
        report = await checkDraft(file.bytes); // DB unavailable: structure-only check
        console.log('ℹ База недоступна — сравнение URL с REAL пропущено.');
      }
      console.log(`Файл: ${file.name} · source=${report.source ?? '?'} · прогон ${report.runId ?? '?'}`);
      console.log('Проверяется только структура и покрытие источниками — НЕ истинность утверждений. Существующий URL ≠ доказательство.');
      for (const i of report.ideas) {
        console.log(`  • ${i.externalId}: источники ${i.sources.total} (Запад ${i.sources.west}, РФ ${i.sources.ru}); конкуренты Запад ${i.competitors.west} / РФ ${i.competitors.ru}; оценка: ${i.assessment === 'present' ? `есть, неизвестных критериев ${i.unknownDimensions}` : 'нет'}`);
        printDiagnostics(i.findings);
      }
      if (report.findings.length) printDiagnostics(report.findings);
      console.log(`Вердикт: ${report.verdict === 'ready-for-founder-review' ? 'готов к проверке основателем (НЕ одобрен)' : report.verdict === 'needs-work' ? 'требует доработки' : 'не проходит схему'}`);
      for (const n of report.nextSteps) console.log(`  → ${n}`);
      if (report.verdict !== 'ready-for-founder-review') process.exitCode = 1;
    } else if (cmd === 'review') {
      const ds = opt('--dataset');
      const r = await reviewEvidence(
        pool,
        { dataset: ds, ideaId: opt('--idea'), evidenceId: opt('--evidence'), status: opt('--status'), reason: opt('--reason'), actor },
        { apply: flags.has('--apply') },
      );
      if (r.evidence) {
        const e = r.evidence;
        console.log(`Идея: ${e.ideaTitle} (${e.ideaId}) · источник ${e.evidenceId}`);
        console.log(`Утверждение: ${e.claim}`);
        console.log(`Ссылка: ${e.url ?? '— нет'} · издатель: ${e.publisher ?? '—'} · наблюдение: ${e.observedAt ?? '—'}`);
        console.log(`Текущий статус: ${e.currentStatus}. История:`);
        for (const h of e.history) console.log(`  ${h.at.slice(0, 16).replace('T', ' ')} UTC  ${h.status.padEnd(10)} ${h.origin === 'manual' ? 'вручную' : 'импорт'} · ${h.actor ?? '—'}${h.reason ? ` · «${h.reason}»` : ''}`);
      }
      console.log(`${r.applied ? '✔' : r.status === 'ready' ? '·' : r.status === 'unchanged' ? '=' : '✖'} ${r.message}`);
      if (r.status === 'ready' && !r.applied) console.log('Это dry-run. Для записи повторите с --apply.');
      if (r.status === 'invalid' || r.status === 'not-found') process.exitCode = 1;
    } else if (cmd === 'snapshot') {
      const ds = opt('--dataset') ?? 'real';
      if (ds !== 'real' && ds !== 'test') throw new Error('--dataset должен быть real или test');
      const r = await createSnapshot(pool, { asOf: opt('--as-of'), id: opt('--id'), apply: flags.has('--apply'), actor, dataset: ds });
      console.log(`Набор данных: ${ds === 'real' ? 'реальные исследования' : 'ТЕСТОВЫЕ синтетические импорты'}`);
      console.log(r.message);
      for (const e of r.entries.slice(0, 10)) console.log(`  #${e.rank}  ${String(e.score).padStart(3)}  ув.${String(e.confidence).padStart(3)}  ${e.title}`);
      if (r.entries.length > 10) console.log(`  … ещё ${r.entries.length - 10} позиций сохраняются для точного расчёта движения`);
      if (r.status === 'conflict' || r.status === 'invalid') process.exitCode = 1;
    } else {
      console.error(
        'Команды: validate <file> | draft-check <file> | import <file> [--apply] | review --dataset real|test --idea ID --evidence ID --status checked|rejected|unreviewed --reason "…" [--actor NAME] [--apply] | snapshot [--as-of YYYY-MM-DD] [--id ID] [--dataset real|test] [--apply]',
      );
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
