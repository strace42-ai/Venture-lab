import { ArrowLeft, Bot, ExternalLink, FileWarning, Gavel, PauseCircle, Search, ShieldAlert, ShieldCheck, UserX } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { FeedBanner, GradeBadge } from '../components/MachineBits';
import { LoadError } from '../components/StateViews';
import { PageSkeleton } from '../components/ui/PageSkeleton';
import { Badge, ConfidenceMeter, EmptyState, Panel, ScoreRing } from '../components/ui/primitives';
import { useLoad } from '../data/context';
import { useMachineClient } from '../data/machine';
import { useFeed } from '../data/machine-feed';
import { CLAIM_STATUS_LABEL, MACHINE_STATE_LABEL, type ClaimStatus, type MachineCandidateDetail, type MachineFeed } from '../domain/machine';
import { DIMENSIONS, contribution } from '../domain/scoring';
import { cx } from '../lib/cx';
import { formatDateShort } from '../lib/format';

const CLAIM_TONE: Record<ClaimStatus, 'success' | 'accent' | 'warn' | 'danger' | 'neutral'> = {
  corroborated: 'success',
  single_source: 'accent',
  vendor_claim: 'warn',
  contradicted: 'danger',
  unretrievable: 'danger',
  unknown: 'neutral',
};

const FETCH_LABEL: Record<string, string> = {
  ok: 'прочитано',
  http_error: 'ошибка HTTP',
  blocked: 'доступ запрещён',
  injection_suspected: 'карантин: попытка инъекции',
  rate_limited: 'лимит запросов',
  budget_exhausted: 'лимит бюджета',
  robots_disallowed: 'запрещено robots.txt',
  unsafe_url: 'небезопасный адрес — не открывался',
  unsupported_content: 'формат не поддерживается',
  too_large: 'слишком большой ответ',
  timeout: 'таймаут',
};

const TYPE_LABEL: Record<string, string> = { independent: 'независимый', company_self_report: 'заявление компании', primary_data: 'первичные данные', unknown: 'тип не указан' };
const REVIEWER_LABEL: Record<string, string> = { analyst: 'Аналитик (ИИ)', claim_checker: 'Проверка цитат (код)', skeptic: 'Скептик (ИИ, другая модель)', quality_gate: 'Фильтр качества (код)' };
const SKEPTIC_LABEL: Record<string, string> = { supported: 'подтверждает', refuted: 'опровергает', needs_more_evidence: 'нужны доказательства', not_reviewed: 'не проверял' };
const SKEPTIC_TONE: Record<string, 'success' | 'danger' | 'warn' | 'neutral'> = { supported: 'success', refuted: 'danger', needs_more_evidence: 'warn', not_reviewed: 'neutral' };
const KIND_LABEL: Record<string, string> = { direct: 'прямой', adjacent: 'смежный', substitute: 'заменитель' };

export default function MachineCandidatePage() {
  const { id = '' } = useParams();
  const [feed] = useFeed();
  const client = useMachineClient();
  const state = useLoad(`machine-cand:${feed}:${id}`, () => client.candidate(feed, id));
  return (
    <div className="page page--machine">
      <nav className="crumbs" aria-label="Хлебные крошки">
        <Link to={`/machine?feed=${feed}`} className="crumbs__back">
          <ArrowLeft size={16} aria-hidden /> Автоматический TOP-10
        </Link>
        <span aria-hidden>/</span>
        <span className="crumbs__here">Машинное досье</span>
      </nav>
      <FeedBanner feed={feed} />
      {state.status === 'loading' ? (
        <PageSkeleton />
      ) : state.status === 'error' ? (
        <LoadError error={state.error} onRetry={state.retry} />
      ) : state.data === null ? (
        <div className="panel">
          <EmptyState icon={<FileWarning size={22} />} title="Кандидат не найден">
            В ленте «{feed === 'fixture' ? 'эмуляция' : 'живой воркер'}» такого кандидата нет.
          </EmptyState>
        </div>
      ) : (
        <Dossier d={state.data} feed={feed} />
      )}
    </div>
  );
}

