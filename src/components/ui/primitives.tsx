import { FlaskConical, Minus, MoveDown, MoveUp, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { STAGE_LABEL, STAGE_TONE, type StageTone } from '../../domain/labels';
import type { Movement } from '../../domain/scoring';
import type { Stage } from '../../domain/types';
import { cx } from '../../lib/cx';

export function DemoBadge({ label = 'Демо', title = 'Демонстрационные данные — не реальные факты', compact = false }: { label?: string; title?: string; compact?: boolean }) {
  return (
    <span className={cx('demo-badge', compact && 'demo-badge--compact')} title={title}>
      <FlaskConical aria-hidden size={compact ? 11 : 12} strokeWidth={2.2} />
      <span>{label}</span>
    </span>
  );
}

export function Badge({ tone = 'neutral', children, icon, className }: { tone?: StageTone; children: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <span className={cx('badge', `badge--${tone}`, className)}>
      {icon}
      {children}
    </span>
  );
}

export function StageBadge({ stage }: { stage: Stage }) {
  return (
    <Badge tone={STAGE_TONE[stage]}>
      <span className="badge__dot" aria-hidden />
      {STAGE_LABEL[stage]}
    </Badge>
  );
}

export function Panel({
  title,
  eyebrow,
  actions,
  demo,
  children,
  className,
  id,
  footer,
}: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  demo?: boolean;
  children: ReactNode;
  className?: string;
  id?: string;
  footer?: ReactNode;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={cx('panel', className)} aria-labelledby={headingId} id={id}>
      {(title || actions || eyebrow) && (
        <header className="panel__head">
          <div className="panel__titles">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && (
              <h2 className="panel__title" id={headingId}>
                {title}
              </h2>
            )}
          </div>
          <div className="panel__actions">
            {demo && <DemoBadge compact />}
            {actions}
          </div>
        </header>
      )}
      <div className="panel__body">{children}</div>
      {footer && <footer className="panel__foot">{footer}</footer>}
    </section>
  );
}

/** Horizontal 0–max meter with tabular number. */
export function ScoreBar({ value, max = 100, tone = 'accent', label, showValue = true }: { value: number; max?: number; tone?: StageTone; label?: string; showValue?: boolean }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="scorebar" role="img" aria-label={label ?? `${value} из ${max}`}>
      {showValue && <span className="scorebar__value num">{value}</span>}
      <span className="scorebar__track">
        <span className={cx('scorebar__fill', `scorebar__fill--${tone}`)} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

/** Five-segment confidence meter — visually distinct from the score bar on purpose. */
export function ConfidenceMeter({ value, showValue = true }: { value: number; showValue?: boolean }) {
  const filled = Math.round(value / 20);
  const tone = value >= 70 ? 'success' : value >= 50 ? 'accent' : 'warn';
  return (
    <div className={cx('confmeter', `confmeter--${tone}`)} role="img" aria-label={`Уверенность в доказательствах ${value} из 100`}>
      <span className="confmeter__segs" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={cx('confmeter__seg', i < filled && 'is-on')} />
        ))}
      </span>
      {showValue && <span className="confmeter__value num">{value}</span>}
    </div>
  );
}

export function MovementIndicator({ movement, scoreDelta }: { movement: Movement; scoreDelta?: number | null }) {
  if (movement.kind === 'new') {
    return (
      <span className="move move--new" title="Новая в рейтинге — предыдущей позиции нет">
        <Sparkles size={12} aria-hidden />
        <span className="move__txt">Новая</span>
      </span>
    );
  }
  const deltaTitle = scoreDelta != null && scoreDelta !== 0 ? `, балл ${scoreDelta > 0 ? '+' : ''}${scoreDelta}` : '';
  if (movement.kind === 'same') {
    return (
      <span className="move move--same" title={`Без изменений (было #${movement.previousRank}${deltaTitle})`}>
        <Minus size={12} aria-hidden />
        <span className="sr-only">Без изменений</span>
      </span>
    );
  }
  const up = movement.kind === 'up';
  return (
    <span className={cx('move', up ? 'move--up' : 'move--down')} title={`Было #${movement.previousRank}${deltaTitle}`}>
      {up ? <MoveUp size={12} aria-hidden /> : <MoveDown size={12} aria-hidden />}
      <span className="num">{movement.by}</span>
      <span className="sr-only">{up ? 'позиции вверх' : 'позиции вниз'}</span>
    </span>
  );
}

export function Sparkline({ values, width = 64, height = 20, label }: { values: number[]; width?: number; height?: number; label?: string }) {
  if (values.length < 2) {
    return (
      <span className="spark spark--empty" style={{ width }} title="Недостаточно оценок для тренда">
        —
      </span>
    );
  }
  const min = Math.min(...values) - 2;
  const max = Math.max(...values) + 2;
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - ((v - min) / span) * height] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  const first = values[0]!;
  const lastV = values[values.length - 1]!;
  const tone = lastV > first ? 'up' : lastV < first ? 'down' : 'flat';
  return (
    <svg className={cx('spark', `spark--${tone}`)} width={width} height={height} viewBox={`-2 -2 ${width + 4} ${height + 4}`} role="img" aria-label={label ?? `Тренд: ${values.join(' → ')}`}>
      <path d={d} fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.2} />
    </svg>
  );
}

export function ScoreRing({ value, size = 112, stroke = 8, caption }: { value: number; size?: number; stroke?: number; caption?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, value)) / 100);
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={`${caption ?? 'Балл'} ${value} из 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ring__fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={off}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring__label">
        <span className="ring__value num">{value}</span>
        {caption && <span className="ring__caption">{caption}</span>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <h3 className="empty__title">{title}</h3>
      {children && <div className="empty__body">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', r = 6 }: { h?: number; w?: number | string; r?: number }) {
  return <span className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden />;
}
