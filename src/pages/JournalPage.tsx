import { ArrowDownRight, ArrowRight, ArrowUpRight, BookOpenText, CalendarDays, Check, ClipboardCopy, FileCheck2, GitCompareArrows, History, Link2Off, Minus, ShieldAlert, ShieldCheck, Sparkles, UserCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SourceLink } from '../components/SourceLink';
import { LoadError } from '../components/StateViews';
import { PageSkeleton } from '../components/ui/PageSkeleton';
import { Segmented } from '../components/ui/Segmented';
import { Badge, DemoBadge, EmptyState, Panel, Skeleton, SyntheticBadge } from '../components/ui/primitives';
import { useDataSource, useLoad } from '../data/context';
import { DIMENSIONS } from '../domain/scoring';
import { EVIDENCE_STATUS_LABEL, EVIDENCE_STATUS_TONE, RISK_LABEL, SOURCE_TYPE_LABEL, STAGE_LABEL } from '../domain/labels';
import {
  DEFAULT_EVIDENCE_QUERY,
  type CompareRow,
  type EvidenceQuery,
  type EvidenceQueueView,
  type EvidenceRow,
  type JournalRun,
  type JournalView,
  type SnapshotComparison,
  type SnapshotMeta,
} from '../domain/research-ops';
import type { EffectiveEvidenceStatus } from '../domain/selectors';
import { isLiveMode, type DataMode, type DimensionKey, type RiskFlag, type SourceType } from '../domain/types';
import { cx } from '../lib/cx';
import { formatDateLong, formatDateShort, formatTime, plural } from '../lib/format';

type Tab = 'runs' | 'evidence' | 'history';
const TABS: Tab[] = ['runs', 'evidence', 'history'];

const FIELD_LABEL: Record<string, string> = {
  title: 'название',
  pitch: 'описание',
  segment: 'сегмент',
  category: 'категория',
  geography: 'география',
  targetPersona: 'персона',
  problem: 'проблема',
  ruUnmetJob: 'пробел в РФ',
  whyNow: 'почему сейчас',
  thesis: 'тезис',
  monetization: 'монетизация',
  priceHypothesis: 'цена (гипотеза)',
  distribution: 'дистрибуция',
  mvp: 'MVP',
  nextAction: 'следующий шаг',
  excludedFeatures: 'исключённые функции',
  originMarkets: 'рынки-источники',
  riskFlags: 'риски',
  slug: 'slug',
};

export default function JournalPage() {
  const { mode } = useDataSource();
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tab: Tab = rawTab && (TABS as string[]).includes(rawTab) ? (rawTab as Tab) : 'runs';

  function setTab(t: Tab) {
    const next = new URLSearchParams();
    if (params.get('mode')) next.set('mode', params.get('mode')!);
    if (t !== 'runs') next.set('tab', t);
    setParams(next, { replace: true });
  }

  return (
    <div className="page page--journal">
      <header className="page-head">
        <div className="eyebrow">
          Журнал исследований
          <DemoBadge compact />
          {mode === 'test' && <SyntheticBadge compact />}
        </div>
        <h1 className="display display--sm">Что исследовано, что проверено, что сдвинулось</h1>
        <p className="page-head__lede">
          Датированные прогоны с провенансом, очередь проверки источников и история ТОП-10 по сохранённым срезам. Ежедневные отчёты ChatGPT не синхронизируются автоматически: в базу попадает только то, что основатель одобрил и импортировал командой.
        </p>
      </header>

      <Segmented<Tab>
        label="Раздел журнала"
        className="journal-tabs"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'runs', label: 'Прогоны', icon: <CalendarDays size={14} aria-hidden /> },
          { value: 'evidence', label: 'Проверка источников', icon: <ShieldCheck size={14} aria-hidden /> },
          { value: 'history', label: 'История ТОП-10', icon: <GitCompareArrows size={14} aria-hidden /> },
        ]}
      />

      {tab === 'runs' && <RunsTab />}
      {tab === 'evidence' && <EvidenceTab />}
      {tab === 'history' && <HistoryTab />}
    </div>
  );
}

// ================================================================== runs

