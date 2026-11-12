import { Activity, ArrowRight, BadgeCheck, Beaker, Bot, CircleDashed, Database, FileSearch, Hammer, Layers, Radar as RadarIcon, ShieldAlert, Target } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { OpportunityMap } from '../components/charts/OpportunityMap';
import { Leaderboard } from '../components/Leaderboard';
import { LoadError, RealEmptyState } from '../components/StateViews';
import { Segmented } from '../components/ui/Segmented';
import { PageSkeleton } from '../components/ui/PageSkeleton';
import { Badge, ConfidenceMeter, DemoBadge, EmptyState, Panel, ScoreRing, StageBadge, SyntheticBadge } from '../components/ui/primitives';
import { useDataSource, useLoad, useMode } from '../data/context';
import { BUILD_STAGE_LABEL, EXPERIMENT_STATUS_LABEL, RISK_LABEL, confidenceBand } from '../domain/labels';
import { HIGH_CONFIDENCE, HIGH_SCORE, hasCriticalRisk, sumFunnel, type BaselineInfo, type OverviewView } from '../domain/selectors';
import type { RankedEntry } from '../domain/scoring';
import type { Segment, Stage } from '../domain/types';
import { formatDateLong, formatDateShort, formatTime, pct, plural, relativeDay, verifiedPaymentsPhrase } from '../lib/format';
import { cx } from '../lib/cx';

type TopSort = 'rank' | 'confidence' | 'movement';

function movementValue(e: RankedEntry): number {
  if (e.movement.kind === 'new') return 100;
  if (e.movement.kind === 'up') return e.movement.by;
  if (e.movement.kind === 'down') return -e.movement.by;
  return 0;
}

export default function OverviewPage() {
  const { source, mode } = useDataSource();
  const state = useLoad(`overview:${mode}`, () => source.overview());
  if (state.status === 'loading') return <PageSkeleton />;
  if (state.status === 'error') return <LoadError error={state.error} onRetry={state.retry} />;
  const view = state.data;
  if (view.mode === 'real' && view.kpis.totalIdeas === 0) return <RealEmptyState view={view} />;
  return <Overview view={view} />;
}

function baselineText(b: BaselineInfo | null): string {
  if (!b) return 'Сохранённых срезов ещё нет — движение в рейтинге не показывается.';
  if (b.kind === 'stored') return `Движение — относительно сохранённого среза ${formatDateShort(b.asOf)} (${b.snapshotId}).`;
  return `Движение — относительно среза ${formatDateShort(b.asOf)}, восстановленного из неизменяемой истории оценок и стадий.`;
}

