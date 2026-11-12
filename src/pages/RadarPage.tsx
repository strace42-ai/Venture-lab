import { AlertTriangle, ArrowUpRight, DatabaseZap, LayoutGrid, List, SearchX, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LoadError } from '../components/StateViews';
import { Segmented } from '../components/ui/Segmented';
import { Badge, ConfidenceMeter, DemoBadge, EmptyState, MovementIndicator, ScoreBar, Skeleton, StageBadge, SyntheticBadge } from '../components/ui/primitives';
import { useDataSource, useLoad, useMode } from '../data/context';
import { RISK_LABEL, STAGE_LABEL, STAGE_ORDER } from '../domain/labels';
import { IntegrityFlag } from '../components/IntegrityNotice';
import { hasCriticalRisk, type RadarQuery, type RadarRow, type RadarSort, type RadarView } from '../domain/selectors';
import type { Stage } from '../domain/types';
import { isLiveMode } from '../domain/types';
import { cx } from '../lib/cx';
import { formatDateShort, plural } from '../lib/format';

type View = 'table' | 'cards';

const SORTS: RadarSort[] = ['score', 'confidence', 'recent'];

export default function RadarPage() {
  const { source, mode } = useDataSource();
  const [params, setParams] = useSearchParams();

  const rawStage = params.get('stage');
  const rawSort = params.get('sort');
  const rawPage = Number(params.get('page') ?? '1');
  const query: RadarQuery = {
    q: params.get('q') ?? '',
    category: params.get('cat') ?? 'all',
    stage: rawStage && (STAGE_ORDER as string[]).includes(rawStage) ? (rawStage as Stage) : 'all',
    sort: rawSort && (SORTS as string[]).includes(rawSort) ? (rawSort as RadarSort) : 'score',
  };
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const view: View = params.get('view') === 'cards' ? 'cards' : 'table';

  // Debounce typing only for the network-backed REAL source.
  const q = useDebounced(query.q, isLiveMode(mode) ? 250 : 0);
  const loadQuery = { ...query, q };
  const state = useLoad(`radar:${mode}:${JSON.stringify(loadQuery)}:${page}`, () => source.radar(loadQuery, page));
  // While a NEW query of the SAME source loads, keep showing the previous result (no flicker while
  // typing). The cache is tagged with the source it came from and is never used for another source,
  // and never on error: an error is shown as an error, not as stale rows.
  const [last, setLast] = useState<{ mode: typeof mode; view: RadarView } | null>(null);
  if (state.status === 'ready' && (last?.view !== state.data || last.mode !== mode)) setLast({ mode, view: state.data });
  const data: RadarView | null = state.status === 'ready' ? state.data : state.status === 'loading' && last?.mode === mode ? last.view : null;

  const cats = data?.categories ?? [];
  const stages = useMemo(() => {
    const present = new Set(data?.stages ?? []);
    return STAGE_ORDER.filter((s) => present.has(s) || s === query.stage);
  }, [data, query.stage]);

  function update(key: string, value: string, defaultValue: string) {
    const next = new URLSearchParams(params);
    if (value === defaultValue || value === '') next.delete(key);
    else next.set(key, value);
    if (key !== 'page' && key !== 'view') next.delete('page');
    setParams(next, { replace: true });
  }

  const filtersActive = query.q !== '' || query.category !== 'all' || query.stage !== 'all';

  function reset() {
    const next = new URLSearchParams();
    if (query.sort !== 'score') next.set('sort', query.sort);
    if (view !== 'table') next.set('view', view);
    if (params.get('mode')) next.set('mode', params.get('mode')!);
    setParams(next, { replace: true });
  }

  const rows = data?.rows ?? [];
  const isReal = isLiveMode(mode);

  return (
    <div className="page page--radar">
      <header className="page-head">
        <div className="eyebrow">
          Радар возможностей
          <DemoBadge compact />
        </div>
        <h1 className="display display--sm">Все идеи, оценки и уверенность</h1>
        <p className="page-head__lede">
          {isReal
            ? 'Импортированные идеи из локальной базы исследований. Ранг — позиция в текущем рейтинге; идеи без оценки помечены «не оценено», отклонённые видны, но не ранжируются.'
            : 'Поиск, фильтры и сортировка работают по локальному демо-набору. Ранг — позиция в общем рейтинге; отклонённые идеи видны, но не ранжируются.'}
        </p>
      </header>

      <div className="panel filters" role="region" aria-label="Фильтры радара">
        <div className="filters__search">
          <label htmlFor="radar-q" className="field-label">
            Поиск
          </label>
          <div className="input-wrap">
            <input
              id="radar-q"
              type="search"
              className="input"
              placeholder="Название, аудитория, категория…"
              value={query.q}
              onChange={(e) => update('q', e.target.value, '')}
              autoComplete="off"
            />
          </div>
        </div>
        <div className="filters__field">
          <label htmlFor="radar-cat" className="field-label">
            Категория
          </label>
          <select id="radar-cat" className="select" value={query.category} onChange={(e) => update('cat', e.target.value, 'all')}>
            <option value="all">Все</option>
            {(cats.includes(query.category) || query.category === 'all' ? cats : [...cats, query.category]).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="filters__field">
          <label htmlFor="radar-stage" className="field-label">
            Стадия
          </label>
          <select id="radar-stage" className="select" value={query.stage} onChange={(e) => update('stage', e.target.value, 'all')}>
            <option value="all">Все</option>
            {stages.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="filters__field filters__sort">
          <span className="field-label" id="radar-sort-label">
            Сортировка
          </span>
          <Segmented<RadarSort>
            label="Сортировка"
            value={query.sort}
            onChange={(v) => update('sort', v, 'score')}
            options={[
              { value: 'score', label: 'Балл' },
              { value: 'confidence', label: 'Уверенность' },
              { value: 'recent', label: 'Свежие' },
            ]}
          />
        </div>
      </div>

      {state.status === 'error' ? (
        <LoadError error={state.error} onRetry={state.retry} />
      ) : !data ? (
        <div className="panel" aria-busy="true">
          <div className="panel__body radar-loading">
            <span className="sr-only">Загрузка…</span>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} h={22} />
            ))}
          </div>
        </div>
      ) : data.totalAll === 0 && isReal ? (
        <div className="panel">
          {mode === 'test' ? (
            <EmptyState icon={<DatabaseZap size={22} />} title="Тестовых импортов нет">
              Синтетические примеры импортируются командой <code>npm run research:import -- research/examples/synthetic-run-1.json --apply</code>.
            </EmptyState>
          ) : (
            <EmptyState icon={<DatabaseZap size={22} />} title="Исследования ещё не импортированы">
              База реальных исследований пуста. Импортируйте проверенный JSON (<code>npm run research:import -- &lt;файл&gt; --apply</code>) — подробности на странице «Обзор».
            </EmptyState>
          )}
        </div>
      ) : (
      <>
      <div className="results-bar">
        <p className="results-bar__count" aria-live="polite">
          <span className="num">{data.total}</span> {plural(data.total, 'идея', 'идеи', 'идей')} из {data.totalAll}
          {state.status === 'loading' && <span className="muted small"> · обновление…</span>}

          {filtersActive && (
            <button type="button" className="chip-btn" onClick={reset}>
              <X size={12} aria-hidden /> Сбросить фильтры
            </button>
          )}
        </p>
        <Segmented<View>
          label="Вид списка"
          size="sm"
          className="view-toggle"
          value={view}
          onChange={(v) => update('view', v, 'table')}
          options={[
            { value: 'table', label: 'Таблица', icon: <List size={14} aria-hidden /> },
            { value: 'cards', label: 'Карточки', icon: <LayoutGrid size={14} aria-hidden /> },
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<SearchX size={22} />}
            title="Ничего не найдено"
            action={
              <button type="button" className="btn btn--ghost" onClick={reset}>
                Сбросить фильтры
              </button>
            }
          >
            {isReal ? 'Под эти условия не подходит ни одна импортированная идея.' : 'Под эти условия не подходит ни одна идея из демо-набора.'} Отсутствие результата не означает отсутствия рынка.
          </EmptyState>
        </div>
      ) : (
        <div className={cx('radar', `radar--${view}`)}>
          {view === 'table' && <RadarTable rows={rows} />}
          <ul className="radar-cards" aria-label="Идеи">
            {rows.map((r) => (
              <RadarCard key={r.idea.id} row={r} />
            ))}
          </ul>
        </div>
      )}
      {data.total > data.pageSize && (
        <nav className="pager" aria-label="Страницы радара">
          <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => update('page', String(page - 1), '1')}>
            Назад
          </button>
          <span className="muted num">
            {(page - 1) * data.pageSize + 1}–{Math.min(page * data.pageSize, data.total)} из {data.total}
          </span>
          <button type="button" className="btn btn--ghost" disabled={page * data.pageSize >= data.total} onClick={() => update('page', String(page + 1), '1')}>
            Вперёд
          </button>
        </nav>
      )}
      </>
      )}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (ms === 0) return;
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return ms === 0 ? value : v;
}

