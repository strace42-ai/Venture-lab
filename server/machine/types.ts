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
  /** Live search: domain and passage snippet. A hit is a LEAD, never proof of anything. */
  domain?: string;
  snippet?: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, region: Region | 'world', ctx: CallContext): Promise<SearchHit[]>;
}

export type FetchStatus =
  | 'ok'
  | 'http_error'
  | 'blocked'
  | 'injection_suspected'
  | 'rate_limited'
  | 'budget_exhausted'
  // live reader (VL-004B): refused or failed safely — the page is UNKNOWN, never filled with generated text
  | 'robots_disallowed'
  | 'unsafe_url'
  | 'unsupported_content'
  | 'too_large'
  | 'timeout';

/** Structured offer extracted from a page (in live mode: by an LLM extraction pass). */
export interface PageOffer {
  name: string;
  market: Region;
  /** Jobs-to-be-done the product claims to do (normalised tags). */
  jobs: string[];
  price?: string;
  /**
   * Live mode: how the offer is bound to the fetched page. Every field kept here was found in the page
   * text by code; `uncertain` lists what the extraction model claimed but code could not ground.
   * Absent for the fixture emulator (whose offers are hand-written test data).
   */
  grounding?: {
    level: 'grounded' | 'partial';
    jobEvidence: Record<string, string>;
    uncertain: string[];
    extractor: string;
    /** The market was established from verifiable page signals (not the model's opinion). */
    marketVerified: boolean;
    marketSignals: string[];
  };
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
  /** Live provenance (optional for fixtures). */
  canonicalUrl?: string | null;
  fetchedAt?: string | null;
  title?: string | null;
  contentType?: string | null;
  /** Why a live read failed (safe, human-readable; never contains secrets). */
  failure?: string | null;
  /** Live: how the source type was established (independence is never a model's word alone). */
  provenance?: { independence: 'verified' | 'unverified' | 'not_claimed'; signals: string[]; reason: string } | null;
}

/** What the reader may know about WHY it reads a page: used only to map offers onto the idea's jobs. */
export interface ReadHint {
  seed: DiscoverySeed;
}

export interface SourceReader {
  readonly name: string;
  read(url: string, ctx: CallContext, hint?: ReadHint): Promise<PageRead>;
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
  /** Live discovery: Russian keywords / synonyms for rival search (optional). */
  ruKeywords?: string[];
  /** Live discovery: the search result URL the seed was found on (must be a real search hit). */
  sourceUrl?: string;
}

/** A page fetched for the analyst BEFORE it writes claims; claims may cite only these URLs. */
export interface EvidenceDoc {
  url: string;
  title: string | null;
  excerpt: string;
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
  /** Model family (e.g. `qwen`, `deepseek`). Live analyst and skeptic must differ; fixtures may omit it. */
  readonly family?: string;
  /** Live mode: discovery searches the pipeline runs first; their hits are passed to `discover` as leads. */
  discoveryQueries?(asOf: ISODate): { query: string; region: Region | 'world' }[];
  discover(asOf: ISODate, known: string[], ctx: CallContext, leads?: SearchHit[]): Promise<DiscoverySeed[]>;
  /**
   * Live mode: queries the pipeline runs (and pages it reads) BEFORE analysis. When present, the analyst
   * receives that evidence pack and every claim must cite only URLs from it (no invented sources).
   */
  evidenceQueries?(seed: DiscoverySeed): { query: string; region: Region | 'world' }[];
  analyse(seed: DiscoverySeed, asOf: ISODate, ctx: CallContext, evidence?: EvidenceDoc[]): Promise<AnalystProposal>;
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
  /** false = market not established by page signals: never counted as a proven rival (default true). */
  marketVerified?: boolean;
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
  readonly family?: string;
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
/** A provider is unavailable for the rest of the run (circuit open / repeated 429/5xx): treated like a rate limit. */
export class ProviderUnavailable extends RateLimited {}
/** A model returned output that failed parsing / schema validation: the candidate is not scored. */
export class InvalidModelOutput extends Error {}
/** Credentials rejected (401/403): never retried; the run fails. */
export class ProviderAuthError extends Error {}
/** Observed cost exceeded the pre-call worst-case bound: no further paid calls in this run (fail-closed). */
export class BillingAnomaly extends Error {}

/**
 * How a usage row's cost is known:
 *  emulated — fixture units; estimate_only — reserved worst case, not yet reconciled; reconciled — from the
 *  provider's reported token usage × tariff; tariff — fixed per-request tariff (no usage reported);
 *  not_billed — provider documents no charge (e.g. 5xx / auth error for Search API); unknown — the
 *  request may have been billed, worst case kept; anomaly_over_estimate — reported usage above the bound.
 */
export type Reconciliation = 'emulated' | 'estimate_only' | 'reconciled' | 'tariff' | 'not_billed' | 'unknown' | 'anomaly_over_estimate';

export interface UsageRecord {
  provider: string;
  operation: 'search' | 'read' | 'llm';
  model: string | null;
  requestId: string;
  tokensIn: number;
  tokensOut: number;
  /** Cost counted against the ledger (≥ actual whenever actual is known and within the bound). */
  cost: number;
  priceVersion: string;
  /** Worst-case cost reserved before the call. */
  estimatedCost?: number;
  /** Cost derived from the provider's response (null = unknown). */
  actualCost?: number | null;
  reconciliation?: Reconciliation;
  /** Provider-side request id (for matching the provider's billing). */
  providerRequestId?: string | null;
  httpStatus?: number | null;
}

export interface ReconcileInput {
  outcome: 'reconciled' | 'tariff' | 'not_billed' | 'unknown';
  actualCost: number | null;
  tokensIn?: number;
  tokensOut?: number;
  providerRequestId?: string | null;
  httpStatus?: number | null;
}

/**
 * Ask the ledger for more budget for THIS attempt. Returns the amount granted (0 = refused: the attempt
 * lost ownership, its lease expired, or the job / month budget is exhausted).
 */
export type BudgetTopUp = (want: number) => Promise<number>;

/**
 * Per-attempt meter shared by all providers: enforces the hard spend cap and per-run rate limits.
 * The attempt starts with a reserved CHUNK and tops it up from the ledger on demand, so a normal run can
 * use the whole job budget while a crashed/superseded attempt only ever holds what it already reserved.
 */
export class CallContext {
  readonly usage: UsageRecord[] = [];
  private seq = 0;
  private counts: Record<string, number> = {};
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly jobKey: string,
    readonly attempt: number,
    /** Budget currently reserved for this attempt and not yet spent (cost units). */
    private remaining: number,
    readonly rateLimits: Partial<Record<UsageRecord['operation'], number>> = {},
    private readonly topUp?: BudgetTopUp,
    /** Minimum size of one top-up request. */
    private readonly chunk = 0,
  ) {}

