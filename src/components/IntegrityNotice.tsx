import { ShieldX } from 'lucide-react';
import type { AssessmentIntegrity } from '../domain/integrity';
import { integrityReason } from '../lib/integrity-text';
import { Badge } from './ui/primitives';

/** Compact flag for leaderboard / radar rows. Renders nothing unless the assessment needs review. */
export function IntegrityFlag({ integrity }: { integrity: AssessmentIntegrity }) {
  if (integrity.status !== 'needs-review') return null;
  return (
    <Badge tone="danger" icon={<ShieldX size={12} aria-hidden />} className="integrity-flag">
      <span title={`Оценка требует пересмотра: ${integrityReason(integrity)}`}>Оценка требует пересмотра</span>
      <span className="sr-only">: {integrityReason(integrity)}</span>
    </Badge>
  );
}

/**
 * Full notice for the dossier: what is wrong, what it does and does not change, and how to lift it.
 * Nothing here rewrites history: the stored assessment and frozen snapshots stay as they are.
 */
export function IntegrityNotice({ integrity, live }: { integrity: AssessmentIntegrity; live: boolean }) {
  if (integrity.status !== 'needs-review') return null;
  return (
    <section className="panel integrity-notice" role="alert" aria-labelledby="integrity-title">
      <ShieldX size={20} aria-hidden className="integrity-notice__icon" />
      <div>
        <h2 id="integrity-title" className="integrity-notice__title">
          Оценка требует пересмотра: {integrityReason(integrity)}
        </h2>
        <p>
          Текущая оценка ссылается на {integrity.rejected.length ? 'опровергнутую при проверке' : 'отсутствующую'} опору. Идея остаётся в рейтинге с прежним баллом, но <strong>не рекомендуется</strong>: она исключена из «сильнейшей находки»
          и из «сильных и обоснованных». Историческая оценка и сохранённые срезы не изменены.
        </p>
        <p className="muted small">
          Как снять предупреждение: импортировать новую ревизию оценки (новый прогон с <code>assessment</code> и <code>revisionReason</code>), которая не опирается на отклонённые источники
          {live && (
            <>
              , либо, если отклонение было ошибкой, пересмотреть решение по источнику: <code>npm run research:review -- … --status checked --reason "…" --apply</code>
            </>
          )}
          .
        </p>
      </div>
    </section>
  );
}
