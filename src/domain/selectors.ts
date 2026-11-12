import { CRITICAL_RISKS } from './labels';
import { effectiveEvidenceStatus } from './integrity';
import { latestAssessment, rankAgainstBaseline, scoreIdea, type RankedEntry } from './scoring';
import type { Category, Dataset, DemoDataset, Experiment, ExperimentFunnel, Idea, ResearchRun, Stage } from './types';

export const HIGH_SCORE = 70;
export const HIGH_CONFIDENCE = 60;

// ---------- Snapshot helpers (DEMO fixture compatibility) ----------

export function previousSnapshot(data: DemoDataset): string | null {
  const dates = data.snapshotDates;
  return dates.length >= 2 ? (dates[dates.length - 2] ?? null) : null;
}

export function currentSnapshot(data: DemoDataset): string {
  return data.snapshotDates[data.snapshotDates.length - 1] ?? data.asOf;
}

/** Date of the movement baseline (stored snapshot or reconstructed DEMO date), if any. */
export function baselineDate(data: Dataset): string | null {
  return data.baseline ? data.baseline.asOf : null;
}

// ---------- Ranking ----------

/** Full ranking (all rankable, scored ideas) at `rankAsOf` with movement vs the baseline. */
export function fullRanking(data: Dataset): RankedEntry[] {
  return rankAgainstBaseline(data.ideas, data.rankAsOf, data.baseline);
}

export function topN(data: Dataset, n = 10): RankedEntry[] {
  return fullRanking(data).slice(0, n);
}

export function hasCriticalRisk(idea: Idea): boolean {
  return idea.riskFlags.some((r) => CRITICAL_RISKS.has(r));
}

/** The current assessment rests on a rejected (or missing) cited source — see integrity.ts. */
export function needsAssessmentReview(e: Pick<RankedEntry, 'integrity'>): boolean {
  return e.integrity.status === 'needs-review';
}

/**
 * Eligible for «strongest find»: no critical risk, not paused, and the current assessment does not
 * rest on a rejected source. A high score never overrides a refuted evidence basis.
 */
export function isFindEligible(e: RankedEntry): boolean {
  return !hasCriticalRisk(e.idea) && e.idea.stage !== 'paused' && !needsAssessmentReview(e);
}

/**
 * Strongest find = highest-ranked eligible idea. There is deliberately NO fallback:
 * if every ranked idea has a critical risk or is paused, the result is `undefined`
 * and the UI must show an explicit «требует ревью» state instead.
 * (A high score never overrides a critical risk — scoring-model.md.)
 */
export function strongestFind(data: Dataset): RankedEntry | undefined {
  return fullRanking(data).find(isFindEligible);
}

const ACTIVE_BUILD_STAGES: ReadonlySet<Stage> = new Set<Stage>(['building']);

export interface Kpis {
  totalIdeas: number;
  rankable: number;
  /** Ideas without any assessment — shown as «не оценено», never ranked. */
  unscored: number;
  highConfidenceLeads: number;
  /** Ranked ideas whose current assessment cites a rejected/missing source (need a new revision). */
  assessmentsNeedingReview: number;
  liveExperiments: number;
  plannedExperiments: number;
  activeBuilds: number;
  buildSpecs: number;
  verifiedPaidSignals: number;
  pendingPaidSignals: number;
  newThisWeek: number;
  /** Evidence counts by effective review status. */
  evidenceChecked: number;
  evidenceNeedsReview: number;
}

