import { AlertTriangle, ArrowLeft, CircleHelp, FileQuestion, Globe2, Link2Off, MapPin, ShieldAlert, Target, Users } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, ConfidenceMeter, DemoBadge, EmptyState, MovementIndicator, Panel, ScoreRing, StageBadge } from '../components/ui/primitives';
import { useData } from '../data/context';
import { COMPETITOR_KIND_LABEL, COVERAGE_LABEL, CRITICAL_RISKS, RISK_LABEL, confidenceBand } from '../domain/labels';
import { fullRanking, ideaById } from '../domain/selectors';
import {
  CONFIDENCE_WEIGHTS,
  DIMENSIONS,
  breakdown,
  currentAssessment,
  evidenceConfidence,
  founderFit,
  marketScore,
  scoreHistory,
} from '../domain/scoring';
import type { ConfidenceComponents, EvidencePlaceholder, Idea } from '../domain/types';
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
  const data = useData();
  const idea = ideaById(data, slug);
  const entry = useMemo(() => fullRanking(data).find((e) => e.idea.id === idea?.id), [data, idea]);

  if (!idea) {
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
            Идеи с идентификатором «{slug}» нет в демо-наборе.
          </EmptyState>
        </div>
      </div>
    );
  }

  const a = currentAssessment(idea);
  const score = marketScore(a.scores);
  const conf = evidenceConfidence(a.confidence);
  const fit = founderFit(idea.founderFit);
  const parts = breakdown(a.scores);
  const history = scoreHistory(idea);
  const band = confidenceBand(conf);
  const critical = idea.riskFlags.filter((r) => CRITICAL_RISKS.has(r));
  const unknowns = parts.filter((p) => p.unknown).length;

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
            Досье идеи · {idea.id}
            <DemoBadge compact label="Синтетическая идея" />
          </div>
          <h1 id="dossier-title" className="display display--sm">
            {idea.title}
          </h1>
          <p className="page-head__lede">{idea.shortPitch}</p>
          <div className="dossier-head__tags">
            <StageBadge stage={idea.stage} />
            <Badge>{idea.category}</Badge>
            <Badge>{idea.segment}</Badge>
            <Badge icon={<MapPin size={12} aria-hidden />}>{idea.geography}</Badge>
            {critical.length > 0 && (
              <Badge tone="danger" icon={<AlertTriangle size={12} aria-hidden />}>
                Требует ревью
              </Badge>
            )}
          </div>
        </div>

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
                <span className="num scorecard__fit">{fit}</span>
                <span className="muted"> / 40</span>
              </dd>
            </div>
          </dl>
          <p className="scorecard__note">
            <CircleHelp size={14} aria-hidden /> Балл — насколько привлекательна возможность. Уверенность — насколько этому можно верить. Fit — диагностика, в рейтинг не входит.
          </p>
        </div>
      </header>

      <div className="dossier-grid">
        <div className="dossier-col">
          <Panel title="Тезис" eyebrow="Почему это может сработать" demo>
            <p className="prose">{idea.thesis}</p>
            <dl className="facts">
              <div>
                <dt>
                  <Target size={14} aria-hidden /> Проблема
                </dt>
                <dd>{idea.primaryProblem}</dd>
              </div>
              <div>
                <dt>
                  <Users size={14} aria-hidden /> Персона
                </dt>
                <dd>{idea.targetPersona}</dd>
              </div>
              <div>
                <dt>Оффер</dt>
                <dd>{idea.offer}</dd>
              </div>
              <div>
                <dt>Почему сейчас</dt>
                <dd>{idea.whyNow}</dd>
              </div>
            </dl>
          </Panel>

          <Panel
            id="dimensions"
            title="12 критериев оценки"
            eyebrow={`Модель ${a.modelVersion} · ${formatDateLong(a.assessedAt)} · ${a.assessor}`}
            demo
            footer={
              <span className="muted">
                Вклад = максимум × оценка / 5. Округляется только итог.{unknowns > 0 ? ` Неизвестных критериев: ${unknowns} — они дают 0 баллов и снижают уверенность, но не означают отсутствие рынка.` : ''}
              </span>
            }
          >
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

          <Panel title="Уверенность" eyebrow={`${conf} / 100 · отдельно от балла`} demo>
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
          </Panel>

          <Panel title="План первой валидации" eyebrow={idea.validationPlan.durationDays ? `${idea.validationPlan.durationDays} дней` : 'Не применимо'} demo>
            <dl className="plan">
              <div>
                <dt>Гипотеза</dt>
                <dd>{idea.validationPlan.hypothesis}</dd>
              </div>
              <div>
                <dt>Кому</dt>
                <dd>{idea.validationPlan.persona}</dd>
              </div>
              <div>
                <dt>Канал</dt>
                <dd>{idea.validationPlan.channel}</dd>
              </div>
              <div>
                <dt>Оффер</dt>
                <dd>{idea.validationPlan.offer}</dd>
              </div>
              <div className="plan__ok">
                <dt>Успех</dt>
                <dd>{idea.validationPlan.successThreshold}</dd>
              </div>
              <div className="plan__stop">
                <dt>Стоп-правило</dt>
                <dd>{idea.validationPlan.stopRule}</dd>
              </div>
            </dl>
            <p className="fineprint">Следующий шаг: {idea.nextAction}</p>
          </Panel>

          <Panel title="История оценок" eyebrow="Append-only" demo>
            <ol className="history">
              {[...history].reverse().map((h, i, arr) => {
                const prev = arr[i + 1];
                const delta = prev ? h.score - prev.score : null;
                return (
                  <li key={h.date} className="history__item">
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
          </Panel>
        </div>
      </div>
    </article>
  );
}

function fmtPts(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',');
}

function EvidenceSection({ idea }: { idea: Idea }) {
  const west = idea.evidence.filter((e) => e.market === 'west');
  const ru = idea.evidence.filter((e) => e.market === 'ru');
  return (
    <Panel title="Доказательства и конкуренция" eyebrow="Источники не привязаны" demo>
      <div className="evidence">
        <EvidenceList title="Западные аналоги" icon={<Globe2 size={16} aria-hidden />} items={west} />
        <EvidenceList title="Россия" icon={<MapPin size={16} aria-hidden />} items={ru} />
      </div>

      <h3 className="subhead">Конкуренты в России</h3>
      {idea.competitors.length === 0 ? (
        <p className="muted">Не обнаружены в проверенных источниках (проверка не проводилась).</p>
      ) : (
        <div className="table-wrap table-wrap--inner">
          <table className="table table--compact">
            <caption className="sr-only">Конкуренты (демо, не проверены)</caption>
            <thead>
              <tr>
                <th scope="col">Альтернатива</th>
                <th scope="col">Тип</th>
                <th scope="col">Покрытие</th>
                <th scope="col">Пробел</th>
                <th scope="col">Проверено</th>
              </tr>
            </thead>
            <tbody>
              {idea.competitors.map((c) => (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td>{COMPETITOR_KIND_LABEL[c.kind]}</td>
                  <td>
                    <span className={cx('cov', `cov--${c.coverage}`)}>{COVERAGE_LABEL[c.coverage]}</span>
                  </td>
                  <td className="muted">{c.gap}</td>
                  <td className="muted">{c.verifiedAt ? formatDateShort(c.verifiedAt) : 'нет'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="fineprint">
        Конкуренты описаны категориями, без названий компаний: до привязки источников это гипотезы. «Не обнаружен» ≠ «конкурентов нет».
      </p>
    </Panel>
  );
}

function EvidenceList({ title, icon, items }: { title: string; icon: ReactNode; items: EvidencePlaceholder[] }) {
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
          {items.map((e) => (
            <li key={e.claim} className="ev">
              <p className="ev__claim">{e.claim}</p>
              <div className="ev__meta">
                <span className="ev__dim">{dimLabel(e.dimension)}</span>
                <span className="ev__src">
                  <Link2Off size={12} aria-hidden /> источник не привязан
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
