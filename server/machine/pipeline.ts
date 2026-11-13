/**
 * Autonomous research pipeline (VL-004A). Pure orchestration over provider interfaces:
 *
 *   discovery → analyst proposal → source reads → RU/West competitor search (analyst + independent
 *   skeptic queries) → deterministic claim check (exact quote ↔ source) → skeptic contradiction hunt →
 *   competition-aware re-scoring → quality gate → rubric v1.0 score + confidence + Founder Fit.
 *
 * No human approval step exists anywhere. Nothing here writes to the database: the worker persists the
 * result atomically. Scores are computed ONLY by src/domain/scoring.ts (single source of truth).
 */
import { z } from 'zod';
import { DIMENSION_KEYS, evidenceConfidence, founderFit, marketScore } from '../../src/domain/scoring';
import { analystProposalSchema, discoverySeedSchema, quoteProblem, skepticFindingsSchema } from './schemas';
import type { ComponentScores, ConfidenceComponents, DimensionKey, ISODate, RawScore } from '../../src/domain/types';
import {
  BudgetExhausted,
  InvalidModelOutput,
  RateLimited,
  type AnalystProposal,
  type CallContext,
  type CandidateResult,
  type ClaimRow,
  type ClaimStatus,
  type CompetitorRow,
  type DiscoverySeed,
  type EvidenceDoc,
  type EvidenceGrade,
  type LLMProvider,
  type MachineState,
  type PageRead,
  type PipelineResult,
  type RawCompetitor,
  type ReadHint,
  type SearchHit,
  type ReviewRow,
  type SkepticFindings,
  type SearchProvider,
  type SearchRow,
  type SkepticalReviewer,
  type SourceReader,
  type SourceRow,
} from './types';

export const PIPELINE_VERSION = 'vl-004b-pipeline-1';

/** Dimensions that MUST be backed by a supported claim; otherwise they are UNKNOWN (null), never guessed. */
export const EVIDENCE_DIMENSIONS: ReadonlySet<DimensionKey> = new Set(['westernNeed', 'westernPay', 'ruWeakness', 'ruUnmetJob', 'monetization', 'distribution']);
/** Execution judgements without a source are accepted but capped (no 5/5 from prose alone). */
const UNSOURCED_CAP = 4;
export const MIN_RU_QUERIES = 3;
/** A rival with a free plan ("free", «бесплатно», «0 ₽») — but not «390 ₽». */
export const FREE_OFFER = /\bfree\b|бесплатн|(?:^|[^\d\s])\s*0\s?₽|(?:^|\s)0\s?₽/i;

export interface Providers {
  search: SearchProvider;
  reader: SourceReader;
  llm: LLMProvider;
  skeptic: SkepticalReviewer;
}

/** Live-mode bounds (fixtures leave them unset = unbounded, as in VL-004A). */
export interface PipelineOptions {
  /** Pages read per evidence query (analyst, before analysis). */
  evidenceHits?: number;
  /** Pages read per competitor query. */
  hitsPerQuery?: number;
  /** Maximum NEW candidates per run. */
  maxNew?: number;
  /** Maximum analyst Russian-market queries per candidate. */
  maxRuQueries?: number;
}

/** A claim about paying users / revenue … */
const PAYMENT_CLAIM = /платящ|платят|оплачива|оплатил|выручк|доход|revenue|paying|paid (users|customers|subscribers|accounts)|customers pay|\bARR\b|\bMRR\b/i;
/** … must be backed by a quote about money, not popularity («10 000 компаний используют»). */
const PAYMENT_EVIDENCE = /[$€£₽]|руб|\bUSD\b|\bEUR\b|per (month|year|user|seat)|\/mo\b|в месяц|в год|\/мес|pricing|price|тариф|subscription|подписк|revenue|выручк|paying|платящ|оплат|plan(s)? (start|from)/i;

const limit = <T,>(xs: T[], n: number | undefined) => (n === undefined ? xs : xs.slice(0, n));

/** direct = the rival's page proves the idea's PRIMARY job; adjacent = another of its jobs; else substitute. */
function codeKind(r: RawCompetitor, seed: DiscoverySeed): CompetitorRow['kind'] {
  return r.jobs.includes(seed.primaryJob) ? 'direct' : r.jobs.some((j) => seed.jobs.includes(j)) ? 'adjacent' : 'substitute';
}

const letters = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
};
/** The product the idea is modelled on (by name overlap, or the very site discovery found it on). */
function isWesternAnalogue(name: string, url: string, seed: DiscoverySeed): boolean {
  const n = letters(name);
  const w = letters(seed.westernProduct);
  if (n === w || (n.length >= 3 && w.includes(n)) || (w.length >= 3 && n.includes(w))) return true;
  return !!seed.sourceUrl && hostOf(seed.sourceUrl) === hostOf(url);
}

