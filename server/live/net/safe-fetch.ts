/**
 * Secure page fetcher for the live reader (VL-004B). Every page the machine reads passes here:
 *
 *  - URL policy: http(s) only, ports 80/443, no credentials, no internal host names (addresses.ts);
 *  - DNS: ALL answers must be public; the connection is pinned to a validated address (no rebinding);
 *  - redirects are followed manually (≤ maxRedirects), each hop re-validated; https→http is refused;
 *  - robots.txt is honoured per origin (5xx/timeout = disallow, 4xx = allow, as RFC 9309);
 *  - hard caps on time, bytes (after decompression) and content type (HTML/XHTML/plain text only;
 *    PDFs and anything else are `unsupported_content`, never guessed);
 *  - per-host politeness delay.
 * Nothing on the page is executed. A failed read is a recorded status, never a generated substitute.
 */
import type { FetchStatus } from '../../machine/types';
import { blockedAddress, checkUrl } from './addresses';
import { parseRobots, robotsAllows, type RobotsRules } from './robots';
import { TransportTimeout, type Resolver, type Transport } from './transport';

export interface FetchPolicy {
  userAgent: string;
  /** Token matched against robots.txt user-agent lines. */
  robotsToken: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** Minimum delay between two requests to the same host. */
  hostIntervalMs: number;
  respectRobots: boolean;
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = {
  userAgent: 'VentureLabBot/0.1 (+automated market research; respects robots.txt)',
  robotsToken: 'venturelabbot',
  timeoutMs: 10_000,
  maxBytes: 2_000_000,
  maxRedirects: 3,
  hostIntervalMs: 1_000,
  respectRobots: true,
};

const TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);

export interface SafeFetchResult {
  status: Extract<FetchStatus, 'ok' | 'http_error' | 'blocked' | 'rate_limited' | 'robots_disallowed' | 'unsafe_url' | 'unsupported_content' | 'too_large' | 'timeout'>;
  httpStatus: number | null;
  requestedUrl: string;
  finalUrl: string;
  contentType: string | null;
  /** Decoded text body (only for status ok). */
  body: string | null;
  failure: string | null;
  fetchedAt: string;
  redirects: string[];
}

