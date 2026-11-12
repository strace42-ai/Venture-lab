import { AlertTriangle, ArrowLeft, CircleHelp, FileQuestion, Globe2, Link2Off, MapPin, ShieldAlert, Target, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LoadError } from '../components/StateViews';
import { SourceLink } from '../components/SourceLink';
import { PageSkeleton } from '../components/ui/PageSkeleton';
import { Badge, ConfidenceMeter, DemoBadge, EmptyState, MovementIndicator, Panel, ScoreRing, StageBadge, SyntheticBadge } from '../components/ui/primitives';
import { useDataSource, useLoad } from '../data/context';
import {
  COMPETITOR_KIND_LABEL,
  COVERAGE_LABEL,
  CRITICAL_RISKS,
  EVIDENCE_STATUS_LABEL,
  EVIDENCE_STATUS_TONE,
  RISK_LABEL,
  SOURCE_TYPE_LABEL,
  confidenceBand,
} from '../domain/labels';
import { effectiveEvidenceStatus, type IdeaDetailView } from '../domain/selectors';
import { CONFIDENCE_WEIGHTS, DIMENSIONS, breakdown, evidenceConfidence, founderFit, latestAssessment, marketScore, scoreHistory } from '../domain/scoring';
import type { Assessment, Competitor, ConfidenceComponents, Evidence, Idea } from '../domain/types';
import { isLiveMode } from '../domain/types';
import { cx } from '../lib/cx';
import { formatDateLong, formatDateShort } from '../lib/format';

const CONF_LABEL: Record<keyof ConfidenceComponents, string> = {
  completeness: 'Полнота доказательств',
  corroboration: 'Независимое подтверждение',
  recency: 'Свежесть',
  reliability: 'Надёжность источников',
  russiaValidation: 'Проверка в России',
};

export default function IdeaPage() {
  const { slug = '' } = useParams();
  const { source, mode } = useDataSource();
  const state = useLoad(`idea:${mode}:${slug}`, () => source.idea(slug));
  if (state.status === 'loading') return <PageSkeleton />;
  if (state.status === 'error') return <LoadError error={state.error} onRetry={state.retry} />;
  if (!state.data) return <NotFound slug={slug} real={isLiveMode(mode)} />;
  return <Dossier view={state.data} />;
}

function NotFound({ slug, real }: { slug: string; real: boolean }) {
  return (
    <div className="page">
      <div className="panel">
        <EmptyState
          icon={<FileQuestion size={22} />}
          title="Досье не найдено"
          action={
            <Link to="/radar" className="btn btn--ghost">
              <ArrowLeft size={16} aria-hidden /> Вернуться к радару
            </Link>
          }
        >
          Идеи с идентификатором «{slug}» нет {real ? 'в базе исследований' : 'в демо-наборе'}.
        </EmptyState>
      </div>
    </div>
  );
}

