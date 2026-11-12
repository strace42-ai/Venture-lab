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
import { DIMENSION_KEYS, evidenceConfidence, founderFit, marketScore } from '../../src/domain/scoring';
import type { ComponentScores, ConfidenceComponents, DimensionKey, ISODate, RawScore } from '../../src/domain/types';
import {
  BudgetExhausted,
  RateLimited,
  type AnalystProposal,
  type CallContext,
  type CandidateResult,
  type ClaimRow,
  type ClaimStatus,
  type CompetitorRow,
  type DiscoverySeed,
  type EvidenceGrade,
  type LLMProvider,
  type MachineState,
  type PageRead,
  type PipelineResult,
  type ReviewRow,
  type SearchProvider,
  type SearchRow,
  type SkepticalReviewer,
  type SourceReader,
  type SourceRow,
} from './types';

export const PIPELINE_VERSION = 'vl-004a-pipeline-1';

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

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Reads every URL once per candidate; a rate-limit/budget stop is recorded, never hidden. */
class Reads {
  readonly rows = new Map<string, { read: PageRead; key: string; agent: 'analyst' | 'skeptic' }>();
  private n = 0;
  constructor(private readonly reader: SourceReader, private readonly ctx: CallContext) {}
  async get(url: string, agent: 'analyst' | 'skeptic'): Promise<{ read: PageRead; key: string }> {
    const hit = this.rows.get(url);
    if (hit) return hit;
    let read: PageRead;
    try {
      read = await this.reader.read(url, this.ctx);
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

function checkClaim(c: AnalystProposal['claims'][number], reads: Reads): Omit<ClaimRow, 'key' | 'dimension' | 'text' | 'highImpact'> & { supporting: SourceRow['sourceType'][] } {
  const keys: string[] = [];
  const supporting: SourceRow['sourceType'][] = [];
  let failed = 0;
  let quarantined = 0;
  for (const url of c.sourceUrls) {
    const r = reads.rows.get(url);
    if (!r) continue;
    keys.push(r.key);
    if (r.read.status === 'injection_suspected') quarantined++;
    else if (r.read.status !== 'ok') failed++;
    else if (r.read.text && norm(r.read.text).includes(norm(c.quote))) supporting.push(r.read.sourceType);
  }
  let status: ClaimStatus;
  let reason: string;
  if (supporting.length === 0) {
    if (failed || quarantined) {
      status = 'unretrievable';
      reason = quarantined ? 'источник помещён в карантин (попытка инъекции инструкций) — содержимое не используется' : 'источник недоступен при чтении';
    } else {
      status = 'unknown';
      reason = 'цитата не найдена в тексте источника';
    }
  } else if (supporting.length >= 2 && supporting.includes('independent')) {
    status = 'corroborated';
    reason = `цитата подтверждена ${supporting.length} источниками, есть независимый`;
  } else if (supporting.every((t) => t === 'company_self_report')) {
    status = 'vendor_claim';
    reason = 'подтверждено только заявлением самой компании';
  } else {
    status = 'single_source';
    reason = 'подтверждено одним источником';
  }
  return { quote: c.quote, sourceKeys: keys, status, reason, supporting };
}

function grade(claims: ClaimRow[], sources: SourceRow[]): EvidenceGrade {
  const high = claims.filter((c) => c.highImpact && c.status !== 'contradicted');
  const bad = high.some((c) => c.status === 'unretrievable' || c.status === 'unknown');
  if (bad || high.length === 0) return 'D';
  const independentOk = sources.some((s) => s.fetchStatus === 'ok' && s.sourceType === 'independent');
  const corroborated = claims.filter((c) => c.status === 'corroborated').length;
  if (corroborated >= 2 && independentOk) return 'A';
  if (independentOk) return 'B';
  return 'C';
}

export async function researchCandidate(seed: DiscoverySeed, isNew: boolean, asOf: ISODate, p: Providers, ctx: CallContext): Promise<CandidateResult> {
  const reviews: ReviewRow[] = [];
  const searches: SearchRow[] = [];
  const competitors: CompetitorRow[] = [];
  const reads = new Reads(p.reader, ctx);

  // 1. Analyst (LLM pass #1)
  const proposal = await p.llm.analyse(seed, asOf, ctx);
  reviews.push({ reviewer: 'analyst', model: proposal.model, decision: 'propose', summary: proposal.rationale, findings: [], citedClaims: proposal.claims.map((c) => c.key) });

  for (const c of proposal.claims) for (const url of c.sourceUrls) await reads.get(url, 'analyst');

  // 2. Competitor search — analyst queries, then the skeptic's INDEPENDENT counter-queries
  const seenCompetitor = new Set<string>();
  const addCompetitorFrom = async (url: string, by: 'analyst' | 'skeptic') => {
    const r = await reads.get(url, by);
    const offer = r.read.status === 'ok' ? r.read.offer : null;
    if (!offer || seenCompetitor.has(`${offer.market}:${offer.name}`)) return;
    // The western analogue the idea is modelled on is evidence of demand, not a rival.
    if (offer.name === seed.westernProduct) return;
    const kind = offer.jobs.includes(seed.primaryJob) ? 'direct' : offer.jobs.some((j) => seed.jobs.includes(j)) ? 'adjacent' : 'substitute';
    seenCompetitor.add(`${offer.market}:${offer.name}`);
    competitors.push({ name: offer.name, url, market: offer.market, kind, foundBy: by, sourceKey: r.key, note: offer.price ? `цена: ${offer.price}` : null });
  };
  for (const q of proposal.ruQueries) {
    for (const h of await runSearch(p.search, ctx, searches, { agent: 'analyst', purpose: 'ru_competitors', region: 'ru', query: q })) await addCompetitorFrom(h.url, 'analyst');
  }
  for (const q of p.skeptic.counterQueries(seed)) {
    const purpose = q.region === 'ru' ? 'ru_competitors' : 'counterevidence';
    for (const h of await runSearch(p.search, ctx, searches, { agent: 'skeptic', purpose, region: q.region, query: q.query })) await addCompetitorFrom(h.url, 'skeptic');
  }

  // 3. Deterministic claim checker (code, not an LLM)
  const claims: ClaimRow[] = proposal.claims.map((c) => {
    const r = checkClaim(c, reads);
    return { key: c.key, dimension: c.dimension, text: c.text, quote: r.quote, sourceKeys: r.sourceKeys, status: r.status, reason: r.reason, highImpact: !!c.highImpact };
  });
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
  }));
  const checkerFindings = claims.filter((c) => c.status === 'unretrievable' || c.status === 'unknown').map((c) => `${c.key}: ${c.reason}`);
  const quarantined = sources.filter((s) => s.fetchStatus === 'injection_suspected');
  if (quarantined.length) checkerFindings.push(`карантин: ${quarantined.map((s) => s.url).join(', ')} — попытка инъекции инструкций, содержимое не используется`);
  reviews.push({
    reviewer: 'claim_checker',
    model: 'deterministic-code',
    decision: checkerFindings.length ? 'challenge' : 'support',
    summary: `Проверено ${claims.length} утверждений: точное совпадение цитаты с текстом источника, доступность, тип источника.`,
    findings: checkerFindings,
    citedClaims: claims.map((c) => c.key),
  });