export interface SafeFetcherDeps {
  transport: Transport;
  resolver: Resolver;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Decode bytes with the declared charset (header, then <meta>), UTF-8 fallback; windows-1251 etc. supported. */
export function decodeBody(buf: Buffer, contentType: string | null): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder((charset ?? 'utf-8').toLowerCase(), { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export class SafeFetcher {
  private readonly robots = new Map<string, RobotsRules | 'unavailable'>();
  private readonly lastHit = new Map<string, number>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Every connection actually attempted (host → pinned address), for audits and tests. */
  readonly connections: { url: string; address: string }[] = [];

  constructor(private readonly deps: SafeFetcherDeps, readonly policy: FetchPolicy = DEFAULT_FETCH_POLICY) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private result(partial: Partial<SafeFetchResult> & Pick<SafeFetchResult, 'status' | 'requestedUrl'>): SafeFetchResult {
    return { httpStatus: null, finalUrl: partial.requestedUrl, contentType: null, body: null, failure: null, fetchedAt: this.now().toISOString(), redirects: [], ...partial };
  }

  /** Validate a URL and resolve it to a pinned public address. */
  private async pin(raw: string): Promise<{ url: URL; address: string } | { reason: string }> {
    const c = checkUrl(raw);
    if (!c.ok) return { reason: c.reason };
    const host = c.url.hostname.replace(/^\[|\]$/g, '');
    let addrs: string[];
    try {
      addrs = blockedAddress(host) === 'not-an-ip' ? await this.deps.resolver.resolve(host) : [host];
    } catch {
      return { reason: `DNS: хост ${host} не найден` };
    }
    if (addrs.length === 0) return { reason: `DNS: хост ${host} без адресов` };
    // Every answer must be public — a mixed answer is a rebinding attempt.
    const bad = addrs.map((a) => [a, blockedAddress(a)] as const).find(([, why]) => why);
    if (bad) return { reason: `хост ${host} указывает на непубличный адрес ${bad[0]} (${bad[1]})` };
    return { url: c.url, address: addrs[0]! };
  }

  private async polite(host: string) {
    const last = this.lastHit.get(host);
    const t = this.now().getTime();
    if (last !== undefined && t - last < this.policy.hostIntervalMs) await this.sleep(this.policy.hostIntervalMs - (t - last));
    this.lastHit.set(host, this.now().getTime());
  }

  private async raw(url: URL, address: string, accept: string) {
    await this.polite(url.hostname);
    this.connections.push({ url: url.toString(), address });
    return this.deps.transport.request({
      method: 'GET',
      url,
      address,
      headers: { 'user-agent': this.policy.userAgent, accept, 'accept-language': 'ru,en;q=0.8' },
      timeoutMs: this.policy.timeoutMs,
      maxBytes: this.policy.maxBytes,
    });
  }

  /** robots.txt for an origin: fetched once through the same safe path. */
  private async allowedByRobots(url: URL): Promise<{ ok: boolean; why?: string }> {
    if (!this.policy.respectRobots) return { ok: true };
    let rules = this.robots.get(url.origin);
    if (!rules) {
      rules = 'unavailable';
      const p = await this.pin(`${url.origin}/robots.txt`);
      if ('url' in p) {
        try {
          const r = await this.raw(p.url, p.address, 'text/plain');
          if (r.status >= 200 && r.status < 300) rules = parseRobots(decodeBody(r.body, r.headers['content-type'] ?? null), this.policy.robotsToken);
          else if (r.status >= 400 && r.status < 500) rules = { rules: [] }; // no robots.txt → allowed
          // 3xx/5xx → unavailable → disallow (conservative)
        } catch {
          rules = 'unavailable';
        }
      }
      this.robots.set(url.origin, rules);
    }
    if (rules === 'unavailable') return { ok: false, why: 'robots.txt недоступен (5xx/таймаут) — чтение запрещено' };
    return robotsAllows(rules, `${url.pathname}${url.search}`) ? { ok: true } : { ok: false, why: 'запрещено robots.txt' };
  }

  async fetch(requested: string): Promise<SafeFetchResult> {
    const redirects: string[] = [];
    let current = requested;
    for (let hop = 0; ; hop++) {
      const p = await this.pin(current);
      if ('reason' in p) return this.result({ status: 'unsafe_url', requestedUrl: requested, finalUrl: current, failure: p.reason, redirects });
      const robots = await this.allowedByRobots(p.url);
      if (!robots.ok) return this.result({ status: 'robots_disallowed', requestedUrl: requested, finalUrl: current, failure: robots.why ?? 'robots', redirects });
      let res;
      try {
        res = await this.raw(p.url, p.address, 'text/html,application/xhtml+xml,text/plain;q=0.8');
      } catch (e) {
        if (e instanceof TransportTimeout) return this.result({ status: 'timeout', requestedUrl: requested, finalUrl: current, failure: e.message, redirects });
        return this.result({ status: 'http_error', requestedUrl: requested, finalUrl: current, failure: `сеть: ${(e as Error).message}`, redirects });
      }
      const ct = res.headers['content-type'] ?? null;
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= this.policy.maxRedirects) return this.result({ status: 'http_error', httpStatus: res.status, requestedUrl: requested, finalUrl: current, failure: 'слишком много перенаправлений', redirects });
        let next: URL;
        try {
          next = new URL(res.headers.location, p.url);
        } catch {
          return this.result({ status: 'unsafe_url', httpStatus: res.status, requestedUrl: requested, finalUrl: current, failure: 'некорректное перенаправление', redirects });
        }
        if (p.url.protocol === 'https:' && next.protocol === 'http:') return this.result({ status: 'unsafe_url', httpStatus: res.status, requestedUrl: requested, finalUrl: current, failure: 'перенаправление https→http запрещено', redirects });
        redirects.push(next.toString());
        current = next.toString();
        continue;
      }
      const base = { httpStatus: res.status, requestedUrl: requested, finalUrl: current, contentType: ct, redirects };
      if (res.status === 429) return this.result({ ...base, status: 'rate_limited', failure: 'HTTP 429' });
      if (res.status === 401 || res.status === 403) return this.result({ ...base, status: 'blocked', failure: `HTTP ${res.status}` });
      if (res.status < 200 || res.status >= 300) return this.result({ ...base, status: 'http_error', failure: `HTTP ${res.status}` });
      if (res.truncated) return this.result({ ...base, status: 'too_large', failure: `ответ больше ${this.policy.maxBytes} байт` });
      const type = (ct ?? '').split(';')[0]!.trim().toLowerCase();
      if (!TEXT_TYPES.has(type)) return this.result({ ...base, status: 'unsupported_content', failure: type === 'application/pdf' ? 'PDF не разбирается в этой версии (неизвестно, не выдумывается)' : `тип ${type || 'не указан'} не поддерживается` });
      return this.result({ ...base, status: 'ok', body: decodeBody(res.body, ct) });
    }
  }
}