function Dossier({ view }: { view: IdeaDetailView }) {
  const { idea, entry } = view;
  const isReal = isLiveMode(view.mode);
  const a = latestAssessment(idea);
  const critical = idea.riskFlags.filter((r) => CRITICAL_RISKS.has(r));

  return (
    <article className="page page--dossier" aria-labelledby="dossier-title">
      <nav className="crumbs" aria-label="Хлебные крошки">
        <Link to="/radar" className="crumbs__back">
          <ArrowLeft size={16} aria-hidden /> Радар
        </Link>
        <span aria-hidden>/</span>
        <span className="crumbs__here">Досье</span>
      </nav>

      <header className="dossier-head">
        <div className="dossier-head__main">
          <div className="eyebrow">
            Досье идеи · {isReal ? idea.slug : idea.id}
            <DemoBadge compact label="Синтетическая идея" />
            {isReal && idea.synthetic && <SyntheticBadge compact />}
          </div>
          <h1 id="dossier-title" className="display display--sm">
            {idea.title}
          </h1>
          <p className="page-head__lede">{idea.shortPitch}</p>
          <div className="dossier-head__tags">
            <StageBadge stage={idea.stage} />
            <Badge>{idea.category}</Badge>
            <Badge>{idea.segment}</Badge>
            {idea.geography && <Badge icon={<MapPin size={12} aria-hidden />}>{idea.geography}</Badge>}
            {critical.length > 0 && (
              <Badge tone="danger" icon={<AlertTriangle size={12} aria-hidden />}>
                Требует ревью
              </Badge>
            )}
          </div>
        </div>
        {a ? <ScoreCard idea={idea} a={a} entry={entry} /> : <UnscoredCard />}
      </header>

      <div className="dossier-grid">
        <div className="dossier-col">
          <Panel title="Тезис" eyebrow="Почему это может сработать" demo>
            {idea.thesis ? <p className="prose">{idea.thesis}</p> : <p className="muted">Тезис не указан в исследовании.</p>}
            <dl className="facts">
              <Fact icon={<Target size={14} aria-hidden />} label="Проблема" value={idea.primaryProblem} />
              <Fact icon={<Users size={14} aria-hidden />} label="Персона" value={idea.targetPersona} />
              <Fact label="Оффер / монетизация" value={idea.offer} />
              <Fact label="Почему сейчас" value={idea.whyNow} />
            </dl>
          </Panel>

          {a ? (
            <DimensionsPanel a={a} />
          ) : (
            <Panel title="12 критериев оценки" eyebrow={`Модель ${view.modelVersion}`}>
              <EmptyState icon={<CircleHelp size={20} />} title="Оценка не импортирована">
                Для этой идеи нет оценки по рубрике v1.0. Балл не присваивается и не равен нулю — идея не участвует в рейтинге, пока не появится оценка с обоснованием и ссылками на источники.
              </EmptyState>
            </Panel>
          )}

          <EvidenceSection idea={idea} />
        </div>

        <div className="dossier-col dossier-col--side">
          <Panel title="Риски" eyebrow="Флаги" demo>
            {idea.riskFlags.length === 0 ? (
              <p className="muted">Флаги риска не выставлены.</p>
            ) : (
              <ul className="risks">
                {idea.riskFlags.map((r) => {
                  const crit = CRITICAL_RISKS.has(r);
                  return (
                    <li key={r} className={cx('risk', crit && 'risk--crit')}>
                      {crit ? <AlertTriangle size={16} aria-hidden /> : <ShieldAlert size={16} aria-hidden />}
                      <span>{RISK_LABEL[r]}</span>
                      {crit && <span className="risk__tag">критический</span>}
                    </li>
                  );
                })}
              </ul>
            )}
            {critical.length > 0 && <p className="note note--danger">Высокий балл не отменяет критический риск: идея остаётся на ревью основателя.</p>}
          </Panel>

          {a && (
            <Panel title="Уверенность" eyebrow={`${evidenceConfidence(a.confidence)} / 100 · отдельно от балла`} demo>
              <ul className="confparts">
                {(Object.keys(CONFIDENCE_WEIGHTS) as (keyof ConfidenceComponents)[]).map((k) => (
                  <li key={k}>
                    <span className="confparts__label">
                      {CONF_LABEL[k]} <span className="muted num">· {Math.round(CONFIDENCE_WEIGHTS[k] * 100)}%</span>
                    </span>
                    <span className="confparts__bar" aria-hidden>
                      <span style={{ width: `${a.confidence[k]}%` }} />
                    </span>
                    <span className="num confparts__v">{a.confidence[k]}</span>
                  </li>
                ))}
              </ul>
              {a.unknowns && a.unknowns.length > 0 && (
                <div className="note">
                  <strong>Неизвестно:</strong> {a.unknowns.join('; ')}
                </div>
              )}
            </Panel>
          )}

          <ValidationPlanPanel idea={idea} />

          <Panel title="История" eyebrow="Append-only" demo>
            <AssessmentHistory idea={idea} />
          </Panel>
        </div>
      </div>
    </article>
  );
}

function Fact({ icon, label, value }: { icon?: ReactNode; label: string; value: string | null }) {
  return (
    <div>
      <dt>
        {icon} {label}
      </dt>
      <dd>{value ?? <span className="muted">не указано</span>}</dd>
    </div>
  );
}

