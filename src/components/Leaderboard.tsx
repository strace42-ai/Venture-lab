import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { RISK_LABEL } from '../domain/labels';
import { hasCriticalRisk } from '../domain/selectors';
import { scoreHistory, type RankedEntry } from '../domain/scoring';
import { cx } from '../lib/cx';
import { IntegrityFlag } from './IntegrityNotice';
import { ConfidenceMeter, MovementIndicator, ScoreBar, Sparkline } from './ui/primitives';

export function Leaderboard({ entries }: { entries: RankedEntry[] }) {
  return (
    <div className="lb">
      <div className="lb__head" aria-hidden>
        <span>#</span>
        <span>Идея</span>
        <span>Балл</span>
        <span>Уверенность</span>
        <span>Тренд</span>
        <span>Риски</span>
      </div>
      <ol className="lb__list" aria-label="Топ возможностей по рейтингу">
        {entries.map((e) => {
          const crit = hasCriticalRisk(e.idea);
          const history = scoreHistory(e.idea).map((h) => h.score);
          return (
            <li key={e.idea.id} className={cx('lb__row', e.rank === 1 && 'lb__row--lead')}>
              <div className="lb__rank">
                <span className="lb__rank-n num">{e.rank}</span>
                <MovementIndicator movement={e.movement} scoreDelta={e.scoreDelta} />
              </div>
              <div className="lb__idea">
                <Link to={`/ideas/${e.idea.slug}`} className="lb__link">
                  <span className="lb__title">{e.idea.title}</span>
                  <ArrowUpRight size={14} className="lb__go" aria-hidden />
                </Link>
                <span className="lb__meta">
                  {e.idea.category} · {e.idea.segment}
                </span>
                <IntegrityFlag integrity={e.integrity} />
              </div>
              <div className="lb__score">
                <span className="lb__mlabel">Балл</span>
                <ScoreBar value={e.score} label={`Балл ${e.score} из 100`} />
              </div>
              <div className="lb__conf">
                <span className="lb__mlabel">Уверенность</span>
                <ConfidenceMeter value={e.confidence} />
              </div>
              <div className="lb__trend">
                <Sparkline values={history} label={`История балла: ${history.join(' → ')}`} />
              </div>
              <div className="lb__risk">
                {e.idea.riskFlags.length === 0 ? (
                  <span className="lb__risk-none">—</span>
                ) : (
                  <span
                    className={cx('risk-count', crit && 'risk-count--crit')}
                    title={e.idea.riskFlags.map((r) => RISK_LABEL[r]).join(', ')}
                  >
                    {crit && <AlertTriangle size={12} aria-hidden />}
                    <span className="num">{e.idea.riskFlags.length}</span>
                    <span className="sr-only">
                      {' '}
                      риск(а): {e.idea.riskFlags.map((r) => RISK_LABEL[r]).join(', ')}
                      {crit ? '. Требует ревью' : ''}
                    </span>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