function Dossier({ d, feed }: { d: MachineCandidateDetail; feed: MachineFeed }) {
  const a = d.current;
  const srcByKey = new Map(d.sources.map((s) => [s.key, s]));
  const passed = a.state === 'AUTOMATED_EVIDENCE_PASSED';
  return (
    <article aria-labelledby="mc-title" className="mdossier">
      <header className="dossier-head">
        <div className="dossier-head__main">
          <div className="eyebrow">
            <Bot size={13} aria-hidden /> Машинное досье · {d.externalId} · впервые найдено {formatDateShort(d.firstSeen)}
          </div>
          <h1 id="mc-title" className="display display--sm">
            {a.title}
          </h1>
          <p className="page-head__lede">{a.pitch}</p>
          <div className="dossier-head__tags">
            <Badge tone={passed ? 'success' : a.state === 'RESEARCH_HOLD' ? 'warn' : 'neutral'} icon={passed ? <ShieldCheck size={12} aria-hidden /> : <PauseCircle size={12} aria-hidden />}>
              {MACHINE_STATE_LABEL[a.state]}
            </Badge>
            <GradeBadge grade={a.evidenceGrade} />
            <Badge>{a.category}</Badge>
            <Badge>{a.segment}</Badge>
            <Badge icon={<UserX size={12} aria-hidden />}>Человек не проверял</Badge>
          </div>
        </div>
        <div className="panel scorecard">
          <div className="scorecard__top">
            <ScoreRing value={a.marketScore} caption="балл" />
            <div className="scorecard__rank">
              <span className="eyebrow">Место</span>
              <span className="scorecard__rank-n num">{d.rank ? `#${d.rank}` : '—'}</span>
              <span className="muted small">{d.rank ? 'в автоматическом TOP-10' : 'не в TOP-10'}</span>
            </div>
          </div>
          <dl className="mscore-meta">
            <div>
              <dt className="eyebrow">Уверенность в доказательствах</dt>
              <dd>
                <ConfidenceMeter value={a.confidence} />
              </dd>
            </div>
            <div>
              <dt className="eyebrow">Соответствие основателю</dt>
              <dd className="num">{a.founderFit !== null ? `${a.founderFit} / 40` : '—'}</dd>
            </div>
          </dl>
          <p className="muted small">Оценка {formatDateShort(a.asOf)} · рубрика v1.0 · {a.pipelineVersion}</p>
        </div>
      </header>

      {a.state === 'RESEARCH_HOLD' && (
        <section className="panel integrity-notice" role="alert" aria-labelledby="hold-title">
          <ShieldAlert size={20} aria-hidden className="integrity-notice__icon" />
          <div>
            <h2 id="hold-title" className="integrity-notice__title">
              Отложено автоматически — не рекомендуется
            </h2>
            <ul className="watch-item__reasons">
              {a.holdReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="muted small">Идея перепроверяется в каждом прогоне и вернётся в рейтинг сама, если появятся доказательства. Прежние оценки и срезы не изменяются.</p>
          </div>
        </section>
      )}

      <div className="dossier-grid">
        <div className="dossier-col">
          <Panel title="Утверждения и их проверка" eyebrow="Цитата ↔ источник · машинная проверка">
            <ul className="mclaims">
              {d.claims.map((c) => (
                <li key={c.key} className={cx('mclaim', `mclaim--${c.status}`)}>
                  <div className="mclaim__head">
                    <Badge tone={CLAIM_TONE[c.status]}>{CLAIM_STATUS_LABEL[c.status]}</Badge>
                    {c.highImpact && <Badge tone="accent">ключевое</Badge>}
                    <span className="muted small">{DIMENSIONS.find((x) => x.key === c.dimension)?.short}</span>
                  </div>
                  <p className="mclaim__text">{c.text}</p>
                  {c.quote && <blockquote className="mclaim__quote">«{c.quote}»</blockquote>}
                  <p className="mclaim__skeptic small">
                    <Badge tone={SKEPTIC_TONE[c.skepticVerdict]}>Скептик: {SKEPTIC_LABEL[c.skepticVerdict]}</Badge>
                    {c.skepticReason && <span className="muted"> {c.skepticReason}</span>}
                  </p>
                  <p className="muted small">
                    {c.reason}
                    {c.sourceKeys.length > 0 && <> · источники: {c.sourceKeys.map((k) => srcByKey.get(k)?.publisher ?? k).join(', ')}</>}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Конкуренты и аналоги" eyebrow="Найдены аналитиком и независимым скептиком">
            {d.competitors.length ? (
              <ul className="mcomp">
                {d.competitors.map((c) => (
                  <li key={`${c.market}-${c.name}`} className="mcomp__item">
                    <Badge tone={c.kind === 'direct' ? 'danger' : 'neutral'}>
                      {c.market === 'ru' ? 'РФ' : 'Запад'} · {KIND_LABEL[c.kind]}
                    </Badge>
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="mcomp__name">
                        {c.name} <ExternalLink size={12} aria-hidden />
                      </a>
                    ) : (
                      <span className="mcomp__name">{c.name}</span>
                    )}
                    {c.foundBy === 'skeptic' && <span className="small tone-warn">найден скептиком</span>}
                    {c.note && <span className="muted small">{c.note}</span>}
                    <span className="muted small mcomp__reason">{c.reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Конкурентов не найдено в перечисленных запросах — это не доказательство их отсутствия.</p>
            )}
          </Panel>

          <Panel title="Источники" eyebrow="Недоверенный контент · только извлечённые фрагменты">
            <ul className="msources">
              {d.sources.map((s) => (
                <li key={s.key} className="msource">
                  <div className="msource__head">
                    <Badge tone={s.fetchStatus === 'ok' ? 'success' : 'danger'}>{FETCH_LABEL[s.fetchStatus] ?? s.fetchStatus}</Badge>
                    <span className="muted small">
                      {s.region === 'ru' ? 'РФ' : 'Запад'} · {TYPE_LABEL[s.sourceType]} · {s.agent === 'skeptic' ? 'скептик' : 'аналитик'}
                    </span>
                  </div>
                  <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="msource__url">
                    {s.publisher ?? s.url} <ExternalLink size={12} aria-hidden />
                  </a>
                  {s.fetchedAt && (
                    <span className="small muted msource__line">
                      прочитано {s.fetchedAt.slice(0, 16).replace('T', ' ')} UTC{s.canonicalUrl && s.canonicalUrl !== s.url ? ` · канонический адрес: ${s.canonicalUrl}` : ''}
                    </span>
                  )}
                  {s.failure && <span className="small tone-warn msource__line">{s.failure}</span>}
                  {s.offerUncertain && s.offerUncertain.length > 0 && <span className="small tone-warn msource__line">Не подтверждено страницей: {s.offerUncertain.join('; ')}</span>}
                  {s.excerpt && <p className="msource__excerpt">{s.excerpt}</p>}
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="dossier-col">
          <Panel title="Разбивка балла" eyebrow="12 критериев · ? = неизвестно">
            <ul className="mdims" aria-label="Разбивка машинного балла">
              {DIMENSIONS.map((dim) => {
                const raw = a.scores[dim.key];
                return (
                  <li key={dim.key} className="mdims__row">
                    <span>{dim.short}</span>
                    <span className={cx('num', raw === null && 'muted')}>{raw === null ? '?' : `${raw}/5`}</span>
                    <span className="num muted">
                      {contribution(dim.max, raw)}/{dim.max}
                    </span>
                  </li>
                );
              })}
            </ul>
            {a.dimensionNotes.length > 0 && (
              <details className="mnotes">
                <summary>Как скорректирован балл ({a.dimensionNotes.length})</summary>
                <ul>
                  {a.dimensionNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </details>
            )}
          </Panel>

          <Panel title="Машинные проверки" eyebrow={<><Gavel size={12} aria-hidden /> Независимые проходы</>}>
            <ol className="mreviews">
              {d.reviews.map((r, i) => (
                <li key={i} className="mreview">
                  <div className="mreview__head">
                    <strong>
                      {REVIEWER_LABEL[r.reviewer]}
                      {feed === 'fixture' && (r.reviewer === 'analyst' || r.reviewer === 'skeptic') ? ' — эмуляция' : ''}
                    </strong>
                    <Badge tone={r.decision === 'pass' || r.decision === 'support' ? 'success' : r.decision === 'propose' ? 'neutral' : 'warn'}>{r.decision}</Badge>
                    <span className="muted small">{r.model}</span>
                  </div>
                  <p className="small">{r.summary}</p>
                  {r.findings.length > 0 && (
                    <ul className="mreview__findings">
                      {r.findings.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Покрытие поиска" eyebrow={<><Search size={12} aria-hidden /> Все запросы фиксируются</>}>
            <ul className="msearches">
              {d.searches.map((s, i) => (
                <li key={i}>
                  <span className={cx('small', s.agent === 'skeptic' ? 'tone-warn' : 'muted')}>{s.agent === 'skeptic' ? 'скептик' : 'аналитик'}</span> <span className="muted small">{s.region === 'ru' ? 'РФ' : s.region === 'west' ? 'Запад' : 'мир'}</span> «{s.query}» —{' '}
                  <span className="num">{s.resultCount}</span>
                  {s.status !== 'ok' && <span className="tone-danger small"> ({s.status})</span>}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="История оценок" eyebrow="Неизменяемые машинные ревизии">
            <ol className="mhistory">
              {d.history.map((h) => (
                <li key={h.id} className="mhistory__item">
                  <span className="num">{formatDateShort(h.asOf)}</span>
                  <span className="num">{h.marketScore}</span>
                  <span className="muted small num">ув. {h.confidence}</span>
                  <Badge tone={h.state === 'AUTOMATED_EVIDENCE_PASSED' ? 'success' : 'warn'}>{MACHINE_STATE_LABEL[h.state]}</Badge>
                </li>
              ))}
            </ol>
            <p className="muted small">
              Ссылка на ленту: <Link to={`/machine?feed=${feed}`}>все кандидаты</Link>
            </p>
          </Panel>
        </div>
      </div>
    </article>
  );
}
