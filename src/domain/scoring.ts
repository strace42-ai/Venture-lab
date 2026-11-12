import type {
  Assessment,
  ComponentScores,
  ConfidenceComponents,
  DimensionKey,
  FounderFitComponents,
  ISODate,
  Idea,
  RawScore,
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
  const last = idea.assessments[idea.assessments.length - 1];
  if (!last) throw new Error(`Idea ${idea.id} has no assessment`);
  return last;
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
  founderFit: number;
  firstPayment: number;
  unknowns: number;
}

export function scoreIdea(idea: Idea, assessment: Assessment = currentAssessment(idea)): ScoredIdea {
  return {
    idea,
    assessment,
    score: marketScore(assessment.scores),
    confidence: evidenceConfidence(assessment.confidence),
    founderFit: founderFit(idea.founderFit),
    firstPayment: contribution(10, assessment.scores.speedToPilot),
    unknowns: unknownCount(assessment.scores),
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

export const EXCLUDED_FROM_RANKING = new Set(['rejected']);

export function rankIdeas(ideas: Idea[], asOf?: ISODate): ScoredIdea[] {
  const scored: ScoredIdea[] = [];
  for (const idea of ideas) {
    if (EXCLUDED_FROM_RANKING.has(idea.stage)) continue;
    const a = asOf ? assessmentAsOf(idea, asOf) : currentAssessment(idea);
    if (!a) continue;
    scored.push(scoreIdea(idea, a));
  }
  return scored.sort(compareRank);
}

export type Movement =
  | { kind: 'up'; by: number; previousRank: number }
  | { kind: 'down'; by: number; previousRank: number }
  | { kind: 'same'; previousRank: number }
  | { kind: 'new' };

export interface RankedEntry extends ScoredIdea {
  rank: number;
  movement: Movement;
  scoreDelta: number | null;
}

/**
 * Derive the full ranking at `current` and compare it with the stored snapshot at `previous`.
 * Movement is only claimed when the idea existed in the previous snapshot.
 */
export function rankWithMovement(ideas: Idea[], current: ISODate, previous: ISODate | null): RankedEntry[] {
  const now = rankIdeas(ideas, current);
  const prev = previous ? rankIdeas(ideas, previous) : [];
  const prevIndex = new Map(prev.map((s, i) => [s.idea.id, { rank: i + 1, score: s.score }]));
  return now.map((s, i) => {
    const rank = i + 1;
    const p = prevIndex.get(s.idea.id);
    let movement: Movement;
    if (!p) movement = { kind: 'new' };
    else if (p.rank > rank) movement = { kind: 'up', by: p.rank - rank, previousRank: p.rank };
    else if (p.rank < rank) movement = { kind: 'down', by: rank - p.rank, previousRank: p.rank };
    else movement = { kind: 'same', previousRank: p.rank };
    return { ...s, rank, movement, scoreDelta: p ? s.score - p.score : null };
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
