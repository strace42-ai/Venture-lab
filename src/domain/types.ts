/**
 * Domain types for Venture Lab.
 * Mirrors docs/data-contracts.md at the granularity needed for VL-001 (demo-only UI).
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

export type Category =
  | 'LegalTech'
  | 'E-commerce'
  | 'HRTech'
  | 'ConTech'
  | 'FinTech'
  | 'EdTech'
  | 'GovTech'
  | 'SMB-сервисы'
  | 'HealthTech'
  | 'HoReCa';

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
}

/** Append-only assessment record. */
export interface Assessment {
  assessedAt: ISODate;
  modelVersion: string;
  assessor: string;
  scores: ComponentScores;
  confidence: ConfidenceComponents;
  reason: string;
}

export type EvidenceMarket = 'west' | 'ru';

/** Evidence placeholder. In demo mode no source is attached and that must be visible. */
export interface EvidencePlaceholder {
  market: EvidenceMarket;
  claim: string;
  dimension: DimensionKey;
  sourceStatus: 'not_attached';
  supportType: 'independent' | 'self_report' | 'unknown';
}

export interface CompetitorPlaceholder {
  label: string;
  kind: 'direct' | 'adjacent' | 'substitute';
  coverage: 'high' | 'partial' | 'low' | 'unknown';
  gap: string;
  verifiedAt: ISODate | null;
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
  primaryProblem: string;
  targetPersona: string;
  offer: string;
  nextAction: string;
  thesis: string;
  whyNow: string;
  evidence: EvidencePlaceholder[];
  competitors: CompetitorPlaceholder[];
  riskFlags: RiskFlag[];
  founderFit: FounderFitComponents;
  validationPlan: ValidationPlan;
  /** Chronological, append-only. Last element = current assessment. */
  assessments: Assessment[];
  /** Chronological, append-only stage transitions. Used to reconstruct past rankings. */
  stageHistory: StageChange[];
  demo: true;
}

export interface ResearchRun {
  id: string;
  date: ISODate;
  marketsExamined: string[];
  newCandidates: number;
  rejectedCandidates: number;
  sourcesReviewed: number;
  conclusion: string;
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

export interface DemoDataset {
  isDemo: true;
  asOf: ISODate;
  modelVersion: string;
  /** Snapshot dates (ascending). Ranks at each are derived, never stored by hand. */
  snapshotDates: ISODate[];
  ideas: Idea[];
  researchRuns: ResearchRun[];
  experiments: Experiment[];
  builds: BuildProject[];
  activity: ActivityEntry[];
}