function RunsTab() {
  const { source, mode } = useDataSource();
  const state = useLoad(`journal:${mode}`, () => source.journal());
  const [params, setParams] = useSearchParams();
  if (state.status === 'loading') return <PageSkeleton />;
  if (state.status === 'error') return <LoadError error={state.error} onRetry={state.retry} />;
  const view = state.data;
  if (view.runs.length === 0) return <NoRuns mode={mode} />;
  const selectedId = params.get('run');
  const run = view.runs.find((r) => r.id === selectedId) ?? view.runs[0]!;

  function select(id: string) {
    const next = new URLSearchParams(params);
    next.set('run', id);
    setParams(next, { replace: true });
  }

  const totals = view.runs.reduce(
    (acc, r) => ({ created: acc.created + r.counts.ideasCreated, evidence: acc.evidence + r.counts.evidenceAdded, rejected: acc.rejected + r.counts.rejected }),
    { created: 0, evidence: 0, rejected: 0 },
  );

  return (
    <>
      <section className="journal-stats" aria-label="Итоги журнала">
        <Stat label="Прогонов" value={view.runs.length} />
        <Stat label="Идей впервые записано" value={totals.created} />
        <Stat label="Источников записано" value={totals.evidence} />
        <Stat label="Ручных проверок" value={view.manualReviews.length} />
        <Stat label="Отклонено идей" value={totals.rejected} />
      </section>
      {view.notes.map((n) => (
        <p key={n} className="note">
          {n}
        </p>
      ))}

      <div className="journal">
        <nav className="panel journal__index" aria-label="Прогоны исследований">
          <label className="journal__select">
            <span className="field-label">Прогон</span>
            <select className="select" value={run.id} onChange={(e) => select(e.target.value)}>
              {view.runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {formatDateShort(r.date)} · {r.title ?? r.id}
                </option>
              ))}
            </select>
          </label>
          <ol className="journal__list">
            {view.runs.map((r) => (
              <li key={r.id}>
                <button type="button" className={cx('run-item', r.id === run.id && 'is-active')} aria-current={r.id === run.id ? 'true' : undefined} onClick={() => select(r.id)}>
                  <span className="run-item__date num">{formatDateShort(r.date)}</span>
                  <span className="run-item__title">{r.title ?? r.id}</span>
                  <span className="run-item__chips">
                    {r.counts.ideasCreated > 0 && <span className="mini-chip mini-chip--new">+{r.counts.ideasCreated}</span>}
                    {r.counts.assessmentsAdded > 0 && <span className="mini-chip">оценок {r.counts.assessmentsAdded}</span>}
                    {r.counts.rejected > 0 && <span className="mini-chip mini-chip--danger">✕{r.counts.rejected}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <RunDetail run={run} mode={mode} />
      </div>

      <ManualReviews view={view} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="panel jstat">
      <span className="jstat__value num">{value}</span>
      <span className="jstat__label">{label}</span>
    </div>
  );
}

function NoRuns({ mode }: { mode: DataMode }) {
  return (
    <div className="panel">
      <EmptyState icon={<BookOpenText size={22} />} title={mode === 'test' ? 'Тестовых прогонов нет' : 'Прогонов исследований ещё нет'}>
        {mode === 'real' ? (
          <>
            В журнал попадают только импортированные и одобренные исследования. Подготовьте черновик по <code>docs/research-export-guide.md</code>, проверьте его <code>npm run research:draft-check</code>, одобрите и импортируйте.
          </>
        ) : mode === 'test' ? (
          <>
            Импортируйте синтетический пример: <code>npm run research:import -- research/examples/synthetic-run-1.json --apply</code>.
          </>
        ) : (
          'В демо-фикстуре нет прогонов.'
        )}
      </EmptyState>
    </div>
  );
}

function RunDetail({ run, mode }: { run: JournalRun; mode: DataMode }) {
  const total = Object.values(run.evidenceStatus).reduce((a, b) => a + b, 0);
  return (
    <article className="panel run" aria-labelledby={`run-${run.id}`}>
      <header className="run__head">
        <div className="eyebrow">
          <CalendarDays size={12} aria-hidden /> {formatDateLong(run.date)}
          {run.synthetic && mode !== 'demo' && <SyntheticBadge compact />}
          <DemoBadge compact />
        </div>
        <h2 id={`run-${run.id}`} className="run__title">
          {run.title ?? run.id}
        </h2>
        <div className="run__badges">
          {run.approval ? (
            <Badge tone="success" icon={<UserCheck size={12} aria-hidden />}>
              Одобрено: {run.approval.by}, {formatDateShort(run.approval.at)}
            </Badge>
          ) : run.origin === 'human-reviewed' ? (
            <Badge tone="warn" icon={<ShieldAlert size={12} aria-hidden />}>
              Одобрение не записано (импорт до VL-003)
            </Badge>
          ) : run.origin === 'synthetic-test' ? (
            <Badge tone="warn">Синтетический тестовый прогон</Badge>
          ) : (
            <Badge>Демо-прогон без провенанса</Badge>
          )}
          {run.markets.map((m) => (
            <Badge key={m}>{m}</Badge>
          ))}
        </div>
      </header>

      <dl className="run__counts">
        <Count label="Новые идеи" value={run.counts.ideasCreated} tone="accent" />
        <Count label="Обновлены досье" value={run.counts.ideasUpdated} />
        <Count label="Оценки" value={run.counts.assessmentsAdded} />
        <Count label="Смены стадий" value={run.counts.stageChanges} />
        <Count label="Отклонены" value={run.counts.rejected} tone={run.counts.rejected ? 'danger' : undefined} />
        <Count label="Источники" value={run.counts.evidenceAdded} />
      </dl>

      {total > 0 && (
        <div className="run__evidence">
          <div className="run__evidence-head">
            <span className="field-label">Источники этого прогона — статус сейчас</span>
            <Link to="?tab=evidence" className="link-cta">
              К проверке <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
          <StatusBar counts={run.evidenceStatus} />
        </div>
      )}

      {(run.coverage || run.limitations) && (
        <dl className="run__text">
          {run.coverage && (
            <div>
              <dt>Охват</dt>
              <dd>{run.coverage}</dd>
            </div>
          )}
          {run.limitations && (
            <div>
              <dt>Ограничения</dt>
              <dd>{run.limitations}</dd>
            </div>
          )}
        </dl>
      )}

      <h3 className="subhead">Изменения по идеям</h3>
      {run.ideas.length === 0 ? (
        <p className="muted">Этот прогон не изменил ни одной идеи.</p>
      ) : (
        <ul className="changes">
          {run.ideas.map((c) => (
            <li key={c.ideaId} className="change">
              <Link to={`/ideas/${c.slug}`} className="change__title">
                {c.title}
                <ArrowUpRight size={14} aria-hidden />
              </Link>
              <div className="change__chips">
                {c.created && (
                  <Badge tone="accent" icon={<Sparkles size={12} aria-hidden />}>
                    Новая
                  </Badge>
                )}
                {c.updatedFields.length > 0 && <Badge>Обновлено: {c.updatedFields.map((f) => FIELD_LABEL[f] ?? f).join(', ')}</Badge>}
                {c.assessmentAdded && <Badge tone="success">Оценка{c.assessmentScore !== null ? ` · ${c.assessmentScore}` : ''}</Badge>}
                {c.stage && (c.stage.from || !c.created) && (
                  <Badge tone={c.stage.to === 'rejected' ? 'danger' : 'neutral'}>
                    {c.stage.from ? `${STAGE_LABEL[c.stage.from]} → ` : ''}
                    {STAGE_LABEL[c.stage.to]}
                  </Badge>
                )}
                {c.evidenceAdded > 0 && <Badge>+{c.evidenceAdded} {plural(c.evidenceAdded, 'источник', 'источника', 'источников')}</Badge>}
                {c.competitorsAdded > 0 && <Badge>+{c.competitorsAdded} конкур.</Badge>}
                {c.statusChanges > 0 && (
                  <Badge tone="warn">
                    {c.statusChanges} {plural(c.statusChanges, 'смена статуса', 'смены статуса', 'смен статуса')}
                  </Badge>
                )}
              </div>
              {c.stage?.reason && <p className="change__reason">Причина: {c.stage.reason}</p>}
            </li>
          ))}
        </ul>
      )}

      {run.sourceRefs.length > 0 && (
        <>
          <h3 className="subhead">Ссылки прогона</h3>
          <ul className="run__refs">
            {run.sourceRefs.map((u) => (
              <li key={u}>
                <SourceLink url={u}>{u}</SourceLink>
              </li>
            ))}
          </ul>
        </>
      )}

      <dl className="run__prov">
        <div>
          <dt>Исследование проверил</dt>
          <dd>{run.reviewedBy}</dd>
        </div>
        <div>
          <dt>Импорт</dt>
          <dd>{run.importedAt ? `${formatDateShort(run.importedAt.slice(0, 10))}, ${formatTime(run.importedAt)} UTC · ${run.importedBy}` : '—'}</dd>
        </div>
        <div>
          <dt>Файл</dt>
          <dd>{run.fileName ?? '—'}</dd>
        </div>
        <div>
          <dt>SHA-256</dt>
          <dd className="mono" title={run.checksum ?? undefined}>
            {run.checksum ? `${run.checksum.slice(0, 16)}…` : '—'}
          </dd>
        </div>
        {run.approval && (
          <div className="run__prov-wide">
            <dt>Заявление об одобрении</dt>
            <dd>«{run.approval.statement}»</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: 'accent' | 'danger' }) {
  return (
    <div className={cx('count', tone && `count--${tone}`, value === 0 && 'is-zero')}>
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

const STATUS_ORDER: EffectiveEvidenceStatus[] = ['checked', 'unreviewed', 'unattributed', 'rejected'];

function StatusBar({ counts }: { counts: Record<EffectiveEvidenceStatus, number> }) {
  const total = STATUS_ORDER.reduce((a, s) => a + counts[s], 0);
  return (
    <div className="statusbar">
      <div className="statusbar__track" role="img" aria-label={STATUS_ORDER.map((s) => `${EVIDENCE_STATUS_LABEL[s]}: ${counts[s]}`).join(', ')}>
        {STATUS_ORDER.map((s) => (counts[s] > 0 ? <span key={s} className={`statusbar__seg statusbar__seg--${s}`} style={{ width: `${(counts[s] / Math.max(1, total)) * 100}%` }} /> : null))}
      </div>
      <ul className="statusbar__legend">
        {STATUS_ORDER.map((s) => (
          <li key={s}>
            <i className={`statusbar__dot statusbar__seg--${s}`} aria-hidden /> {EVIDENCE_STATUS_LABEL[s]} <span className="num">{counts[s]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ManualReviews({ view }: { view: JournalView }) {
  return (
    <Panel title="Ручные проверки источников" eyebrow="Append-only · research:review" demo>
      {view.manualReviews.length === 0 ? (
        <p className="muted">
          Ручных проверок ещё не было. Статус «проверено» ставит человек по каждому источнику командой <code>npm run research:review</code> — с причиной и именем.
        </p>
      ) : (
        <ol className="timeline">
          {view.manualReviews.map((m, i) => (
            <li key={`${m.at}-${m.evidenceId}-${i}`} className="timeline__item">
              <span className={cx('timeline__avatar', 'is-human')} aria-hidden>
                <UserCheck size={14} />
              </span>
              <div className="timeline__body">
                <div className="timeline__head">
                  <span className="timeline__actor">{m.actor}</span>
                  <span className="timeline__time num">
                    {formatDateShort(m.at.slice(0, 10))}, {formatTime(m.at)} UTC
                  </span>
                </div>
                <p className="timeline__text">
                  {m.previousStatus ? `${EVIDENCE_STATUS_LABEL[m.previousStatus]} → ` : ''}
                  <strong className={`tone-${EVIDENCE_STATUS_TONE[m.status]}`}>{EVIDENCE_STATUS_LABEL[m.status]}</strong> · «{m.reason}»
                </p>
                <p className="timeline__claim">{m.claim}</p>
                <Link to={`/ideas/${m.idea.slug}`} className="timeline__idea">
                  {m.idea.title}
                </Link>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// ================================================================== evidence queue

const STATUS_FILTERS: { value: EvidenceQuery['status']; label: string }[] = [
  { value: 'needs-review', label: 'Требуют проверки' },
  { value: 'unreviewed', label: 'Не проверено' },
  { value: 'unattributed', label: 'Без атрибуции' },
  { value: 'checked', label: 'Проверено' },
  { value: 'rejected', label: 'Отклонено' },
  { value: 'all', label: 'Все' },
];

function readQuery(p: URLSearchParams): { q: EvidenceQuery; page: number } {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = p.get(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  };
  const age = Number(p.get('age'));
  const page = Number(p.get('page') ?? '1');
  return {
    q: {
      status: pick('status', STATUS_FILTERS.map((s) => s.value), DEFAULT_EVIDENCE_QUERY.status),
      market: pick('market', ['all', 'west', 'ru'] as const, 'all'),
      sourceType: pick<SourceType | 'all'>('stype', ['all', 'independent', 'company_self_report', 'primary_data', 'unknown'], 'all'),
      idea: p.get('idea') ?? 'all',
      minAgeDays: Number.isInteger(age) && age > 0 ? age : null,
      missingUrl: p.get('nourl') === '1',
      dimension: pick<DimensionKey | 'all'>('dim', ['all', ...DIMENSIONS.map((d) => d.key)], 'all'),
      risk: pick<RiskFlag | 'all'>('risk', ['all', ...(Object.keys(RISK_LABEL) as RiskFlag[])], 'all'),
    },
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function EvidenceTab() {
  const { source, mode } = useDataSource();
  const [params, setParams] = useSearchParams();
  const { q, page } = readQuery(params);
  const state = useLoad(`evidence:${mode}:${JSON.stringify(q)}:${page}`, () => source.evidence(q, page));

  function update(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    // `status` defaults to needs-review, so its «all» must stay explicit in the URL.
    if (value === null || value === '' || (value === 'all' && key !== 'status')) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  }

  return (
    <>
      <div className="panel review-explainer">
        <ShieldCheck size={20} aria-hidden className="review-explainer__icon" />
        <div>
          <strong>Открытие ссылки — не доказательство.</strong> «Проверено» означает, что человек прочитал источник и подтвердил, что он действительно поддерживает именно это утверждение (дата, издатель, формулировка). Статус меняется только командой <code>research:review</code> с причиной и именем, каждое решение сохраняется как неизменяемое событие. Утверждение без ссылки, издателя и даты наблюдения проверенным не станет.
        </div>
      </div>

      <div className="panel filters filters--evidence" role="region" aria-label="Фильтры источников">
        <div className="filters__field">
          <label htmlFor="ev-status" className="field-label">
            Статус
          </label>
          <select id="ev-status" className="select" value={q.status} onChange={(e) => update('status', e.target.value === 'needs-review' ? null : e.target.value)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="filters__field">
          <label htmlFor="ev-idea" className="field-label">
            Идея
          </label>
          <select id="ev-idea" className="select" value={q.idea} onChange={(e) => update('idea', e.target.value)}>
            <option value="all">Все</option>
            {(state.status === 'ready' ? state.data.ideas : []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
            {q.idea !== 'all' && state.status === 'ready' && !state.data.ideas.some((i) => i.id === q.idea) && <option value={q.idea}>{q.idea}</option>}
          </select>
        </div>
        <div className="filters__field">
          <label htmlFor="ev-market" className="field-label">
            Рынок
          </label>
          <select id="ev-market" className="select" value={q.market} onChange={(e) => update('market', e.target.value)}>
            <option value="all">Все</option>
            <option value="west">Запад</option>
            <option value="ru">Россия</option>
          </select>
        </div>
        <div className="filters__field">
          <label htmlFor="ev-stype" className="field-label">
            Тип источника
          </label>
          <select id="ev-stype" className="select" value={q.sourceType} onChange={(e) => update('stype', e.target.value)}>
            <option value="all">Все</option>
            {(Object.keys(SOURCE_TYPE_LABEL) as SourceType[]).map((t) => (
              <option key={t} value={t}>
                {SOURCE_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="filters__field">
          <label htmlFor="ev-dim" className="field-label">
            Критерий
          </label>
          <select id="ev-dim" className="select" value={q.dimension} onChange={(e) => update('dim', e.target.value)}>
            <option value="all">Все</option>
            {DIMENSIONS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.short}
              </option>
            ))}
          </select>
        </div>
        <div className="filters__field">
          <label htmlFor="ev-risk" className="field-label">
            Риск идеи
          </label>
          <select id="ev-risk" className="select" value={q.risk} onChange={(e) => update('risk', e.target.value)}>
            <option value="all">Все</option>
            {(Object.keys(RISK_LABEL) as RiskFlag[]).map((r) => (
              <option key={r} value={r}>
                {RISK_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="filters__field">
          <label htmlFor="ev-age" className="field-label">
            Давность наблюдения
          </label>
          <select id="ev-age" className="select" value={q.minAgeDays ?? ''} onChange={(e) => update('age', e.target.value)}>
            <option value="">Любая</option>
            <option value="30">старше 30 дней</option>
            <option value="90">старше 90 дней</option>
            <option value="180">старше 180 дней</option>
          </select>
        </div>
        <label className="filters__check">
          <input type="checkbox" checked={q.missingUrl} onChange={(e) => update('nourl', e.target.checked ? '1' : null)} />
          <span>Только без ссылки</span>
        </label>
      </div>

      {state.status === 'loading' ? (
        <div className="panel" aria-busy="true">
          <div className="panel__body radar-loading">
            <span className="sr-only">Загрузка…</span>
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} h={22} />
            ))}
          </div>
        </div>
      ) : state.status === 'error' ? (
        <LoadError error={state.error} onRetry={state.retry} />
      ) : (
        <EvidenceList view={state.data} mode={mode} page={page} onPage={(n) => update('page', n === 1 ? null : String(n))} />
      )}
    </>
  );
}

function EvidenceList({ view, mode, page, onPage }: { view: EvidenceQueueView; mode: DataMode; page: number; onPage: (n: number) => void }) {
  if (view.totalAll === 0) {
    return (
      <div className="panel">
        <EmptyState icon={<FileCheck2 size={22} />} title="Источников пока нет">
          Источники появляются вместе с импортированными исследованиями.
        </EmptyState>
      </div>
    );
  }
  return (
    <>
      <div className="results-bar">
        <p className="results-bar__count" aria-live="polite">
          <span className="num">{view.total}</span> {plural(view.total, 'утверждение', 'утверждения', 'утверждений')} из {view.totalAll}
        </p>
        <ul className="ev-counts" aria-label="Статусы всех источников">
          {STATUS_ORDER.map((s) => (
            <li key={s}>
              <Badge tone={EVIDENCE_STATUS_TONE[s]}>
                {EVIDENCE_STATUS_LABEL[s]} <span className="num">{view.counts[s]}</span>
              </Badge>
            </li>
          ))}
        </ul>
      </div>
      {view.rows.length === 0 ? (
        <div className="panel">
          <EmptyState icon={<Check size={22} />} title="Под фильтр ничего не подходит">
            Измените фильтры. Пустая очередь «требуют проверки» означает, что все утверждения рассмотрены человеком, — а не что они истинны.
          </EmptyState>
        </div>
      ) : (
        <ul className="evq" aria-label="Очередь проверки источников">
          {view.rows.map((r) => (
            <EvidenceCard key={`${r.idea.id}/${r.evidence.id}`} row={r} mode={mode} />
          ))}
        </ul>
      )}
      {view.total > view.pageSize && (
        <nav className="pager" aria-label="Страницы очереди">
          <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            Назад
          </button>
          <span className="muted num">
            {(page - 1) * view.pageSize + 1}–{Math.min(page * view.pageSize, view.total)} из {view.total}
          </span>
          <button type="button" className="btn btn--ghost" disabled={page * view.pageSize >= view.total} onClick={() => onPage(page + 1)}>
            Вперёд
          </button>
        </nav>
      )}
    </>
  );
}

function reviewCommand(mode: DataMode, r: EvidenceRow, status: 'checked' | 'rejected'): string {
  return `npm run research:review -- --dataset ${mode} --idea ${r.idea.id} --evidence ${r.evidence.id} --status ${status} --reason "что именно проверено" --apply`;
}

function EvidenceCard({ row, mode }: { row: EvidenceRow; mode: DataMode }) {
  const e = row.evidence;
  const reviews = e.reviews ?? [];
  const dims = e.dimensions.map((d) => DIMENSIONS.find((x) => x.key === d)?.short ?? d);
  return (
    <li className={cx('panel evc', `evc--${row.status}`)}>
      <div className="evc__top">
        <Badge tone={EVIDENCE_STATUS_TONE[row.status]}>{EVIDENCE_STATUS_LABEL[row.status]}</Badge>
        <Badge>{e.market === 'west' ? 'Запад' : 'Россия'}</Badge>
        {row.usedInAssessment && <Badge tone="accent">В текущей оценке</Badge>}
        <Link to={`/ideas/${row.idea.slug}`} className="evc__idea">
          {row.idea.title}
        </Link>
      </div>
      <p className="evc__claim">{e.claim}</p>
      <div className="evc__source">
        {e.url ? (
          <SourceLink url={e.url}>{e.title ?? e.publisher ?? e.url}</SourceLink>
        ) : (
          <span className="ev__src">
            <Link2Off size={12} aria-hidden /> ссылки нет — проверить невозможно
          </span>
        )}
        <span className="muted small">
          {[e.publisher ?? 'издатель не указан', SOURCE_TYPE_LABEL[e.sourceType], e.observedAt ? `наблюдение ${formatDateShort(e.observedAt)}${row.ageDays !== null ? ` (${row.ageDays} дн.)` : ''}` : 'дата наблюдения не указана', e.publishedAt && `опубл. ${formatDateShort(e.publishedAt)}`]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      {dims.length > 0 && (
        <div className="evc__dims">
          {dims.map((d) => (
            <span key={d} className="ev__dim">
              {d}
            </span>
          ))}
        </div>
      )}
      {reviews.length > 0 && (
        <details className="evc__history">
          <summary>
            <History size={12} aria-hidden /> История проверок ({reviews.length})
          </summary>
          <ol>
            {reviews.map((rv, i) => (
              <li key={`${rv.at}-${i}`}>
                <span className="num muted">
                  {formatDateShort(rv.at.slice(0, 10))} {formatTime(rv.at)} UTC
                </span>{' '}
                <strong className={`tone-${EVIDENCE_STATUS_TONE[rv.status]}`}>{EVIDENCE_STATUS_LABEL[rv.status]}</strong> · {rv.origin === 'manual' ? 'вручную' : 'при импорте'} · {rv.actor ?? '—'}
                {rv.reason && <> · «{rv.reason}»</>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {isLiveMode(mode) && row.status !== 'checked' && row.status !== 'rejected' && <ReviewCommands row={row} mode={mode} />}
    </li>
  );
}

function ReviewCommands({ row, mode }: { row: EvidenceRow; mode: DataMode }) {
  const [copied, setCopied] = useState<string | null>(null);
  const commands = row.status === 'unattributed' ? (['rejected'] as const) : (['checked', 'rejected'] as const);
  async function copy(cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(cmd);
    } catch {
      setCopied(null);
    }
  }
  return (
    <details className="evc__cmd">
      <summary>
        <ShieldCheck size={12} aria-hidden /> Как зафиксировать решение (локальная команда, с причиной)
      </summary>
      {commands.map((st) => {
        const cmd = reviewCommand(mode, row, st);
        return (
          <div key={st} className="cmd">
            <code>{cmd}</code>
            <button type="button" className="icon-btn cmd__copy" onClick={() => copy(cmd)} aria-label={`Скопировать команду (${st})`}>
              {copied === cmd ? <Check size={16} /> : <ClipboardCopy size={16} />}
            </button>
          </div>
        );
      })}
      {row.status === 'unattributed' && <p className="fineprint">Без ссылки, издателя и даты утверждение можно только отклонить или заменить новым источником при следующем импорте.</p>}
    </details>
  );
}

// ================================================================== top-10 history

function HistoryTab() {
  const { source, mode } = useDataSource();
  const state = useLoad(`snapshots:${mode}`, () => source.snapshots());
  if (state.status === 'loading') return <PageSkeleton />;
  if (state.status === 'error') return <LoadError error={state.error} onRetry={state.retry} />;
  const snaps = state.data;
  if (snaps.length < 2) {
    return (
      <div className="panel">
        <EmptyState icon={<GitCompareArrows size={22} />} title={snaps.length === 0 ? 'Сохранённых срезов ещё нет' : 'Нужен ещё один срез для сравнения'}>
          {isLiveMode(mode) ? (
            <>
              Срез фиксирует весь рейтинг на дату и больше не меняется. Создайте его командой <code>npm run research:snapshot -- --dataset {mode} --apply</code> (по одному на дату).
              {snaps.length === 1 && <> Сейчас есть только срез {formatDateShort(snaps[0]!.asOf)}.</>}
            </>
          ) : (
            'В демо-фикстуре недостаточно дат.'
          )}
        </EmptyState>
      </div>
    );
  }
  return <Comparator snaps={snaps} mode={mode} />;
}

function Comparator({ snaps, mode }: { snaps: SnapshotMeta[]; mode: DataMode }) {
  const { source } = useDataSource();
  const [params, setParams] = useSearchParams();
  const ids = snaps.map((s) => s.id);
  const pa = params.get('a');
  const pb = params.get('b');
  const b = pb && ids.includes(pb) ? pb : snaps[0]!.id;
  const a = pa && ids.includes(pa) && pa !== b ? pa : (snaps.find((s) => s.id !== b) ?? snaps[1]!).id;
  const state = useLoad(`compare:${mode}:${a}:${b}`, () => source.compare(a, b));

  function set(key: 'a' | 'b', v: string) {
    const next = new URLSearchParams(params);
    next.set('a', key === 'a' ? v : a);
    next.set('b', key === 'b' ? v : b);
    setParams(next, { replace: true });
  }

  const label = (s: SnapshotMeta) => `${formatDateLong(s.asOf)} · ${s.entryCount} ${plural(s.entryCount, 'позиция', 'позиции', 'позиций')}`;

  return (
    <>
      <div className="panel compare-pick" role="region" aria-label="Выбор срезов">
        <div className="filters__field">
          <label htmlFor="snap-a" className="field-label">
            Срез A (раньше)
          </label>
          <select id="snap-a" className="select" value={a} onChange={(e) => set('a', e.target.value)}>
            {snaps
              .filter((s) => s.id !== b)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {label(s)}
                </option>
              ))}
          </select>
        </div>
        <ArrowRight className="compare-pick__arrow" size={20} aria-hidden />
        <div className="filters__field">
          <label htmlFor="snap-b" className="field-label">
            Срез B (позже)
          </label>
          <select id="snap-b" className="select" value={b} onChange={(e) => set('b', e.target.value)}>
            {snaps
              .filter((s) => s.id !== a)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {label(s)}
                </option>
              ))}
          </select>
        </div>
      </div>
      {state.status === 'loading' ? (
        <PageSkeleton />
      ) : state.status === 'error' ? (
        <LoadError error={state.error} onRetry={state.retry} />
      ) : (
        <ComparisonView cmp={state.data} />
      )}
    </>
  );
}

const CHANGE_META: Record<CompareRow['change'], { label: string; tone: 'success' | 'danger' | 'accent' | 'warn' | 'neutral'; icon: ReactNode }> = {
  entered: { label: 'Вошла', tone: 'accent', icon: <Sparkles size={12} aria-hidden /> },
  exited: { label: 'Выбыла', tone: 'danger', icon: <ArrowDownRight size={12} aria-hidden /> },
  up: { label: 'Выше', tone: 'success', icon: <ArrowUpRight size={12} aria-hidden /> },
  down: { label: 'Ниже', tone: 'warn', icon: <ArrowDownRight size={12} aria-hidden /> },
  same: { label: 'Без изменений', tone: 'neutral', icon: <Minus size={12} aria-hidden /> },
};

const DETAIL_LABEL: Record<NonNullable<CompareRow['detail']>, string> = {
  'new-in-ranking': 'новая в рейтинге',
  'from-below': 'поднялась из-за пределов ТОП-10',
  'below-cut': 'осталась в рейтинге ниже 10-го места',
  'left-ranking': 'выбыла из рейтинга (отклонена, на паузе или без оценки)',
};

function delta(v: number | null) {
  if (v === null || v === 0) return null;
  return <span className={cx('delta', v > 0 ? 'delta--up' : 'delta--down')}>{v > 0 ? `+${v}` : v}</span>;
}

function ComparisonView({ cmp }: { cmp: SnapshotComparison }) {
  const reconstructed = cmp.a.kind === 'reconstructed';
  return (
    <>
      <section className="compare-summary" aria-label="Итог сравнения">
        <div className="panel compare-summary__dates">
          <span className="field-label">Сравнение</span>
          <strong>
            {formatDateShort(cmp.a.asOf)} → {formatDateShort(cmp.b.asOf)}
          </strong>
          <span className="muted small num">
            ТОП: {cmp.topA}/{cmp.cut} → {cmp.topB}/{cmp.cut}
          </span>
        </div>
        {(Object.keys(CHANGE_META) as CompareRow['change'][]).map((k) => (
          <div key={k} className={cx('panel compare-summary__item', `cs--${k}`)}>
            <span className="num compare-summary__n">{cmp.summary[k]}</span>
            <span className="compare-summary__label">{CHANGE_META[k].label}</span>
          </div>
        ))}
      </section>
      {cmp.swapped && <p className="note">Срезы переставлены по дате: A — более ранний.</p>}
      <Panel
        title="Изменения ТОП-10"
        eyebrow={reconstructed ? 'Демо: срезы восстановлены из фикстуры' : 'Значения заморожены в сохранённых срезах'}
        demo
        footer={
          <span className="muted">
            Баллы, уверенность и названия взяты из самих срезов на их даты, а не из сегодняшних данных. {cmp.topB < cmp.cut ? `В срезе B только ${cmp.topB} оценённых идей — ТОП не дополняется искусственно.` : ''}
          </span>
        }
      >
        <div className="table-wrap cmp-table-wrap">
          <table className="table cmp-table">
            <caption className="sr-only">Сравнение срезов ТОП-10</caption>
            <thead>
              <tr>
                <th scope="col">A</th>
                <th scope="col">B</th>
                <th scope="col">Идея</th>
                <th scope="col">Изменение</th>
                <th scope="col" className="num-col">
                  Балл
                </th>
                <th scope="col" className="num-col">
                  Уверенность
                </th>
              </tr>
            </thead>
            <tbody>
              {cmp.rows.map((r) => {
                const m = CHANGE_META[r.change];
                const renamed = r.titleA && r.titleB && r.titleA !== r.titleB;
                return (
                  <tr key={r.ideaId} className={cx(`cmp--${r.change}`)}>
                    <td className="num cmp-rank">{r.rankA ? `#${r.rankA}` : '—'}</td>
                    <td className="num cmp-rank cmp-rank--b">{r.rankB ? `#${r.rankB}` : '—'}</td>
                    <td>
                      <Link to={`/ideas/${r.slug}`} className="t-idea">
                        <span className="t-idea__title">{r.titleB ?? r.titleA}</span>
                        {renamed && <span className="t-idea__meta">в срезе A: «{r.titleA}»</span>}
                      </Link>
                    </td>
                    <td>
                      <Badge tone={m.tone} icon={m.icon}>
                        {m.label}
                        {r.rankDelta ? ` ${Math.abs(r.rankDelta)}` : ''}
                      </Badge>
                      {r.detail && <span className="cmp-detail">{DETAIL_LABEL[r.detail]}</span>}
                    </td>
                    <td className="num num-col">
                      {r.scoreA ?? '—'} → {r.scoreB ?? '—'} {delta(r.scoreDelta)}
                    </td>
                    <td className="num num-col">
                      {r.confidenceA ?? '—'} → {r.confidenceB ?? '—'} {delta(r.confidenceDelta)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="cmp-cards" aria-label="Изменения ТОП-10">
          {cmp.rows.map((r) => {
            const m = CHANGE_META[r.change];
            return (
              <li key={r.ideaId} className={cx('cmp-card', `cmp--${r.change}`)}>
                <div className="cmp-card__ranks num">
                  <span>{r.rankA ? `#${r.rankA}` : '—'}</span>
                  <ArrowRight size={14} aria-hidden />
                  <strong>{r.rankB ? `#${r.rankB}` : '—'}</strong>
                </div>
                <Link to={`/ideas/${r.slug}`} className="cmp-card__title">
                  {r.titleB ?? r.titleA}
                </Link>
                {r.titleA && r.titleB && r.titleA !== r.titleB && <span className="muted small">в срезе A: «{r.titleA}»</span>}
                <div className="cmp-card__meta">
                  <Badge tone={m.tone} icon={m.icon}>
                    {m.label}
                  </Badge>
                  <span className="num small">
                    балл {r.scoreA ?? '—'}→{r.scoreB ?? '—'} {delta(r.scoreDelta)}
                  </span>
                  <span className="num small muted">
                    ув. {r.confidenceA ?? '—'}→{r.confidenceB ?? '—'}
                  </span>
                </div>
                {r.detail && <span className="cmp-detail">{DETAIL_LABEL[r.detail]}</span>}
              </li>
            );
          })}
        </ul>
      </Panel>
    </>
  );
}
