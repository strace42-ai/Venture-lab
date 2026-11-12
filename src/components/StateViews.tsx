import { CloudOff, DatabaseZap, FileJson, RotateCw } from 'lucide-react';
import { useDataSource } from '../data/context';
import { ApiError } from '../data/source';
import type { OverviewView } from '../domain/selectors';
import { formatDateLong } from '../lib/format';

/** REAL mode: the API/DB is unavailable or returned an error. Never falls back to demo silently. */
export function LoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { setMode } = useDataSource();
  const unavailable = error instanceof ApiError && error.kind === 'unavailable';
  return (
    <div className="page">
      <div className="panel state-panel" role="alert">
        <div className="state-panel__icon state-panel__icon--danger" aria-hidden>
          <CloudOff size={22} />
        </div>
        <h1 className="state-panel__title">{unavailable ? 'Локальная база исследований недоступна' : 'Не удалось загрузить данные'}</h1>
        <p className="state-panel__body">{error.message}</p>
        {unavailable && (
          <ol className="state-steps">
            <li>
              <code>docker compose up -d db</code> — запустить PostgreSQL
            </li>
            <li>
              <code>npm run db:migrate</code> — применить миграции
            </li>
            <li>
              <code>npm run api</code> — запустить локальный API (127.0.0.1:8787)
            </li>
          </ol>
        )}
        <p className="fineprint">Данные не подменяются другим источником автоматически: режимы «Реальные», «Тест» и «Демо» никогда не смешиваются.</p>
        <div className="state-panel__actions">
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            <RotateCw size={16} aria-hidden /> Повторить
          </button>
          {setMode && (
            <button type="button" className="btn btn--ghost" onClick={() => setMode('demo')}>
              Открыть демо-режим
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** REAL mode with an empty database: honest «no research imported yet». */
export function RealEmptyState({ view }: { view: OverviewView }) {
  const { setMode } = useDataSource();
  if (view.mode === 'test') {
    return (
      <div className="page page--overview">
        <header className="page-head">
          <div className="eyebrow">Обзор · тестовые импорты · {formatDateLong(view.asOf)}</div>
          <h1 className="display">Тестовых импортов нет.</h1>
          <p className="page-head__lede">
            Этот режим показывает только синтетические тестовые импорты (<code>source: "synthetic-test"</code>). Они изолированы от реальных исследований и никогда не попадают в их рейтинг, KPI и срезы.
          </p>
        </header>
        <div className="panel state-panel state-panel--wide">
          <div className="state-panel__icon" aria-hidden>
            <FileJson size={22} />
          </div>
          <h2 className="state-panel__title">Как загрузить синтетический пример</h2>
          <ol className="state-steps">
            <li>
              <code>npm run research:import -- research/examples/synthetic-run-1.json --apply</code>
            </li>
            <li>
              Срез тестового набора: <code>npm run research:snapshot -- --dataset test --apply</code>
            </li>
            <li>Обновите страницу.</li>
          </ol>
        </div>
      </div>
    );
  }
  return (
    <div className="page page--overview">
      <header className="page-head">
        <div className="eyebrow">Обзор · реальные данные · {formatDateLong(view.asOf)}</div>
        <h1 className="display">Исследования ещё не импортированы.</h1>
        <p className="page-head__lede">
          База реальных исследований пуста. Здесь появятся только идеи из проверенного JSON-исследования (схема <code>vl-research-1</code>) — без выдуманных источников, баллов и оплат.
        </p>
      </header>
      <div className="panel state-panel state-panel--wide">
        <div className="state-panel__icon" aria-hidden>
          <DatabaseZap size={22} />
        </div>
        <h2 className="state-panel__title">Как загрузить первое исследование</h2>
        <ol className="state-steps">
          <li>
            Положите проверенный файл в <code>research/inbox/</code> (пример схемы — <code>research/examples/</code>).
          </li>
          <li>
            Проверьте без записи: <code>npm run research:import -- research/inbox/&lt;файл&gt;.json</code>
          </li>
          <li>
            Запишите в базу: <code>npm run research:import -- research/inbox/&lt;файл&gt;.json --apply</code>
          </li>
          <li>
            При необходимости зафиксируйте срез ТОП-10: <code>npm run research:snapshot -- --apply</code>
          </li>
          <li>Обновите страницу.</li>
        </ol>
        <p className="fineprint">
          <FileJson size={12} aria-hidden /> Синтетические примеры из <code>research/examples/</code> сюда не попадают: они видны только в режиме «Тестовые импорты».
        </p>
        {setMode && (
          <div className="state-panel__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setMode('demo')}>
              Посмотреть демо-режим
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