  // 4. Skeptic (LLM pass #2, different model) — refute absence claims with found competitors
  const skepticFindings: string[] = [];
  const refutations: { claim: string; market: string; job: string; rivals: CompetitorRow[] }[] = [];
  for (const pc of proposal.claims) {
    if (!pc.absence) continue;
    const rivals = competitors.filter((c) => c.market === pc.absence!.market && c.kind === 'direct');
    if (rivals.length === 0) continue;
    const claim = claims.find((c) => c.key === pc.key)!;
    claim.status = 'contradicted';
    claim.reason = `опровергнуто: прямые конкуренты (${pc.absence.market === 'ru' ? 'РФ' : 'Запад'}) — ${rivals.map((r) => r.name).join(', ')}`;
    refutations.push({ claim: pc.key, market: pc.absence.market, job: pc.absence.job, rivals });
    skepticFindings.push(`${pc.key}: ${claim.reason}`);
  }
  const ruQueries = new Set(searches.filter((s) => s.region === 'ru' && s.status === 'ok').map((s) => norm(s.query)));
  if (ruQueries.size < MIN_RU_QUERIES) skepticFindings.push(`покрытие поиска конкурентов в РФ: ${ruQueries.size} запрос(а) < ${MIN_RU_QUERIES}`);
  reviews.push({
    reviewer: 'skeptic',
    model: p.skeptic.model,
    decision: skepticFindings.length ? 'challenge' : 'support',
    summary: `Независимые контр-запросы: ${searches.filter((s) => s.agent === 'skeptic').length}; найдено конкурентов: ${competitors.length} (прямых в РФ: ${competitors.filter((c) => c.market === 'ru' && c.kind === 'direct').length}).`,
    findings: skepticFindings,
    citedClaims: refutations.map((r) => r.claim),
  });

