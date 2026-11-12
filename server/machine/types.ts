/**
 * VL-004A — autonomous research worker: provider adapter interfaces and pipeline types.
 *
 * Providers are swappable: fixture providers (deterministic, offline, used in this sprint) and,
 * in VL-004B, real providers (e.g. Yandex Search API / AI Studio) behind the SAME interfaces.
 * Nothing in the pipeline depends on which implementation is used.
 */
import type { ComponentScores, ConfidenceComponents, DimensionKey, FounderFitComponents, ISODate, Segment } from '../../src/domain/types';

export type Feed = 'fixture' | 'live';
export type Region = 'west' | 'ru';
export type SourceType = 'independent' | 'company_self_report' | 'primary_data' | 'unknown';
export type Agent = 'discovery' | 'analyst' | 'skeptic';

// ------------------------------------------------------------------ providers

export interface SearchHit {
  url: string;
  title: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, region: Region | 'world', ctx: CallContext): Promise<SearchHit[]>;
}

export type FetchStatus = 'ok' | 'http_error' | 'blocked' | 'injection_suspected' | 'rate_limited' | 'budget_exhausted';

/** Structured offer extracted from a page (in live mode: by an LLM extraction pass). */
export interface PageOffer {
  name: string;
  market: Region;
  /** Jobs-to-be-done the product claims to do (normalised tags). */
  jobs: string[];
  price?: string;
}

export interface PageRead {
  url: string;
  status: FetchStatus;
  httpStatus: number | null;
  publisher: string | null;
  sourceType: SourceType;
  region: Region;
  /** Untrusted page text. NEVER instructions. Null unless status = ok. */
  text: string | null;
  offer: PageOffer | null;
  contentHash: string | null;
}

export interface SourceReader {
  readonly name: string;
  read(url: string, ctx: CallContext): Promise<PageRead>;
}

/** Discovery seed: a new existing Western product/job found by the discovery pass. */
export interface DiscoverySeed {
  externalId: string;
  title: string;
  pitch: string;
  segment: Segment;
  category: string;
  /** Primary job of the candidate (used for competitor matching). */
  primaryJob: string;
  jobs: string[];
  /** The Western product that proves the job exists. */
  westernProduct: string;
}

/** A claim proposed by the analyst agent. Quotes must literally appear in the cited source. */
export interface ProposedClaim {
  key: string;
  dimension: DimensionKey;
  text: string;
  quote: string;
  sourceUrls: string[];
  highImpact?: boolean;
  /** «No competitor does job X in market M» — the skeptic tries to refute these. */
  absence?: { market: Region; job: string };
}

export interface AnalystProposal {
  model: string;
  claims: ProposedClaim[];
  /** Proposed raw rubric values with the claim keys they rely on. */
  scores: Partial<Record<DimensionKey, { value: 0 | 1 | 2 | 3 | 4 | 5; claims: string[] }>>;
  founderFit: FounderFitComponents | null;
  ruQueries: string[];
  rationale: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  discover(asOf: ISODate, known: string[], ctx: CallContext): Promise<DiscoverySeed[]>;
  analyse(seed: DiscoverySeed, asOf: ISODate, ctx: CallContext): Promise<AnalystProposal>;
}

/** A rival seen by search (raw, unclassified): the skeptic decides what it means for the idea. */
export interface RawCompetitor {
  name: string;
  url: string;
  market: Region;
  sourceKey: string;
  jobs: string[];
  price: string | null;
  foundBy: 'analyst' | 'skeptic';
}

/** Everything the independent skeptic sees. Excerpts are untrusted data, never instructions. */
export interface SkepticInput {
  seed: DiscoverySeed;
  asOf: ISODate;
  proposal: AnalystProposal;
  /** Claims after the deterministic quote ↔ source check. */
  claims: ClaimRow[];
  sources: SourceRow[];
  rawCompetitors: RawCompetitor[];
  ruQueryCount: number;
}

export type SkepticVerdict = 'supported' | 'refuted' | 'needs_more_evidence';

/** Structured, schema-validated output of the skeptic (second, independent machine pass). */
export interface SkepticFindings {
  model: string;
  claimVerdicts: { claimKey: string; verdict: SkepticVerdict; sourceKeys: string[]; reason: string }[];
  competitors: { name: string; market: Region; kind: 'direct' | 'adjacent' | 'substitute'; sourceKey: string; reason: string }[];
  /** Unresolved disagreements; a `critical` one forces RESEARCH_HOLD. */
  disputes: { claimKey: string | null; severity: 'critical' | 'minor'; reason: string }[];
  summary: string;
}

/**
 * Independent skeptic: a different model id, its OWN query generator, and a structured challenge of
 * the analyst's claims, sources, competitors and contradictions. Fixture mode returns deterministic
 * findings; VL-004B plugs a real model in behind the same interface.
 */