function Overview({ view }: { view: OverviewView }) {
  const { kpis, ranking } = view;
  const isReal = view.mode === 'real';
  const [sort, setSort] = useState<TopSort>('rank');
  const [segment, setSegment] = useState<Segment | 'all'>('all');

  const top10View = useMemo(() => {
    const rows = ranking.slice(0, 10).filter((e) => segment === 'all' || e.idea.segment === segment);
    if (sort === 'confidence') return [...rows].sort((a, b) => b.confidence - a.confidence || a.rank - b.rank);
    if (sort === 'movement') return [...rows].sort((a, b) => movementValue(b) - movementValue(a) || a.rank - b.rank);
    return rows;
  }, [ranking, sort, segment]);

  const strong = kpis.highConfidenceLeads;

  return (
    <div className="page page--overview">
      <header className="page-head">
        <div className="eyebrow">
          {isReal ? <>Обзор · рейтинг на {formatDateLong(view.rankAsOf)}</> : <>Обзор · срез на {formatDateLong(view.asOf)}</>}
          <DemoBadge compact />
          {isReal && view.syntheticIdeas > 0 && <SyntheticBadge compact />}
        </div>
        <h1 className="display">
          {kpis.rankable} {plural(kpis.rankable, 'идея', 'идеи', 'идей')} в рейтинге
          {kpis.unscored > 0 && <>, {kpis.unscored} не {plural(kpis.unscored, 'оценена', 'оценены', 'оценены')}</>}.{' '}
          <span className="display__muted">
            {strong} {plural(strong, 'сильная и обоснованная', 'сильные и обоснованные', 'сильных и обоснованных')}, {verifiedPaymentsPhrase(kpis.verifiedPaidSignals)}.
          </span>
        </h1>
        <p className="page-head__lede">
          Рейтинг пересчитывается из 12 критериев по модели {view.modelVersion}. Балл и уверенность в доказательствах — разные метрики: высокий балл без источников — задача на исследование, а не на сборку.
          {isReal && ' Идеи без импортированной оценки не ранжируются и помечены «не оценено».'}
        </p>
      </header>

      <div className="grid grid--hero">
        {view.lead ? <HeroFind entry={view.lead} asOf={view.asOf} /> : <NoEligibleFind ranked={ranking.length} unscored={kpis.unscored} />}
        <ResearchPulse view={view} />
      </div>

      <section className="grid grid--kpi" aria-label={isReal ? 'Ключевые показатели' : 'Ключевые показатели (демо)'}>
        <Kpi icon={<Layers size={16} />} label="Идей на радаре" value={kpis.totalIdeas} sub={`${kpis.rankable} в рейтинге${kpis.unscored ? ` · ${kpis.unscored} не оценено` : ''} · +${kpis.newThisWeek} ${view.baseline ? 'с прошлого среза' : 'всего'}`} />
        <Kpi icon={<Target size={16} />} label="Сильные и обоснованные" value={kpis.highConfidenceLeads} sub={`балл ≥ ${HIGH_SCORE} и уверенность ≥ ${HIGH_CONFIDENCE}`} tone="accent" />
        {isReal ? (
          <Kpi icon={<FileSearch size={16} />} label="Проверенные источники" value={kpis.evidenceChecked} sub={`${kpis.evidenceNeedsReview} требуют проверки`} />
        ) : (
          <Kpi icon={<Beaker size={16} />} label="Эксперименты идут" value={kpis.liveExperiments} sub={`+${kpis.plannedExperiments} ${plural(kpis.plannedExperiments, 'запланирован', 'запланировано', 'запланировано')}`} />
        )}
        <Kpi icon={<Hammer size={16} />} label="Активные сборки" value={kpis.activeBuilds} sub={isReal ? 'учёт сборок — Build Studio (позже)' : `${kpis.buildSpecs} в спецификации`} />
        <Kpi
          icon={<BadgeCheck size={16} />}
          label="Подтверждённые оплаты"
          value={kpis.verifiedPaidSignals}
          sub={isReal ? 'платежи не импортируются в VL-002' : `${kpis.pendingPaidSignals} ожидает проверки · обещание ≠ оплата`}
          tone={kpis.verifiedPaidSignals > 0 ? 'success' : 'muted'}
        />
      </section>

      <div className="grid grid--main">
        <Panel
          id="top10"
          className="panel--top10"
          eyebrow={`Рейтинг на ${formatDateShort(view.rankAsOf)} · из ${ranking.length} оценённых`}
          title="Топ-10 возможностей"
          demo
          actions={
            <div className="toolbar">
              <Segmented<Segment | 'all'>
                label="Сегмент"
                size="sm"
                value={segment}
                onChange={setSegment}
                options={[
                  { value: 'all', label: 'Все' },
                  { value: 'B2B', label: 'B2B' },
                  { value: 'B2C', label: 'B2C' },
                ]}
              />
              <Segmented<TopSort>
                label="Сортировка топ-10"
                size="sm"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'rank', label: 'Рейтинг' },
                  { value: 'confidence', label: 'Уверенность' },
                  { value: 'movement', label: 'Движение' },
                ]}
              />
            </div>
          }
          footer={
            <>
              <span className="muted">{baselineText(view.baseline)} Отклонённые и неоценённые идеи не ранжируются.</span>
              <Link to="/radar" className="link-cta">
                Весь радар <ArrowRight size={14} aria-hidden />
              </Link>
            </>
          }
        >
          {top10View.length ? (
            <Leaderboard entries={top10View} />
          ) : (
            <EmptyState icon={<CircleDashed size={20} />} title={ranking.length ? 'В топ-10 нет идей этого сегмента' : 'Нет оценённых идей'}>
              {ranking.length ? 'Попробуйте другой сегмент или откройте полный радар.' : 'Импортируйте оценку по рубрике v1.0 — без неё идея не получает балл и место в рейтинге.'}
            </EmptyState>
          )}
        </Panel>

        <div className="stack">
          <Panel className="panel--map" eyebrow="Балл × уверенность" title="Карта возможностей" demo footer={<span className="muted">Нажмите на точку, чтобы открыть досье.</span>}>
            {ranking.length ? <OpportunityMap entries={ranking} /> : <EmptyState icon={<CircleDashed size={20} />} title="Нет точек для карты" />}
          </Panel>
          <PipelinePreview view={view} />
        </div>
      </div>

      <div className="grid grid--three">
        <ValidationPreview view={view} />
        <BuildsPreview view={view} />
        <ActivityPreview view={view} />
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone = 'neutral' }: { icon: ReactNode; label: string; value: number; sub: string; tone?: 'neutral' | 'accent' | 'success' | 'muted' }) {
  return (
    <div className={cx('panel kpi', `kpi--${tone}`)}>
      <div className="kpi__head">
        <div className="kpi__label">
          <span className="kpi__icon" aria-hidden>
            {icon}
          </span>
          {label}
        </div>
        <DemoBadge compact label="демо" />
      </div>
      <div className="kpi__value num">{value}</div>
      <div className="kpi__sub">{sub}</div>
    </div>
  );
}

