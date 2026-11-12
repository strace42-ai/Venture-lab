/**
 * Recorded transports for offline tests and the offline benchmark (VL-004B Phase A).
 *  - RecordedWeb: DNS + public pages. It enforces DNS pinning: a request must target the address the
 *    resolver returned for that host, or it fails loudly.
 *  - RecordedProviders: Yandex Search API and AI Studio endpoints, answering from recordings in the
 *    official response shapes. Hooks let tests inject 401/429/5xx, timeouts, invalid JSON, usage anomalies.
 * Nothing here opens a socket.
 */
import { DISCOVERY_OUTPUT, ANALYST, DNS, EXTRACT, PAGES, SEARCH, SKEPTIC, type PageRec } from './world';
import { TransportTimeout, type Resolver, type Transport, type TransportRequest, type TransportResponse } from '../net/transport';

const enc = (s: string) => Buffer.from(s, 'utf8');

export class RecordedWeb implements Transport, Resolver {
  readonly requests: TransportRequest[] = [];
  readonly dns: Record<string, string[] | (() => string[])>;
  readonly pages: Record<string, PageRec>;
  constructor(over: { dns?: Record<string, string[] | (() => string[])>; pages?: Record<string, PageRec> } = {}) {
    this.dns = { ...DNS, ...over.dns };
    this.pages = { ...PAGES, ...over.pages };
  }
  async resolve(host: string): Promise<string[]> {
    const a = this.dns[host];
    if (!a) throw new Error(`ENOTFOUND ${host}`);
    return typeof a === 'function' ? a() : a;
  }
  async request(req: TransportRequest): Promise<TransportResponse> {
    this.requests.push(req);
    const host = req.url.hostname;
    const answer = this.dns[host];
    const allowed = typeof answer === 'function' ? null : answer;
    if (!req.address) throw new Error(`RecordedWeb: unpinned request to ${host}`);
    if (allowed && !allowed.includes(req.address)) throw new Error(`RecordedWeb: ${host} pinned to ${req.address}, not a recorded address`);
    const key = `${req.url.origin}${req.url.pathname}${req.url.search}`;
    const rec = this.pages[key] ?? (req.url.pathname === '/robots.txt' ? { status: 404, body: '' } : { status: 404, body: 'Not found' });
    if (rec.status === -1) throw new TransportTimeout('recorded timeout');
    const body = enc(rec.body ?? '');
    const truncated = body.length > req.maxBytes;
    return { status: rec.status, headers: { 'content-type': rec.contentType ?? 'text/html; charset=utf-8', ...rec.headers }, body: truncated ? body.subarray(0, req.maxBytes) : body, truncated };
  }
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function searchXml(docs: { url: string; title: string; passage: string }[], reqid = 'rec-1'): string {
  if (docs.length === 0) return `<?xml version="1.0" encoding="utf-8"?><yandexsearch version="1.0"><response><reqid>${reqid}</reqid><error code="15">Sorry, there are no results for this search</error></response></yandexsearch>`;
  const groups = docs
    .map((d) => {
      const host = new URL(d.url).hostname;
      return `<group><categ attr="d" name="${host}"/><doccount>1</doccount><doc id="${host}"><url>${xmlEsc(d.url)}</url><domain>${host}</domain><title>${xmlEsc(d.title)}</title><headline>${xmlEsc(d.passage)}</headline><modtime>20261101T000000</modtime><passages><passage>${xmlEsc(d.passage).replace(/(\S+)/, '<hlword>$1</hlword>')}</passage></passages><mime-type>text/html</mime-type></doc></group>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><yandexsearch version="1.0"><request><query>q</query></request><response date="20261112T030000"><reqid>${reqid}</reqid><found priority="phrase">${docs.length}</found><found priority="strict">${docs.length}</found><found priority="all">${docs.length}</found><results><grouping attr="d" mode="deep" groups-on-page="10" docs-in-group="1" curcateg="-1"><found priority="all">${docs.length}</found><page first="1" last="${docs.length}">0</page>${groups}</grouping></results></response></yandexsearch>`;
}

export type Hook = { status?: number; content?: string; usage?: { prompt_tokens: number; completion_tokens: number } | null; timeout?: boolean; headers?: Record<string, string> } | undefined;

interface SkepticData {
  seed: { externalId: string };
  claims: { key: string; supportingKeys: string[] }[];
  sources: { key: string; url: string }[];
  rawCompetitors: { name: string; market: 'ru' | 'west'; sourceKey: string }[];
}

function skepticResponse(d: SkepticData) {
  const spec = SKEPTIC[d.seed.externalId];
  const key = (u: string) => d.sources.find((s) => s.url === u)?.key;
  const claimKeys = new Set(d.claims.map((c) => c.key));
  return {
    claimVerdicts: d.claims.map((c) => {
      const v = spec?.verdicts[c.key];
      if (!v) return { claimKey: c.key, verdict: 'needs_more_evidence', sourceKeys: [], reason: 'нет записи скептика для этого утверждения' };
      const keys = v.supporting ? c.supportingKeys : (v.urls ?? []).map(key).filter((k): k is string => !!k);
      return { claimKey: c.key, verdict: v.verdict, sourceKeys: keys, reason: v.reason };
    }),
    competitors: [
      ...d.rawCompetitors.map((r) => ({ name: r.name, market: r.market, kind: spec?.kinds[r.name] ?? 'substitute', sourceKey: r.sourceKey, reason: 'классификация из записи скептика' })),
      ...(spec?.phantoms ?? []).flatMap((p) => (key(p.url) ? [{ name: p.name, market: p.market, kind: 'direct', sourceKey: key(p.url)!, reason: 'выдуманный моделью конкурент' }] : [])),
    ],
    disputes: (spec?.disputes ?? []).filter((x) => !x.claimKey || claimKeys.has(x.claimKey)),
    summary: `Записанный ответ скептика для ${d.seed.externalId}.`,
  };
}

export class RecordedProviders implements Transport {
  readonly requests: { url: string; task: string | null; body: unknown; headers: Record<string, string> }[] = [];
  private n = 0;
  constructor(private readonly hooks: { search?: (q: { text: string; type: string; page: number }, n: number) => Hook; llm?: (task: string, data: Record<string, unknown>, n: number) => Hook } = {}) {}

  get llmCalls() {
    return this.requests.filter((r) => r.task !== null);
  }
  get searchCalls() {
    return this.requests.filter((r) => r.task === null);
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    const n = ++this.n;
    const body = JSON.parse(req.body ?? '{}');
    if (req.url.hostname === 'searchapi.api.cloud.yandex.net') {
      this.requests.push({ url: req.url.toString(), task: null, body, headers: req.headers });
      const q = { text: String(body.query?.queryText ?? ''), type: String(body.query?.searchType ?? ''), page: Number(body.query?.page ?? 0) };
      const h = this.hooks.search?.(q, n);
      if (h?.timeout) throw new TransportTimeout('recorded search timeout');
      if (h?.status && h.status !== 200) return { status: h.status, headers: { ...h.headers }, body: enc('{"error":"recorded"}'), truncated: false };
      const rule = q.page === 0 ? SEARCH.find((r) => r.type === q.type && r.match.test(q.text)) : undefined;
      const xml = searchXml(rule?.results ?? [], `rec-${n}`);
      return { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `search-${n}` }, body: enc(JSON.stringify({ rawData: Buffer.from(xml, 'utf8').toString('base64') })), truncated: false };
    }
    if (req.url.hostname === 'ai.api.cloud.yandex.net' || req.url.hostname === 'llm.api.cloud.yandex.net') {
      const system = String(body.messages?.[0]?.content ?? '');
      const task = /TASK: (\w+)/.exec(system)?.[1] ?? 'unknown';
      const data = JSON.parse(String(body.messages?.[1]?.content ?? '{}')).DATA ?? {};
      this.requests.push({ url: req.url.toString(), task, body, headers: req.headers });
      const h = this.hooks.llm?.(task, data, n);
      if (h?.timeout) throw new TransportTimeout('recorded llm timeout');
      if (h?.status && h.status !== 200) return { status: h.status, headers: { ...h.headers }, body: enc('{"error":{"message":"recorded"}}'), truncated: false };
      let content: string;
      if (h?.content !== undefined) content = h.content;
      else if (task === 'discover_seeds') content = JSON.stringify(DISCOVERY_OUTPUT);
      else if (task === 'analyse_candidate') {
        const a = ANALYST[(data.seed as { externalId: string }).externalId];
        content = typeof a === 'string' ? a : JSON.stringify(a ?? { claims: [], scores: {}, founderFit: null, ruQueries: [], rationale: 'нет записи' });
      } else if (task === 'extract_offer') content = JSON.stringify(EXTRACT[(data.page as { url: string }).url] ?? { isProductPage: false, name: null, market: 'unknown', jobs: [], price: null, pageKind: 'unknown' });
      else if (task === 'skeptic_challenge') content = JSON.stringify(skepticResponse(data as unknown as SkepticData));
      else content = '{}';
      const usage = h?.usage === undefined ? { prompt_tokens: Math.ceil(Buffer.byteLength(req.body ?? '') / 3), completion_tokens: Math.ceil(Buffer.byteLength(content) / 3) + 40 } : h.usage;
      const resp = { id: `chatcmpl-rec-${n}`, object: 'chat.completion', created: 1_794_000_000, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], ...(usage ? { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } } : {}) };
      return { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `llm-${n}`, ...h?.headers }, body: enc(JSON.stringify(resp)), truncated: false };
    }
    throw new Error(`RecordedProviders: unexpected host ${req.url.hostname}`);
  }
}

/** A complete, valid-looking live config for tests (fake credentials; never sent anywhere real). */
export const TEST_ENV: NodeJS.ProcessEnv = {
  VL_LIVE_PROVIDER: 'yandex',
  YANDEX_FOLDER_ID: 'b1gtestfolder000000',
  YANDEX_API_KEY: 'test-key-not-a-secret-000',
  VL_LIVE_MAX_NEW: '6',
  VL_HOST_INTERVAL_MS: '0',
};
