import { assessmentIntegrity, type AssessmentIntegrity } from './integrity';
import type {
  Assessment,
  ComponentScores,
  ConfidenceComponents,
  DimensionKey,
  FounderFitComponents,
  ISODate,
  Idea,
  RankBaseline,
  RawScore,
  Stage,
} from './types';

export const SCORING_MODEL_VERSION = 'v1.0';

export interface DimensionDef {
  key: DimensionKey;
  label: string;
  short: string;
  max: number;
  question: string;
}

/** Fixed weights from docs/scoring-model.md — must sum to 100. */
export const DIMENSIONS: readonly DimensionDef[] = [
  { key: 'westernNeed', label: 'Подтверждённая потребность на Западе', short: 'Спрос Запад', max: 12, question: 'Есть ли регулярное использование, частота проблемы, удержание, независимые отзывы?' },
  { key: 'westernPay', label: 'Готовность платить на Западе', short: 'Оплата Запад', max: 8, question: 'Есть ли реальные платящие пользователи, проверяемая выручка или продления — а не только прайс-лист?' },
  { key: 'ruWeakness', label: 'Слабость российских альтернатив', short: 'Слабость РФ', max: 12, question: 'Найдены ли прямые и смежные конкуренты, жалобы пользователей, пробелы в функциях, цены, реальный доступ?' },
  { key: 'ruUnmetJob', label: 'Неудовлетворённый сценарий в России', short: 'Пробел РФ', max: 8, question: 'Можно ли назвать конкретного недообслуженного пользователя и почему альтернативы не справляются?' },
  { key: 'monetization', label: 'Реализуемость монетизации', short: 'Монетизация', max: 10, question: 'Кто платит, метрика ценности, юнит-экономика, бюджет и сложность закупки?' },
  { key: 'speedToPilot', label: 'Скорость до первого платного пилота', short: 'Первый пилот', max: 10, question: 'Тёплый доступ, срочность проблемы, консьерж/предпродажа, длина цикла сделки?' },
  { key: 'mvpFeasible', label: 'MVP по силам соло-разработчику + ИИ', short: 'MVP соло', max: 10, question: 'Один разработчик с доступными инструментами, зависимости, технический риск, стоимость?' },
  { key: 'fastTest', label: 'Проверка за 7–14 дней', short: 'Тест 7–14 дн', max: 8, question: 'Измеримый тест на реальных пользователях с правилами остановки и без полной разработки?' },
  { key: 'distribution', label: 'Доступная дистрибуция первых пользователей', short: 'Дистрибуция', max: 8, question: 'Понятные сообщества, достижимая аудитория, недорогие и повторяемые каналы?' },
  { key: 'retention', label: 'Потенциал удержания и повторов', short: 'Удержание', max: 6, question: 'Постоянный рабочий процесс, стоимость переключения, повторяющаяся боль?' },
  { key: 'defensibility', label: 'Защитимая дифференциация', short: 'Защита', max: 4, question: 'Данные, дистрибуция, процесс или бренд — а не просто «есть ИИ»?' },
  { key: 'riskManageable', label: 'Управляемый юр./операционный риск', short: 'Риски', max: 4, question: 'Комплаенс, зависимость от API и вендоров, доверие и безопасность, операционные издержки?' },
] as const;

export const DIMENSION_KEYS: readonly DimensionKey[] = DIMENSIONS.map((d) => d.key);

export const MAX_TOTAL = DIMENSIONS.reduce((sum, d) => sum + d.max, 0);

export interface DimensionContribution {
  key: DimensionKey;
  raw: RawScore;
  max: number;
  /** Unrounded weighted points: max × raw / 5. Unknown contributes 0 but is flagged. */
  points: number;
  unknown: boolean;
}

export function contribution(max: number, raw: RawScore): number {
  if (raw === null) return 0;
  if (raw < 0 || raw > 5) throw new RangeError(`Raw score must be 0–5, got ${raw}`);
  return (max * raw) / 5;
}

export function breakdown(scores: ComponentScores): DimensionContribution[] {
  return DIMENSIONS.map((d) => {
    const raw = scores[d.key];
    return { key: d.key, raw, max: d.max, points: contribution(d.max, raw), unknown: raw === null };
  });
}

/** Market Opportunity Score 0–100. Only the final total is rounded. */
export function marketScore(scores: ComponentScores): number {
  const sum = breakdown(scores).reduce((acc, c) => acc + c.points, 0);
  return Math.round(sum);
}

