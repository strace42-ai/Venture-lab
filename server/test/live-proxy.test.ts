// @vitest-environment node
/**
 * VL-004B-proxy — paid provider calls go through HTTPS_PROXY (where the cloud environment substitutes the
 * network secret); the web reader never does. Fully offline: a local CONNECT proxy, local TLS servers and a
 * throw-away test CA generated with openssl. Connecting to the proxy is NOT proof that a real secret is
 * substituted — only the next authorised request can show that.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isProxiedProviderEndpoint, providerTransportFromEnv, proxyFromEnv, ProxyConfigError, ProviderTransport, type ProxySettings } from '../live/net/provider-proxy';
import { MinIntervalLimiter } from '../live/net/rate-limit';
import { NodeTransport, TransportError, TransportTimeout, type Transport, type TransportRequest, type TransportResponse } from '../live/net/transport';
import { ProviderCaller } from '../live/provider-http';
import { searchXml } from '../live/recordings/mock';
import { YandexSearchProvider } from '../live/yandex-search';
import { CallContext, ProviderAuthError } from '../machine/types';

const SEARCH = 'https://searchapi.api.cloud.yandex.net/v2/web/search';
const CHAT = 'https://ai.api.cloud.yandex.net/v1/chat/completions';
const DUMMY = 'Api-Key dummy-placeholder-not-a-secret';

let dir = '';
let ca = '';
const listen = async (s: Server): Promise<number> => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as { port: number }).port;
};
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

function issue(name: string, sans: string[]): { key: string; cert: string } {
  const key = join(dir, `${name}.key`);
  const csr = join(dir, `${name}.csr`);
  const crt = join(dir, `${name}.crt`);
  const ext = join(dir, `${name}.ext`);
  writeFileSync(ext, `subjectAltName=${sans.map((s) => `DNS:${s}`).join(',')}\n`);
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${name}`], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', crt, '-days', '2', '-extfile', ext], { stdio: 'ignore' });
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(crt, 'utf8') };
}

// ---- local "Yandex" TLS backends ----
interface Seen { method: string; path: string; host: string | undefined; authorization: string | undefined; body: string }
const seen: Seen[] = [];
let backendMode: 'ok' | 'auth401' | 'redirect' | 'big' = 'ok';
let yandexPort = 0;
let wrongNamePort = 0;
const servers: Server[] = [];

// ---- local CONNECT proxy ----
interface Connect { target: string; headers: IncomingHttpHeaders }
const connects: Connect[] = [];
let plainProxyRequests = 0;
let proxyPort = 0;
let refusingProxyPort = 0;
let silentProxyPort = 0;
const route: Record<string, () => number> = {};
const sockets = new Set<Socket>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vl-proxy-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.crt'), '-days', '2', '-subj', '/CN=vl-offline-test-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { stdio: 'ignore' });
  ca = readFileSync(join(dir, 'ca.crt'), 'utf8');
  const good = issue('yandex', ['searchapi.api.cloud.yandex.net', 'ai.api.cloud.yandex.net']);
  const wrong = issue('wrong', ['attacker.example']);

  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', host: req.headers.host, authorization: req.headers.authorization, body });
      if (backendMode === 'auth401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 16, message: 'Unknown api key' }));
      } else if (backendMode === 'redirect') {
        res.writeHead(302, { location: 'https://attacker.example/steal' });
        res.end();
      } else if (backendMode === 'big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(Buffer.alloc(50_000, 0x61));
      } else if (req.url === '/v2/web/search') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rawData: Buffer.from(searchXml([{ url: 'https://touchstay.com/', title: 'Touch Stay', passage: 'Digital guidebooks' }])).toString('base64') }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      }
    });
  };
  const yandex = createHttpsServer(good, handler);
  const wrongSrv = createHttpsServer(wrong, handler);
  servers.push(yandex, wrongSrv);
  yandexPort = await listen(yandex);
  wrongNamePort = await listen(wrongSrv);
  route['searchapi.api.cloud.yandex.net:443'] = () => yandexPort;
  route['ai.api.cloud.yandex.net:443'] = () => yandexPort;

  const proxy = createHttpServer((_req, res) => {
    plainProxyRequests++;
    res.writeHead(400);
    res.end();
  });
  proxy.on('connect', (req, client: Socket, head: Buffer) => {
    sockets.add(client);
    connects.push({ target: req.url ?? '', headers: req.headers });
    const port = route[req.url ?? '']?.();
    if (!port) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const up = netConnect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    sockets.add(up);
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  const refusing = createHttpServer();
  refusing.on('connect', (_req, client: Socket) => client.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  const silent = createHttpServer();
  silent.on('connect', (_req, client: Socket) => void sockets.add(client)); // never answers
  servers.push(proxy, refusing, silent);
  proxyPort = await listen(proxy);
  refusingProxyPort = await listen(refusing);
  silentProxyPort = await listen(silent);
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await Promise.all(servers.map(close));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  connects.length = 0;
  plainProxyRequests = 0;
  backendMode = 'ok';
  route['ai.api.cloud.yandex.net:443'] = () => yandexPort;
});

const proxy = (port = proxyPort): ProxySettings => ({ host: '127.0.0.1', port, auth: null });
class SpyTransport implements Transport {
  readonly calls: string[] = [];
  async request(req: TransportRequest): Promise<TransportResponse> {
    this.calls.push(req.url.href);
    return { status: 299, headers: {}, body: Buffer.from('direct'), truncated: false };
  }
}
const post = (url: string, over: Partial<TransportRequest> = {}): TransportRequest => ({
  method: 'POST',
  url: new URL(url),
  address: null,
  headers: { 'content-type': 'application/json', authorization: DUMMY },
  body: '{}',
  timeoutMs: 3000,
  maxBytes: 100_000,
  ...over,
});

describe('which requests may use the proxy', () => {
  it('only the two exact paid endpoints (https, port 443, exact host and path, no userinfo)', () => {
    expect(isProxiedProviderEndpoint(new URL(SEARCH))).toBe(true);
    expect(isProxiedProviderEndpoint(new URL(CHAT))).toBe(true);
    expect(isProxiedProviderEndpoint(new URL('https://searchapi.api.cloud.yandex.net:443/v2/web/search'))).toBe(true);
    for (const u of [
      'http://searchapi.api.cloud.yandex.net/v2/web/search',
      'https://searchapi.api.cloud.yandex.net:8443/v2/web/search',
      'https://searchapi.api.cloud.yandex.net/v2/web/searchAsync',
      'https://ai.api.cloud.yandex.net/v1/models',
      'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      'https://user:pw@ai.api.cloud.yandex.net/v1/chat/completions',
      'https://searchapi.api.cloud.yandex.net.attacker.example/v2/web/search',
      'https://touchstay.com/pricing',
    ]) expect(isProxiedProviderEndpoint(new URL(u)), u).toBe(false);
  });

  it('HTTPS_PROXY parsing: unset → direct; http:// accepted; anything else fails closed', () => {
    expect(proxyFromEnv({})).toBeNull();
    expect(proxyFromEnv({ HTTPS_PROXY: '  ' })).toBeNull();
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://127.0.0.1:39219' })).toEqual({ host: '127.0.0.1', port: 39219, auth: null });
    expect(proxyFromEnv({ https_proxy: 'http://proxy.local:3128' })).toMatchObject({ host: 'proxy.local', port: 3128 });
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://u:p%40ss@127.0.0.1:1' })!.auth).toBe('u:p@ss');
    expect(() => proxyFromEnv({ HTTPS_PROXY: 'https://127.0.0.1:1' })).toThrow(ProxyConfigError);
    expect(() => proxyFromEnv({ HTTPS_PROXY: 'socks5://127.0.0.1:1' })).toThrow(ProxyConfigError);
    expect(() => proxyFromEnv({ HTTPS_PROXY: 'not a url' })).toThrow(ProxyConfigError);
    expect(providerTransportFromEnv({}).proxy).toBeNull();
    expect(() => providerTransportFromEnv({ HTTPS_PROXY: 'ftp://x' })).toThrow(ProxyConfigError);
  });

  it('without HTTPS_PROXY every request keeps the direct transport', async () => {
    const direct = new SpyTransport();
    const t = new ProviderTransport(direct, null);
    await t.request(post(SEARCH));
    await t.request(post(CHAT));
    expect(direct.calls).toEqual([SEARCH, CHAT]);
    expect(connects).toHaveLength(0);
  });
});

describe('paid endpoints go through the CONNECT tunnel (TLS verified end to end)', () => {
  it('Search API: CONNECT searchapi…:443; Authorization travels only inside TLS to the target', async () => {
    const direct = new SpyTransport();
    const t = new ProviderTransport(direct, proxy(), { tlsCa: ca });
    const r = await t.request(post(SEARCH, { body: '{"q":1}' }));
    expect(r.status).toBe(200);
    expect(direct.calls).toEqual([]);
    expect(connects.map((c) => c.target)).toEqual(['searchapi.api.cloud.yandex.net:443']);
    expect(connects[0]!.headers.authorization).toBeUndefined();
    expect(connects[0]!.headers['proxy-authorization']).toBeUndefined();
    expect(plainProxyRequests).toBe(0);
    expect(seen).toEqual([{ method: 'POST', path: '/v2/web/search', host: 'searchapi.api.cloud.yandex.net', authorization: DUMMY, body: '{"q":1}' }]);
  });

  it('AI Studio: CONNECT ai…:443 with the chat path', async () => {
    const t = new ProviderTransport(new SpyTransport(), proxy(), { tlsCa: ca });
    const r = await t.request(post(CHAT));
    expect(JSON.parse(r.body.toString())).toEqual({ ok: true, path: '/v1/chat/completions' });
    expect(connects.map((c) => c.target)).toEqual(['ai.api.cloud.yandex.net:443']);
  });

  it('proxy credentials from the URL are sent only as Proxy-Authorization on CONNECT', async () => {
    const t = new ProviderTransport(new SpyTransport(), { host: '127.0.0.1', port: proxyPort, auth: 'u:p' }, { tlsCa: ca });
    await t.request(post(SEARCH));
    expect(connects[0]!.headers['proxy-authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(connects[0]!.headers.authorization).toBeUndefined();
  });

  it('other provider paths and pinned (web) requests never use the tunnel', async () => {
    const direct = new SpyTransport();
    const t = new ProviderTransport(direct, proxy(), { tlsCa: ca });
    await t.request(post('https://ai.api.cloud.yandex.net/v1/models'));
    await t.request(post('https://llm.api.cloud.yandex.net/foundationModels/v1/completion'));
    await t.request(post('https://touchstay.com/pricing', { method: 'GET', address: '93.184.216.34' }));
    await t.request(post(SEARCH, { address: '93.184.216.34' }));
    expect(direct.calls).toHaveLength(4);
    expect(connects).toHaveLength(0);
  });

  it('the full Search adapter (limiter + cost ledger) works unchanged over the tunnel', async () => {
    const limiter = new MinIntervalLimiter(0);
    const caller = new ProviderCaller({ transport: new ProviderTransport(new SpyTransport(), proxy(), { tlsCa: ca }), sleep: async () => {}, limiter });
    const p = new YandexSearchProvider(caller, { url: SEARCH, folderId: 'b1gtestfolder000000', authHeader: () => DUMMY, pages: 1, groupsOnPage: 10 });
    const ctx = new CallContext('t', 1, 1_000_000);
    const hits = await p.search('цифровой гид гостя', 'ru', ctx);
    expect(hits.map((h) => h.url)).toEqual(['https://touchstay.com/']);
    expect(limiter.granted).toHaveLength(1);
    expect(ctx.usage).toHaveLength(1);
    expect(ctx.usage[0]!.cost).toBe(49);
    expect(connects).toHaveLength(1);
  });

  it('401 through the tunnel: not retried, not billed (same rules as direct)', async () => {
    backendMode = 'auth401';
    const caller = new ProviderCaller({ transport: new ProviderTransport(new SpyTransport(), proxy(), { tlsCa: ca }), sleep: async () => {} });
    const p = new YandexSearchProvider(caller, { url: SEARCH, folderId: 'f', authHeader: () => DUMMY, pages: 1, groupsOnPage: 10 });
    const ctx = new CallContext('t', 1, 1_000_000);
    await expect(p.search('x', 'ru', ctx)).rejects.toBeInstanceOf(ProviderAuthError);
    expect(seen).toHaveLength(1);
    expect(ctx.usage[0]!.cost).toBe(0);
  });
});

describe('the tunnel never weakens TLS, redirects, caps or fail-closed behaviour', () => {
  it('an untrusted certificate is refused (default trust store; no way to disable verification)', async () => {
    const direct = new SpyTransport();
    const t = new ProviderTransport(direct, proxy()); // no test CA → Node's own trust store
    await expect(t.request(post(SEARCH))).rejects.toBeInstanceOf(TransportError);
    expect(seen).toHaveLength(0);
    expect(direct.calls).toEqual([]); // no fallback to a direct connection
  });

  it('a certificate for another host name is refused even when signed by a trusted CA', async () => {
    route['ai.api.cloud.yandex.net:443'] = () => wrongNamePort;
    const t = new ProviderTransport(new SpyTransport(), proxy(), { tlsCa: ca });
    await expect(t.request(post(CHAT))).rejects.toThrow(/TLS через прокси/);
    expect(seen).toHaveLength(0);
  });

  it('a redirect is returned, never followed (Authorization cannot move to another host)', async () => {
    backendMode = 'redirect';
    const t = new ProviderTransport(new SpyTransport(), proxy(), { tlsCa: ca });
    const r = await t.request(post(SEARCH));
    expect(r.status).toBe(302);
    expect(connects.map((c) => c.target)).toEqual(['searchapi.api.cloud.yandex.net:443']);
    expect(seen).toHaveLength(1);
  });

  it('response size cap and timeout still apply', async () => {
    backendMode = 'big';
    const t = new ProviderTransport(new SpyTransport(), proxy(), { tlsCa: ca });
    const r = await t.request(post(SEARCH, { maxBytes: 1000 }));
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBeLessThanOrEqual(1000);
    const silent = new ProviderTransport(new SpyTransport(), proxy(silentProxyPort), { tlsCa: ca });
    const t0 = Date.now();
    await expect(silent.request(post(SEARCH, { timeoutMs: 300 }))).rejects.toBeInstanceOf(TransportTimeout);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a proxy that refuses CONNECT is an error — no silent direct fallback', async () => {
    const direct = new SpyTransport();
    const t = new ProviderTransport(direct, proxy(refusingProxyPort), { tlsCa: ca });
    await expect(t.request(post(SEARCH))).rejects.toThrow(/прокси отклонил CONNECT/);
    expect(direct.calls).toEqual([]);
  });

  it('a tunnelled NodeTransport refuses pinned or plain-http requests', async () => {
    const t = new NodeTransport(() => {
      throw new Error('must not be called');
    });
    await expect(t.request(post(SEARCH, { address: '1.2.3.4' }))).rejects.toBeInstanceOf(TransportError);
    await expect(t.request(post('http://searchapi.api.cloud.yandex.net/v2/web/search'))).rejects.toBeInstanceOf(TransportError);
  });
});

describe('the web reader stays direct (SSRF guard, DNS pinning untouched)', () => {
  let web: Server;
  let webPort = 0;
  beforeAll(async () => {
    web = createHttpServer((req, res) => res.end(`host=${req.headers.host}`));
    webPort = await listen(web);
  });
  afterAll(() => close(web));

  it('NodeTransport (the SafeFetcher transport) ignores HTTPS_PROXY and connects to the pinned address', async () => {
    const before = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    try {
      const r = await new NodeTransport().request({ method: 'GET', url: new URL(`http://shop.example:${webPort}/`), address: '127.0.0.1', headers: {}, timeoutMs: 2000, maxBytes: 1000 });
      expect(r.body.toString()).toBe(`host=shop.example:${webPort}`);
      expect(connects).toHaveLength(0);
      expect(plainProxyRequests).toBe(0);
    } finally {
      if (before === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = before;
    }
  });

  it('wiring: only the provider transport is proxied; the web reader gets a plain NodeTransport', () => {
    const worker = readFileSync(join(__dirname, '../cli/worker.ts'), 'utf8');
    expect(worker).toMatch(/new CapturingTransport\(providerTransport,/);
    expect(worker).toMatch(/webTransport: new NodeTransport\(\)/);
    for (const f of ['safe-fetch.ts', 'robots.ts', 'addresses.ts']) expect(readFileSync(join(__dirname, '../live/net', f), 'utf8')).not.toMatch(/provider-proxy|HTTPS_PROXY/);
  });
});