const sameUrl = (a: string, b: string) => a.replace(/#.*$/, '').replace(/\/$/, '') === b.replace(/#.*$/, '').replace(/\/$/, '');

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Reads every URL once per candidate; a rate-limit/budget stop is recorded, never hidden. */
class Reads {
  readonly rows = new Map<string, { read: PageRead; key: string; agent: 'analyst' | 'skeptic' }>();
  private n = 0;
  constructor(private readonly reader: SourceReader, private readonly ctx: CallContext) {}
  async get(url: string, agent: 'analyst' | 'skeptic', hint?: ReadHint): Promise<{ read: PageRead; key: string }> {
    const hit = this.rows.get(url);
    if (hit) return hit;
    let read: PageRead;
    try {
      read = await this.reader.read(url, this.ctx, hint);
    } catch (e) {
      if (e instanceof RateLimited) read = { url, status: 'rate_limited', httpStatus: null, publisher: null, sourceType: 'unknown', region: 'west', text: null, offer: null, contentHash: null };
      else throw e;
    }
    const row = { read, key: `s${++this.n}`, agent };
    this.rows.set(url, row);
    return row;
  }
}

async function runSearch(sp: SearchProvider, ctx: CallContext, out: SearchRow[], row: Omit<SearchRow, 'resultCount' | 'status'>) {
  try {
    const hits = await sp.search(row.query, row.region, ctx);
    out.push({ ...row, resultCount: hits.length, status: 'ok' });
    return hits;
  } catch (e) {
    if (e instanceof RateLimited) {
      out.push({ ...row, resultCount: 0, status: 'rate_limited' });
      return [];
    }
    throw e;
  }
}

function checkClaim(c: AnalystProposal['claims'][number], reads: Reads, invented: Set<string>): Pick<ClaimRow, 'quote' | 'sourceKeys' | 'supportingKeys' | 'status' | 'reason' | 'quoteLocations'> {
  const keys: string[] = [];
  const supporting: string[] = [];
  const quoteLocations: { sourceKey: string; offset: number }[] = [];
  const types: SourceRow['sourceType'][] = [];
  let failed = 0;
  let quarantined = 0;
  const problem = quoteProblem(c.quote);
  for (const url of c.sourceUrls) {
    const r = reads.rows.get(url);
    if (!r) continue;
    keys.push(r.key);
    if (r.read.status === 'injection_suspected') quarantined++;
    else if (r.read.status !== 'ok') failed++;
    else if (!problem && r.read.text && norm(r.read.text).includes(norm(c.quote))) {
      supporting.push(r.key);
      types.push(r.read.sourceType);
      quoteLocations.push({ sourceKey: r.key, offset: norm(r.read.text).indexOf(norm(c.quote)) });
    }
  }
  const inventedUrls = c.sourceUrls.filter((u) => invented.has(u));
  let status: ClaimStatus;
  let reason: string;
  if (inventedUrls.length === c.sourceUrls.length) {
    status = 'unknown';
    reason = 'источники не найдены поиском и не загружались — ссылки, вероятно, сгенерированы моделью; не используются';
    return { quote: c.quote, sourceKeys: [], supportingKeys: [], status, reason, quoteLocations: [] };
  }
  if (!problem && supporting.length && PAYMENT_CLAIM.test(c.text) && !PAYMENT_EVIDENCE.test(c.quote)) {
    // Popularity ≠ payment: a count of users/companies never proves paying customers or revenue.
    return { quote: c.quote, sourceKeys: keys, supportingKeys: [], status: 'unknown', reason: 'утверждение об оплате/выручке, а цитата говорит только о популярности — оплата не подтверждена', quoteLocations: [] };
  }
  if (problem) {
    status = 'unknown';
    reason = `цитата отклонена: ${problem}`;
  } else if (supporting.length === 0) {
    if (failed || quarantined) {
      status = 'unretrievable';
      reason = quarantined ? 'источник помещён в карантин (попытка инъекции инструкций) — содержимое не используется' : 'источник недоступен при чтении';
    } else {
      status = 'unknown';
      reason = 'цитата не найдена в тексте источника';
    }
  } else if (supporting.length >= 2 && types.includes('independent')) {
    status = 'corroborated';
    reason = `цитата найдена в ${supporting.length} источниках, есть независимый`;
  } else if (types.every((t) => t === 'company_self_report')) {
    status = 'vendor_claim';
    reason = 'подтверждено только заявлением самой компании';
  } else {
    status = 'single_source';
    reason = 'подтверждено одним источником';
  }
  if (inventedUrls.length) reason += `; не загружались (не из найденных): ${inventedUrls.length}`;
  return { quote: c.quote, sourceKeys: keys, supportingKeys: supporting, status, reason, quoteLocations };
}

const DETERMINISTIC_OK: ReadonlySet<ClaimStatus> = new Set(['corroborated', 'single_source', 'vendor_claim']);

/** A claim counts as evidence only if the code check found the quote AND the skeptic did not dispute it. */
export function claimSupports(c: ClaimRow): boolean {
  return DETERMINISTIC_OK.has(c.status) && c.skepticVerdict === 'supported';
}

/**
 * Evidence grade from the sources that ACTUALLY support the claims used in non-null scores — an unrelated
 * page (even an independent one) that was merely fetched does not raise the grade.
 */
export function evidenceGrade(claims: ClaimRow[], sources: SourceRow[], scoreClaimKeys: Set<string>): EvidenceGrade {
  const used = claims.filter((c) => scoreClaimKeys.has(c.key) && claimSupports(c));
  const westNeed = claims.some((c) => c.dimension === 'westernNeed' && claimSupports(c));
  if (!westNeed || used.length === 0) return 'D';
  const type = new Map(sources.map((s) => [s.key, s.sourceType]));
  const independentBacked = used.some((c) => c.supportingKeys.some((k) => type.get(k) === 'independent'));
  const corroborated = used.filter((c) => c.status === 'corroborated').length;
  let g: EvidenceGrade = corroborated >= 2 && independentBacked ? 'A' : independentBacked ? 'B' : 'C';
  const unresolved = claims.some((c) => c.highImpact && c.skepticVerdict === 'needs_more_evidence');
  if (unresolved) g = g === 'A' ? 'B' : 'C';
  return g;
}

function invalidResult(seed: DiscoverySeed, isNew: boolean, reviews: ReviewRow[], reason: string, models: string[], kind: 'invalid' | 'unavailable' = 'invalid'): CandidateResult {
  const scores = Object.fromEntries(DIMENSION_KEYS.map((d) => [d, null])) as ComponentScores;
  const conf: ConfidenceComponents = { completeness: 0, corroboration: 0, recency: 0, reliability: 0, russiaValidation: 0 };
  const summary = kind === 'invalid' ? `Ответ модели отклонён проверкой схемы — кандидат не оценивается: ${reason}` : `Провайдер недоступен — кандидат не оценивается в этом прогоне: ${reason}`;
  reviews.push({ reviewer: 'quality_gate', model: PIPELINE_VERSION, decision: 'hold', summary, findings: [reason], citedClaims: [] });
  return {
    externalId: seed.externalId,
    seed,
    isNew,
    sources: [],
    claims: [],
    searches: [],
    competitors: [],
    reviews,
    assessment: {
      title: seed.title, pitch: seed.pitch, segment: seed.segment, category: seed.category, scores, confidence: conf, founderFit: null,
      marketScore: marketScore(scores), confidenceScore: evidenceConfidence(conf), founderFitScore: null, evidenceGrade: 'D', state: 'DISCOVERED',
      holdReasons: [], rationale: kind === 'invalid' ? `Некорректный ответ модели: ${reason}` : `Провайдер недоступен: ${reason}`, dimensionNotes: [], models,
    },
  };
}

const issues = (e: z.ZodError) => e.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'ответ'}: ${i.message}`).join('; ');

/** Run a model call; schema failures and unavailable providers become an unscored candidate, never a crash or a score. */
async function guarded<T>(f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; kind: 'invalid' | 'unavailable'; reason: string }> {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    if (e instanceof InvalidModelOutput) return { ok: false, kind: 'invalid', reason: e.message };
    if (e instanceof RateLimited) return { ok: false, kind: 'unavailable', reason: e.message };
    throw e;
  }
}

export async function researchCandidate(seed: DiscoverySeed, isNew: boolean, asOf: ISODate, p: Providers, ctx: CallContext, opts: PipelineOptions = {}): Promise<CandidateResult> {
  const reviews: ReviewRow[] = [];
  const searches: SearchRow[] = [];
  const reads = new Reads(p.reader, ctx);
  const hint: ReadHint = { seed };

  // 0. Live mode: the analyst first gets an evidence pack of pages ACTUALLY found and fetched; it may cite only those.
  const evidence: EvidenceDoc[] = [];
  const attempted: string[] = [];
  const evidenceMode = typeof p.llm.evidenceQueries === 'function';
  if (evidenceMode) {
    for (const q of p.llm.evidenceQueries!(seed)) {
      const hits = await runSearch(p.search, ctx, searches, { agent: 'analyst', purpose: 'west_products', region: q.region, query: q.query });
      for (const h of hits.slice(0, opts.evidenceHits ?? hits.length)) {
        if (attempted.some((u) => sameUrl(u, h.url))) continue;
        attempted.push(h.url);
        const r = await reads.get(h.url, 'analyst', hint);
        if (r.read.status === 'ok' && r.read.text) evidence.push({ url: h.url, title: r.read.title ?? h.title, excerpt: r.read.text.slice(0, 4000) });
      }
    }
  }

  // 1. Analyst (LLM pass #1) — runtime-validated
  const got = await guarded(() => p.llm.analyse(seed, asOf, ctx, evidenceMode ? evidence : undefined));
  if (!got.ok) return invalidResult(seed, isNew, reviews, `аналитик: ${got.reason}`, [p.llm.model, p.skeptic.model], got.kind);
  const parsed = analystProposalSchema.safeParse(got.value);
  if (!parsed.success) return invalidResult(seed, isNew, reviews, `аналитик: ${issues(parsed.error)}`, [p.llm.model, p.skeptic.model]);
  const proposal = parsed.data as AnalystProposal;
  reviews.push({ reviewer: 'analyst', model: proposal.model, decision: 'propose', summary: proposal.rationale, findings: [], citedClaims: proposal.claims.map((c) => c.key) });

  // Cited URLs are read — EXCEPT, in live mode, URLs the search never surfaced: a model-generated link is never fetched.
  const invented = new Set<string>();
  for (const c of proposal.claims) {
    for (const url of c.sourceUrls) {
      if (evidenceMode && !attempted.some((u) => sameUrl(u, url))) invented.add(url);
      else await reads.get(url, 'analyst', hint);
    }
  }

  // 2. Competitor search — analyst queries, then the skeptic's INDEPENDENT counter-queries
  const raw: RawCompetitor[] = [];
  const collect = async (url: string, by: 'analyst' | 'skeptic') => {
    const r = await reads.get(url, by, hint);
    const offer = r.read.status === 'ok' ? r.read.offer : null;
    // The western analogue the idea is modelled on is evidence of demand, not a rival.
    if (!offer || isWesternAnalogue(offer.name, url, seed) || raw.some((x) => x.market === offer.market && x.name === offer.name)) return;
    raw.push({ name: offer.name, url, market: offer.market, sourceKey: r.key, jobs: offer.jobs, price: offer.price ?? null, foundBy: by, marketVerified: offer.grounding ? offer.grounding.marketVerified : true, marketStatus: offer.grounding ? offer.grounding.marketStatus : 'declared' });
  };
  for (const q of limit(proposal.ruQueries, opts.maxRuQueries)) {
    for (const h of limit(await runSearch(p.search, ctx, searches, { agent: 'analyst', purpose: 'ru_competitors', region: 'ru', query: q }), opts.hitsPerQuery)) await collect(h.url, 'analyst');
  }
  for (const q of p.skeptic.counterQueries(seed)) {
    const purpose = q.region === 'ru' ? 'ru_competitors' : 'counterevidence';
    for (const h of limit(await runSearch(p.search, ctx, searches, { agent: 'skeptic', purpose, region: q.region, query: q.query }), opts.hitsPerQuery)) await collect(h.url, 'skeptic');
  }

  // 3. Deterministic claim checker (code): specific quote ↔ fetched text, availability, source type
  const claims: ClaimRow[] = proposal.claims.map((c) => ({ key: c.key, dimension: c.dimension as DimensionKey, text: c.text, highImpact: !!c.highImpact, skepticVerdict: 'not_reviewed', skepticReason: null, ...checkClaim(c, reads, invented) }));
  const sources: SourceRow[] = [...reads.rows.values()].map(({ read, key, agent }) => ({
    key,
    url: read.url,
    publisher: read.publisher,
    region: read.region,
    sourceType: read.sourceType,
    fetchStatus: read.status,
    httpStatus: read.httpStatus,
    contentHash: read.contentHash,
    excerpt: read.status === 'ok' ? (read.text ?? '').slice(0, 2000) : null,
    agent,
    canonicalUrl: read.canonicalUrl ?? null,
    fetchedAt: read.fetchedAt ?? null,
    title: read.title ?? null,
    contentType: read.contentType ?? null,
    failure: read.failure ?? null,
    offer: read.offer ?? null,
    provenance: read.provenance ?? null,
  }));
  const checkerFindings = claims.filter((c) => c.status === 'unretrievable' || c.status === 'unknown').map((c) => `${c.key}: ${c.reason}`);
  const quarantined = sources.filter((s) => s.fetchStatus === 'injection_suspected');
  if (quarantined.length) checkerFindings.push(`карантин: ${quarantined.map((s) => s.url).join(', ')} — попытка инъекции инструкций, содержимое не используется`);
  if (invented.size) checkerFindings.push(`ссылки не из поиска (не загружались): ${[...invented].slice(0, 5).join(', ')}`);
  for (const s of sources.filter((x) => x.offer?.grounding?.uncertain.length)) checkerFindings.push(`${s.key}: не подтверждено страницей — ${s.offer!.grounding!.uncertain.join('; ')}`);
  reviews.push({
    reviewer: 'claim_checker',
    model: 'deterministic-code',
    decision: checkerFindings.length ? 'challenge' : 'support',
    summary: `Проверено ${claims.length} утверждений: конкретная цитата ↔ текст источника, доступность, тип источника.`,
    findings: checkerFindings,
    citedClaims: claims.map((c) => c.key),
  });

  // 4. Skeptic (LLM pass #2, different model): structured challenge, schema-validated, references checked
  const ruQueries = new Set(searches.filter((s) => s.region === 'ru' && s.status === 'ok').map((s) => norm(s.query)));
  const ch = await guarded(() => p.skeptic.challenge({ seed, asOf, proposal, claims, sources, rawCompetitors: raw, ruQueryCount: ruQueries.size }, ctx));
  if (!ch.ok) return invalidResult(seed, isNew, reviews, `скептик: ${ch.reason}`, [proposal.model, p.skeptic.model], ch.kind);
  const fParsed = skepticFindingsSchema.safeParse(ch.value);
  if (!fParsed.success) return invalidResult(seed, isNew, reviews, `скептик: ${issues(fParsed.error)}`, [proposal.model, p.skeptic.model]);
  const findings = fParsed.data as SkepticFindings;
  const srcKeys = new Set(sources.map((s) => s.key));
  const badRefs = [
    ...findings.claimVerdicts.filter((v) => !claims.some((c) => c.key === v.claimKey) || v.sourceKeys.some((k) => !srcKeys.has(k))).map((v) => v.claimKey),
    ...findings.competitors.filter((c) => !srcKeys.has(c.sourceKey)).map((c) => c.name),
  ];
  if (badRefs.length) return invalidResult(seed, isNew, reviews, `скептик сослался на несуществующие утверждения или источники: ${badRefs.join(', ')}`, [proposal.model, p.skeptic.model]);

  // Skeptic output is a model output: every rival must be one that search actually surfaced — same
  // source, same name, same market, on a page that was fetched OK. Anything else is dropped (it can
  // neither create a competitor nor move a score or the ranking).
  const rejected: string[] = [];
  const competitors: CompetitorRow[] = [];
  for (const c of findings.competitors) {
    const s = sources.find((x) => x.key === c.sourceKey);
    const r = raw.find((x) => x.sourceKey === c.sourceKey && x.name === c.name && x.market === c.market && x.url === s?.url);
    if (!r || s?.fetchStatus !== 'ok') {
      rejected.push(`отклонено: конкурент «${c.name}» (${c.market === 'ru' ? 'РФ' : 'Запад'}) не найден на загруженной странице ${c.sourceKey}`);
      continue;
    }
    if (competitors.some((x) => x.name === c.name && x.market === c.market)) continue;
    // The kind follows the jobs PROVEN on the rival's page (code), not the model's opinion.
    const kind = codeKind(r, seed);
    if (kind !== c.kind) rejected.push(`«${c.name}»: скептик указал «${c.kind}», по подтверждённым на странице работам — «${kind}»`);
    competitors.push({ name: c.name, url: r.url, market: c.market, kind, foundBy: r.foundBy, sourceKey: c.sourceKey, note: r.price ? `цена: ${r.price}` : null, reason: kind === c.kind ? c.reason : `${c.reason} (исправлено кодом: ${kind})`, marketVerified: r.marketVerified !== false, marketStatus: r.marketStatus ?? 'declared' });
  }
  // A rival the skeptic did not mention is still a rival: no model can hide a competitor found on a fetched page.
  for (const r of raw) {
    if (competitors.some((x) => x.name === r.name && x.market === r.market)) continue;
    const kind = codeKind(r, seed);
    rejected.push(`«${r.name}» не упомянут скептиком — классифицирован кодом как «${kind}»`);
    competitors.push({ name: r.name, url: r.url, market: r.market, kind, foundBy: r.foundBy, sourceKey: r.sourceKey, note: r.price ? `цена: ${r.price}` : null, reason: 'классифицирован кодом по работам, подтверждённым на странице', marketVerified: r.marketVerified !== false, marketStatus: r.marketStatus ?? 'declared' });
  }
  // Only rivals whose market is established by page signals count as proven competition.
  const proven = competitors.filter((c) => c.marketVerified !== false);
  // …but an unproven market is NOT evidence of absence: a rival whose page proves the job while its market is
  // conflicting/unknown is a POSSIBLE competitor — it can never raise the «empty Russian niche».
  const possible = competitors.filter((c) => c.marketVerified === false && c.kind !== 'substitute');
  for (const c of competitors.filter((x) => x.marketVerified === false)) {
    rejected.push(`«${c.name}»: рынок ${c.marketStatus === 'conflicting' ? 'противоречив' : 'не подтверждён'} — не учитывается как доказанный конкурент, но не считается и доказательством отсутствия; перепроверяется автоматически`);
  }
  const okSrc = new Set(sources.filter((s) => s.fetchStatus === 'ok').map((s) => s.key));
  const downgraded = new Set<string>();
  for (const c of claims) {
    const v = findings.claimVerdicts.find((x) => x.claimKey === c.key);
    if (!v) {
      c.skepticVerdict = 'needs_more_evidence';
      c.skepticReason = 'скептик не вынес вердикт — утверждение не засчитывается';
      continue;
    }
    // Cross-check the verdict's own citations: «supported» must cite sources that really contain the
    // quote; «refuted» must cite a validated rival (absence claims) or a fetched page (other claims).
    const absence = proposal.claims.find((pc) => pc.key === c.key)?.absence;
    let problem: string | null = null;
    if (v.verdict === 'supported' && (v.sourceKeys.length === 0 || v.sourceKeys.some((k) => !c.supportingKeys.includes(k)))) problem = 'подтверждение не опирается на источник, где код нашёл цитату';
    if (v.verdict === 'refuted' && absence && !v.sourceKeys.some((k) => proven.some((x) => x.sourceKey === k && x.market === absence.market && x.kind === 'direct'))) problem = 'опровержение не опирается на подтверждённого прямого конкурента (с установленным рынком)';
    if (v.verdict === 'refuted' && !absence && (v.sourceKeys.length === 0 || v.sourceKeys.some((k) => !okSrc.has(k)))) problem = 'опровержение не опирается на загруженный источник';
    if (!problem && v.verdict === 'supported' && absence?.market === 'ru' && possible.some((x) => x.kind === 'direct'))
      problem = `пробел в РФ не может считаться подтверждённым: есть возможный прямой конкурент с неустановленным рынком (${possible.filter((x) => x.kind === 'direct').map((x) => x.name).join(', ')})`;
    if (problem) {
      downgraded.add(c.key);
      rejected.push(`отклонено: вердикт «${v.verdict === 'supported' ? 'подтверждено' : 'опровергнуто'}» по ${c.key} — ${problem}`);
      c.skepticVerdict = 'needs_more_evidence';
      c.skepticReason = `вердикт скептика отклонён кодом: ${problem}`;
      continue;
    }
    c.skepticVerdict = v.verdict;
    c.skepticReason = v.reason;
    if (v.verdict === 'refuted') {
      c.status = 'contradicted';
      c.reason = `опровергнуто скептиком: ${v.reason}`;
    }
  }
  // A dispute that rests on a rejected verdict cannot be critical.
  const disputes = findings.disputes.map((d) => (d.claimKey && downgraded.has(d.claimKey) && d.severity === 'critical' ? { ...d, severity: 'minor' as const, reason: `${d.reason} (понижено: вердикт отклонён кодом)` } : d));
  const skepticFindingsText = [
    ...claims.filter((c) => c.skepticVerdict === 'refuted' || c.skepticVerdict === 'needs_more_evidence').map((c) => `${c.key}: ${c.skepticVerdict === 'refuted' ? 'опровергнуто' : 'нужны доказательства'} — ${c.skepticReason}`),
    ...disputes.map((d) => `${d.severity === 'critical' ? 'КРИТИЧЕСКИЙ спор' : 'спор'}${d.claimKey ? ` (${d.claimKey})` : ''}: ${d.reason}`),
    ...rejected,
  ];
  if (ruQueries.size < MIN_RU_QUERIES) skepticFindingsText.push(`покрытие поиска конкурентов в РФ: ${ruQueries.size} запрос(а) < ${MIN_RU_QUERIES}`);
  reviews.push({
    reviewer: 'skeptic',
    model: findings.model,
    decision: claims.some((c) => c.skepticVerdict !== 'supported') || disputes.length || rejected.length ? 'challenge' : 'support',
    summary: `${findings.summary} Контр-запросов: ${searches.filter((s) => s.agent === 'skeptic').length}; конкурентов: ${competitors.length} (прямых в РФ с подтверждённым рынком: ${proven.filter((c) => c.market === 'ru' && c.kind === 'direct').length}${competitors.length > proven.length ? `; рынок не подтверждён: ${competitors.length - proven.length}` : ''}).`,
    findings: skepticFindingsText,
    citedClaims: findings.claimVerdicts.map((v) => v.claimKey),
  });

  // 5. Scoring: only claims supported by BOTH the code check and the skeptic; RU dims capped by competition
  const notes: string[] = [];
  const byKey = new Map(claims.map((c) => [c.key, c]));
  const srcType = new Map(sources.map((s) => [s.key, s]));
  const directRu = proven.filter((c) => c.market === 'ru' && c.kind === 'direct');
  const adjacentRu = proven.filter((c) => c.market === 'ru' && c.kind !== 'direct');
  // Zero rivals found is NOT proof of a gap: without rivals the cap is 3, or 4 only when an independent
  // Russian source supports an RU claim. Never 5/5 from searches alone.
  const ruIndependent = claims.some((c) => (c.dimension === 'ruWeakness' || c.dimension === 'ruUnmetJob') && claimSupports(c) && c.supportingKeys.some((k) => srcType.get(k)?.sourceType === 'independent' && srcType.get(k)?.region === 'ru'));
  let ruCap = ruQueries.size < MIN_RU_QUERIES ? 2 : directRu.length >= 2 ? 1 : directRu.length === 1 ? 2 : adjacentRu.length ? 3 : ruIndependent ? 4 : 3;
  // Possible rivals (market not established) never let the RU dimensions rise above «competition unclear» (3).
  if (possible.length && ruCap > 3) {
    ruCap = 3;
    notes.push(`РФ: потолок 3 — есть возможные конкуренты с неустановленным рынком (${possible.map((x) => x.name).join(', ')})`);
  }
  const scores = {} as Record<DimensionKey, RawScore>;
  const scoreClaimKeys = new Set<string>();
  for (const d of DIMENSION_KEYS) {
    const prop = proposal.scores[d];
    if (!prop) {
      scores[d] = null;
      notes.push(`${d}: нет оценки — неизвестно`);
      continue;
    }
    let v: number | null = prop.value;
    const ok = prop.claims.filter((k) => byKey.get(k) && claimSupports(byKey.get(k)!));
    const refuted = prop.claims.filter((k) => byKey.get(k)?.status === 'contradicted');
    if (EVIDENCE_DIMENSIONS.has(d)) {
      if (d === 'ruWeakness' || d === 'ruUnmetJob') {
        if (ok.length === 0 && refuted.length === 0) {
          v = null;
          notes.push(`${d}: ${prop.value} не засчитано — нет утверждения, подтверждённого кодом и скептиком`);
        } else if (ok.length === 0) {
          // The only basis was refuted (a rival does this job): evidence of failing the criterion, never a new score.
          v = 0;
          notes.push(`${d}: ${prop.value} → 0 (утверждение о пробеле опровергнуто, подтверждённой опоры нет)`);
        } else if (v > ruCap) {
          notes.push(`${d}: ${v} → ${ruCap} (прямых конкурентов в РФ: ${directRu.length}, смежных: ${adjacentRu.length}${directRu.length + adjacentRu.length === 0 ? '; отсутствие найденных ≠ отсутствие конкурентов' : ''})`);
          v = ruCap;
        }
      } else if (ok.length === 0) {
        notes.push(`${d}: ${prop.value} не засчитано — нет утверждения, подтверждённого кодом и скептиком`);
        v = null;
      }
    } else if (prop.claims.length === 0 && v > UNSOURCED_CAP) {
      notes.push(`${d}: ${v} → ${UNSOURCED_CAP} (суждение без источника ограничено)`);
      v = UNSOURCED_CAP;
    }
    if (v !== null && !d.startsWith('ru') && refuted.length) {
      notes.push(`${d}: ${v} → 1 (утверждение опровергнуто скептиком)`);
      v = 1;
    }
    if (v !== null) ok.forEach((k) => scoreClaimKeys.add(k));
    scores[d] = v as RawScore;
  }
  const componentScores = scores as ComponentScores;

  const supportingSources = sources.filter((s) => claims.some((c) => scoreClaimKeys.has(c.key) && c.supportingKeys.includes(s.key)));
  const evidenceClaims = claims.filter((c) => c.status !== 'contradicted');
  const conf: ConfidenceComponents = {
    completeness: Math.round((100 * DIMENSION_KEYS.filter((d) => componentScores[d] !== null).length) / DIMENSION_KEYS.length),
    corroboration: evidenceClaims.length
      ? Math.round((100 * evidenceClaims.reduce((a, c) => a + (!claimSupports(c) ? 0 : c.status === 'corroborated' ? 1 : c.status === 'single_source' ? 0.5 : 0.3), 0)) / evidenceClaims.length)
      : 0,
    recency: supportingSources.length ? 90 : 0,
    reliability: supportingSources.length ? Math.round((100 * supportingSources.filter((s) => s.sourceType === 'independent').length) / supportingSources.length) : 0,
    russiaValidation: Math.min(100, ruQueries.size * 15 + proven.filter((c) => c.market === 'ru').length * 10),
  };

  // 6. Quality gate (code) — combines deterministic checks with the skeptic's structured findings
  const grade = evidenceGrade(claims, sources, scoreClaimKeys);
  const hold: string[] = [];
  const westNeedOk = claims.some((c) => c.dimension === 'westernNeed' && claimSupports(c) && c.supportingKeys.some((k) => srcType.get(k)?.region === 'west'));
  if (!westNeedOk) hold.push('Нет доступного западного первоисточника, подтверждающего спрос');
  if (ruQueries.size < MIN_RU_QUERIES) hold.push(`Слабое покрытие поиска конкурентов в РФ (${ruQueries.size} из ${MIN_RU_QUERIES} запросов)`);
  for (const c of claims.filter((x) => x.status === 'contradicted' && proposal.claims.find((pc) => pc.key === x.key)?.absence)) {
    const market = proposal.claims.find((pc) => pc.key === c.key)!.absence!.market;
    const rivals = proven.filter((x) => x.market === market && x.kind === 'direct');
    const free = rivals.some((x) => FREE_OFFER.test(x.note ?? ''));
    if (rivals.length >= 2 || free) hold.push(`Пробел опровергнут: ${market === 'ru' ? 'в РФ' : 'на Западе'} уже есть ${rivals.map((x) => x.name).join(', ')}${free ? ' (есть бесплатный тариф)' : ''}`);
  }
  for (const d of disputes.filter((x) => x.severity === 'critical')) hold.push(`Неразрешённый критический спор скептика${d.claimKey ? ` (${d.claimKey})` : ''}: ${d.reason}`);
  if (grade === 'D') hold.push('Недостаточно подтверждённых доказательств для ключевых утверждений');
  if (p.llm.family && p.skeptic.family && p.llm.family === p.skeptic.family) hold.push(`Скептик из того же семейства моделей (${p.skeptic.family}) — режим single-model-degraded, независимой проверки нет`);
  const uniqueHold = [...new Set(hold)];
  const rateLimited = sources.some((s) => s.fetchStatus === 'rate_limited') || searches.some((s) => s.status === 'rate_limited');
  const state: MachineState = rateLimited ? 'DISCOVERED' : uniqueHold.length ? 'RESEARCH_HOLD' : 'AUTOMATED_EVIDENCE_PASSED';
  reviews.push({
    reviewer: 'quality_gate',
    model: PIPELINE_VERSION,
    decision: state === 'AUTOMATED_EVIDENCE_PASSED' ? 'pass' : 'hold',
    summary:
      state === 'AUTOMATED_EVIDENCE_PASSED'
        ? `Проверено системой: класс доказательств ${grade}; ключевые утверждения подтверждены кодом и скептиком.`
        : state === 'DISCOVERED'
          ? 'Исследование неполное (лимит запросов) — кандидат не ранжируется до следующего прогона.'
          : `Отложено автоматически: ${uniqueHold.join('; ')}.`,
    findings: uniqueHold,
    citedClaims: claims.filter((c) => c.highImpact).map((c) => c.key),
  });

  const ffScore = proposal.founderFit ? founderFit(proposal.founderFit) : null;
  return {
    externalId: seed.externalId,
    seed,
    isNew,
    sources,
    claims,
    searches,
    competitors,
    reviews,
    assessment: {
      title: seed.title,
      pitch: seed.pitch,
      segment: seed.segment,
      category: seed.category,
      scores: componentScores,
      confidence: conf,
      founderFit: proposal.founderFit,
      marketScore: marketScore(componentScores),
      confidenceScore: evidenceConfidence(conf),
      founderFitScore: ffScore,
      evidenceGrade: grade,
      state,
      holdReasons: state === 'RESEARCH_HOLD' ? uniqueHold : [],
      rationale: proposal.rationale,
      dimensionNotes: notes,
      models: [proposal.model, findings.model, 'deterministic-code', PIPELINE_VERSION],
    },
  };
}

/**
 * One full autonomous run. `known` = seeds of every candidate already in the registry: incumbents are
 * re-researched every run so new competitors / broken sources change their status automatically.
 */
export interface RunPipelineOptions extends PipelineOptions {
  /** Incumbents to re-research this run (default: all of `known`). */
  recheck?: DiscoverySeed[];
}

export async function runPipeline(asOf: ISODate, known: DiscoverySeed[], p: Providers, ctx: CallContext, opts: RunPipelineOptions = {}): Promise<PipelineResult> {
  const discoverySearches: SearchRow[] = [];
  let leads: SearchHit[] | undefined;
  if (p.llm.discoveryQueries) {
    // Live: real discovery searches; the model may only propose seeds found on these hits.
    leads = [];
    for (const q of p.llm.discoveryQueries(asOf)) leads.push(...(await runSearch(p.search, ctx, discoverySearches, { agent: 'discovery', purpose: 'discovery', region: q.region, query: q.query })));
  } else {
    await runSearch(p.search, ctx, discoverySearches, { agent: 'discovery', purpose: 'discovery', region: 'world', query: `discovery:${asOf}` });
  }
  // Discovery output is validated; an invalid seed is dropped (never scored), the rest proceed.
  const knownIds = new Set(known.map((k) => k.externalId));
  const d = await guarded(() => p.llm.discover(asOf, [...knownIds], ctx, leads));
  let fresh = (d.ok ? d.value : []).filter((s) => discoverySeedSchema.safeParse(s).success && !knownIds.has(s.externalId));
  // A seed must come from a real search hit (no invented products / sources).
  if (leads) fresh = fresh.filter((s) => s.sourceUrl && leads!.some((l) => sameUrl(l.url, s.sourceUrl!)));
  fresh = fresh.filter((s, i) => fresh.findIndex((x) => x.externalId === s.externalId) === i);
  if (opts.maxNew !== undefined) fresh = fresh.slice(0, opts.maxNew);
  const candidates: CandidateResult[] = [];
  for (const seed of [...(opts.recheck ?? known), ...fresh]) {
    candidates.push(await researchCandidate(seed, !knownIds.has(seed.externalId), asOf, p, ctx, opts));
  }
  return { asOf, discoverySearches, candidates };
}

export { BudgetExhausted };