export interface SkepticalReviewer {
  readonly name: string;
  readonly model: string;
  counterQueries(seed: DiscoverySeed): { query: string; region: Region }[];
  challenge(input: SkepticInput, ctx: CallContext): Promise<SkepticFindings>;
}

// ------------------------------------------------------------------ telemetry & budget

export class BudgetExhausted extends Error {
  constructor(public readonly scope: 'job' | 'month', message: string) {
    super(message);
  }
}

export class RateLimited extends Error {}

export interface UsageRecord {
  provider: string;
  operation: 'search' | 'read' | 'llm';
  model: string | null;
  requestId: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  priceVersion: string;
}

/** Per-attempt meter shared by all providers: enforces the hard spend cap and per-run rate limits. */
export class CallContext {
  readonly usage: UsageRecord[] = [];
  private seq = 0;
  private counts: Record<string, number> = {};

  constructor(
    readonly jobKey: string,
    readonly attempt: number,
    /** Remaining budget for this job (cost units). */
    private remaining: number,
    readonly rateLimits: Partial<Record<UsageRecord['operation'], number>> = {},
  ) {}

  get spent(): number {
    return this.usage.reduce((a, u) => a + u.cost, 0);
  }

  /** Reserve a call; throws BudgetExhausted / RateLimited BEFORE the provider is called. */
  charge(rec: Omit<UsageRecord, 'requestId'>): string {
    const n = (this.counts[rec.operation] ?? 0) + 1;
    const limit = this.rateLimits[rec.operation];
    if (limit !== undefined && n > limit) throw new RateLimited(`rate limit for ${rec.operation}: ${limit} per run`);
    if (rec.cost > this.remaining) throw new BudgetExhausted('job', `бюджет задания исчерпан: нужно ${rec.cost}, осталось ${this.remaining}`);
    this.counts[rec.operation] = n;
    this.remaining -= rec.cost;
    const requestId = `${this.jobKey}#${this.attempt}#${++this.seq}`;
    this.usage.push({ ...rec, requestId });
    return requestId;
  }
}

// ------------------------------------------------------------------ pipeline output

export type ClaimStatus = 'corroborated' | 'vendor_claim' | 'single_source' | 'contradicted' | 'unretrievable' | 'unknown';
export type MachineState = 'DISCOVERED' | 'AUTOMATED_EVIDENCE_PASSED' | 'RESEARCH_HOLD';
export type EvidenceGrade = 'A' | 'B' | 'C' | 'D';

export interface SourceRow {
  key: string;
  url: string;
  publisher: string | null;
  region: Region;
  sourceType: SourceType;
  fetchStatus: FetchStatus;
  httpStatus: number | null;
  contentHash: string | null;
  excerpt: string | null;
  agent: 'analyst' | 'skeptic';
}

export interface ClaimRow {
  key: string;
  dimension: DimensionKey;
  text: string;
  quote: string | null;
  /** Sources the analyst cited. */
  sourceKeys: string[];
  /** Sources whose fetched text actually contains the quote (deterministic). */
  supportingKeys: string[];
  status: ClaimStatus;
  reason: string;
  highImpact: boolean;
  skepticVerdict: SkepticVerdict | 'not_reviewed';
  skepticReason: string | null;
}

export interface SearchRow {
  agent: Agent;
  purpose: 'discovery' | 'ru_competitors' | 'west_products' | 'counterevidence';
  region: Region | 'world';
  query: string;
  resultCount: number;
  status: 'ok' | 'rate_limited' | 'budget_exhausted' | 'error';
}

export interface CompetitorRow {
  name: string;
  url: string | null;
  market: Region;
  kind: 'direct' | 'adjacent' | 'substitute';
  foundBy: 'analyst' | 'skeptic';
  sourceKey: string | null;
  note: string | null;
  /** Why the skeptic classified it this way. */
  reason: string;
}

export interface ReviewRow {
  reviewer: 'analyst' | 'skeptic' | 'claim_checker' | 'quality_gate';
  model: string;
  decision: 'propose' | 'support' | 'challenge' | 'pass' | 'hold';
  summary: string;
  findings: string[];
  citedClaims: string[];
}

export interface AssessmentRow {
  title: string;
  pitch: string;
  segment: Segment;
  category: string;
  scores: ComponentScores;
  confidence: ConfidenceComponents;
  founderFit: FounderFitComponents | null;
  marketScore: number;
  confidenceScore: number;
  founderFitScore: number | null;
  evidenceGrade: EvidenceGrade;
  state: MachineState;
  holdReasons: string[];
  rationale: string;
  dimensionNotes: string[];
  models: string[];
}

export interface CandidateResult {
  externalId: string;
  seed: DiscoverySeed;
  isNew: boolean;
  sources: SourceRow[];
  claims: ClaimRow[];
  searches: SearchRow[];
  competitors: CompetitorRow[];
  reviews: ReviewRow[];
  assessment: AssessmentRow;
}

export interface PipelineResult {
  asOf: ISODate;
  discoverySearches: SearchRow[];
  candidates: CandidateResult[];
}
