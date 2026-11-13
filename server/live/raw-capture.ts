/**
 * Raw provider responses of a paid run, saved LOCALLY for format verification (VL-004B-prep):
 *  - never inside the git working tree (refused) — only deliberately cleaned fixtures go into the repo;
 *  - directory 0700, files 0600;
 *  - secrets and sensitive data removed before anything touches the disk: the API key / IAM token
 *    (exact values and patterns), the folder id, `Authorization` values, e-mails and phone numbers.
 * Request headers are never written.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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

/** Real path of `p`, resolving symlinks of the longest existing prefix (the rest may not exist yet). */
export function realPathOf(p: string): string {
  const abs = resolve(p);
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  return join(existsSync(head) ? realpathSync(head) : head, ...tail);
}

/** Refuse any directory that is — or REALLY points — inside a git working tree (tracked or not, symlinks resolved). */
export function assertOutsideRepo(dir: string, repoRoot = repoRootOf()): void {
  if (!repoRoot) return;
  const root = realPathOf(repoRoot);
  for (const candidate of new Set([resolve(dir), realPathOf(dir)])) {
    const rel = relative(root, candidate);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error(`каталог сырых ответов ${dir} (фактически ${candidate}) внутри репозитория ${root} — запрещено; укажите путь вне Git (VL_RAW_DIR)`);
  }
}

/** Parse our ledger id `trial:<id>:<stage>#<attempt>#<seq>` (sent as x-client-request-id). */
export function parseLedgerId(id: string | undefined): { jobKey: string; attempt: number; seq: number } | null {
  const m = /^([a-z0-9][a-z0-9:._-]{2,119})#(\d{1,4})#(\d{1,7})$/.exec(id ?? '');
  return m ? { jobKey: m[1]!, attempt: Number(m[2]), seq: Number(m[3]) } : null;
}

/**
 * Every record is stored ONCE, at a path derived from the request's ledger id:
 *   <dir>/<job key: trial_<id>_<stage>>/attempt-<n>/<seq>-<host>-<status>.json
 * so a record maps unambiguously to its usage row (mr_usage.request_id), trial, stage and attempt, and
 * stages / attempts / processes never share a file name. Files are created with O_EXCL ('wx'): an existing
 * file is NEVER overwritten (a clash is kept as a separate «-clash-<random>» file and reported).
 */
export class CapturingTransport implements Transport {
  readonly files: string[] = [];
  readonly clashes: string[] = [];
  private readonly dir: string;
  constructor(private readonly inner: Transport, dir: string, private readonly secrets: (string | null | undefined)[], repoRoot = repoRootOf()) {
    assertOutsideRepo(dir, repoRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertOutsideRepo(dir, repoRoot); // re-check the REAL path once it exists (symlinks)
    this.dir = realpathSync(dir);
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
      this.write(req, res, error);
    }
  }

  private write(req: TransportRequest, res: TransportResponse | null, error: string | null) {
    const ledgerId = req.headers['x-client-request-id'];
    const led = parseLedgerId(ledgerId);
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
      ledgerId: ledgerId ?? null,
      jobKey: led?.jobKey ?? null,
      attempt: led?.attempt ?? null,
      seq: led?.seq ?? null,
      method: req.method,
      endpoint: `${req.url.origin}${req.url.pathname}`,
      status: res?.status ?? null,
      providerRequestId: res?.headers['x-request-id'] ?? res?.headers['x-server-trace-id'] ?? null,
      error,
      requestBody: req.body ?? null,
      responseBody: bodyText,
      decodedRawData: decoded,
    };
    const sub = led ? join(led.jobKey.replace(/[^a-z0-9._-]/gi, '_'), `attempt-${led.attempt}`) : 'unlabeled';
    const folder = join(this.dir, sub);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stem = led ? `${String(led.seq).padStart(5, '0')}-${req.url.hostname}-${res?.status ?? 'error'}` : `${Date.now()}-${req.url.hostname}-${res?.status ?? 'error'}-${randomBytes(4).toString('hex')}`;
    const text = redact(JSON.stringify(rec, null, 2), this.secrets);
    let path = join(folder, `${stem}.json`);
    try {
      writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      path = join(folder, `${stem}-clash-${randomBytes(4).toString('hex')}.json`);
      writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
      this.clashes.push(path);
    }
    this.files.push(path);
  }
}