function UnscoredCard() {
  return (
    <div className="scorecard scorecard--unscored" aria-label="Оценка идеи">
      <div className="scorecard__primary">
        <div className="unscored-ring" aria-hidden>
          ?
        </div>
        <div className="scorecard__rank">
          <span className="scorecard__k">Балл</span>
          <span className="scorecard__unscored">Не оценено</span>
          <span className="muted small">не ранжируется</span>
        </div>
      </div>
      <p className="scorecard__note">
        <CircleHelp size={14} aria-hidden /> Идея импортирована без оценки. Уверенность и Founder Fit также не рассчитываются, пока нет оценки по рубрике.
      </p>
    </div>
  );
}

function ScoreCard({ idea, a, entry }: { idea: Idea; a: Assessment; entry: IdeaDetailView['entry'] }) {
  const score = marketScore(a.scores);
  const conf = evidenceConfidence(a.confidence);
  const fitComponents = a.founderFit ?? idea.founderFit;
  const fit = fitComponents ? founderFit(fitComponents) : null;
  const band = confidenceBand(conf);
  return (
    <div className="scorecard" aria-label="Оценка идеи">
      <div className="scorecard__primary">
        <ScoreRing value={score} caption="балл" size={120} />
        <div className="scorecard__rank">
          <span className="scorecard__k">Рейтинг</span>
          {entry ? (
            <>
              <span className="scorecard__rank-n num">#{entry.rank}</span>
              <MovementIndicator movement={entry.movement} scoreDelta={entry.scoreDelta} />
            </>
          ) : (
            <span className="muted">не ранжируется</span>
          )}
        </div>
      </div>
      <dl className="scorecard__side">
        <div>
          <dt>Уверенность в доказательствах</dt>
          <dd>
            <ConfidenceMeter value={conf} />
            <span className={cx('scorecard__band', `tone-${band.tone}`)}>{band.label}</span>
          </dd>
        </div>
        <div>
          <dt>Соответствие основателю</dt>
          <dd>
            {fit === null ? (
              <span className="muted">не оценено</span>
            ) : (
              <>
                <span className="num scorecard__fit">{fit}</span>
                <span className="muted"> / 40</span>
              </>
            )}
          </dd>
        </div>
      </dl>
      <p className="scorecard__note">
        <CircleHelp size={14} aria-hidden /> Балл — насколько привлекательна возможность. Уверенность — насколько этому можно верить. Fit — диагностика, в рейтинг не входит.
      </p>
    </div>
  );
}

function fmtPts(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',');
}

function DimensionsPanel({ a }: { a: Assessment }) {
  const parts = breakdown(a.scores);
  const unknowns = parts.filter((p) => p.unknown).length;
  const score = marketScore(a.scores);
  return (
    <Panel
      id="dimensions"
      title="12 критериев оценки"
      eyebrow={`Модель ${a.modelVersion} · ${formatDateLong(a.assessedAt)} · ${a.assessor}`}
      demo
      footer={
        <span className="muted">
          Вклад = максимум × оценка / 5. Округляется только итог.
          {unknowns > 0 ? ` Неизвестных критериев: ${unknowns} — они дают 0 баллов и снижают уверенность, но не означают отсутствие рынка.` : ''}
        </span>
      }
    >
      {a.reason && <p className="dims__rationale">{a.reason}</p>}
      <ul className="dims" aria-label="Разбивка балла по критериям">
        {DIMENSIONS.map((d, i) => {
          const p = parts[i]!;
          return (
            <li key={d.key} className={cx('dim', p.unknown && 'dim--unknown')}>
              <div className="dim__head">
                <span className="dim__label">{d.label}</span>
                <span className="dim__pts num">
                  {p.unknown ? '?' : fmtPts(p.points)}
                  <span className="muted"> / {d.max}</span>
                </span>
              </div>
              <div className="dim__row">
                <span className="dim__pips" role="img" aria-label={p.unknown ? 'Оценка неизвестна' : `Оценка ${p.raw} из 5`}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <span key={n} className={cx('dim__pip', p.raw !== null && n <= p.raw && 'is-on')} />
                  ))}
                </span>
                <span className="dim__bar" aria-hidden>
                  <span className="dim__fill" style={{ width: `${(p.points / d.max) * 100}%` }} />
                </span>
              </div>
              <p className="dim__q">{d.question}</p>
            </li>
          );
        })}
      </ul>
      <div className="dims__total">
        <span>Итого</span>
        <span className="num">
          {score}
          <span className="muted"> / 100</span>
        </span>
      </div>
    </Panel>
  );
}

