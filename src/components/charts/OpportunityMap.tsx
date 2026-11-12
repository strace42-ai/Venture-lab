import { useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { HIGH_CONFIDENCE, HIGH_SCORE, hasCriticalRisk } from '../../domain/selectors';
import type { RankedEntry } from '../../domain/scoring';
import { cx } from '../../lib/cx';

const W = 440;
const H = 300;
const PAD = { l: 36, r: 12, t: 12, b: 32 };

function niceDomain(values: number[], threshold: number, pad = 6): [number, number] {
  const lo = Math.min(...values, threshold) - pad;
  const hi = Math.max(...values, threshold) + pad;
  return [Math.max(0, Math.floor(lo / 10) * 10), Math.min(100, Math.ceil(hi / 10) * 10)];
}

/**
 * Score × evidence-confidence map. Makes the core product distinction visible:
 * a high score with thin evidence is a research task, not a build decision.
 */
export function OpportunityMap({ entries, topN = 10 }: { entries: RankedEntry[]; topN?: number }) {
  const navigate = useNavigate();
  const [active, setActive] = useState<string | null>(null);

  const { xDom, yDom } = useMemo(
    () => ({
      xDom: niceDomain(entries.map((e) => e.confidence), HIGH_CONFIDENCE),
      yDom: niceDomain(entries.map((e) => e.score), HIGH_SCORE),
    }),
    [entries],
  );

  const x = (v: number) => PAD.l + ((v - xDom[0]) / (xDom[1] - xDom[0])) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - ((v - yDom[0]) / (yDom[1] - yDom[0])) * (H - PAD.t - PAD.b);

  const xTicks = range(xDom[0], xDom[1], 10);
  const yTicks = range(yDom[0], yDom[1], 10);
  const activeEntry = entries.find((e) => e.idea.id === active);

  function onKey(e: KeyboardEvent<SVGGElement>, slug: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate(`/ideas/${slug}`);
    }
  }

  // Draw lower ranks first so top ranks sit on top when overlapping.
  const ordered = [...entries].sort((a, b) => b.rank - a.rank);

  return (
    <figure className="omap">
      <div className="omap__canvas">
        <svg viewBox={`0 0 ${W} ${H}`} className="omap__svg" role="group" aria-label="Карта возможностей: балл по вертикали, уверенность в доказательствах по горизонтали">
          {/* Quadrant highlight: strong & well-evidenced */}
          <rect x={x(HIGH_CONFIDENCE)} y={y(yDom[1])} width={x(xDom[1]) - x(HIGH_CONFIDENCE)} height={y(HIGH_SCORE) - y(yDom[1])} className="omap__q-strong" />
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="omap__grid" />
              <text x={PAD.l - 8} y={y(t)} className="omap__tick" textAnchor="end" dominantBaseline="middle">
                {t}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={`x${t}`} x={x(t)} y={H - PAD.b + 16} className="omap__tick" textAnchor="middle">
              {t}
            </text>
          ))}
          <line x1={x(HIGH_CONFIDENCE)} x2={x(HIGH_CONFIDENCE)} y1={PAD.t} y2={H - PAD.b} className="omap__threshold" />
          <line x1={PAD.l} x2={W - PAD.r} y1={y(HIGH_SCORE)} y2={y(HIGH_SCORE)} className="omap__threshold" />
          <text x={W - PAD.r - 6} y={y(yDom[1]) + 14} className="omap__qlabel" textAnchor="end">
            Сильные и обоснованные
          </text>
          <text x={PAD.l + 6} y={y(yDom[1]) + 14} className="omap__qlabel">
            Нужны доказательства
          </text>

          {ordered.map((e) => {
            const isTop = e.rank <= topN;
            const crit = hasCriticalRisk(e.idea);
            const cx_ = x(e.confidence);
            const cy_ = y(e.score);
            return (
              <g
                key={e.idea.id}
                role="link"
                tabIndex={0}
                aria-label={`#${e.rank} ${e.idea.title}: балл ${e.score}, уверенность ${e.confidence}${crit ? ', критический риск' : ''}`}
                className={cx('omap__pt', isTop ? 'is-top' : 'is-rest', crit && 'is-risk', active === e.idea.id && 'is-active')}
                onMouseEnter={() => setActive(e.idea.id)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(e.idea.id)}
                onBlur={() => setActive(null)}
                onClick={() => navigate(`/ideas/${e.idea.slug}`)}
                onKeyDown={(ev) => onKey(ev, e.idea.slug)}
              >
                <circle cx={cx_} cy={cy_} r={11} className="omap__dot" />
                <text x={cx_} y={cy_} className="omap__num" textAnchor="middle" dominantBaseline="central">
                  {e.rank}
                </text>
              </g>
            );
          })}
        </svg>
        {activeEntry && (
          <div
            className="omap__tip"
            style={{
              left: `${(x(activeEntry.confidence) / W) * 100}%`,
              top: `${(y(activeEntry.score) / H) * 100}%`,
            }}
            role="status"
          >
            <strong>
              #{activeEntry.rank} {activeEntry.idea.title}
            </strong>
            <span>
              Балл <b className="num">{activeEntry.score}</b> · Уверенность <b className="num">{activeEntry.confidence}</b>
            </span>
          </div>
        )}
      </div>
      <figcaption className="omap__legend">
        <span>
          <i className="lg lg--top" /> Топ-{topN}
        </span>
        <span>
          <i className="lg lg--rest" /> Остальные
        </span>
        <span>
          <i className="lg lg--risk" /> Критический риск
        </span>
        <span className="omap__axes">↑ балл · → уверенность · пороги {HIGH_SCORE} / {HIGH_CONFIDENCE}</span>
      </figcaption>
    </figure>
  );
}

function range(a: number, b: number, step: number): number[] {
  const out: number[] = [];
  for (let v = a; v <= b; v += step) out.push(v);
  return out;
}
