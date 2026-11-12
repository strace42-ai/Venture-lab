/**
 * Domain types for Venture Lab — shared by the UI (DEMO + REAL) and the local API/importer.
 * Mirrors docs/data-contracts.md and docs/research-engine-contract.md.
 * Pure types only: no DOM, no Node APIs.
 */

export type ISODate = string; // YYYY-MM-DD

export type DimensionKey =
  | 'westernNeed'
  | 'westernPay'
  | 'ruWeakness'
  | 'ruUnmetJob'
  | 'monetization'
  | 'speedToPilot'
  | 'mvpFeasible'
  | 'fastTest'
  | 'distribution'
  | 'retention'
  | 'defensibility'
  | 'riskManageable';

/** Raw 0–5 rubric value. `null` = unknown (never treated as evidence of absence). */
export type RawScore = 0 | 1 | 2 | 3 | 4 | 5 | null;

export type ComponentScores = Record<DimensionKey, RawScore>;

export interface ConfidenceComponents {
  /** Each 0–100. Weighted per scoring-model.md. */
  completeness: number;
  corroboration: number;
  recency: number;
  reliability: number;
  russiaValidation: number;
}

export interface FounderFitComponents {
  skills: number; // 0–10
  access: number; // 0–10
  timeToSale: number; // 0–10
  motivation: number; // 0–5
  synergy: number; // 0–5
}

export type Segment = 'B2B' | 'B2C';

/** Free-text category. DEMO uses a fixed set; REAL takes what the reviewed research declares. */
export type Category = string;

export type Stage =
  | 'discovered'
  | 'researching'
  | 'scored'
  | 'validation_planned'
  | 'validating'
  | 'paid_signal'
  | 'build_candidate'
  | 'building'
  | 'launched'
  | 'monetizing'
  | 'paused'
  | 'rejected';

export type RiskFlag =
  | 'legal'
  | 'lockedApi'
  | 'demandUnverified'
  | 'coldStart'
  | 'networkEffect'
  | 'lowRetention'
  | 'dataPrivacy'
  | 'highCogs'
  | 'competitionUnverified';

/** Append-only lifecycle transition. The last entry must equal `Idea.stage`. */
export interface StageChange {
  at: ISODate;
  stage: Stage;
  reason?: string | null;
}

/** Append-only assessment record. */
export interface Assessment {
  assessedAt: ISODate;
  modelVersion: string;
  assessor: string;
  scores: ComponentScores;
  confidence: ConfidenceComponents;
  /** Founder fit recorded with this assessment (REAL). DEMO keeps it on the idea. */
  founderFit?: FounderFitComponents | null;
  reason: string;
  /** Evidence ids the assessment relies on (REAL imports require ≥ 1). */
  evidenceIds?: string[];
  unknowns?: string[];
}

export type EvidenceMarket = 'west' | 'ru';
export type SourceType = 'independent' | 'company_self_report' | 'primary_data' | 'unknown';
export type VerificationStatus = 'unreviewed' | 'checked' | 'rejected';

/**
 * A source-linked claim. In DEMO no source is attached (url = null) and that must be visible.
 * A claim without url + publisher + observedAt can never be shown as checked.
 */
export interface Evidence {
  id: string;
  market: EvidenceMarket;
  claim: string;
  dimensions: DimensionKey[];
  url: string | null;
  title: string | null;
  publisher: string | null;
  sourceType: SourceType;
  language: string | null;
  publishedAt: ISODate | null;
  observedAt: ISODate | null;
  retrievedAt: ISODate | null;
  verificationStatus: VerificationStatus;
  supportNote: string | null;
}

export type CompetitorKind = 'direct' | 'adjacent' | 'substitute';
export type Coverage = 'high' | 'partial' | 'low' | 'unknown';

export interface Competitor {
  id: string;
  name: string;
  market: EvidenceMarket;
  url: string | null;
  kind: CompetitorKind;
  coverage: Coverage;
  gap: string | null;
  observedAt: ISODate | null;
  evidenceIds: string[];
}

export interface ValidationPlan {
  hypothesis: string;
  persona: string;
  channel: string;
  offer: string;
  successThreshold: string;
  stopRule: string;
  durationDays: number;
}

