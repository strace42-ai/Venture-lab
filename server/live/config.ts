/**
 * Live-provider configuration (VL-004B). Read from the environment only — never from files in git.
 * Disabled by default: without VL_LIVE_PROVIDER=yandex and credentials nothing can be called.
 * Secrets (API key / IAM token) are kept out of every printable form of the config.
 */
import { z } from 'zod';

/** Officially deprecated model ids (AI Studio «Модели», checked 2026-11-12): refused. */
export const DEPRECATED_MODELS: Record<string, string> = {
  'deepseek-v4-flash': 'объявлена устаревшей, отключение 2026-11-15 — используйте deepseek-v4.1-flash',
  'yandexgpt-5-lite': 'объявлена устаревшей, отключение 2026-11-15',
};

export const DEFAULT_ANALYST_MODEL = 'qwen3.6-35b-a3b';
export const DEFAULT_SKEPTIC_MODEL = 'deepseek-v4.1-flash';
export const YANDEX_SEARCH_URL = 'https://searchapi.api.cloud.yandex.net/v2/web/search';
export const YANDEX_LLM_URL = 'https://ai.api.cloud.yandex.net/v1/chat/completions';
/** Provider hosts the live mode may call with credentials. Anything else is refused. */
export const PROVIDER_HOSTS = new Set(['searchapi.api.cloud.yandex.net', 'ai.api.cloud.yandex.net', 'llm.api.cloud.yandex.net']);

/** Model family from an AI Studio model id: `qwen3.6-35b-a3b` → `qwen`, `deepseek-v4.1-flash` → `deepseek`. */
export function modelFamily(model: string): string {
  const id = model.replace(/^gpt:\/\/[^/]+\//, '').toLowerCase();
  if (id.startsWith('qwen')) return 'qwen';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('yandexgpt')) return 'yandexgpt';
  if (id.startsWith('aliceai')) return 'aliceai';
  if (id.startsWith('gemma')) return 'gemma';
  if (id.startsWith('llama')) return 'llama';
  return id.split(/[-.\d]/)[0] || id;
}

const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);
const bool = z.enum(['true', 'false', '1', '0']).optional().transform((v) => v === 'true' || v === '1');
const modelId = z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,80}$/, 'идентификатор модели (без gpt://)');

const schema = z.object({
  VL_LIVE_PROVIDER: z.enum(['yandex', 'none']).default('none'),
  YANDEX_FOLDER_ID: z.string().trim().regex(/^[a-z0-9]{10,50}$/, 'ID каталога Yandex Cloud').optional(),
  YANDEX_API_KEY: z.string().trim().min(10).optional(),
  YANDEX_IAM_TOKEN: z.string().trim().min(10).optional(),
  YANDEX_SEARCH_URL: z.string().url().default(YANDEX_SEARCH_URL),
  YANDEX_LLM_URL: z.string().url().default(YANDEX_LLM_URL),
  VL_ANALYST_MODEL: modelId.default(DEFAULT_ANALYST_MODEL),
  VL_SKEPTIC_MODEL: modelId.default(DEFAULT_SKEPTIC_MODEL),
  VL_ALLOW_SINGLE_MODEL: bool,
  VL_LLM_RESPONSE_FORMAT: z.enum(['json_schema', 'json_object', 'none']).default('json_schema'),
  VL_LIVE_MAX_NEW: int(3, 0, 20),
  VL_LIVE_MAX_RECHECKS: int(3, 0, 50),
  VL_LIVE_CARRY_DAYS: int(7, 0, 30),
  VL_SEARCH_PAGES: int(1, 1, 3),
  VL_SEARCH_GROUPS: int(10, 5, 50),
  VL_HITS_PER_QUERY: int(3, 1, 10),
  VL_EVIDENCE_HITS: int(3, 1, 10),
  VL_MAX_COUNTER_QUERIES: int(8, 3, 20),
  VL_MAX_SEARCHES_PER_RUN: int(150, 1, 2000),
  VL_MAX_READS_PER_RUN: int(300, 1, 5000),
  VL_MAX_LLM_CALLS_PER_RUN: int(300, 1, 5000),
  VL_FETCH_TIMEOUT_MS: int(10_000, 1000, 60_000),
  /** Search API sync quota is 1 request/s: the interval may never go below 1000 ms (default 1100 = 10 % margin). */
  VL_SEARCH_MIN_INTERVAL_MS: int(1100, 1000, 60_000),
  VL_FETCH_MAX_BYTES: int(2_000_000, 10_000, 10_000_000),
  VL_HOST_INTERVAL_MS: int(1000, 0, 60_000),
  VL_LLM_TIMEOUT_MS: int(60_000, 5000, 300_000),
  VL_LLM_MAX_TOKENS: int(2_000, 200, 16_000),
  VL_LIVE_MONTHLY_BUDGET_KOP: int(40_000, 0, 10_000_000),
  VL_DISCOVERY_QUERIES: z.string().optional(),
});

export interface LiveConfig {
  provider: 'yandex' | 'none';
  folderId: string | null;
  /** The secret itself is only reachable through `authHeader()`. */
  auth: { kind: 'api-key' | 'iam-token' | 'none' };
  searchUrl: string;
  llmUrl: string;
  analystModel: string;
  skepticModel: string;
  allowSingleModel: boolean;
  responseFormat: 'json_schema' | 'json_object' | 'none';
  maxNew: number;
  maxRechecks: number;
  carryDays: number;
  searchPages: number;
  searchGroups: number;
  hitsPerQuery: number;
  evidenceHits: number;
  maxCounterQueries: number;
  rateLimits: { search: number; read: number; llm: number };
  fetchTimeoutMs: number;
  searchMinIntervalMs: number;
  fetchMaxBytes: number;
  hostIntervalMs: number;
  llmTimeoutMs: number;
  llmMaxTokens: number;
  monthlyBudgetKop: number;
  discoveryQueries: string[];
  authHeader(): string | null;
}