/** Explicit state when no ranked idea is eligible (all critical-risk or paused, or nothing scored). */
function NoEligibleFind({ ranked, unscored }: { ranked: number; unscored: number }) {
  return (
    <section className="panel hero hero--empty" aria-labelledby="hero-title">
      <div className="hero__content">
        <div className="eyebrow hero__eyebrow">
          Сильнейшая находка дня
          <DemoBadge compact />
        </div>
        <h2 id="hero-title" className="hero__title">
          {ranked === 0 ? 'Пока нет оценённых идей' : 'Нет находки без критических рисков'}
        </h2>
        <p className="hero__pitch">
          {ranked === 0
            ? `${unscored ? `${unscored} ${plural(unscored, 'идея ждёт', 'идеи ждут', 'идей ждут')} оценки. ` : ''}Как только появится оценка по рубрике v1.0, здесь будет сильнейшая возможность.`
            : `Все ${ranked} ${plural(ranked, 'идея', 'идеи', 'идей')} в рейтинге либо имеют критический риск, либо стоят на паузе. Высокий балл не отменяет критический риск — нужно ревью основателя.`}
        </p>
        <div className="hero__cta">
          <Link to="/radar" className="btn btn--ghost">
            Открыть радар <ArrowRight size={16} aria-hidden />
          </Link>
        </div>
      </div>
      <aside className="hero__score hero__score--review" aria-label="Статус">
        <Badge tone={ranked === 0 ? 'warn' : 'danger'} icon={<ShieldAlert size={12} aria-hidden />}>
          {ranked === 0 ? 'Не оценено' : 'Требует ревью'}
        </Badge>
      </aside>
    </section>
  );
}

