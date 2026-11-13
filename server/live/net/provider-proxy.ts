/**
 * Provider transport for Phase B (VL-004B-proxy).
 *
 * In a Claude Code cloud environment the API key is a *network secret*: the app sends a dummy
 * `Authorization: Api-Key <placeholder>` and the agent proxy named in HTTPS_PROXY replaces it. The proxy only
 * sees requests that are sent THROUGH it (a CONNECT tunnel). The first probe connected directly, so the
 * placeholder reached Yandex (HTTP 401).
 *
 * Rules enforced here:
 *  - only the two exact paid endpoints (host + path, https, port 443) go through the tunnel;
 *    anything else is sent directly, exactly as before;
 *  - the web reader (SafeFetcher) never uses this transport: it keeps its SSRF guard, DNS pinning, public-IP
 *    check and robots.txt untouched;
 *  - TLS to the target is verified normally (Node's trust store); there is no switch to disable it;
 *  - the CONNECT request carries only `Host` (and `Proxy-Authorization` if the proxy URL has credentials) —
 *    the provider's Authorization header travels only inside TLS;
 *  - redirects are never followed (NodeTransport never follows them), so Authorization cannot move to
 *    another host;
 *  - HTTPS_PROXY set but unusable → configuration error (fail closed), never a silent direct connection;
 *  - no HTTPS_PROXY → the original direct, TLS-verified connection.
 * NO_PROXY is deliberately not consulted for these two endpoints: they need the proxy for the secret.
 */
import http from 'node:http';
import tls from 'node:tls';
import { NodeTransport, TransportError, TransportTimeout, type Transport, type TransportRequest, type TransportResponse, type TunnelConnect } from './transport';

/** The only endpoints that may use HTTPS_PROXY (exact host + path). */
export const PROXIED_PROVIDER_ENDPOINTS: ReadonlyArray<{ host: string; path: string }> = [
  { host: 'searchapi.api.cloud.yandex.net', path: '/v2/web/search' },
  { host: 'ai.api.cloud.yandex.net', path: '/v1/chat/completions' },
];

export class ProxyConfigError extends Error {}

export interface ProxySettings {
  host: string;
  port: number;
  /** `user:pass` from the proxy URL, if any (never logged). */
  auth: string | null;
}

/** Is this URL one of the two paid endpoints that may go through the proxy? */
export function isProxiedProviderEndpoint(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    (url.port === '' || url.port === '443') &&
    url.username === '' &&
    url.password === '' &&
    PROXIED_PROVIDER_ENDPOINTS.some((e) => e.host === url.hostname && e.path === url.pathname)
  );
}

/** HTTPS_PROXY (or https_proxy) → settings; null when unset. Only an http:// proxy URL is accepted. */
export function proxyFromEnv(env: NodeJS.ProcessEnv): ProxySettings | null {
  const raw = (env.HTTPS_PROXY ?? env.https_proxy ?? '').trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProxyConfigError('HTTPS_PROXY задан, но не является URL — платные запросы не отправляются');
  }
  if (u.protocol !== 'http:') throw new ProxyConfigError(`HTTPS_PROXY: поддерживается только http://-прокси (получено ${u.protocol}) — платные запросы не отправляются`);
  if (!u.hostname) throw new ProxyConfigError('HTTPS_PROXY: не указан хост прокси');
  const port = Number(u.port || 80);
  const auth = u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null;
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port, auth };
}

/** Human-readable route for diagnostics (no credentials). */
export function describeProviderRoute(proxy: ProxySettings | null): string {
  return proxy
    ? `через HTTPS_PROXY ${proxy.host}:${proxy.port} (CONNECT; секрет подставляет прокси): ${PROXIED_PROVIDER_ENDPOINTS.map((e) => e.host + e.path).join(', ')}`
    : 'напрямую (HTTPS_PROXY не задан): TLS-проверка, ключ из окружения';
}

/**
 * CONNECT tunnel through an http:// proxy, then TLS to the target with certificate + hostname verification.
 * `tlsCa` exists only for offline tests (a local test CA); production uses Node's default trust store.
 */
export function connectTunnel(proxy: ProxySettings, opts: { tlsCa?: string | Buffer } = {}): TunnelConnect {
  return (target, cb) => {
    let finished = false;
    const finish = (err: Error | null, socket?: import('node:stream').Duplex) => {
      if (finished) {
        socket?.destroy();
        return;
      }
      finished = true;
      clearTimeout(timer);
      cb(err, socket);
    };
    const authority = `${target.host}:${target.port}`;
    const headers: Record<string, string> = { host: authority };
    if (proxy.auth) headers['proxy-authorization'] = `Basic ${Buffer.from(proxy.auth).toString('base64')}`;
    const creq = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: authority, headers, agent: false });
    const timer = setTimeout(() => {
      creq.destroy();
      finish(new TransportTimeout(`таймаут подключения через прокси (${target.timeoutMs} мс)`));
    }, target.timeoutMs);
    creq.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish(new TransportError(`прокси отклонил CONNECT ${authority}: HTTP ${res.statusCode}`));
        return;
      }
      if (head && head.length) socket.unshift(head);
      const t = tls.connect({ socket, servername: target.host, ALPNProtocols: ['http/1.1'], ...(opts.tlsCa ? { ca: opts.tlsCa } : {}) });
      t.once('secureConnect', () => finish(null, t));
      t.once('error', (e) => {
        t.destroy();
        finish(new TransportError(`TLS через прокси к ${target.host}: ${e.message}`));
      });
    });
    creq.on('error', (e) => finish(new TransportError(`прокси ${proxy.host}:${proxy.port} недоступен: ${e.message}`)));
    creq.end();
  };
}

/**
 * The transport for paid provider calls: the two exact endpoints go through the proxy tunnel when HTTPS_PROXY
 * is set; everything else (and everything when no proxy is set) uses the direct transport unchanged.
 */
export class ProviderTransport implements Transport {
  private readonly tunneled: Transport | null;
  constructor(
    private readonly direct: Transport,
    readonly proxy: ProxySettings | null,
    opts: { tlsCa?: string | Buffer; tunneled?: Transport } = {},
  ) {
    this.tunneled = proxy ? (opts.tunneled ?? new NodeTransport(connectTunnel(proxy, { tlsCa: opts.tlsCa }))) : null;
  }

  request(req: TransportRequest): Promise<TransportResponse> {
    if (this.tunneled && req.address === null && isProxiedProviderEndpoint(req.url)) return this.tunneled.request(req);
    return this.direct.request(req);
  }
}

/** Production wiring: proxy from the environment (fail closed on a malformed value). */
export function providerTransportFromEnv(env: NodeJS.ProcessEnv): ProviderTransport {
  return new ProviderTransport(new NodeTransport(), proxyFromEnv(env));
}
