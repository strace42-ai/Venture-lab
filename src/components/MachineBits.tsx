import { Badge } from './ui/primitives';
import type { MachineFeed } from '../domain/machine';

export function FeedBanner({ feed }: { feed: MachineFeed }) {
  return feed === 'fixture' ? (
    <div className="mode-banner mode-banner--test machine-banner" role="status">
      <span className="mode-banner__dot" aria-hidden />
      <strong>Эмуляция на фикстурах</strong>
      <span className="mode-banner__text">детерминированные тестовые провайдеры — не живое исследование. Живые источники подключаются отдельно (VL-004B).</span>
    </div>
  ) : (
    <div className="mode-banner mode-banner--real machine-banner" role="status">
      <span className="mode-banner__dot" aria-hidden />
      <strong>Живой автономный воркер</strong>
      <span className="mode-banner__text">машинная проверка доказательств — не проверка человеком</span>
    </div>
  );
}

const GRADE_TONE = { A: 'success', B: 'accent', C: 'warn', D: 'danger' } as const;

export function GradeBadge({ grade }: { grade: 'A' | 'B' | 'C' | 'D' }) {
  return (
    <Badge tone={GRADE_TONE[grade]} className="grade-badge">
      <span title="Класс доказательств: A — подтверждено несколькими источниками, D — недостаточно">Доказательства {grade}</span>
    </Badge>
  );
}