export function unknownCount(scores: ComponentScores): number {
  return DIMENSION_KEYS.filter((k) => scores[k] === null).length;
}

export const CONFIDENCE_WEIGHTS: Record<keyof ConfidenceComponents, number> = {
  completeness: 0.3,
  corroboration: 0.25,
  recency: 0.15,
  reliability: 0.2,
  russiaValidation: 0.1,
};

/** Evidence confidence 0–100, separate from the market score. */
export function evidenceConfidence(c: ConfidenceComponents): number {
  const keys = Object.keys(CONFIDENCE_WEIGHTS) as (keyof ConfidenceComponents)[];
  const value = keys.reduce((acc, k) => acc + clamp(c[k], 0, 100) * CONFIDENCE_WEIGHTS[k], 0);
  return Math.round(value);
}

/** Founder Fit 0–40, diagnostic only — never mixed into rank. */
export function founderFit(f: FounderFitComponents): number {
  return (
    clamp(f.skills, 0, 10) +
    clamp(f.access, 0, 10) +
    clamp(f.timeToSale, 0, 10) +
    clamp(f.motivation, 0, 5) +
    clamp(f.synergy, 0, 5)
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function currentAssessment(idea: Idea): Assessment {
  const last = latestAssessment(idea);
  if (!last) throw new Error(`Idea ${idea.id} has no assessment`);
  return last;
}

/** Latest assessment or `undefined` for an unscored idea (never a fabricated zero). */
export function latestAssessment(idea: Idea): Assessment | undefined {
  return idea.assessments[idea.assessments.length - 1];
}

export function isScored(idea: Idea): boolean {
  return idea.assessments.length > 0;
}

/** Latest assessment on or before `date`, or undefined if the idea was not assessed yet. */
export function assessmentAsOf(idea: Idea, date: ISODate): Assessment | undefined {
  let found: Assessment | undefined;
  for (const a of idea.assessments) {
    if (a.assessedAt <= date) found = a;
  }
  return found;
}

export interface ScoredIdea {
  idea: Idea;
  assessment: Assessment;
  score: number;
  confidence: number;
  /** Founder Fit 0–40, or null when it was never assessed. Diagnostic only. */
  founderFit: number | null;
  firstPayment: number;
  unknowns: number;
  /**
   * CURRENT evidence integrity of this assessment (derived from today's review statuses; never
   * stored, never changes score/confidence). See integrity.ts.
   */
  integrity: AssessmentIntegrity;
}

export function scoreIdea(idea: Idea, assessment: Assessment = currentAssessment(idea)): ScoredIdea {
  const fit = assessment.founderFit ?? idea.founderFit;
  return {
    idea,
    assessment,
    score: marketScore(assessment.scores),
    confidence: evidenceConfidence(assessment.confidence),
    founderFit: fit ? founderFit(fit) : null,
    firstPayment: contribution(10, assessment.scores.speedToPilot),
    unknowns: unknownCount(assessment.scores),
    integrity: assessmentIntegrity(idea, assessment),
  };
}

/**
 * Rank comparator per scoring-model.md:
 * score desc → confidence desc → first-payment feasibility desc → stable id asc.
 */
export function compareRank(a: ScoredIdea, b: ScoredIdea): number {
  return (
    b.score - a.score ||
    b.confidence - a.confidence ||
    b.firstPayment - a.firstPayment ||
    a.idea.id.localeCompare(b.idea.id)
  );
}

export const EXCLUDED_FROM_RANKING: ReadonlySet<Stage> = new Set<Stage>(['rejected']);

/**
 * Lifecycle stage the idea had on `date`, from its append-only stage history.
 * `undefined` = the idea had no recorded stage yet (did not exist in that snapshot).
 */
export function stageAsOf(idea: Idea, date: ISODate): Stage | undefined {
  let found: Stage | undefined;
  for (const c of idea.stageHistory) {
    if (c.at <= date) found = c.stage;
  }
  return found;
}

/**
 * Rank all ideas as they were on `asOf` (or as they are now when omitted).
 * Both the assessment AND the lifecycle stage are taken as of that date, so a later
 * status change (e.g. rejection) never rewrites an earlier snapshot.
 */
export function rankIdeas(ideas: Idea[], asOf?: ISODate): ScoredIdea[] {
  const scored: ScoredIdea[] = [];
  for (const idea of ideas) {
    const stage = asOf ? stageAsOf(idea, asOf) : idea.stage;
    if (!stage || EXCLUDED_FROM_RANKING.has(stage)) continue;
    const a = asOf ? assessmentAsOf(idea, asOf) : latestAssessment(idea);
    if (!a) continue; // unscored ideas are never ranked
    scored.push(scoreIdea(idea, a));
  }
  return scored.sort(compareRank);
}

export type Movement =
  | { kind: 'up'; by: number; previousRank: number }
  | { kind: 'down'; by: number; previousRank: number }
  | { kind: 'same'; previousRank: number }
  | { kind: 'new' }
  /** No previous snapshot exists — movement is not claimed at all. */
  | { kind: 'none' };

export interface RankedEntry extends ScoredIdea {
  rank: number;
  movement: Movement;
  scoreDelta: number | null;
}

/**
 * Derive the full ranking at `current` and compare it with the snapshot at `previous`.
 * The previous snapshot is reconstructed deterministically from append-only assessments and
 * stage history (no record is ever rewritten), so it equals what was ranked on that date.
 * Movement is only claimed when the idea was ranked in the previous snapshot.
 */
export function rankWithMovement(ideas: Idea[], current: ISODate, previous: ISODate | null): RankedEntry[] {
  const now = rankIdeas(ideas, current);
  const prev = previous ? rankIdeas(ideas, previous) : [];
  const prevIndex = new Map(prev.map((s, i) => [s.idea.id, { rank: i + 1, score: s.score }]));
  return now.map((s, i) => {
    const rank = i + 1;
    const p = prevIndex.get(s.idea.id);
    return { ...s, rank, movement: movementFrom(rank, p), scoreDelta: p ? s.score - p.score : null };
  });
}

function movementFrom(rank: number, p: { rank: number; score: number } | undefined): Movement {
  if (!p) return { kind: 'new' };
  if (p.rank > rank) return { kind: 'up', by: p.rank - rank, previousRank: p.rank };
  if (p.rank < rank) return { kind: 'down', by: rank - p.rank, previousRank: p.rank };
  return { kind: 'same', previousRank: p.rank };
}

/**
 * Movement of an already-ranked list (e.g. a stored snapshot) against a baseline list.
 * `null` baseline = no previous snapshot → movement `none` (never assumed «new»).
 */
export function compareToBaseline<T extends { ideaId: string; rank: number; score: number }>(
  entries: T[],
  baseline: { ideaId: string; rank: number; score: number }[] | null,
): (T & { movement: Movement; scoreDelta: number | null })[] {
  if (!baseline) return entries.map((e) => ({ ...e, movement: { kind: 'none' } as Movement, scoreDelta: null }));
  const idx = new Map(baseline.map((b) => [b.ideaId, { rank: b.rank, score: b.score }]));
  return entries.map((e) => {
    const p = idx.get(e.ideaId);
    return { ...e, movement: movementFrom(e.rank, p), scoreDelta: p ? e.score - p.score : null };
  });
}

/**
 * Current ranking at `current` with movement against an explicit baseline.
 * - stored baseline (REAL): an immutable DB snapshot; ideas absent from it are «new».
 * - reconstruct baseline (DEMO): previous ranking derived from append-only history.
 * - null: no previous snapshot — every movement is `none` (never «new» by assumption).
 */
export function rankAgainstBaseline(ideas: Idea[], current: ISODate, baseline: RankBaseline | null): RankedEntry[] {
  if (!baseline) {
    return rankIdeas(ideas, current).map((s, i) => ({ ...s, rank: i + 1, movement: { kind: 'none' }, scoreDelta: null }));
  }
  if (baseline.kind === 'reconstruct') return rankWithMovement(ideas, current, baseline.asOf);
  const prevIndex = new Map(baseline.entries.map((e) => [e.ideaId, { rank: e.rank, score: e.score }]));
  return rankIdeas(ideas, current).map((s, i) => {
    const p = prevIndex.get(s.idea.id);
    return { ...s, rank: i + 1, movement: movementFrom(i + 1, p), scoreDelta: p ? s.score - p.score : null };
  });
}

/** Score history points (one per assessment) for sparkline / dossier. */
export function scoreHistory(idea: Idea): { date: ISODate; score: number; confidence: number; reason: string }[] {
  return idea.assessments.map((a) => ({
    date: a.assessedAt,
    score: marketScore(a.scores),
    confidence: evidenceConfidence(a.confidence),
    reason: a.reason,
  }));
}
