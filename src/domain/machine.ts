/**
 * VL-004A — read models of the autonomous machine-research dataset (shared by API and UI).
 * Machine states never claim human verification: the strongest one is «Проверено системой».
 */
import type { ComponentScores, ConfidenceComponents, DimensionKey, FounderFitComponents, ISODate } from './types';

export type MachineFeed = 'fixture' | 'live';
export type MachineState = 'DISCOVERED' | 'AUTOMATED_EVIDENCE_PASSED' | 'RESEARCH_HOLD';
export type EvidenceGrade = 'A' | 'B' | 'C' | 'D';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';
export type ClaimStatus = 'corroborated' | 'vendor_claim' | 'single_source' | 'contradicted' | 'unretrievable' | 'unknown';

export const MACHINE_STATE_LABEL: Record<MachineState, string> = {
  AUTOMATED_EVIDENCE_PASSED: 'Проверено системой',
  RESEARCH_HOLD: 'Отложено системой',
  DISCOVERED: 'Найдено, не исследовано',
};

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  corroborated: 'Подтверждено несколькими источниками',
  vendor_claim: 'Заявление компании',
  single_source: 'Один источник',
  contradicted: 'Опровергнуто',
  unretrievable: 'Источник недоступен',
  unknown: 'Цитата не найдена',
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'В очереди',
  running: 'Выполняется',
  succeeded: 'Успешно',
  partial: 'Прервано (лимит)',
  failed: 'Ошибка',
};

export interface MachineRun {
  id: number;
  jobKey: string;
  feed: MachineFeed;
  asOf: ISODate;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  spent: number;
  budgetLimit: number;
  error: string | null;
  partialReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  pipelineVersion: string;
}

export interface MachineTopEntry {
  rank: number;
  externalId: string;
  title: string;
  category: string;
  segment: 'B2B' | 'B2C';
  marketScore: number;
  confidence: number;
  founderFit: number | null;
  evidenceGrade: EvidenceGrade;
  prevRank: number | null;
  scoreDelta: number | null;
  isNew: boolean;
  /** Date of the assessment shown; older than the snapshot when it was carried forward (live rotation). */
  assessedAsOf: ISODate;
  carried: boolean;
}

export interface MachineWatchItem {
  externalId: string;
  title: string;
  state: MachineState;
  marketScore: number;
  confidence: number;
  evidenceGrade: EvidenceGrade;
  holdReasons: string[];
  isNew: boolean;
}

export type MachineChange =
  | { kind: 'entered' | 'exited' | 'up' | 'down'; externalId: string; title: string; from: number | null; to: number | null; scoreDelta: number | null }
  | { kind: 'state'; externalId: string; title: string; fromState: MachineState | null; toState: MachineState; reasons: string[] }
  | { kind: 'competitor'; externalId: string; title: string; competitor: string; market: 'west' | 'ru'; competitorKind: 'direct' | 'adjacent' | 'substitute'; url: string | null };

export interface MachineSnapshotMeta {
  asOf: ISODate;
  jobId: number;
  eligibleCount: number;
  holdCount: number;
  publishedAt: string;
}

export interface MachineOverview {
  feed: MachineFeed;
  timezone: string;
  /** «today» in the worker timezone. */
  today: ISODate;
  latestRun: MachineRun | null;
  lastSuccess: MachineRun | null;
  /** The last successful run is older than yesterday (in the worker timezone). */
  stale: boolean;
  snapshot: (MachineSnapshotMeta & { entries: MachineTopEntry[] }) | null;
  previousSnapshot: MachineSnapshotMeta | null;
  newToday: MachineWatchItem[];
  watchlist: MachineWatchItem[];
  changes: MachineChange[];
  costs: { lastRun: number; month: number; budgetPerRun: number; monthlyBudget: number; priceVersion: string | null };
  totals: { candidates: number; passed: number; held: number; discovered: number };
  /** Diagnostics of the latest run (null before the first run). */
  diagnostics: MachineRunDiagnostics | null;
}

