/**
 * Source provenance (VL-004B audit P1): is a page an INDEPENDENT publication? A model's opinion is
 * necessary but never sufficient — «independent» raises the evidence grade and reliability, so it needs
 * verifiable signals: not the product's own site or publisher, no product offer on the page, and
 * publication markup (article / review / news) plus an identifiable publisher or author distinct from
 * the product. Anything less is UNKNOWN («тип не установлен»), never independent.
 */
import type { PageMeta } from './html';
import type { DiscoverySeed, SourceType } from '../machine/types';

export interface Provenance {
  sourceType: SourceType;
  /** verified — independence established by signals; unverified — model claimed it, signals missing; not_claimed. */
  independence: 'verified' | 'unverified' | 'not_claimed';
  signals: string[];
  reason: string;
}

const ARTICLE_TYPES = new Set(['Article', 'NewsArticle', 'Review', 'BlogPosting', 'ScholarlyArticle', 'Report', 'TechArticle', 'AnalysisNewsArticle']);
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};
const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Registrable-ish domain: last two labels (www/sub-domains of one site are the same owner). */
export function siteOf(urlOrHost: string): string {
  let h = urlOrHost;
  try {
    h = new URL(urlOrHost).hostname;
  } catch {
    /* already a host */
  }
  return h.toLowerCase().replace(/\.$/, '').split('.').slice(-2).join('.');
}

export function assessProvenance(i: {
  url: string;
  meta: PageMeta;
  hasGroundedOffer: boolean;
  modelPageKind: 'vendor' | 'independent' | 'marketplace' | 'forum' | 'unknown' | null;
  seed: DiscoverySeed | null;
  /** Sites known (this run) to belong to a product: the seed's source and every site with a grounded offer. */
  productSites: ReadonlySet<string>;
}): Provenance {
  const site = siteOf(i.url);
  const brand = i.seed ? letters(i.seed.westernProduct) : '';
  const brandIn = (s: string | null) => !!s && brand.length >= 4 && letters(s).includes(brand);
  if (i.hasGroundedOffer) return { sourceType: 'company_self_report', independence: 'not_claimed', signals: [], reason: 'на странице предложение продукта — самоописание компании' };
  if (i.productSites.has(site) || (i.seed?.sourceUrl && siteOf(i.seed.sourceUrl) === site)) return { sourceType: 'company_self_report', independence: 'not_claimed', signals: [], reason: `сайт ${site} принадлежит продукту` };
  if (brandIn(site)) return { sourceType: 'company_self_report', independence: 'not_claimed', signals: [], reason: `домен ${site} содержит название продукта` };
  if (brandIn(i.meta.siteName) || brandIn(i.meta.author)) return { sourceType: 'company_self_report', independence: 'not_claimed', signals: [], reason: 'издатель или автор — сам продукт' };
  if (i.modelPageKind === 'vendor') return { sourceType: 'company_self_report', independence: 'not_claimed', signals: [], reason: 'страница компании' };
  if (i.modelPageKind !== 'independent') return { sourceType: 'unknown', independence: 'not_claimed', signals: [], reason: 'тип источника не установлен' };

  const article: string[] = [];
  if ((i.meta.ogType ?? '').toLowerCase() === 'article') article.push('og:type=article');
  const types = i.meta.schemaTypes.filter((t) => ARTICLE_TYPES.has(t));
  if (types.length) article.push(`schema.org ${types.join('/')}`);
  if (i.meta.articleTag) article.push('разметка <article>');
  const byline: string[] = [];
  if (i.meta.author) byline.push(`автор: ${i.meta.author.slice(0, 80)}`);
  if (i.meta.siteName) byline.push(`издатель: ${i.meta.siteName.slice(0, 80)}`);
  if (article.length && byline.length) {
    return { sourceType: 'independent', independence: 'verified', signals: [`сайт ${hostOf(i.url)} не принадлежит продукту`, ...article, ...byline], reason: 'независимая публикация: сторонний сайт, разметка статьи, указан издатель/автор' };
  }
  const missing = [article.length ? null : 'нет разметки статьи/обзора', byline.length ? null : 'не указан издатель или автор'].filter(Boolean).join(', ');
  return { sourceType: 'unknown', independence: 'unverified', signals: [...article, ...byline], reason: `модель считает источник независимым, но это не подтверждено (${missing}) — тип не установлен` };
}