  // 5. Scoring: evidence-backed dimensions only; competition-aware caps for the RU dimensions
  const notes: string[] = [];
  const status = new Map(claims.map((c) => [c.key, c.status]));
  const supported = (k: string) => {
    const s = status.get(k);
    return s === 'corroborated' || s === 'single_source' || s === 'vendor_claim';
  };
  const directRu = competitors.filter((c) => c.market === 'ru' && c.kind === 'direct');
  const adjacentRu = competitors.filter((c) => c.market === 'ru' && c.kind !== 'direct');
  const ruCap = directRu.length >= 2 ? 1 : directRu.length === 1 ? 2 : adjacentRu.length ? 3 : ruQueries.size >= MIN_RU_QUERIES ? 5 : 2;
  const scores = {} as Record<DimensionKey, RawScore>;
  for (const d of DIMENSION_KEYS) {
    const prop = proposal.scores[d];
    if (!prop) {
      scores[d] = null;
      notes.push(`${d}: нет оценки — неизвестно`);
      continue;
    }
    let v: number | null = prop.value;
    if (EVIDENCE_DIMENSIONS.has(d)) {
      const ok = prop.claims.filter(supported);
      const refuted = prop.claims.filter((k) => status.get(k) === 'contradicted');
      if (d === 'ruWeakness' || d === 'ruUnmetJob') {
        if (ok.length === 0 && refuted.length === 0) v = null;
        else if (v !== null && v > ruCap) {
          notes.push(`${d}: ${v} → ${ruCap} (конкуренты в РФ: прямых ${directRu.length}, смежных ${adjacentRu.length})`);
          v = ruCap;
        }
        if (v === null) notes.push(`${d}: нет подтверждённых утверждений — неизвестно`);
      } else if (ok.length === 0) {
        notes.push(`${d}: ${prop.value} не засчитано — нет подтверждённого утверждения`);
        v = null;
      }
    } else if (prop.claims.length === 0 && v > UNSOURCED_CAP) {
      notes.push(`${d}: ${v} → ${UNSOURCED_CAP} (суждение без источника ограничено)`);
      v = UNSOURCED_CAP;
    }
    // A refuted absence claim on a non-RU dimension (e.g. «на Западе нет аналога») drops the value.
    if (v !== null && !d.startsWith('ru') && prop.claims.some((k) => status.get(k) === 'contradicted')) {
      notes.push(`${d}: ${v} → 1 (утверждение опровергнуто скептиком)`);
      v = 1;
    }
    scores[d] = v as RawScore;
  }
  const componentScores = scores as ComponentScores;

