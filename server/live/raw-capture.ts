/**
 * Raw provider responses of a paid run, saved LOCALLY for format verification (VL-004B-prep):
 *  - never inside the git working tree (refused) — only deliberately cleaned fixtures go into the repo;
 *  - directory 0700, files 0600;
 *  - secrets and sensitive data removed before anything touches the disk: the API key / IAM token
 *    (exact values and patterns), the folder id, `Authorization` values, e-mails and phone numbers.
 * Request headers are never written.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { Transport, TransportRequest, TransportResponse } from './net/transport';

export function redact(text: string, secrets: (string | null | undefined)[]): string {
  let s = text;
  for (const v of secrets) if (v && v.length >= 6) s = s.split(v).join('<redacted>');
  return s
    .replace(/(Api-Key|Bearer)\s+[A-Za-z0-9_\-.~+/=]+/g, '$1 <redacted>')
    .replace(/\bAQVN[A-Za-z0-9_-]{16,}/g, '<redacted-key>')
    .replace(/\bt1\.[A-Za-z0-9_\-.]{16,}/g, '<redacted-iam>')
    .replace(/\b(b1g|aje)[a-z0-9]{17}\b/g, '<redacted-id>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/(?:\+7|(?:^|[^\d])8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g, ' <phone>');
}

/** The git working tree containing `from` (walks up to a `.git`), or null. */
export function repoRootOf(from = process.cwd()): string | null {
  let d = resolve(from);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function defaultRawDir(trialId: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.VL_RAW_DIR ? resolve(env.VL_RAW_DIR) : join(homedir(), '.venture-lab', 'phase-b', trialId, 'raw');
}

/** Refuse any directory inside a git working tree (tracked or not). */
export function assertOutsideRepo(dir: string, repoRoot = repoRootOf()): void {
  if (!repoRoot) return;
  const rel = relative(repoRoot, resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error(`каталог сырых ответов ${dir} внутри репозитория ${repoRoot} — запрещено; укажите путь вне Git (VL_RAW_DIR)`);
}

export class CapturingTransport implements Transport {
  private seq = 0;
  readonly files: string[] = [];
  constructor(private readonly inner: Transport, private readonly dir: string, private readonly secrets: (string | null | undefined)[], repoRoot = repoRootOf()) {
    assertOutsideRepo(dir, repoRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    let res: TransportResponse | null = null;
    let error: string | null = null;
    try {
      res = await this.inner.request(req);
      return res;
    } catch (e) {
      error = (e as Error).message;
      throw e;
    } finally {
      const bodyText = res ? res.body.toString('utf8') : null;
      let decoded: string | null = null;
      try {
        const raw = bodyText ? (JSON.parse(bodyText) as { rawData?: string }).rawData : undefined;
        if (typeof raw === 'string') decoded = Buffer.from(raw, 'base64').toString('utf8');
      } catch {
        /* not JSON */
      }
      const rec = {
        at: new Date().toISOString(),
        method: req.method,
        endpoint: `${req.url.origin}${req.url.pathname}`,
        status: res?.status ?? null,
        providerRequestId: res?.headers['x-request-id'] ?? res?.headers['x-server-trace-id'] ?? null,
        error,
        requestBody: req.body ?? null,
        responseBody: bodyText,
        decodedRawData: decoded,
      };
      const name = `${String(++this.seq).padStart(4, '0')}-${req.url.hostname}-${res?.status ?? 'error'}.json`;
      const path = join(this.dir, name);
      writeFileSync(path, redact(JSON.stringify(rec, null, 2), this.secrets), { mode: 0o600 });
      this.files.push(path);
    }
  }
}