export interface MachineRunDiagnostics {
  jobId: number;
  asOf: ISODate;
  status: JobStatus;
  /** emulated (fixtures) | independent (two model families) | single-model-degraded */
  independence: 'emulated' | 'independent' | 'single-model-degraded' | null;
  searches: { ru: number; west: number; world: number; failed: number };
  pages: { ok: number; failed: number; byStatus: Record<string, number> };
  competitors: { ruDirect: number; ruAdjacent: number; distinctRu: number; marketUnverified: number };
  /** Sources the model called independent but provenance did not confirm (kept as «type not established»). */
  independenceUnverified: number;
  contradictions: number;
  cost: { estimated: number; charged: number; observed: number; unknownCalls: number; anomalies: number };
  averageConfidence: number | null;
  partialReason: string | null;
  error: string | null;
  carried: number;
}

export interface MachineSource {
  key: string;
  url: string;
  publisher: string | null;
  region: 'west' | 'ru';
  sourceType: 'independent' | 'company_self_report' | 'primary_data' | 'unknown';
  fetchStatus: 'ok' | 'http_error' | 'blocked' | 'injection_suspected' | 'rate_limited' | 'budget_exhausted' | 'robots_disallowed' | 'unsafe_url' | 'unsupported_content' | 'too_large' | 'timeout';
  httpStatus: number | null;
  excerpt: string | null;
  agent: 'analyst' | 'skeptic';
  /** Live provenance (null for fixtures). */
  canonicalUrl?: string | null;
  fetchedAt?: string | null;
  failure?: string | null;
  /** What the extraction model claimed that code could not find on the page. */
  offerUncertain?: string[];
  /** How the source type was established (live). */
  provenance?: { independence: 'verified' | 'unverified' | 'not_claimed'; signals: string[]; reason: string } | null;
}

export interface MachineClaim {
  key: string;
  dimension: DimensionKey;
  text: string;
  quote: string | null;
  sourceKeys: string[];
  status: ClaimStatus;
  reason: string;
  highImpact: boolean;
  /** Sources whose text actually contains the quote. */
  supportingKeys: string[];
  /** Independent skeptic pass (machine, not human). */
  skepticVerdict: 'supported' | 'refuted' | 'needs_more_evidence' | 'not_reviewed';
  skepticReason: string | null;
}

export interface MachineSearch {
  agent: 'discovery' | 'analyst' | 'skeptic';
  purpose: string;
  region: 'west' | 'ru' | 'world';
  query: string;
  resultCount: number;
  status: string;
}

export interface MachineCompetitor {
  name: string;
  url: string | null;
  market: 'west' | 'ru';
  kind: 'direct' | 'adjacent' | 'substitute';
  foundBy: 'analyst' | 'skeptic';
  note: string | null;
  /** The skeptic's classification reason. */
  reason: string;
  /** false = market not established by page signals: shown, never counted (default true). */
  marketVerified?: boolean;
  /** verified (page signals) · declared (fixture) · conflicting · unknown · not_assessed (historical row). */
  marketStatus?: 'verified' | 'declared' | 'conflicting' | 'unknown' | 'not_assessed';
}

export interface MachineReview {
  reviewer: 'analyst' | 'skeptic' | 'claim_checker' | 'quality_gate';
  model: string;
  decision: string;
  summary: string;
  findings: string[];
}

export interface MachineAssessment {
  id: number;
  jobId: number;
  asOf: ISODate;
  title: string;
  pitch: string;
  segment: 'B2B' | 'B2C';
  category: string;
  scores: ComponentScores;
  confidenceComponents: ConfidenceComponents;
  founderFitComponents: FounderFitComponents | null;
  marketScore: number;
  confidence: number;
  founderFit: number | null;
  evidenceGrade: EvidenceGrade;
  state: MachineState;
  holdReasons: string[];
  rationale: string;
  dimensionNotes: string[];
  models: string[];
  pipelineVersion: string;
}

export interface MachineCandidateDetail {
  feed: MachineFeed;
  externalId: string;
  firstSeen: ISODate;
  primaryJob: string;
  westernProduct: string;
  current: MachineAssessment;
  rank: number | null;
  history: MachineAssessment[];
  sources: MachineSource[];
  claims: MachineClaim[];
  searches: MachineSearch[];
  competitors: MachineCompetitor[];
  reviews: MachineReview[];
}