  const okSources = sources.filter((s) => s.fetchStatus === 'ok');
  const evidenceClaims = claims.filter((c) => c.status !== 'contradicted');
  const conf: ConfidenceComponents = {
    completeness: Math.round((100 * DIMENSION_KEYS.filter((d) => componentScores[d] !== null).length) / DIMENSION_KEYS.length),
    corroboration: evidenceClaims.length
      ? Math.round((100 * evidenceClaims.reduce((a, c) => a + (c.status === 'corroborated' ? 1 : c.status === 'single_source' ? 0.5 : c.status === 'vendor_claim' ? 0.3 : 0), 0)) / evidenceClaims.length)
      : 0,
    recency: okSources.length ? 90 : 0,
    reliability: okSources.length ? Math.round((100 * okSources.filter((s) => s.sourceType === 'independent').length) / okSources.length) : 0,
    russiaValidation: Math.min(100, ruQueries.size * 15 + competitors.filter((c) => c.market === 'ru').length * 10),
  };

  // 6. Quality gate (deterministic)
  const evidenceGrade = grade(claims, sources);
  const hold: string[] = [];
  const westNeed = claims.find((c) => c.dimension === 'westernNeed');
  const westOk = okSources.some((s) => s.region === 'west');
  if (!westOk || !westNeed || !supported(westNeed.key)) hold.push('Нет доступного западного первоисточника, подтверждающего спрос');
  if (ruQueries.size < MIN_RU_QUERIES) hold.push(`Слабое покрытие поиска конкурентов в РФ (${ruQueries.size} из ${MIN_RU_QUERIES} запросов)`);
  for (const r of refutations) {
    const free = r.rivals.some((x) => FREE_OFFER.test(x.note ?? ''));
    if (r.rivals.length >= 2 || free) {
      hold.push(`Пробел опровергнут: ${r.market === 'ru' ? 'в РФ' : 'на Западе'} уже есть ${r.rivals.map((x) => x.name).join(', ')}${free ? ' (есть бесплатный тариф)' : ''}`);
    }
  }
  if (evidenceGrade === 'D') hold.push('Недостаточно подтверждённых доказательств для ключевых утверждений');
  const uniqueHold = [...new Set(hold)];
  const rateLimited = sources.some((s) => s.fetchStatus === 'rate_limited') || searches.some((s) => s.status === 'rate_limited');
  const state: MachineState = rateLimited ? 'DISCOVERED' : uniqueHold.length ? 'RESEARCH_HOLD' : 'AUTOMATED_EVIDENCE_PASSED';
  reviews.push({
    reviewer: 'quality_gate',
    model: PIPELINE_VERSION,
    decision: state === 'AUTOMATED_EVIDENCE_PASSED' ? 'pass' : 'hold',
    summary:
      state === 'AUTOMATED_EVIDENCE_PASSED'
        ? `Проверено системой: класс доказательств ${evidenceGrade}; ключевые утверждения подтверждены источниками.`
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
      evidenceGrade,
      state,
      holdReasons: state === 'RESEARCH_HOLD' ? uniqueHold : [],
      rationale: proposal.rationale,
      dimensionNotes: notes,
      models: [proposal.model, p.skeptic.model, 'deterministic-code', PIPELINE_VERSION],
    },
  };
}

/**
 * One full autonomous run. `known` = seeds of every candidate already in the registry: incumbents are
 * re-researched every run so new competitors / broken sources change their status automatically.
 */
export async function runPipeline(asOf: ISODate, known: DiscoverySeed[], p: Providers, ctx: CallContext): Promise<PipelineResult> {
  const discoverySearches: SearchRow[] = [];
  await runSearch(p.search, ctx, discoverySearches, { agent: 'discovery', purpose: 'discovery', region: 'world', query: `discovery:${asOf}` });
  const fresh = await p.llm.discover(asOf, known.map((k) => k.externalId), ctx);
  const candidates: CandidateResult[] = [];
  for (const seed of [...known, ...fresh]) {
    candidates.push(await researchCandidate(seed, !known.some((k) => k.externalId === seed.externalId), asOf, p, ctx));
  }
  return { asOf, discoverySearches, candidates };
}

export { BudgetExhausted };
