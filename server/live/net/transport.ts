/**
 * HTTP transport abstraction (VL-004B). Every outbound byte of the live mode goes through a Transport:
 * production uses NodeTransport (pinned DNS, hard time/size caps); tests use recorded responses
 * (MockTransport) — tests never touch paid endpoints or the open web.
 */
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import zlib from 'node:zlib';

export interface TransportRequest {
  method: 'GET' | 'POST';
  url: URL;
  /** Pinned IP the connection MUST use (SSRF guard). null = ordinary DNS (fixed provider endpoints only). */
  address: string | null;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** The body exceeded maxBytes (after decompression) and was cut off. */
  truncated: boolean;
}

export class TransportTimeout extends Error {}
export class TransportError extends Error {}

export interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>;
}

export interface Resolver {
  /** All A/AAAA answers for a host. */
  resolve(host: string): Promise<string[]>;
}

export const systemResolver: Resolver = {
  async resolve(host) {
    const r = await lookup(host, { all: true, verbatim: true });
    return r.map((x) => x.address);
  },
};

/** A transport that refuses everything — used by dry runs: proves that no request leaves the process. */
export class NoNetworkTransport implements Transport {
  readonly attempted: string[] = [];
  async request(req: TransportRequest): Promise<TransportResponse> {
    this.attempted.push(`${req.method} ${req.url.origin}${req.url.pathname}`);
    throw new TransportError('сетевые запросы запрещены в этом режиме (dry-run / Phase A)');
  }
}

/**
 * Real transport over node:http(s). The socket connects to `address` (validated by the caller) while
 * TLS SNI and the Host header use the URL's hostname; bodies are capped AFTER decompression (zip
 * bombs), the whole exchange is bounded by `timeoutMs`. Never follows redirects itself.
 */
/**
 * Opens an already-TLS-verified stream to `host:port` (e.g. a CONNECT tunnel through HTTPS_PROXY). Only the
 * provider transport uses one (`provider-proxy.ts`); the web reader never does.
 */
export type TunnelConnect = (
  target: { host: string; port: number; timeoutMs: number },
  cb: (err: Error | null, socket?: Duplex) => void,
) => void;

export class NodeTransport implements Transport {
  /** `tunnel` absent → a direct connection (the only mode the web reader uses). */
  constructor(private readonly tunnel?: TunnelConnect) {}

  async request(req: TransportRequest): Promise<TransportResponse> {
    if (this.tunnel && (req.address || req.url.protocol !== 'https:')) {
      // A tunnel resolves the host on the proxy side, so it can never honour an SSRF-pinned address.
      throw new TransportError('туннель через прокси — только для https без закреплённого адреса');
    }
    const mod = req.url.protocol === 'https:' ? https : http;
    const host = req.url.hostname.replace(/^\[|\]$/g, '');
    return new Promise<TransportResponse>((resolve, reject) => {
      let settled = false;
      const done = (f: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          f();
        }
      };
      const opts: https.RequestOptions = {
        method: req.method,
        protocol: req.url.protocol,
        hostname: host,
        port: req.url.port || undefined,
        path: `${req.url.pathname}${req.url.search}`,
        headers: { 'accept-encoding': 'gzip, deflate, br', ...req.headers, ...(req.body ? { 'content-length': String(Buffer.byteLength(req.body)) } : {}) },
        servername: isIP(host) ? undefined : host,
        agent: false,
      };
      if (req.address) {
        const pinned = req.address;
        // Pin the connection to the validated address: no second DNS lookup can redirect it.
        opts.lookup = ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          const family = isIP(pinned);
          if (o?.all) cb(null, [{ address: pinned, family }]);
          else cb(null, pinned, family);
        }) as unknown as https.RequestOptions['lookup'];
      }
      if (this.tunnel) {
        const tunnel = this.tunnel;
        const port = Number(req.url.port || 443);
        // No agent: one tunnel per request, closed after the response (no pooled socket reuse).
        opts.agent = undefined;
        // Without an agent Node assumes port 80; keep the Host header exactly `host` for :443.
        opts.port = port;
        opts.defaultPort = 443;
        opts.createConnection = (_o, oncreate) => {
          tunnel({ host, port, timeoutMs: req.timeoutMs }, (err, socket) => {
            if (err || !socket) oncreate(err ?? new TransportError('туннель не создан'), undefined as unknown as Duplex);
            else oncreate(null, socket);
          });
          return undefined;
        };
      }
      const r = mod.request(opts, (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        const enc = (headers['content-encoding'] ?? '').trim().toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > req.maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - req.maxBytes)));
            res.destroy();
            done(() => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated: true }));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => done(() => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks), truncated })));
        stream.on('error', (e: Error) => done(() => reject(new TransportError(`ошибка чтения ответа: ${e.message}`))));
      });
      const timer = setTimeout(() => {
        r.destroy();
        done(() => reject(new TransportTimeout(`таймаут ${req.timeoutMs} мс`)));
      }, req.timeoutMs);
      // Tunnel errors arrive already typed (timeout vs failure); direct-mode socket errors are wrapped as before.
      r.on('error', (e) => done(() => reject(e instanceof TransportTimeout || e instanceof TransportError ? e : new TransportError(e.message))));
      if (req.body) r.write(req.body);
      r.end();
    });
  }
}
