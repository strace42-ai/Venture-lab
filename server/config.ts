/**
 * Local-only configuration. Values come from the environment (never committed secrets).
 * The defaults match docker-compose.yml and are for a developer machine only.
 */
export const DEFAULT_DATABASE_URL = 'postgres://venture_lab:venture_lab_local@127.0.0.1:5433/venture_lab';

export interface ServerConfig {
  databaseUrl: string;
  host: string;
  port: number;
  allowedOrigins: string[];
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.API_HOST ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    // VL-002 has no auth: the API must never be reachable from the network.
    throw new Error(`API_HOST=${host} is not a loopback address. VL-002 API is local-only (no auth).`);
  }
  const port = Number(env.API_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid API_PORT: ${env.API_PORT}`);
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    host,
    port,
    allowedOrigins: (env.API_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Refuse destructive commands against anything but a local database. */
export function assertLocalDatabase(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!isLoopbackHost(host) && host !== 'db' && host !== 'postgres') {
    throw new Error(`Refusing destructive operation on non-local database host "${host}".`);
  }
}
