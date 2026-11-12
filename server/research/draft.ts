/**
 * Draft check (VL-003): `npm run research:draft-check -- <file>`.
 *
 * Validates a research draft against the REAL `vl-research-1` schema and reports what a founder must
 * still verify before approving it. It checks STRUCTURE and COVERAGE only — it cannot and does not
 * decide whether a claim is true. A URL that exists is not proof of the claim.
 */
import type { Queryable } from '../db/pool';
import { validateResearch, type Diagnostic } from './importer';
import type { ResearchEnvelope } from './schema';

export interface DraftIdeaReport {
  externalId: string;
  title: string;
  sources: { total: number; west: number; ru: number; withoutUrl: number; withoutPublisher: number; withoutObservedAt: number };
  competitors: { west: number; ru: number };
  assessment: 'none' | 'present';
  unknownDimensions: number;
  citedSources: number;
  findings: Diagnostic[];
}

export interface DraftReport {
  ok: boolean;
  source: ResearchEnvelope['source'] | null;
  runId: string | null;
  ideas: DraftIdeaReport[];
  findings: Diagnostic[];
  /** Short, honest verdict. */
  verdict: 'invalid' | 'needs-work' | 'ready-for-founder-review';
  nextSteps: string[];
}

export function canonicalUrlKey(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}${x.search}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/**
 * @param db optional — when given, URLs already stored in the REAL dataset are reported (warning only:
 *   the same source may legitimately support several ideas).
 */
export async function checkDraft(bytes: Buffer | string, db?: Queryable): Promise<DraftReport> {
  const v = validateResearch(bytes);
  const findings: Diagnostic[] = [...v.diagnostics];
  if (!v.ok || !v.envelope) {
    return { ok: false, source: null, runId: null, ideas: [], findings, verdict: 'invalid', nextSteps: ['Исправьте ошибки схемы (см. выше) и повторите проверку.'] };
  }
  const env = v.envelope;
  if (env.source === 'synthetic-test') findings.push({ level: 'warning', path: 'source', message: 'это синтетический тестовый файл — для черновика реального исследования используйте source "ai-draft"' });
  if (env.ideas.length > 10) findings.push({ level: 'warning', path: 'ideas', message: `в одном прогоне ${env.ideas.length} идей — рекомендовано 1–10` });

  const urlSeen = new Map<string, string>();
  const ideas: DraftIdeaReport[] = env.ideas.map((idea, i) => {
    const f: Diagnostic[] = [];
    const p = `ideas.${i}(${idea.externalId})`;
    const srcs = idea.sources;
    const rep: DraftIdeaReport = {
      externalId: idea.externalId,
      title: idea.title,
      sources: {
        total: srcs.length,
        west: srcs.filter((s) => s.region === 'west').length,
        ru: srcs.filter((s) => s.region === 'ru').length,
        withoutUrl: srcs.filter((s) => !s.url).length,
        withoutPublisher: srcs.filter((s) => !s.publisher).length,
        withoutObservedAt: srcs.filter((s) => !s.observedAt).length,
      },
      competitors: { west: idea.westernProducts.length, ru: idea.russianCompetitors.length },
      assessment: idea.assessment ? 'present' : 'none',
      unknownDimensions: idea.assessment ? Object.values(idea.assessment.scores).filter((x) => x === null).length : 12,
      citedSources: idea.assessment?.evidenceIds.length ?? 0,
      findings: f,
    };
    if (rep.sources.total === 0) f.push({ level: 'error', path: p, message: 'нет ни одного источника' });
    if (rep.sources.west === 0) f.push({ level: 'warning', path: p, message: 'нет западных источников (спрос/оплата на Западе не подкреплены)' });
    if (rep.sources.ru === 0) f.push({ level: 'warning', path: p, message: 'нет российских источников — пробел в РФ не подтверждён; укажите, что искали (coverage)' });
    if (rep.competitors.ru === 0) f.push({ level: 'warning', path: p, message: 'не указаны российские конкуренты/заменители — «не найдено» ≠ «нет конкурентов»' });
    if (rep.sources.withoutUrl || rep.sources.withoutPublisher || rep.sources.withoutObservedAt) {
      f.push({ level: 'warning', path: p, message: `атрибуция неполная: без URL ${rep.sources.withoutUrl}, без издателя ${rep.sources.withoutPublisher}, без даты наблюдения ${rep.sources.withoutObservedAt} — такие утверждения никогда не станут «проверенными»` });
    }
    if (!idea.assessment) f.push({ level: 'warning', path: p, message: 'нет оценки по рубрике — идея будет «не оценено» и не войдёт в рейтинг (это допустимо)' });
    else if (rep.unknownDimensions > 0) f.push({ level: 'warning', path: p, message: `${rep.unknownDimensions} критериев оценки неизвестны (null)` });
    for (const [j, s] of srcs.entries()) {
      if (!s.url) continue;
      const key = canonicalUrlKey(s.url);
      const other = urlSeen.get(key);
      if (other) f.push({ level: 'warning', path: `${p}.sources.${j}`, message: `URL уже использован (${other}) — проверьте, что это не дубль (повтор допустим, если источник подтверждает разное)` });
      else urlSeen.set(key, `${idea.externalId}/${s.id}`);
    }
    const compUrls = new Set<string>();
    for (const c of [...idea.westernProducts, ...idea.russianCompetitors]) {
      if (!c.url) continue;
      const key = canonicalUrlKey(c.url);
      if (compUrls.has(key)) f.push({ level: 'warning', path: p, message: `дублирующийся URL конкурента/аналога: ${c.url}` });
      compUrls.add(key);
    }
    return rep;
  });

  if (db) {
    const urls = [...urlSeen.keys()];
    if (urls.length) {
      const r = await db.query<{ url: string; external_id: string }>(
        `SELECT e.url, i.external_id FROM evidence e JOIN ideas i ON i.id = e.idea_id WHERE i.synthetic = false AND e.url IS NOT NULL`,
      );
      for (const row of r.rows) {
        const key = canonicalUrlKey(row.url);
        if (urlSeen.has(key)) findings.push({ level: 'warning', path: urlSeen.get(key)!, message: `этот URL уже хранится в REAL у идеи "${row.external_id}" (предупреждение, не ошибка)` });
      }
    }
  }

  const errors = [...findings, ...ideas.flatMap((i) => i.findings)].filter((d) => d.level === 'error');
  const nextSteps: string[] = [];
  if (env.source === 'ai-draft') {
    nextSteps.push('Откройте каждый источник и убедитесь, что он действительно подтверждает утверждение (дата, издатель, формулировка).');
    nextSteps.push('Проверьте российских конкурентов вручную; отсутствие найденного ≠ отсутствие конкуренции.');
    nextSteps.push('Если согласны: замените source на "human-reviewed", добавьте блок approval {approvedBy, approvedAt, statement}, перенесите файл в research/inbox/.');
    nextSteps.push('Затем: npm run research:import -- research/inbox/<файл>.json (dry-run), и только после этого --apply.');
    nextSteps.push('Статус «проверено» ставится по каждому источнику отдельно: npm run research:review -- … --apply.');
  }
  return {
    ok: errors.length === 0,
    source: env.source,
    runId: env.runId,
    ideas,
    findings,
    verdict: errors.length ? 'needs-work' : 'ready-for-founder-review',
    nextSteps,
  };
}
