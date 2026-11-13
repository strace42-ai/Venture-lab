/**
 * LiveSourceReader (VL-004B): real page retrieval for the pipeline, behind the existing SourceReader
 * contract. Fetch through SafeFetcher → visible text → injection quarantine → (optional) offer
 * extraction by the analyst model → deterministic grounding. A page that cannot be read stays
 * UNKNOWN (its status is recorded); nothing generated ever replaces fetched text.
 */
import { createHash } from 'node:crypto';
import { canonicalUrl } from './yandex-search';
import { extractPage, looksLikeInjection } from './html';
import { groundOffer, marketEvidence, marketSignal, type ExtractedOffer } from './grounding';
import { assessProvenance, siteOf } from './provenance';
import type { OfferExtractor } from './ai-studio';
import type { SafeFetcher, SafeFetchResult } from './net/safe-fetch';
import { InvalidModelOutput, RateLimited, type CallContext, type PageRead, type ReadHint, type SourceReader, type SourceType } from '../machine/types';

export class LiveSourceReader implements SourceReader {
  readonly name = 'live-reader';
  /** One network fetch per URL per run (pages are re-used across candidates). */
  private readonly cache = new Map<string, Promise<SafeFetchResult>>();
  private readonly extracted = new Map<string, { x: ExtractedOffer; offer: PageRead['offer']; uncertain: string[] }>();
  /** Sites seen (this run) offering a product: never «independent» publishers. */
  private readonly productSites = new Set<string>();

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
    let failure: string | null = null;
    let pageKind: ExtractedOffer['pageKind'] | null = null;
    if (hint && this.extractor) {
      const ek = `${key}|${hint.seed.externalId}`;
      let got = this.extracted.get(ek);
      if (!got) {
        try {
          const x = await this.extractor.extract(ctx, { url: f.finalUrl, title: page.title, text: page.text }, hint.seed);
          // Market not established on this page → one automatic re-check on the site's home page (free, same safe fetcher).
          let probe: { url: string; lang: string | null; text: string } | null = null;
          if (x.isProductPage && x.name && marketEvidence(f.finalUrl, page.lang, page.text).status === 'unknown') probe = await this.homeProbe(ctx, f.finalUrl);
          const g = groundOffer(x, { url: f.finalUrl, title: page.title, lang: page.lang, text: page.text }, hint.seed, this.extractor.model, probe);
          got = { x, offer: g.offer, uncertain: g.uncertain };
          this.extracted.set(ek, got);
        } catch (e) {
          if (e instanceof RateLimited) throw e;
          if (!(e instanceof InvalidModelOutput)) throw e;
          failure = `извлечение предложения отклонено: ${e.message}`.slice(0, 480);
        }
      }
      if (got) {
        offer = got.offer;
        pageKind = got.x.pageKind;
        if (got.uncertain.length && !offer) failure = got.uncertain.join('; ').slice(0, 480);
      }
      if (offer) this.productSites.add(siteOf(f.finalUrl));
    }
    // Source type from deterministic provenance; the model's «independent» is only a claim to be verified.
    const prov = assessProvenance({ url: f.finalUrl, meta: page.meta, hasGroundedOffer: !!offer, modelPageKind: pageKind, seed: hint?.seed ?? null, productSites: this.productSites });
    const sourceType: SourceType = prov.sourceType;
    const provenance = { independence: prov.independence, signals: prov.signals, reason: prov.reason };
    return { ...base, status: 'ok', sourceType, region, text: page.text, title: page.title, offer, contentHash, failure, provenance };
  }

  /** The site's home page, fetched once per run through the same safe fetcher (no model call, no charge). */
  private async homeProbe(ctx: CallContext, url: string): Promise<{ url: string; lang: string | null; text: string } | null> {
    let home: string;
    try {
      home = new URL('/', url).toString();
    } catch {
      return null;
    }
    if (canonicalUrl(home) === canonicalUrl(url)) return null;
    await ctx.charge({ provider: this.name, operation: 'read', model: null, tokensIn: 0, tokensOut: 0, cost: 0, priceVersion: 'no-charge', reconciliation: 'tariff', actualCost: 0 });
    const k = canonicalUrl(home) ?? home;
    let p = this.cache.get(k);
    if (!p) {
      p = this.fetcher.fetch(home);
      this.cache.set(k, p);
    }
    const r = await p;
    if (r.status !== 'ok' || r.body === null) return null;
    const pg = extractPage(r.body, r.contentType);
    if (looksLikeInjection(pg.text)) return null;
    return { url: r.finalUrl, lang: pg.lang, text: pg.text };
  }
}
