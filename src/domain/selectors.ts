import { CRITICAL_RISKS } from './labels';
import { rankWithMovement, scoreIdea, type RankedEntry } from './scoring';
import type { Category, DemoDataset, Experiment, ExperimentFunnel, Idea, Stage } from './types';

export const HIGH_SCORE = 70;
export const HIGH_CONFIDENCE = 60;

export function previousSnapshot(data: DemoDataset): string | null {
  const dates = data.snapshotDates;
  return dates.length >= 2 ? (dates[dates.length - 2] ?? null) : null;
}

export function currentSnapshot(data: DemoDataset): string {
  return data.snapshotDates[data.snapshotDates.length - 1] ?? data.asOf;
}

/** Full ranking (all rankable ideas) at the current snapshot with movement vs previous. */
export function fullRanking(data: DemoDataset): RankedEntry[] {
  return rankWithMovement(data.ideas, currentSnapshot(data), previousSnapshot(data));
}

export function topN(data: DemoDataset, n = 10): RankedEntry[] {
  return fullRanking(data).slice(0, n);
}

export function hasCriticalRisk(idea: Idea): boolean {
  return idea.riskFlags.some((r) => CRITICAL_RISKS.has(r));
}

/** Eligible for «strongest find»: no critical risk and not paused. */
export function isFindEligible(e: RankedEntry): boolean {
  return !hasCriticalRisk(e.idea) && e.idea.stage !== 'paused';
}

/**
 * Strongest find = highest-ranked eligible idea. There is deliberately NO fallback:
 * if every ranked idea has a critical risk or is paused, the result is `undefined`
 * and the UI must show an explicit «требует ревью» state instead.
 * (A high score never overrides a critical risk — scoring-model.md.)
 */
export function strongestFind(data: DemoDataset): RankedEntry | undefined {
  return fullRanking(data).find(isFindEligible);
}

const ACTIVE_BUILD_STAGES: ReadonlySet<Stage> = new Set<Stage>(['building']);

export interface Kpis {
  totalIdeas: number;
  rankable: number;
  highConfidenceLeads: number;
  liveExperiments: number;
  plannedExperiments: number;
  activeBuilds: number;
  buildSpecs: number;
  verifiedPaidSignals: number;
  pendingPaidSignals: number;
  newThisWeek: number;
}

export function computeKpis(data: DemoDataset): Kpis {
  const ranking = fullRanking(data);
  const prev = previousSnapshot(data);
  return {
    totalIdeas: data.ideas.length,
    rankable: ranking.length,
    highConfidenceLeads: ranking.filter((e) => e.score >= HIGH_SCORE && e.confidence >= HIGH_CONFIDENCE).length,
    liveExperiments: data.experiments.filter((e) => e.status === 'running').length,
    plannedExperiments: data.experiments.filter((e) => e.status === 'planned').length,
    activeBuilds:
      data.ideas.filter((i) => ACTIVE_BUILD_STAGES.has(i.stage)).length +
      data.builds.filter((b) => b.stage === 'prototype' || b.stage === 'review').length,
    buildSpecs: data.builds.filter((b) => b.stage === 'spec').length,
    verifiedPaidSignals: sumFunnel(data.experiments).paymentsVerified,
    pendingPaidSignals: sumFunnel(data.experiments).paymentsPending,
    newThisWeek: prev ? data.ideas.filter((i) => i.createdAt > prev).length : data.ideas.length,
  };
}

export function sumFunnel(experiments: Experiment[]): ExperimentFunnel {
  return experiments.reduce<ExperimentFunnel>(
    (acc, e) => ({
      contacted: acc.contacted + e.funnel.contacted,
      replied: acc.replied + e.funnel.replied,
      interviews: acc.interviews + e.funnel.interviews,
      offersSent: acc.offersSent + e.funnel.offersSent,
      paymentsPending: acc.paymentsPending + e.funnel.paymentsPending,
      paymentsVerified: acc.paymentsVerified + e.funnel.paymentsVerified,
    }),
    { contacted: 0, replied: 0, interviews: 0, offersSent: 0, paymentsPending: 0, paymentsVerified: 0 },
  );
}

export function ideaById(data: DemoDataset, id: string): Idea | undefined {
  return data.ideas.find((i) => i.id === id || i.slug === id);
}

export function categories(data: DemoDataset): Category[] {
  return Array.from(new Set(data.ideas.map((i) => i.category))).sort((a, b) => a.localeCompare(b, 'ru'));
}

export function stagesPresent(data: DemoDataset): Stage[] {
  return Array.from(new Set(data.ideas.map((i) => i.stage)));
}

// ---------- Radar query ----------

export type RadarSort = 'score' | 'confidence' | 'recent';

export interface RadarQuery {
  q: string;
  category: Category | 'all';
  stage: Stage | 'all';
  sort: RadarSort;
}

export interface RadarRow {
  idea: Idea;
  score: number;
  confidence: number;
  founderFit: number;
  /** Rank in the full current ranking, null for excluded (e.g. rejected). */
  rank: number | null;
  entry: RankedEntry | null;
}

/** Radar rows include ALL ideas (also rejected) — ranking only covers rankable ones. */
export function radarRows(data: DemoDataset, query: RadarQuery): RadarRow[] {
  const ranking = fullRanking(data);
  const byId = new Map(ranking.map((e) => [e.idea.id, e]));
  const needle = query.q.trim().toLowerCase();

  const rows: RadarRow[] = data.ideas.map((idea) => {
    const entry = byId.get(idea.id) ?? null;
    if (entry) return { idea, score: entry.score, confidence: entry.confidence, founderFit: entry.founderFit, rank: entry.rank, entry };
    // Excluded from ranking (e.g. rejected) — still show its honest current numbers.
    const s = scoreIdea(idea);
    return { idea, score: s.score, confidence: s.confidence, founderFit: s.founderFit, rank: null, entry: null };
  });

  const filtered = rows.filter((r) => {
    if (query.category !== 'all' && r.idea.category !== query.category) return false;
    if (query.stage !== 'all' && r.idea.stage !== query.stage) return false;
    if (needle) {
      const hay = `${r.idea.title} ${r.idea.shortPitch} ${r.idea.category} ${r.idea.targetPersona}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const byRank = (a: RadarRow, b: RadarRow) =>
    (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || b.score - a.score;

  switch (query.sort) {
    case 'score':
      return filtered.sort(byRank);
    case 'confidence':
      return filtered.sort((a, b) => b.confidence - a.confidence || byRank(a, b));
    case 'recent':
      return filtered.sort((a, b) => b.idea.updatedAt.localeCompare(a.idea.updatedAt) || byRank(a, b));
  }
}
