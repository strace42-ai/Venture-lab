/**
 * SSRF guard (VL-004B): which URLs and IP addresses the live reader may ever connect to.
 *
 * Only public unicast addresses on ports 80/443 over http(s). Everything else — loopback, private
 * (RFC 1918 / ULA), link-local (incl. the 169.254.169.254 cloud metadata service), CGNAT, multicast,
 * reserved, documentation ranges, IPv4-mapped/compatible/NAT64/6to4 forms of those — is refused.
 * The address that passes this check is the one the transport connects to (DNS pinning), so a second
 * DNS answer (rebinding) can never redirect the connection.
 */
import { isIP } from 'node:net';

const V4_BLOCKED: [string, number, string][] = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local/metadata'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-protocol'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4-relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
  ['255.255.255.255', 32, 'broadcast'],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

function v4Blocked(ip: string): string | null {
  const n = v4ToInt(ip);
  for (const [base, bits, why] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) === (v4ToInt(base) & mask)) return why;
  }
  return null;
}

/** Expand an IPv6 address to 8 hextets (handles `::` and a trailing dotted IPv4). */
function v6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    s = s.slice(0, -dotted[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  if (s.includes('::') ? h.length + t.length > 7 : h.length !== 8) return null;
  const parts = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
  return parts.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff) ? null : parts;
}

function v6Blocked(ip: string): string | null {
  const x = v6Hextets(ip);
  if (!x) return 'unparseable';
  const embedded4 = () => `${x[6]! >> 8}.${x[6]! & 255}.${x[7]! >> 8}.${x[7]! & 255}`;
  if (x.every((v) => v === 0)) return 'unspecified';
  if (x.slice(0, 7).every((v) => v === 0) && x[7] === 1) return 'loopback';
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d → judge the embedded IPv4
  if (x.slice(0, 5).every((v) => v === 0) && (x[5] === 0xffff || x[5] === 0)) return v4Blocked(embedded4()) ?? (x[5] === 0 ? 'ipv4-compatible' : null);
  if (x[0] === 0x64 && x[1] === 0xff9b) return v4Blocked(embedded4()) ? 'nat64-to-blocked' : 'nat64'; // 64:ff9b::/96
  if (x[0] === 0x2002) return 'six-to-four';
  if ((x[0]! & 0xfe00) === 0xfc00) return 'unique-local';
  if ((x[0]! & 0xffc0) === 0xfe80) return 'link-local';
  if ((x[0]! & 0xffc0) === 0xfec0) return 'site-local';
  if ((x[0]! & 0xff00) === 0xff00) return 'multicast';
  if (x[0] === 0x2001 && x[1] === 0x0db8) return 'documentation';
  if (x[0] === 0x2001 && x[1]! < 0x200) return 'ietf-special'; // Teredo, benchmarking, ORCHID…
  if (x[0] === 0x0100 && x.slice(1, 4).every((v) => v === 0)) return 'discard';
  // Only global unicast (2000::/3) is allowed
  if ((x[0]! & 0xe000) !== 0x2000) return 'not-global-unicast';
  return null;
}

/** Why an IP may not be contacted, or null if it is a public unicast address. */
export function blockedAddress(ip: string): string | null {
  const v = isIP(ip);
  if (v === 4) return v4Blocked(ip);
  if (v === 6) return v6Blocked(ip);
  return 'not-an-ip';
}

export const ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.private', '.arpa'];

/** Static URL checks (before DNS). Returns the parsed URL or a refusal reason. */
export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'некорректный URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: `протокол ${url.protocol} запрещён` };
  if (url.username || url.password) return { ok: false, reason: 'учётные данные в URL запрещены' };
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) return { ok: false, reason: `порт ${port} запрещён` };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, reason: 'пустой хост' };
  if (isIP(host)) {
    const why = blockedAddress(host);
    if (why) return { ok: false, reason: `адрес ${host} запрещён (${why})` };
  } else {
    if (host === 'localhost' || !host.includes('.') || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: `хост ${host} не публичный` };
    // Numeric-looking hosts that WHATWG would not normalise (e.g. 0x7f.1) are refused outright.
    if (/^[\d.x]+$/i.test(host)) return { ok: false, reason: `числовой хост ${host} запрещён` };
  }
  if (raw.length > 2048) return { ok: false, reason: 'слишком длинный URL' };
  url.hash = '';
  return { ok: true, url };
}