export interface Idea {
  id: string;
  slug: string;
  title: string;
  shortPitch: string;
  segment: Segment;
  category: Category;
  geography: string;
  stage: Stage;
  createdAt: ISODate;
  updatedAt: ISODate;
  primaryProblem: string | null;
  targetPersona: string | null;
  offer: string | null;
  nextAction: string | null;
  thesis: string | null;
  whyNow: string | null;
  evidence: Evidence[];
  competitors: Competitor[];
  riskFlags: RiskFlag[];
  /** DEMO-only founder fit on the idea; REAL stores it per assessment. */
  founderFit: FounderFitComponents | null;
  validationPlan: ValidationPlan | null;
  /** Chronological, append-only. Last element = current assessment. May be empty (unscored). */
  assessments: Assessment[];
  /** Chronological, append-only stage transitions. Used to reconstruct past rankings. */
  stageHistory: StageChange[];
  /** True for DEMO fixtures and for explicitly synthetic test imports. */
  synthetic: boolean;
}

export interface ResearchRun {
  id: string;
  date: ISODate;
  marketsExamined: string[];
  newCandidates: number;
  rejectedCandidates: number;
  sourcesReviewed: number;
  conclusion: string;
  synthetic?: boolean;
}

export type ExperimentStatus = 'planned' | 'running' | 'completed';

export interface ExperimentFunnel {
  contacted: number;
  replied: number;
  interviews: number;
  offersSent: number;
  /** Payment signals awaiting human verification — NOT sales. */
  paymentsPending: number;
  /** Human-verified payments only. */
  paymentsVerified: number;
}

export interface Experiment {
  id: string;
  ideaId: string;
  hypothesis: string;
  channel: string;
  status: ExperimentStatus;
  startedAt: ISODate | null;
  endsAt: ISODate | null;
  funnel: ExperimentFunnel;
  spendRub: number;
}

export type BuildStage = 'spec' | 'prototype' | 'review' | 'paused';

export interface BuildProject {
  id: string;
  ideaId: string;
  stage: BuildStage;
  currentTask: string;
  checklist: { label: string; done: boolean }[];
  updatedAt: ISODate;
}

export type AgentActor = 'ChatGPT' | 'Claude Code' | 'Codex' | 'Основатель';

export interface ActivityEntry {
  id: string;
  at: string; // ISO datetime
  actor: AgentActor;
  action: string;
  ideaId?: string;
}

/**
 * - `demo`: VL-001 fixture computed in the browser.
 * - `real`: human-reviewed research from the local DB (synthetic imports are NEVER included).
 * - `test`: synthetic test imports from the local DB, an isolated dataset of its own.
 */
export type DataMode = 'demo' | 'real' | 'test';

/** Which persisted dataset a live (API-backed) mode reads. */
export type LiveDataset = 'real' | 'test';

export function isLiveMode(m: DataMode): m is LiveDataset {
  return m !== 'demo';
}

/** One ranked row of a previous snapshot, used as the movement baseline. */
export interface BaselineEntry {
  ideaId: string;
  rank: number;
  score: number;
}

/**
 * Movement baseline.
 * - `stored`: an immutable TOP-10 snapshot row set read from the database (REAL).
 * - `reconstruct`: derive the previous ranking from append-only history at `asOf` (DEMO fixture).
 */
export type RankBaseline =
  | { kind: 'stored'; snapshotId: string; asOf: ISODate; entries: BaselineEntry[] }
  | { kind: 'reconstruct'; asOf: ISODate };

export interface Dataset {
  mode: DataMode;
  /** Date the data describes (DEMO fixture date / REAL «today»). */
  asOf: ISODate;
  modelVersion: string;
  /** Date at which the current ranking is computed. */
  rankAsOf: ISODate;
  baseline: RankBaseline | null;
  ideas: Idea[];
  researchRuns: ResearchRun[];
  experiments: Experiment[];
  builds: BuildProject[];
  activity: ActivityEntry[];
}

export interface DemoDataset extends Dataset {
  mode: 'demo';
  isDemo: true;
  /** Snapshot dates (ascending). Ranks at each are derived, never stored by hand. */
  snapshotDates: ISODate[];
}
