import type { AssessmentIntegrity } from '../domain/integrity';
import { plural } from './format';

/** «2 источника» style list of ids, for compact labels. */
function idsLabel(ids: string[]): string {
  return ids.join(', ');
}

/** Human-readable reason, with the concrete evidence ids. */
export function integrityReason(i: AssessmentIntegrity): string {
  const parts: string[] = [];
  if (i.rejected.length) parts.push(`${plural(i.rejected.length, 'источник', 'источники', 'источники')} ${idsLabel(i.rejected)} ${plural(i.rejected.length, 'отклонён', 'отклонены', 'отклонены')}`);
  if (i.missing.length) parts.push(`${plural(i.missing.length, 'источник', 'источники', 'источники')} ${idsLabel(i.missing)} не ${plural(i.missing.length, 'найден', 'найдены', 'найдены')}`);
  return parts.join('; ');
}
