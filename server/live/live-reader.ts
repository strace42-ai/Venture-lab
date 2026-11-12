/**
 * LiveSourceReader (VL-004B): real page retrieval for the pipeline, behind the existing SourceReader
 * contract. Fetch through SafeFetcher → visible text → injection quarantine → (optional) offer
 * extraction by the analyst model → deterministic grounding. A page that cannot be read stays
 * UNKNOWN (its status is recorded); nothing generated ever replaces fetched text.
 */
import { createHash } from 'node:crypto';
import { canonicalUrl } from './yandex-search';
import { extractPage, looksLikeInjection } from './html';
import { groundOffer, marketSignal } from './grounding';
import type { OfferExtractor } from './ai-studio';
import type { SafeFetcher, SafeFetchResult } from './net/safe-fetch';
import { InvalidModelOutput, RateLimited, type CallContext, type PageRead, type ReadHint, type SourceReader, type SourceType } from '../machine/types';

export class LiveSourceReader implements SourceReader {
  readonly name = 'live-reader';
  /** One network fetch per URL per run (pages are re-used across candidates). */
  private readonly cache = new Map<string, Promise<SafeFetchResult>>();
  private readonly extracted = new Map<string, PageRead['offer'] & object>();

  constructor(private readonly fetcher: SafeFetcher, private readonly extractor: OfferExtractor | null) {}

  async read(url: string, ctx: CallContext, hint?: ReadHint): Promise<PageRead> {
    // Counted (rate limit per run), free of charge: fetching a public page has no provider tariff.
    await ctx.charge({ provider: this.name, operation: 'read', model: null, tokensIn: 0, tokensOut: 0, cost: 0, priceVersion: 'no-charge', reconciliation: 'tariff', actualCost: 0 });
    const key = canonicalUrl(url) ?? url;
    let p = this.cache.get(key);
    if (!p) {
      p = this.fetcher.fetch(url);
      this.cache.set(key, p);
    }
    const f = await p;
    let publisher: string | null = null;
    try {
      publisher = new URL(f.finalUrl).hostname.replace(/^www\./, '');
    } catch {
      /* ignore */
    }
    const base = { url, httpStatus: f.httpStatus, publisher, canonicalUrl: canonicalUrl(f.finalUrl), fetchedAt: f.fetchedAt, contentType: f.contentType, offer: null, contentHash: null } as const;
    if (f.status !== 'ok' || f.body === null) {
      return { ...base, status: f.status, sourceType: 'unknown', region: 'west', text: null, title: null, failure: f.failure };
    }
    const page = extractPage(f.body, f.contentType);
    const contentHash = createHash('sha256').update(page.text).digest('hex');
    const region = marketSignal(f.finalUrl, page.lang, page.text) ?? 'west';
    // Visible OR hidden instruction-like text aimed at an AI reader → quarantine the whole page.
    const inj = looksLikeInjection(page.text) ?? looksLikeInjection(f.body.replace(/<[^>]+>/g, ' '));
    if (inj) return { ...base, status: 'injection_suspected', sourceType: 'unknown', region, text: null, title: page.title, contentHash, failure: `карантин: «${inj}»` };
    if (page.text.length < 40) return { ...base, status: 'unsupported_content', sourceType: 'unknown', region, text: null, title: page.title, contentHash, failure: 'страница без видимого текста (вероятно, требует JavaScript) — не разбирается' };

    let offer: PageRead['offer'] = null;
    let sourceType: SourceType = 'unknown';
    let failure: string | null = null;
    if (hint && this.extractor) {
      const ek = `${key}|${hint.seed.externalId}`;
      const cached = this.extracted.get(ek);
      if (cached) offer = cached;
      else {
        try {
          const x = await this.extractor.extract(ctx, { url: f.finalUrl, title: page.title, text: page.text }, hint.seed);
          const g = groundOffer(x, { url: f.finalUrl, title: page.title, lang: page.lang, text: page.text }, hint.seed, this.extractor.model);
          offer = g.offer;
          if (offer) this.extracted.set(ek, offer);
          if (g.uncertain.length && !offer) failure = g.uncertain.join('; ').slice(0, 480);
          sourceType = offer ? 'company_self_report' : x.pageKind === 'independent' ? 'independent' : x.pageKind === 'vendor' ? 'company_self_report' : 'unknown';
        } catch (e) {
          if (e instanceof RateLimited) throw e;
          if (!(e instanceof InvalidModelOutput)) throw e;
          failure = `извлечение предложения отклонено: ${e.message}`.slice(0, 480);
        }
      }
      if (offer) sourceType = 'company_self_report'; // a vendor's own offer is a self-report, never independent proof
      // The Western product's own site is never «independent», whatever the model says.
      const brand = hint.seed.westernProduct.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (brand.length >= 4 && (publisher ?? '').replace(/[^a-z0-9]/g, '').includes(brand)) sourceType = 'company_self_report';
    }
    return { ...base, status: 'ok', sourceType, region, text: page.text, title: page.title, offer, contentHash, failure };
  }
}