function Unscored() {
  return (
    <span className="unscored" title="Оценка по рубрике v1.0 не импортирована — балл не присваивается">
      не оценено
    </span>
  );
}

function RadarTable({ rows }: { rows: RadarRow[] }) {
  const isReal = isLiveMode(useMode());
  return (
    <div className="panel table-wrap">
      <table className="table">
        <caption className="sr-only">Идеи на радаре</caption>
        <thead>
          <tr>
            <th scope="col" className="t-rank">Ранг</th>
            <th scope="col">Идея</th>
            <th scope="col">Стадия</th>
            <th scope="col" className="t-score">Балл</th>
            <th scope="col" className="t-conf">Уверенность</th>
            <th scope="col" className="t-fit" title="Соответствие основателю, 0–40 — не входит в балл">Fit</th>
            <th scope="col" className="t-risk">Риски</th>
            <th scope="col" className="t-upd">Обновлено</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const crit = hasCriticalRisk(r.idea);
            return (
              <tr key={r.idea.id} className={cx(r.idea.stage === 'rejected' && 'is-dim')}>
                <td className="t-rank">
                  {r.rank ? (
                    <span className="t-rank__inner">
                      <span className="num">#{r.rank}</span>
                      {r.entry && <MovementIndicator movement={r.entry.movement} scoreDelta={r.entry.scoreDelta} />}
                    </span>
                  ) : (
                    <span className="muted" title="Не ранжируется">—</span>
                  )}
                </td>
                <td>
                  <Link to={`/ideas/${r.idea.slug}`} className="t-idea">
                    <span className="t-idea__title">{r.idea.title}</span>
                    {r.idea.synthetic && isReal && <SyntheticBadge compact />}
                    <span className="t-idea__meta">
                      {r.idea.category} · {r.idea.segment}
                    </span>
                  </Link>
                  {r.entry && <IntegrityFlag integrity={r.entry.integrity} />}
                </td>
                <td>
                  <StageBadge stage={r.idea.stage} />
                </td>
                <td className="t-score">{r.score === null ? <Unscored /> : <ScoreBar value={r.score} label={`Балл ${r.score}`} />}</td>
                <td className="t-conf">{r.confidence === null ? <span className="muted">—</span> : <ConfidenceMeter value={r.confidence} />}</td>
                <td className="t-fit num">{r.founderFit ?? <span className="muted" title="Founder Fit не оценён">—</span>}</td>
                <td className="t-risk">
                  {r.idea.riskFlags.length ? (
                    <span className={cx('risk-count', crit && 'risk-count--crit')} title={r.idea.riskFlags.map((f) => RISK_LABEL[f]).join(', ')}>
                      {crit && <AlertTriangle size={12} aria-hidden />}
                      <span className="num">{r.idea.riskFlags.length}</span>
                      <span className="sr-only"> риск(а): {r.idea.riskFlags.map((f) => RISK_LABEL[f]).join(', ')}</span>
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="t-upd num muted">{formatDateShort(r.idea.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RadarCard({ row }: { row: RadarRow }) {
  const { idea } = row;
  const isReal = isLiveMode(useMode());
  const crit = hasCriticalRisk(idea);
  return (
    <li className={cx('panel rcard', idea.stage === 'rejected' && 'is-dim')}>
      <div className="rcard__top">
        <span className="rcard__rank num">{row.rank ? `#${row.rank}` : '—'}</span>
        {row.entry && <MovementIndicator movement={row.entry.movement} scoreDelta={row.entry.scoreDelta} />}
        <span className="rcard__spacer" />
        <StageBadge stage={idea.stage} />
      </div>
      <Link to={`/ideas/${idea.slug}`} className="rcard__title">
        {idea.title}
        <ArrowUpRight size={14} aria-hidden />
      </Link>
      <p className="rcard__pitch">{idea.shortPitch}</p>
      <div className="rcard__metrics">
        <div>
          <span className="rcard__mlabel">Балл</span>
          {row.score === null ? <Unscored /> : <ScoreBar value={row.score} label={`Балл ${row.score}`} />}
        </div>
        <div>
          <span className="rcard__mlabel">Уверенность</span>
          {row.confidence === null ? <span className="muted">—</span> : <ConfidenceMeter value={row.confidence} />}
        </div>
      </div>
      <div className="rcard__foot">
        <Badge>{idea.category}</Badge>
        <Badge>{idea.segment}</Badge>
        {idea.synthetic && isReal && <SyntheticBadge compact />}
        {crit && (
          <Badge tone="danger" icon={<AlertTriangle size={12} aria-hidden />}>
            Требует ревью
          </Badge>
        )}
        {row.entry && <IntegrityFlag integrity={row.entry.integrity} />}
        <span className="rcard__upd muted num">{formatDateShort(idea.updatedAt)}</span>
      </div>
    </li>
  );
}