function HeroFind({ entry, asOf }: { entry: RankedEntry; asOf: string }) {
  const { idea } = entry;
  const isReal = useMode() === 'real';
  const band = confidenceBand(entry.confidence);
  const crit = hasCriticalRisk(idea);
  return (
    <section className="panel hero" aria-labelledby="hero-title">
      <div className="hero__glow" aria-hidden />
      <div className="hero__content">
        <div className="eyebrow hero__eyebrow">
          <span className="hero__pulse" aria-hidden />
          Сильнейшая находка
          <DemoBadge compact />
          {isReal && idea.synthetic && <SyntheticBadge compact />}
        </div>
        <h2 id="hero-title" className="hero__title">
          {idea.title}
        </h2>
        <p className="hero__pitch">{idea.shortPitch}</p>
        {(idea.whyNow || idea.nextAction) && (
          <dl className="hero__facts">
            {idea.whyNow && (
              <div>
                <dt>Почему сейчас</dt>
                <dd>{idea.whyNow}</dd>
              </div>
            )}
            {idea.nextAction && (
              <div>
                <dt>Следующий шаг</dt>
                <dd>{idea.nextAction}</dd>
              </div>
            )}
          </dl>
        )}
        <div className="hero__tags">
          <StageBadge stage={idea.stage} />
          <Badge>{idea.category}</Badge>
          <Badge>{idea.segment}</Badge>
          {idea.riskFlags.map((r) => (
            <Badge key={r} tone="warn" icon={<ShieldAlert size={12} aria-hidden />}>
              {RISK_LABEL[r]}
            </Badge>
          ))}
        </div>
        <div className="hero__cta">
          <Link to={`/ideas/${idea.slug}`} className="btn btn--primary">
            Открыть досье <ArrowRight size={16} aria-hidden />
          </Link>
          <span className="muted small">Обновлено {relativeDay(idea.updatedAt, asOf)}</span>
        </div>
      </div>
      <aside className="hero__score" aria-label="Оценка">
        <ScoreRing value={entry.score} caption="балл" size={128} />
        <div className="hero__metric">
          <span className="hero__metric-label">Уверенность</span>
          <ConfidenceMeter value={entry.confidence} />
          <span className={cx('hero__band', `tone-${band.tone}`)}>{band.label}</span>
        </div>
        <div className="hero__metric">
          <span className="hero__metric-label">Рейтинг</span>
          <span className="hero__rank num">#{entry.rank}</span>
        </div>
        {crit && <Badge tone="danger">Требует ревью</Badge>}
      </aside>
    </section>
  );
}

function ResearchPulse({ view }: { view: OverviewView }) {
  const runs = view.researchRuns;
  const latest = runs[0];
  const isReal = view.mode === 'real';
  return (
    <Panel className="pulse" eyebrow={isReal ? 'Исследовательские прогоны' : 'Исследовательский пульс'} title={latest ? `Прогон ${formatDateShort(latest.date)}` : 'Прогонов нет'} demo>
      {latest ? (
        <>
          <div className="pulse__fresh">
            <span className="pulse__dot" aria-hidden />
            Свежесть: {relativeDay(latest.date, view.asOf)}
            {isReal && latest.synthetic && <SyntheticBadge compact />}
          </div>
          <dl className="pulse__stats">
            <div>
              <dt>Новые</dt>
              <dd className="num">{latest.newCandidates}</dd>
            </div>
            <div>
              <dt>Отклонены</dt>
              <dd className="num">{latest.rejectedCandidates}</dd>
            </div>
            <div>
              <dt>Источники</dt>
              <dd className="num">{latest.sourcesReviewed}</dd>
            </div>
          </dl>
          {latest.conclusion && <p className="pulse__conclusion">{latest.conclusion}</p>}
          <ul className="pulse__runs">
            {runs.slice(1, 4).map((r) => (
              <li key={r.id}>
                <span className="num pulse__date">{formatDateShort(r.date)}</span>
                <span className="pulse__markets">{r.marketsExamined.join(', ') || r.id}</span>
                <span className="num muted">+{r.newCandidates}</span>
              </li>
            ))}
          </ul>
          <p className="fineprint">
            {isReal
              ? 'Прогоны импортированы из проверенных JSON-файлов (research/inbox). Автоматического сбора нет.'
              : 'Прогоны вымышлены. Источники не привязаны — автоматический сбор появится в следующих спринтах.'}
          </p>
        </>
      ) : (
        <EmptyState icon={<RadarIcon size={20} />} title="Ещё не было прогонов" />
      )}
    </Panel>
  );
}

