/**
 * Yandex Search API v2 adapter (VL-004B) — official REST `POST /v2/web/search` (synchronous).
 * Docs: https://aistudio.yandex.ru/ru/docs/search-api/concepts/web-search and
 *       https://aistudio.yandex.ru/ru/docs/search-api/api-ref/WebSearch/search
 *
 *  - region `ru` → SEARCH_TYPE_RU (+ region 225 = Russia, LOCALIZATION_RU); `west`/`world` → SEARCH_TYPE_COM (LOCALIZATION_EN);
 *  - response `{ rawData: base64(XML) }`; the XML is parsed tolerantly (fields may be absent), error
 *    code 15 («no results») is an empty result, other error codes are provider errors;
 *  - pagination (bounded), URL canonicalisation and de-duplication;
 *  - each page is one billable request: reserved at the daytime tariff, reconciled as `tariff`
 *    (or `not_billed` for 5xx/auth errors, as documented).
 * Results are LEADS: a URL from search proves nothing until the page itself is fetched and checked.
 */
import { z } from 'zod';
import { decodeEntities } from './html';
import { searchCostKop, YANDEX_PRICE_VERSION } from './prices';
import type { ProviderCaller } from './provider-http';
import { ProviderUnavailable, type CallContext, type Region, type SearchHit, type SearchProvider } from '../machine/types';

export interface YandexSearchOptions {
  url: string;
  folderId: string;
  authHeader: () => string | null;
  pages: number;
  groupsOnPage: number;
  timeoutMs?: number;
}

export interface ParsedSearch {
  reqid: string | null;
  found: number | null;
  docs: { url: string; domain: string | null; title: string; passages: string[] }[];
  error: { code: string; message: string } | null;
}

const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const tag = (block: string, name: string) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)?.[1] ?? null;

/** Tolerant parser of the Yandex XML search response (no external XML dependency, no entity expansion). */
export function parseYandexXml(xml: string): ParsedSearch {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return { reqid: null, found: null, docs: [], error: { code: 'xml', message: 'DOCTYPE/ENTITY в ответе отклонены' } };
  const err = /<error\b[^>]*code="([^"]*)"[^>]*>([\s\S]*?)<\/error>/i.exec(xml);
  const reqid = tag(xml, 'reqid');
  const foundAll = /<found\b[^>]*priority="all"[^>]*>(\d+)<\/found>/i.exec(xml)?.[1];
  const docs: ParsedSearch['docs'] = [];
  for (const m of xml.matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/gi)) {
    const d = m[1]!;
    const url = tag(d, 'url');
    if (!url) continue;
    const passages = [...(tag(d, 'passages') ?? '').matchAll(/<passage\b[^>]*>([\s\S]*?)<\/passage>/gi)].map((p) => strip(p[1]!)).filter(Boolean);
    const headline = tag(d, 'headline');
    docs.push({ url: decodeEntities(url.trim()), domain: tag(d, 'domain')?.trim() ?? null, title: strip(tag(d, 'title') ?? ''), passages: passages.length ? passages : headline ? [strip(headline)] : [] });
  }
  return { reqid: reqid ? reqid.trim() : null, found: foundAll ? Number(foundAll) : null, docs, error: err ? { code: err[1]!, message: strip(err[2]!) } : null };
}

const TRACKING = /^(utm_[a-z]+|gclid|yclid|fbclid|_openstat|from|ref|ysclid)$/i;

/** Canonical form for de-duplication: lower-case host, no fragment, no tracking parameters, no default port (path kept as is). */
export function canonicalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

const responseSchema = z.object({ rawData: z.string().max(20_000_000) });

export class YandexSearchProvider implements SearchProvider {
  readonly name = 'yandex-search-api';

  constructor(private readonly caller: ProviderCaller, private readonly o: YandexSearchOptions) {}

  async search(query: string, region: Region | 'world', ctx: CallContext): Promise<SearchHit[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!q) return [];
    const ru = region === 'ru';
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (let page = 0; page < this.o.pages; page++) {
      const body = {
        query: { searchType: ru ? 'SEARCH_TYPE_RU' : 'SEARCH_TYPE_COM', queryText: q, familyMode: 'FAMILY_MODE_MODERATE', page: String(page), fixTypoMode: 'FIX_TYPO_MODE_OFF' },
        sortSpec: { sortMode: 'SORT_MODE_BY_RELEVANCE', sortOrder: 'SORT_ORDER_DESC' },
        groupSpec: { groupMode: 'GROUP_MODE_DEEP', groupsOnPage: String(this.o.groupsOnPage), docsInGroup: '1' },
        maxPassages: '2',
        ...(ru ? { region: '225' } : {}),
        l10n: ru ? 'LOCALIZATION_RU' : 'LOCALIZATION_EN',
        folderId: this.o.folderId,
        responseFormat: 'FORMAT_XML',
      };
      const res = await this.caller.call(ctx, {
        provider: this.name,
        operation: 'search',
        model: null,
        priceVersion: YANDEX_PRICE_VERSION,
        estimateKop: searchCostKop(),
        build: (ledgerId) => ({
          method: 'POST',
          url: new URL(this.o.url),
          address: null,
          headers: { 'content-type': 'application/json', authorization: this.o.authHeader() ?? '', 'x-client-request-id': ledgerId },
          body: JSON.stringify(body),
          timeoutMs: this.o.timeoutMs ?? 15_000,
          maxBytes: 5_000_000,
        }),
        settle: (r) => ({ outcome: 'tariff', actualCost: searchCostKop(), providerRequestId: r.headers['x-request-id'] ?? r.headers['x-server-trace-id'] ?? null }),
        notBilled: (s) => s >= 500 || s === 401 || s === 403,
      });
      let parsed: ParsedSearch;
      try {
        const json = responseSchema.parse(JSON.parse(res.body.toString('utf8')));
        parsed = parseYandexXml(Buffer.from(json.rawData, 'base64').toString('utf8'));
      } catch {
        throw new ProviderUnavailable(`${this.name}: ответ не разобран (не JSON с rawData)`);
      }
      if (parsed.error && parsed.error.code !== '15') throw new ProviderUnavailable(`${this.name}: ошибка поиска ${parsed.error.code}: ${parsed.error.message.slice(0, 200)}`);
      for (const d of parsed.docs) {
        const c = canonicalUrl(d.url);
        if (!c || seen.has(c)) continue;
        seen.add(c);
        hits.push({ url: c, title: d.title, domain: d.domain ?? new URL(c).hostname, snippet: d.passages.join(' … ').slice(0, 600) });
      }
      if (parsed.docs.length < this.o.groupsOnPage) break; // last page
    }
    return hits;
  }
}