function ValidationPlanPanel({ idea }: { idea: Idea }) {
  const plan = idea.validationPlan;
  if (!plan) {
    return (
      <Panel title="План первой валидации" eyebrow="Не задан">
        <p className="muted">План валидации не импортирован. Его ведение появится в Лаборатории валидации (VL-004).</p>
      </Panel>
    );
  }
  return (
    <Panel title="План первой валидации" eyebrow={plan.durationDays ? `${plan.durationDays} дней` : 'Не применимо'} demo>
      <dl className="plan">
        <div>
          <dt>Гипотеза</dt>
          <dd>{plan.hypothesis}</dd>
        </div>
        <div>
          <dt>Кому</dt>
          <dd>{plan.persona}</dd>
        </div>
        <div>
          <dt>Канал</dt>
          <dd>{plan.channel}</dd>
        </div>
        <div>
          <dt>Оффер</dt>
          <dd>{plan.offer}</dd>
        </div>
        <div className="plan__ok">
          <dt>Успех</dt>
          <dd>{plan.successThreshold}</dd>
        </div>
        <div className="plan__stop">
          <dt>Стоп-правило</dt>
          <dd>{plan.stopRule}</dd>
        </div>
      </dl>
      {idea.nextAction && <p className="fineprint">Следующий шаг: {idea.nextAction}</p>}
    </Panel>
  );
}

