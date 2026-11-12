import { AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, CheckCircle2, CircleDashed, Clock, Cpu, Minus, PauseCircle, ShieldCheck, Sparkles, Users, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';
import { FeedBanner, GradeBadge } from '../components/MachineBits';
import { useFeed } from '../data/machine-feed';
import { LoadError } from '../components/StateViews';
import { PageSkeleton } from '../components/ui/PageSkeleton';
import { Segmented } from '../components/ui/Segmented';
import { Badge, ConfidenceMeter, EmptyState, Panel, ScoreBar } from '../components/ui/primitives';
import { useLoad } from '../data/context';
import { useMachineClient } from '../data/machine';
import { JOB_STATUS_LABEL, MACHINE_STATE_LABEL, type MachineChange, type MachineFeed, type MachineOverview, type MachineRun, type MachineTopEntry, type MachineWatchItem } from '../domain/machine';
import { cx } from '../lib/cx';
import { formatDateLong, formatDateShort, formatTime, plural } from '../lib/format';

function Move({ e }: { e: MachineTopEntry }) {
  if (e.prevRank === null)
    return (
      <span className="mmove mmove--new" title={e.isNew ? 'Новая идея, впервые в TOP-10' : 'Вошла в TOP-10 (не было в прошлом срезе)'}>
        <Sparkles size={12} aria-hidden /> {e.isNew ? 'новая' : 'вошла'}
      </span>
    );
  const d = e.prevRank - e.rank;
  if (d === 0)
    return (
      <span className="mmove" title="Без изменений">
        <Minus size={12} aria-hidden />
        <span className="sr-only">без изменений</span>
      </span>
    );
  return (
    <span className={cx('mmove', d > 0 ? 'mmove--up' : 'mmove--down')} title={`Было #${e.prevRank}`}>
      {d > 0 ? <ArrowUpRight size={12} aria-hidden /> : <ArrowDownRight size={12} aria-hidden />}
      {Math.abs(d)}
      <span className="sr-only">{d > 0 ? ' вверх' : ' вниз'}, было #{e.prevRank}</span>
    </span>
  );
}

function RunStatus({ o }: { o: MachineOverview }) {
  const run = o.latestRun;
  const failed = run && (run.status === 'failed' || run.status === 'partial');
  return (
    <section className={cx('panel run-strip', failed && 'run-strip--bad', o.stale && 'run-strip--stale')} aria-label="Состояние автономного воркера">
      <div className="run-strip__item">
        <span className="run-strip__label">
          <Clock size={13} aria-hidden /> Последний успешный прогон
        </span>
        <strong>{o.lastSuccess ? `${formatDateLong(o.lastSuccess.asOf)}${o.lastSuccess.finishedAt ? ` · ${formatTime(o.lastSuccess.finishedAt)} UTC` : ''}` : 'ещё не было'}</strong>
        {o.stale && <span className="tone-warn small">данные устарели — успешного прогона за вчера/сегодня нет</span>}
      </div>
      <div className="run-strip__item">
        <span className="run-strip__label">
          <Cpu size={13} aria-hidden /> Последний запуск
        </span>
        {run ? (
          <strong className={cx(run.status === 'succeeded' ? 'tone-success' : failed ? 'tone-danger' : 'tone-warn')}>
            {formatDateShort(run.asOf)} · {JOB_STATUS_LABEL[run.status]}
            {run.attempts > 1 ? ` · попытка ${run.attempts}/${run.maxAttempts}` : ''}
          </strong>
        ) : (
          <strong>—</strong>
        )}
        {failed && <span className="small tone-danger">{run!.partialReason ?? run!.error} — показан последний успешный TOP-10.</span>}
      </div>
      <div className="run-strip__item">
        <span className="run-strip__label">
          <Wallet size={13} aria-hidden /> Расходы
        </span>
        <strong className="num">
          {o.costs.lastRun} / {o.costs.budgetPerRun} ед.
        </strong>
        <span className="small muted num">
          за месяц {o.costs.month} из {o.costs.monthlyBudget}
          {o.costs.priceVersion ? ` · ${o.costs.priceVersion}` : ''}
        </span>
      </div>
      <div className="run-strip__item">
        <span className="run-strip__label">
          <Users size={13} aria-hidden /> Без участия человека
        </span>
        <strong>{o.timezone}, ежедневно 06:00</strong>
        <span className="small muted">поиск → проверка → скептик → оценка → публикация</span>
      </div>
    </section>
  );
}

function TopTable({ entries, feed }: { entries: MachineTopEntry[]; feed: MachineFeed }) {
  return (
    <>
      <div className="table-wrap mtop-wrap">
        <table className="table mtop">
          <caption className="sr-only">Автоматический TOP-10</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Идея</th>
              <th scope="col">Балл</th>
              <th scope="col">Уверенность</th>
              <th scope="col">Доказательства</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.externalId}>
                <td className="mtop__rank">
                  <span className="num">{e.rank}</span>
                  <Move e={e} />
                </td>
                <td>
                  <Link to={`/machine/${e.externalId}?feed=${feed}`} className="t-idea">
                    <span className="t-idea__title">{e.title}</span>
                    <span className="t-idea__meta">
                      {e.category} · {e.segment}
                      {e.isNew ? ' · новое сегодня' : ''}
                    </span>
                  </Link>
                </td>
                <td className="mtop__score">
                  <ScoreBar value={e.marketScore} label={`Балл ${e.marketScore} из 100`} />
                  {e.scoreDelta !== null && e.scoreDelta !== 0 && <span className={cx('num small', e.scoreDelta > 0 ? 'tone-success' : 'tone-danger')}>{e.scoreDelta > 0 ? `+${e.scoreDelta}` : e.scoreDelta}</span>}
                </td>
                <td>
                  <ConfidenceMeter value={e.confidence} />
                </td>
                <td>
                  <GradeBadge grade={e.evidenceGrade} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ol className="mtop-cards" aria-label="Автоматический TOP-10">
        {entries.map((e) => (
          <li key={e.externalId} className="mtop-card">
            <div className="mtop-card__top">
              <span className="mtop-card__rank num">#{e.rank}</span>
              <Move e={e} />
              <GradeBadge grade={e.evidenceGrade} />
            </div>
            <Link to={`/machine/${e.externalId}?feed=${feed}`} className="mtop-card__title">
              {e.title}
            </Link>
            <div className="mtop-card__metrics">
              <ScoreBar value={e.marketScore} label={`Балл ${e.marketScore} из 100`} />
              <ConfidenceMeter value={e.confidence} />
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function WatchItem({ w, feed }: { w: MachineWatchItem; feed: MachineFeed }) {
  return (
    <li className="watch-item">
      <div className="watch-item__head">
        <Badge tone={w.state === 'RESEARCH_HOLD' ? 'warn' : 'neutral'} icon={w.state === 'RESEARCH_HOLD' ? <PauseCircle size={12} aria-hidden /> : <CircleDashed size={12} aria-hidden />}>
          {MACHINE_STATE_LABEL[w.state]}
        </Badge>
        <Link to={`/machine/${w.externalId}?feed=${feed}`} className="watch-item__title">
          {w.title}
        </Link>
        <span className="muted small num">
          балл {w.marketScore} · ув. {w.confidence} · {w.evidenceGrade}
        </span>
      </div>
      {w.holdReasons.length > 0 && (
        <ul className="watch-item__reasons">
          {w.holdReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ChangeItem({ c, feed }: { c: MachineChange; feed: MachineFeed }) {
  const link = (
    <Link to={`/machine/${c.externalId}?feed=${feed}`} className="change-feed__idea">
      {c.title}
    </Link>
  );
  if (c.kind === 'competitor')
    return (
      <li className="change-feed__item">
        <Badge tone={c.competitorKind === 'direct' ? 'danger' : 'neutral'}>{c.market === 'ru' ? 'Новый конкурент в РФ' : 'Новый аналог на Западе'}</Badge> {link}: <strong>{c.competitor}</strong> ({c.competitorKind === 'direct' ? 'прямой' : 'смежный'})
      </li>
    );
  if (c.kind === 'state')
    return (
      <li className="change-feed__item">
        <Badge tone={c.toState === 'AUTOMATED_EVIDENCE_PASSED' ? 'success' : 'warn'}>{MACHINE_STATE_LABEL[c.toState]}</Badge> {link}
        {c.fromState ? <span className="muted"> — было «{MACHINE_STATE_LABEL[c.fromState]}»</span> : null}
        {c.reasons.length > 0 && <span className="muted">: {c.reasons.join('; ')}</span>}
      </li>
    );
  const label = { entered: 'Вошла в TOP', exited: 'Выбыла из TOP', up: 'Выше', down: 'Ниже' }[c.kind];
  return (
    <li className="change-feed__item">
      <Badge tone={c.kind === 'entered' || c.kind === 'up' ? 'success' : 'danger'}>{label}</Badge> {link}
      <span className="muted num">
        {' '}
        {c.from !== null ? `#${c.from}` : '—'} → {c.to !== null ? `#${c.to}` : '—'}
        {c.scoreDelta !== null && c.scoreDelta !== 0 ? ` · балл ${c.scoreDelta > 0 ? '+' : ''}${c.scoreDelta}` : ''}
      </span>
    </li>
  );
}

function Runs({ feed }: { feed: MachineFeed }) {
  const client = useMachineClient();
  const state = useLoad(`machine-runs:${feed}`, () => client.runs(feed));
  if (state.status !== 'ready') return null;
  const runs: MachineRun[] = state.data;
  if (!runs.length) return null;
  return (
    <Panel title="Прогоны воркера" eyebrow="Журнал заданий · идемпотентный ключ на дату">
      <ul className="runs-list">
        {runs.map((r) => (
          <li key={r.id} className="runs-list__item">
            <span className="num">{formatDateShort(r.asOf)}</span>
            <Badge tone={r.status === 'succeeded' ? 'success' : r.status === 'running' || r.status === 'queued' ? 'neutral' : 'danger'}>{JOB_STATUS_LABEL[r.status]}</Badge>
            <span className="muted small num">
              попыток {r.attempts}/{r.maxAttempts} · расход {r.spent}/{r.budgetLimit}
            </span>
            {(r.error || r.partialReason) && <span className="small tone-danger">{r.partialReason ?? r.error}</span>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export default function MachinePage() {
  const [feed, setFeed] = useFeed();
  const client = useMachineClient();
  const state = useLoad(`machine:${feed}`, () => client.overview(feed));

  return (
    <div className="page page--machine">
      <header className="page-head">
        <div className="eyebrow">
          <Bot size={13} aria-hidden /> Автономная бизнес-разведка · машинный датасет
        </div>
        <h1 className="display display--sm">Автоматический TOP-10</h1>
        <p className="page-head__lede machine-lede-short">Находит идеи, проверяет конкурентов в РФ, спорит с собой и публикует рейтинг — без участия человека. «Проверено системой» ≠ проверено человеком.</p>
        <p className="page-head__lede machine-lede-long">
          Воркер сам находит продукты, ищет конкурентов в РФ, сверяет цитаты с источниками, спорит с собственными выводами и пересчитывает баллы по рубрике v1.0 — без одобрения человеком. «Проверено системой» означает машинную проверку доказательств, а не проверку человеком.
        </p>
      </header>
      <Segmented<MachineFeed>
        label="Лента"
        value={feed}
        onChange={setFeed}
        options={[
          { value: 'fixture', label: 'Эмуляция (фикстуры)' },
          { value: 'live', label: 'Живой воркер' },
        ]}
      />
      <FeedBanner feed={feed} />
      {state.status === 'loading' ? (
        <PageSkeleton />
      ) : state.status === 'error' ? (
        <LoadError error={state.error} onRetry={state.retry} />
      ) : (
        <Overview o={state.data} feed={feed} />
      )}
    </div>
  );
}

function Overview({ o, feed }: { o: MachineOverview; feed: MachineFeed }) {
  if (!o.latestRun) {
    return (
      <div className="panel">
        <EmptyState icon={<Bot size={22} />} title={feed === 'live' ? 'Живой воркер ещё не подключён' : 'Воркер ещё не запускался'}>
          {feed === 'live' ? (
            <>Реальные провайдеры поиска и моделей подключаются в отдельном этапе VL-004B. До этого доступна эмуляция на фикстурах.</>
          ) : (
            <>
              Запустите автономный прогон: <code>npm run research:worker:run -- --fixture --as-of 2026-11-10</code>. Никаких подтверждений не требуется.
            </>
          )}
        </EmptyState>
      </div>
    );
  }
  const snap = o.snapshot;
  return (
    <>
      <RunStatus o={o} />
      <div className="machine-grid">
        <Panel
          title={snap ? `TOP-${snap.entries.length} на ${formatDateLong(snap.asOf)}` : 'TOP-10 ещё не опубликован'}
          eyebrow={
            <>
              <ShieldCheck size={12} aria-hidden /> Проверено системой · {snap ? `${snap.entries.length}/10` : '0/10'}
            </>
          }
          className="panel--mtop"
          footer={
            snap ? (
              <span className="muted">
                Только кандидаты в состоянии «Проверено системой». {snap.entries.length < 10 ? `Прошли проверку ${snap.eligibleCount} — TOP не дополняется до десяти. ` : ''}
                {snap.holdCount ? `${snap.holdCount} ${plural(snap.holdCount, 'кандидат отложен', 'кандидата отложены', 'кандидатов отложено')} автоматически.` : ''}
              </span>
            ) : undefined
          }
        >
          {snap && snap.entries.length > 0 ? (
            <TopTable entries={snap.entries} feed={feed} />
          ) : (
            <EmptyState icon={<AlertTriangle size={22} />} title="Нет кандидатов, прошедших проверку">
              Все найденные идеи отложены или ещё исследуются. Рейтинг не заполняется искусственно.
            </EmptyState>
          )}
        </Panel>
        <div className="machine-side">
          <Panel title="Новое в последнем прогоне" eyebrow={<><Sparkles size={12} aria-hidden /> Найдено воркером</>}>
            {o.newToday.length ? (
              <ul className="watch-list">
                {o.newToday.map((w) => (
                  <WatchItem key={w.externalId} w={w} feed={feed} />
                ))}
              </ul>
            ) : (
              <p className="muted small">Новых кандидатов в последнем прогоне нет.</p>
            )}
          </Panel>
          <Panel title="Что изменилось" eyebrow={o.previousSnapshot ? `с ${formatDateShort(o.previousSnapshot.asOf)}` : 'первый срез'}>
            {o.changes.length ? (
              <ul className="change-feed">
                {o.changes.map((c, i) => (
                  <ChangeItem key={`${c.kind}-${c.externalId}-${i}`} c={c} feed={feed} />
                ))}
              </ul>
            ) : (
              <p className="muted small">{o.previousSnapshot ? 'Изменений нет.' : 'Сравнивать пока не с чем.'}</p>
            )}
          </Panel>
        </div>
      </div>
      <Panel
        title="Наблюдение и автоматические отсрочки"
        eyebrow={
          <>
            <PauseCircle size={12} aria-hidden /> Не рекомендуются · перепроверяются в каждом прогоне
          </>
        }
        footer={<span className="muted">Отложенные идеи не входят в TOP-10. Если появятся новые доказательства, следующий прогон вернёт идею автоматически.</span>}
      >
        {o.watchlist.length ? (
          <ul className="watch-list">
            {o.watchlist.map((w) => (
              <WatchItem key={w.externalId} w={w} feed={feed} />
            ))}
          </ul>
        ) : (
          <p className="muted small">
            <CheckCircle2 size={13} aria-hidden /> Отложенных кандидатов нет.
          </p>
        )}
      </Panel>
      <Runs feed={feed} />
    </>
  );
}