const PIPELINE_GROUPS: { label: string; stages: Stage[] }[] = [
  { label: 'Обнаружены и исследуются', stages: ['discovered', 'researching'] },
  { label: 'Оценены', stages: ['scored'] },
  { label: 'Валидация', stages: ['validation_planned', 'validating'] },
  { label: 'Платёжный сигнал', stages: ['paid_signal'] },
  { label: 'Сборка и запуск', stages: ['build_candidate', 'building', 'launched', 'monetizing'] },
  { label: 'Пауза / отклонены', stages: ['paused', 'rejected'] },
];

function PipelinePreview({ view }: { view: OverviewView }) {
  const total = view.kpis.totalIdeas;
  return (
    <Panel eyebrow={`Все ${total} ${plural(total, 'идея', 'идеи', 'идей')} по стадиям`} title="Конвейер идей" demo>
      <ul className="pipeline">
        {PIPELINE_GROUPS.map((g) => {
          const n = g.stages.reduce((acc, s) => acc + (view.stageCounts[s] ?? 0), 0);
          return (
            <li key={g.label} className={cx('pipeline__row', n === 0 && 'is-zero')}>
              <span className="pipeline__label">{g.label}</span>
              <span className="pipeline__bar" aria-hidden>
                <span style={{ width: `${(n / Math.max(1, total)) * 100}%` }} />
              </span>
              <span className="pipeline__n num">{n}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function IdeaRefLink({ view, id, className }: { view: OverviewView; id: string; className: string }) {
  const ref = view.ideaRefs[id];
  if (!ref) return null;
  return (
    <Link to={`/ideas/${ref.slug}`} className={className}>
      {ref.title}
    </Link>
  );
}

function ValidationPreview({ view }: { view: OverviewView }) {
  const f = sumFunnel(view.experiments);
  const steps = [
    { label: 'Контакты', value: f.contacted, base: f.contacted },
    { label: 'Ответили', value: f.replied, base: f.contacted },
    { label: 'Интервью', value: f.interviews, base: f.replied },
    { label: 'Офферы', value: f.offersSent, base: f.interviews },
    { label: 'Оплаты (подтв.)', value: f.paymentsVerified, base: f.offersSent },
  ];
  const max = Math.max(1, f.contacted);
  return (
    <Panel
      eyebrow="Валидация спроса"
      title="Воронка экспериментов"
      demo
      footer={
        <Link to="/validation" className="link-cta">
          Лаборатория валидации <ArrowRight size={14} aria-hidden />
        </Link>
      }
    >
      {view.experiments.length === 0 ? (
        <EmptyState icon={<Beaker size={20} />} title="Экспериментов нет">
          {view.mode === 'real'
            ? 'Учёт интервью, офферов и подтверждённых оплат появится в Лаборатории валидации (VL-004). Здесь не показываются выдуманные цифры.'
            : 'Эксперименты ещё не запланированы.'}
        </EmptyState>
      ) : (
        <>
          <ol className="funnel">
            {steps.map((s, i) => (
              <li key={s.label} className="funnel__step">
                <span className="funnel__label">{s.label}</span>
                <span className="funnel__bar" aria-hidden>
                  <span className={cx('funnel__fill', i === steps.length - 1 && 'funnel__fill--pay')} style={{ width: `${(s.value / max) * 100}%` }} />
                </span>
                <span className="funnel__value num">{s.value}</span>
                <span className="funnel__conv num" title={i ? `${s.value} из ${s.base}` : undefined}>
                  {i === 0 ? '' : pct(s.value, s.base)}
                </span>
              </li>
            ))}
          </ol>
          {f.paymentsPending > 0 && (
            <p className="note note--warn">
              {f.paymentsPending} {plural(f.paymentsPending, 'платёж ожидает', 'платежа ожидают', 'платежей ожидают')} ручной проверки и не считается оплатой.
            </p>
          )}
          <ul className="explist">
            {view.experiments.map((e) => (
              <li key={e.id}>
                <Badge tone={e.status === 'running' ? 'accent' : 'neutral'}>{EXPERIMENT_STATUS_LABEL[e.status]}</Badge>
                <span className="explist__body">
                  <IdeaRefLink view={view} id={e.ideaId} className="explist__idea" />
                  <span className="explist__hyp">{e.hypothesis}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function BuildsPreview({ view }: { view: OverviewView }) {
  return (
    <Panel
      eyebrow="Build Studio"
      title="Статус сборок"
      demo
      footer={
        <Link to="/build" className="link-cta">
          Build Studio <ArrowRight size={14} aria-hidden />
        </Link>
      }
    >
      {view.builds.length === 0 ? (
        <EmptyState icon={<Hammer size={20} />} title="Нет активных сборок">
          Сборка начинается только после решения по итогам валидации.
        </EmptyState>
      ) : (
        <ul className="builds">
          {view.builds.map((b) => {
            const done = b.checklist.filter((c) => c.done).length;
            return (
              <li key={b.id} className="build">
                <div className="build__top">
                  <Badge tone="accent">{BUILD_STAGE_LABEL[b.stage]}</Badge>
                  <span className="muted small num">{formatDateShort(b.updatedAt)}</span>
                </div>
                <IdeaRefLink view={view} id={b.ideaId} className="build__title" />
                <p className="build__task">{b.currentTask}</p>
                <div className="build__progress" role="img" aria-label={`Выполнено ${done} из ${b.checklist.length}`}>
                  {b.checklist.map((c) => (
                    <span key={c.label} className={cx('build__seg', c.done && 'is-done')} title={c.label} />
                  ))}
                  <span className="num small muted">
                    {done}/{b.checklist.length}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="lifecycle" aria-label="Жизненный цикл до сборки">
        <span className="lifecycle__step is-current">Валидация</span>
        <span className="lifecycle__arrow" aria-hidden>
          →
        </span>
        <span className="lifecycle__step">Решение</span>
        <span className="lifecycle__arrow" aria-hidden>
          →
        </span>
        <span className="lifecycle__step">Сборка</span>
      </div>
      <p className="fineprint">GitHub не подключён: ветки, PR и CI появятся в Build Studio.</p>
    </Panel>
  );
}

const ACTOR_ICON: Record<string, ReactNode> = {
  ChatGPT: <Bot size={14} />,
  'Claude Code': <Bot size={14} />,
  Codex: <Bot size={14} />,
  Основатель: <Activity size={14} />,
};

function ActivityPreview({ view }: { view: OverviewView }) {
  if (view.mode === 'real') {
    return (
      <Panel eyebrow="Журнал агентов" title="Активность" footer={<span className="muted">Live-статусы агентов не подключены и не имитируются.</span>}>
        <EmptyState icon={<Database size={20} />} title="Журнал агентов не подключён">
          В REAL-режиме показываются только импортированные записи. История импортов — в «Исследовательских прогонах».
        </EmptyState>
      </Panel>
    );
  }
  return (
    <Panel eyebrow="Журнал агентов" title="Активность" demo footer={<span className="muted">Демо-журнал. Это не live-статусы агентов.</span>}>
      <ol className="timeline">
        {view.activity.map((a) => (
          <li key={a.id} className="timeline__item">
            <span className={cx('timeline__avatar', a.actor === 'Основатель' && 'is-human')} aria-hidden>
              {ACTOR_ICON[a.actor]}
            </span>
            <div className="timeline__body">
              <div className="timeline__head">
                <span className="timeline__actor">{a.actor}</span>
                <span className="timeline__time num">
                  {relativeDay(a.at, view.asOf)}, {formatTime(a.at)}
                </span>
              </div>
              <p className="timeline__text">{a.action}</p>
              {a.ideaId && <IdeaRefLink view={view} id={a.ideaId} className="timeline__idea" />}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