  get spent(): number {
    return this.usage.reduce((a, u) => a + u.cost, 0);
  }

  /** Set when a reconciliation found cost above its bound: every later charge is refused. */
  anomaly: string | null = null;

  /** Reserve a call; throws BudgetExhausted / RateLimited BEFORE the provider is called. Serialised. */
  charge(rec: Omit<UsageRecord, 'requestId'>): Promise<string> {
    const next = this.chain.then(() => this.chargeNow(rec));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async chargeNow(rec: Omit<UsageRecord, 'requestId'>): Promise<string> {
    if (this.anomaly) throw new BillingAnomaly(this.anomaly);
    const n = (this.counts[rec.operation] ?? 0) + 1;
    const limit = this.rateLimits[rec.operation];
    if (limit !== undefined && n > limit) throw new RateLimited(`rate limit for ${rec.operation}: ${limit} per run`);
    if (rec.cost > this.remaining && this.topUp) {
      this.remaining += await this.topUp(Math.max(this.chunk, rec.cost - this.remaining));
    }
    if (rec.cost > this.remaining) throw new BudgetExhausted('job', `бюджет исчерпан: нужно ${rec.cost}, доступно ${this.remaining}`);
    this.counts[rec.operation] = n;
    this.remaining -= rec.cost;
    const requestId = `${this.jobKey}#${this.attempt}#${++this.seq}`;
    this.usage.push({ estimatedCost: rec.cost, actualCost: rec.reconciliation === 'emulated' || !rec.reconciliation ? rec.cost : null, reconciliation: 'emulated', ...rec, requestId });
    return requestId;
  }

  /**
   * Replace a reserved worst case with what the provider reported. Cost can only go DOWN here (the
   * difference returns to this attempt's reservation); an observation ABOVE the bound is recorded as an
   * anomaly — the ledger keeps the bound, the observed value is kept for audit, and all later paid
   * calls are refused (fail-closed).
   */
  reconcile(requestId: string, r: ReconcileInput): void {
    const u = this.usage.find((x) => x.requestId === requestId);
    if (!u) throw new Error(`unknown usage ${requestId}`);
    if (u.reconciliation !== 'estimate_only') throw new Error(`usage ${requestId} already reconciled`);
    const est = u.estimatedCost ?? u.cost;
    u.tokensIn = r.tokensIn ?? u.tokensIn;
    u.tokensOut = r.tokensOut ?? u.tokensOut;
    u.providerRequestId = r.providerRequestId ?? null;
    u.httpStatus = r.httpStatus ?? null;
    if (r.outcome === 'unknown' || r.actualCost === null) {
      u.reconciliation = 'unknown';
      u.actualCost = null;
      return;
    }
    if (r.actualCost > est) {
      u.reconciliation = 'anomaly_over_estimate';
      u.actualCost = r.actualCost;
      this.anomaly = `фактическая стоимость ${r.actualCost} превысила верхнюю оценку ${est} (${u.provider}, ${u.providerRequestId ?? 'без id'}) — платные вызовы остановлены, сверьте счёт провайдера`;
      return;
    }
    u.reconciliation = r.outcome;
    u.actualCost = r.actualCost;
    this.remaining += est - r.actualCost;
    u.cost = r.actualCost;
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
  canonicalUrl?: string | null;
  fetchedAt?: string | null;
  title?: string | null;
  contentType?: string | null;
  failure?: string | null;
  offer?: PageOffer | null;
  provenance?: PageRead['provenance'];
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
  /** Where the quote was found (offset in the normalised page text) per supporting source. */
  quoteLocations?: { sourceKey: string; offset: number }[];
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
  /** false = market not established: shown, but never used for caps, refutations or holds. */
  marketVerified?: boolean;
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