export const DEFAULT_DISCOVERY_QUERIES = ['new SaaS for small business launched this month', 'micro SaaS tool small businesses pay for', 'Product Hunt launch B2B tool for freelancers'];

export class LiveConfigError extends Error {}

export function loadLiveConfig(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const parsed = schema.safeParse(env);
  // Never echo values: only the variable names and the rule they broke.
  if (!parsed.success) throw new LiveConfigError(`Некорректная конфигурация live: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const e = parsed.data;
  for (const m of [e.VL_ANALYST_MODEL, e.VL_SKEPTIC_MODEL]) if (DEPRECATED_MODELS[m]) throw new LiveConfigError(`Модель ${m} ${DEPRECATED_MODELS[m]}`);
  for (const u of [e.YANDEX_SEARCH_URL, e.YANDEX_LLM_URL]) {
    const url = new URL(u);
    if (url.protocol !== 'https:' || !PROVIDER_HOSTS.has(url.hostname)) throw new LiveConfigError(`Эндпоинт ${url.hostname} не входит в список официальных хостов Yandex`);
  }
  const secret = e.YANDEX_API_KEY ?? e.YANDEX_IAM_TOKEN ?? null;
  const kind = e.YANDEX_API_KEY ? 'api-key' : e.YANDEX_IAM_TOKEN ? 'iam-token' : 'none';
  return {
    provider: e.VL_LIVE_PROVIDER,
    folderId: e.YANDEX_FOLDER_ID ?? null,
    auth: { kind },
    searchUrl: e.YANDEX_SEARCH_URL,
    llmUrl: e.YANDEX_LLM_URL,
    analystModel: e.VL_ANALYST_MODEL,
    skepticModel: e.VL_SKEPTIC_MODEL,
    allowSingleModel: e.VL_ALLOW_SINGLE_MODEL,
    responseFormat: e.VL_LLM_RESPONSE_FORMAT,
    maxNew: e.VL_LIVE_MAX_NEW,
    maxRechecks: e.VL_LIVE_MAX_RECHECKS,
    carryDays: e.VL_LIVE_CARRY_DAYS,
    searchPages: e.VL_SEARCH_PAGES,
    searchGroups: e.VL_SEARCH_GROUPS,
    hitsPerQuery: e.VL_HITS_PER_QUERY,
    evidenceHits: e.VL_EVIDENCE_HITS,
    maxCounterQueries: e.VL_MAX_COUNTER_QUERIES,
    rateLimits: { search: e.VL_MAX_SEARCHES_PER_RUN, read: e.VL_MAX_READS_PER_RUN, llm: e.VL_MAX_LLM_CALLS_PER_RUN },
    fetchTimeoutMs: e.VL_FETCH_TIMEOUT_MS,
    searchMinIntervalMs: e.VL_SEARCH_MIN_INTERVAL_MS,
    fetchMaxBytes: e.VL_FETCH_MAX_BYTES,
    hostIntervalMs: e.VL_HOST_INTERVAL_MS,
    llmTimeoutMs: e.VL_LLM_TIMEOUT_MS,
    llmMaxTokens: e.VL_LLM_MAX_TOKENS,
    monthlyBudgetKop: e.VL_LIVE_MONTHLY_BUDGET_KOP,
    discoveryQueries: e.VL_DISCOVERY_QUERIES ? e.VL_DISCOVERY_QUERIES.split('|').map((s) => s.trim()).filter(Boolean).slice(0, 10) : DEFAULT_DISCOVERY_QUERIES,
    authHeader: () => (secret ? `${kind === 'api-key' ? 'Api-Key' : 'Bearer'} ${secret}` : null),
  };
}

/** Why live calls may NOT be executed with this config (empty = ready). */
export function readinessProblems(c: LiveConfig): string[] {
  const p: string[] = [];
  if (c.provider !== 'yandex') p.push('VL_LIVE_PROVIDER не равен yandex (live выключен)');
  if (!c.folderId) p.push('не задан YANDEX_FOLDER_ID');
  if (c.auth.kind === 'none') p.push('не задан YANDEX_API_KEY или YANDEX_IAM_TOKEN');
  if (modelFamily(c.analystModel) === modelFamily(c.skepticModel) && !c.allowSingleModel) p.push(`аналитик и скептик из одного семейства моделей (${modelFamily(c.analystModel)}) — независимой проверки нет`);
  return p;
}

/** Printable summary — never contains the secret. */
export function describeConfig(c: LiveConfig): Record<string, string | number | boolean> {
  return {
    provider: c.provider,
    folderId: c.folderId ? `${c.folderId.slice(0, 4)}…` : 'не задан',
    auth: c.auth.kind === 'none' ? 'не задан' : `${c.auth.kind} (значение скрыто)`,
    searchUrl: c.searchUrl,
    llmUrl: c.llmUrl,
    analystModel: c.analystModel,
    skepticModel: c.skepticModel,
    independence: modelFamily(c.analystModel) !== modelFamily(c.skepticModel) ? 'independent' : 'single-model-degraded',
    responseFormat: c.responseFormat,
    maxNew: c.maxNew,
    maxRechecks: c.maxRechecks,
    carryDays: c.carryDays,
    monthlyBudgetKop: c.monthlyBudgetKop,
  };
}
