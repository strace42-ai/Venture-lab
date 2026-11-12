import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only directory tree research files may be read from. */
export const RESEARCH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../research');
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export class FileAccessError extends Error {}

export interface ResearchFile {
  path: string;
  name: string;
  bytes: Buffer;
  checksum: string;
}

/**
 * Resolve a user-supplied path safely: must be a regular `.json` file (no symlink escape)
 * inside `research/` (e.g. research/inbox, research/examples), at most 5 MB.
 */
export function readResearchFile(input: string, root = RESEARCH_ROOT, cwd = process.cwd()): ResearchFile {
  if (!input || input.includes('\0')) throw new FileAccessError('Пустой или некорректный путь.');
  const abs = resolve(cwd, input);
  if (!abs.toLowerCase().endsWith('.json')) throw new FileAccessError('Допускаются только файлы .json.');
  let real: string;
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
    real = realpathSync(abs);
  } catch {
    throw new FileAccessError(`Файл не найден: ${input}`);
  }
  if (!real.startsWith(rootReal + sep)) {
    throw new FileAccessError(`Файл должен находиться внутри research/ (например research/inbox/). Получено: ${input}`);
  }
  const st = lstatSync(real);
  if (!st.isFile()) throw new FileAccessError('Путь не указывает на обычный файл.');
  if (st.size > MAX_FILE_BYTES) throw new FileAccessError(`Файл больше ${MAX_FILE_BYTES / 1024 / 1024} МБ.`);
  const bytes = readFileSync(real);
  return { path: real, name: basename(real), bytes, checksum: sha256(bytes) };
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable JSON (sorted keys) for content hashing. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function contentHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
