/**
 * Deterministic fixture providers (offline). Same interfaces as future live providers.
 * Costs are emulated in «units» (kopecks) with an explicit price version so budgets, caps and
 * telemetry are exercised exactly like in live mode.
 */
import { createHash } from 'node:crypto';
import type { ISODate } from '../../../src/domain/types';
import { CANDIDATES, PAGES, SEARCHES, SKEPTIC_SYNONYMS, type FixtureCandidate } from '../fixtures/world';
import type { AnalystProposal, CallContext, DiscoverySeed, LLMProvider, PageRead, Region, SearchHit, SearchProvider, SkepticalReviewer, SourceReader } from '../types';

export const FIXTURE_PRICES = { version: 'fixture-prices-2026-11', search: 10, read: 2, llm: 25 } as const;

const visible = (from: string | undefined, until: string | undefined, asOf: ISODate) => (!from || from <= asOf) && (!until || until >= asOf);

/** Prompt-injection / instruction-like content in an untrusted page. Matched pages are quarantined. */
const INJECTION = [
  /ignore (all )?(previous|prior) instructions/i,
  /игнорируй (все )?(предыдущие|прошлые) инструкции/i,
  /\bsystem prompt\b/i,
  /rate this idea \d/i,
  /mark all claims as verified/i,
  /<\s*script\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION.some((r) => r.test(text));
}

export class FixtureSearchProvider implements SearchProvider {
  readonly name = 'fixture-search';
  constructor(private readonly asOf: ISODate) {}
  async search(query: string, region: Region | 'world', ctx: CallContext): Promise<SearchHit[]> {
    ctx.charge({ provider: this.name, operation: 'search', model: null, tokensIn: 0, tokensOut: 0, cost: FIXTURE_PRICES.search, priceVersion: FIXTURE_PRICES.version });
    const q = query.trim().toLowerCase();
    const hit = SEARCHES.find((s) => s.query.toLowerCase() === q && s.region === region && visible(s.from, undefined, this.asOf));
    return (hit?.urls ?? []).map((url) => ({ url, title: PAGES.find((p) => p.url === url)?.publisher ?? url }));
  }
}

export class FixtureSourceReader implements SourceReader {
  readonly name = 'fixture-reader';
  constructor(private readonly asOf: ISODate) {}
  async read(url: string, ctx: CallContext): Promise<PageRead> {
    ctx.charge({ provider: this.name, operation: 'read', model: null, tokensIn: 0, tokensOut: 0, cost: FIXTURE_PRICES.read, priceVersion: FIXTURE_PRICES.version });
    const page = PAGES.find((p) => p.url === url && visible(p.from, p.until, this.asOf));
    if (!page) return { url, status: 'http_error', httpStatus: 404, publisher: null, sourceType: 'unknown', region: 'west', text: null, offer: null, contentHash: null };
    if (page.status !== 200 || !page.text) {
      return { url, status: page.status === 403 ? 'blocked' : 'http_error', httpStatus: page.status, publisher: page.publisher, sourceType: page.sourceType, region: page.region, text: null, offer: null, contentHash: null };
    }
    const contentHash = createHash('sha256').update(page.text).digest('hex');
    if (looksLikeInjection(page.text)) {
      // Untrusted content tried to issue instructions: quarantine it, never pass it to analysis.
      return { url, status: 'injection_suspected', httpStatus: 200, publisher: page.publisher, sourceType: page.sourceType, region: page.region, text: null, offer: null, contentHash };
    }
    return { url, status: 'ok', httpStatus: 200, publisher: page.publisher, sourceType: page.sourceType, region: page.region, text: page.text, offer: page.offer ?? null, contentHash };
  }
}

function applyOverrides(c: FixtureCandidate, asOf: ISODate): AnalystProposal {
  let p = c.proposal;
  for (const o of c.overrides ?? []) if (o.from <= asOf) p = { ...p, ...o.proposal };
  return p;
}

export class FixtureLLMProvider implements LLMProvider {
  readonly name = 'fixture-llm';
  readonly model = 'fixture-analyst-v1';
  async discover(asOf: ISODate, known: string[], ctx: CallContext): Promise<DiscoverySeed[]> {
    ctx.charge({ provider: this.name, operation: 'llm', model: this.model, tokensIn: 800, tokensOut: 300, cost: FIXTURE_PRICES.llm, priceVersion: FIXTURE_PRICES.version });
    return CANDIDATES.filter((c) => c.discoveredOn === asOf && !known.includes(c.seed.externalId)).map((c) => c.seed);
  }
  async analyse(seed: DiscoverySeed, asOf: ISODate, ctx: CallContext): Promise<AnalystProposal> {
    ctx.charge({ provider: this.name, operation: 'llm', model: this.model, tokensIn: 2400, tokensOut: 900, cost: FIXTURE_PRICES.llm, priceVersion: FIXTURE_PRICES.version });
    const c = CANDIDATES.find((x) => x.seed.externalId === seed.externalId);
    if (!c) throw new Error(`fixture: no analyst proposal for ${seed.externalId}`);
    return applyOverrides(c, asOf);
  }
}

/** Independent skeptic: category synonyms + «аналог <western product>» + «<western product> review». */
export class FixtureSkeptic implements SkepticalReviewer {
  readonly name = 'fixture-skeptic';
  readonly model = 'fixture-skeptic-v1';
  counterQueries(seed: DiscoverySeed): { query: string; region: Region }[] {
    return [
      ...(SKEPTIC_SYNONYMS[seed.category] ?? []).map((q) => ({ query: q, region: 'ru' as const })),
      { query: `аналог ${seed.westernProduct}`, region: 'ru' },
      ...(seed.category === 'Auto' ? [{ query: 'VCDS log analyzer online', region: 'west' as const }] : []),
      { query: `${seed.westernProduct.split(' ').slice(-1)[0]} review`, region: 'west' },
    ];
  }
}

export function seedFor(externalId: string): DiscoverySeed | undefined {
  return CANDIDATES.find((c) => c.seed.externalId === externalId)?.seed;
}