function AssessmentHistory({ idea }: { idea: Idea }) {
  const history = scoreHistory(idea);
  const stages = [...idea.stageHistory].reverse();
  return (
    <>
      {history.length === 0 ? (
        <p className="muted">Оценок нет.</p>
      ) : (
        <ol className="history" aria-label="История оценок">
          {[...history].reverse().map((h, i, arr) => {
            const prev = arr[i + 1];
            const delta = prev ? h.score - prev.score : null;
            return (
              <li key={`${h.date}-${i}`} className="history__item">
                <span className="history__date num">{formatDateShort(h.date)}</span>
                <span className="history__score num">
                  {h.score}
                  {delta !== null && delta !== 0 && <span className={cx('history__delta', delta > 0 ? 'up' : 'down')}>{delta > 0 ? `+${delta}` : delta}</span>}
                </span>
                <span className="history__conf num muted">ув. {h.confidence}</span>
                <p className="history__reason">{h.reason}</p>
              </li>
            );
          })}
        </ol>
      )}
      {stages.length > 0 && (
        <>
          <h3 className="subhead">Стадии</h3>
          <ol className="stage-history" aria-label="История стадий">
            {stages.map((s, i) => (
              <li key={`${s.at}-${s.stage}-${i}`}>
                <span className="history__date num">{formatDateShort(s.at)}</span>
                <StageBadge stage={s.stage} />
                {s.reason && <span className="muted small">{s.reason}</span>}
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

function EvidenceSection({ idea }: { idea: Idea }) {
  const west = idea.evidence.filter((e) => e.market === 'west');
  const ru = idea.evidence.filter((e) => e.market === 'ru');
  const anyAttached = idea.evidence.some((e) => e.url);
  const westComps = idea.competitors.filter((c) => c.market === 'west');
  const ruComps = idea.competitors.filter((c) => c.market === 'ru');
  return (
    <Panel title="Доказательства и конкуренция" eyebrow={anyAttached ? 'Источники с провенансом' : 'Источники не привязаны'} demo>
      <div className="evidence">
        <EvidenceList title="Запад" icon={<Globe2 size={16} aria-hidden />} items={west} />
        <EvidenceList title="Россия" icon={<MapPin size={16} aria-hidden />} items={ru} />
      </div>

      {westComps.length > 0 && (
        <>
          <h3 className="subhead">Западные аналоги</h3>
          <CompetitorTable items={westComps} caption="Западные аналоги" />
        </>
      )}

      <h3 className="subhead">Конкуренты в России</h3>
      {ruComps.length === 0 ? (
        <p className="muted">Не обнаружены в проверенных источниках. Это не означает, что конкурентов нет.</p>
      ) : (
        <CompetitorTable items={ruComps} caption="Конкуренты в России" />
      )}
      <p className="fineprint">
        «Не обнаружен» ≠ «конкурентов нет». Утверждение считается проверенным, только если у него есть ссылка, издатель, дата наблюдения и статус «проверено». «Проверено» — отметка ручной проверки человеком при подготовке исследования; приложение не открывает ссылки и не проверяет источники автоматически.
      </p>
    </Panel>
  );
}

function CompetitorTable({ items, caption }: { items: Competitor[]; caption: string }) {
  return (
    <div className="table-wrap table-wrap--inner">
      <table className="table table--compact">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Альтернатива</th>
            <th scope="col">Тип</th>
            <th scope="col">Покрытие</th>
            <th scope="col">Пробел</th>
            <th scope="col">Наблюдение</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>{c.url ? <SourceLink url={c.url}>{c.name}</SourceLink> : c.name}</td>
              <td>{COMPETITOR_KIND_LABEL[c.kind]}</td>
              <td>
                <span className={cx('cov', `cov--${c.coverage}`)}>{COVERAGE_LABEL[c.coverage]}</span>
              </td>
              <td className="muted">{c.gap ?? '—'}</td>
              <td className="muted">{c.observedAt ? formatDateShort(c.observedAt) : 'нет даты'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Who made the current verification decision (append-only history lives in the Journal queue). */
function LastDecision({ e }: { e: Evidence }) {
  const last = e.reviews?.[e.reviews.length - 1];
  if (!last || last.status === 'unreviewed') return null;
  return (
    <p className="ev__decision">
      {last.status === 'checked' ? 'Проверил' : 'Отклонил'} {last.origin === 'manual' ? 'вручную' : 'при импорте'}: {last.actor ?? '—'}, {formatDateShort(last.at.slice(0, 10))}
      {last.reason && <> · «{last.reason}»</>}
    </p>
  );
}

function EvidenceList({ title, icon, items }: { title: string; icon: ReactNode; items: Evidence[] }) {
  const dimLabel = (k: string) => DIMENSIONS.find((d) => d.key === k)?.short ?? k;
  return (
    <div className="evlist">
      <h3 className="subhead">
        {icon} {title}
      </h3>
      {items.length === 0 ? (
        <div className="evlist__empty">Доказательств пока нет — критерии с этим рынком оцениваются с низкой уверенностью.</div>
      ) : (
        <ul>
          {items.map((e) => {
            const st = effectiveEvidenceStatus(e);
            return (
              <li key={e.id} className={cx('ev', `ev--${st}`)}>
                <p className="ev__claim">{e.claim}</p>
                {e.url ? (
                  <div className="ev__source">
                    <SourceLink url={e.url}>{e.title ?? e.publisher ?? e.url}</SourceLink>
                    <span className="muted small">
                      {[e.publisher, SOURCE_TYPE_LABEL[e.sourceType], e.observedAt && `наблюдение ${formatDateShort(e.observedAt)}`, e.publishedAt && `опубл. ${formatDateShort(e.publishedAt)}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                ) : null}
                {e.supportNote && <p className="ev__note">{e.supportNote}</p>}
                <LastDecision e={e} />
                <div className="ev__meta">
                  {e.dimensions.map((d) => (
                    <span key={d} className="ev__dim">
                      {dimLabel(d)}
                    </span>
                  ))}
                  {e.url ? (
                    <Badge tone={EVIDENCE_STATUS_TONE[st]} className="ev__status">
                      {EVIDENCE_STATUS_LABEL[st]}
                    </Badge>
                  ) : (
                    <span className="ev__src">
                      <Link2Off size={12} aria-hidden /> источник не привязан
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