export function computeKpis(data: Dataset): Kpis {
  const ranking = fullRanking(data);
  const since = baselineDate(data);
  const funnel = sumFunnel(data.experiments);
  let checked = 0;
  let needsReview = 0;
  for (const idea of data.ideas) {
    for (const e of idea.evidence) {
      const st = effectiveEvidenceStatus(e);
      if (st === 'checked') checked++;
      else if (st !== 'rejected') needsReview++;
    }
  }
  return {
    totalIdeas: data.ideas.length,
    rankable: ranking.length,
    unscored: data.ideas.filter((i) => !latestAssessment(i)).length,
    highConfidenceLeads: ranking.filter((e) => e.score >= HIGH_SCORE && e.confidence >= HIGH_CONFIDENCE && !needsAssessmentReview(e)).length,
    assessmentsNeedingReview: ranking.filter(needsAssessmentReview).length,
    liveExperiments: data.experiments.filter((e) => e.status === 'running').length,
    plannedExperiments: data.experiments.filter((e) => e.status === 'planned').length,
    activeBuilds:
      data.ideas.filter((i) => ACTIVE_BUILD_STAGES.has(i.stage)).length +
      data.builds.filter((b) => b.stage === 'prototype' || b.stage === 'review').length,
    buildSpecs: data.builds.filter((b) => b.stage === 'spec').length,
    verifiedPaidSignals: funnel.paymentsVerified,
    pendingPaidSignals: funnel.paymentsPending,
    newThisWeek: since ? data.ideas.filter((i) => i.createdAt > since).length : data.ideas.length,
    evidenceChecked: checked,
    evidenceNeedsReview: needsReview,
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

export function ideaById(data: Dataset, id: string): Idea | undefined {
  return data.ideas.find((i) => i.id === id || i.slug === id);
}

export function categories(data: Dataset): Category[] {
  return Array.from(new Set(data.ideas.map((i) => i.category))).sort((a, b) => a.localeCompare(b, 'ru'));
}

export function stagesPresent(data: Dataset): Stage[] {
  return Array.from(new Set(data.ideas.map((i) => i.stage)));
}

// ---------- Evidence status ----------


export { effectiveEvidenceStatus, type EffectiveEvidenceStatus } from './integrity';

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
  /** null = unscored (no assessment). Never shown as 0. */
  score: number | null;
  confidence: number | null;
  founderFit: number | null;
  /** Rank in the full current ranking, null for excluded/unscored. */
  rank: number | null;
  entry: RankedEntry | null;
}

/** Radar rows include ALL ideas (also rejected and unscored) — ranking only covers rankable ones. */
export function radarRows(data: Dataset, query: RadarQuery): RadarRow[] {
  const ranking = fullRanking(data);
  const byId = new Map(ranking.map((e) => [e.idea.id, e]));
  const needle = query.q.trim().toLowerCase();

  const rows: RadarRow[] = data.ideas.map((idea) => {
    const entry = byId.get(idea.id) ?? null;
    if (entry) return { idea, score: entry.score, confidence: entry.confidence, founderFit: entry.founderFit, rank: entry.rank, entry };
    const a = latestAssessment(idea);
    if (!a) return { idea, score: null, confidence: null, founderFit: null, rank: null, entry: null };
    // Excluded from ranking (e.g. rejected) — still show its honest current numbers.
    const s = scoreIdea(idea, a);
    return { idea, score: s.score, confidence: s.confidence, founderFit: s.founderFit, rank: null, entry: null };
  });

  const filtered = rows.filter((r) => {
    if (query.category !== 'all' && r.idea.category !== query.category) return false;
    if (query.stage !== 'all' && r.idea.stage !== query.stage) return false;
    if (needle) {
      const hay = `${r.idea.title} ${r.idea.shortPitch} ${r.idea.category} ${r.idea.targetPersona ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const NONE = Number.MAX_SAFE_INTEGER;
  const byRank = (a: RadarRow, b: RadarRow) =>
    (a.rank ?? NONE) - (b.rank ?? NONE) || (b.score ?? -1) - (a.score ?? -1) || a.idea.id.localeCompare(b.idea.id);

  switch (query.sort) {
    case 'score':
      return filtered.sort(byRank);
    case 'confidence':
      return filtered.sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1) || byRank(a, b));
    case 'recent':
      return filtered.sort((a, b) => b.idea.updatedAt.localeCompare(a.idea.updatedAt) || byRank(a, b));
  }
}

// ---------- View models (shared by the DEMO adapter and the local API) ----------

export interface Page {
  page: number;
  pageSize: number;
}

export interface RadarView {
  rows: RadarRow[];
  total: number;
  /** Number of ideas in the dataset before filtering. */
  totalAll: number;
  page: number;
  pageSize: number;
  categories: Category[];
  stages: Stage[];
}

export function buildRadarView(data: Dataset, query: RadarQuery, page: Page = { page: 1, pageSize: 500 }): RadarView {
  const all = radarRows(data, query);
  const start = (page.page - 1) * page.pageSize;
  return {
    rows: all.slice(start, start + page.pageSize),
    total: all.length,
    totalAll: data.ideas.length,
    page: page.page,
    pageSize: page.pageSize,
    categories: categories(data),
    stages: stagesPresent(data),
  };
}

export interface BaselineInfo {
  kind: 'stored' | 'reconstruct';
  asOf: string;
  snapshotId: string | null;
}

export interface OverviewView {
  mode: Dataset['mode'];
  asOf: string;
  rankAsOf: string;
  modelVersion: string;
  baseline: BaselineInfo | null;
  kpis: Kpis;
  ranking: RankedEntry[];
  lead: RankedEntry | null;
  researchRuns: ResearchRun[];
  experiments: Experiment[];
  builds: Dataset['builds'];
  activity: Dataset['activity'];
  /** Idea titles/slugs for cross-links from experiments/builds/activity. */
  ideaRefs: Record<string, { slug: string; title: string }>;
  stageCounts: Partial<Record<Stage, number>>;
  syntheticIdeas: number;
}

export function baselineInfo(data: Dataset): BaselineInfo | null {
  const b = data.baseline;
  if (!b) return null;
  return { kind: b.kind, asOf: b.asOf, snapshotId: b.kind === 'stored' ? b.snapshotId : null };
}

export function buildOverview(data: Dataset): OverviewView {
  const ranking = fullRanking(data);
  const refs: OverviewView['ideaRefs'] = {};
  const stageCounts: OverviewView['stageCounts'] = {};
  for (const i of data.ideas) {
    refs[i.id] = { slug: i.slug, title: i.title };
    stageCounts[i.stage] = (stageCounts[i.stage] ?? 0) + 1;
  }
  return {
    mode: data.mode,
    asOf: data.asOf,
    rankAsOf: data.rankAsOf,
    modelVersion: data.modelVersion,
    baseline: baselineInfo(data),
    kpis: computeKpis(data),
    ranking,
    lead: ranking.find(isFindEligible) ?? null,
    researchRuns: [...data.researchRuns].sort((a, b) => b.date.localeCompare(a.date)),
    experiments: data.experiments,
    builds: data.builds,
    activity: data.activity,
    ideaRefs: refs,
    stageCounts,
    syntheticIdeas: data.ideas.filter((i) => i.synthetic).length,
  };
}

export interface IdeaDetailView {
  mode: Dataset['mode'];
  modelVersion: string;
  asOf: string;
  baseline: BaselineInfo | null;
  idea: Idea;
  entry: RankedEntry | null;
}

export function buildIdeaDetail(data: Dataset, idOrSlug: string): IdeaDetailView | null {
  const idea = ideaById(data, idOrSlug);
  if (!idea) return null;
  const entry = fullRanking(data).find((e) => e.idea.id === idea.id) ?? null;
  return { mode: data.mode, modelVersion: data.modelVersion, asOf: data.asOf, baseline: baselineInfo(data), idea, entry };
}
