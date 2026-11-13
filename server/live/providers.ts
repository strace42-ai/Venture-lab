/**
 * Assemble the live providers (VL-004B) behind the existing Providers contract. Fail-closed:
 *  - not configured / no credentials → refuse (unless a test or dry-run passes its own transport);
 *  - analyst and skeptic of the SAME model family → refuse, unless VL_ALLOW_SINGLE_MODEL=true, in which
 *    case the providers are marked `single-model-degraded` and the pipeline holds every candidate
 *    (it never claims an independent second model).
 */
import { AIStudioChat, OfferExtractor, YandexAnalyst, YandexSkeptic } from './ai-studio';
import { describeConfig, LiveConfigError, modelFamily, readinessProblems, type LiveConfig } from './config';
import { LiveSourceReader } from './live-reader';
import { DEFAULT_FETCH_POLICY, SafeFetcher } from './net/safe-fetch';
import type { Resolver, Transport } from './net/transport';
import { ProviderCaller, type RetryPolicy } from './provider-http';
import { MinIntervalLimiter, realClock, type Clock } from './net/rate-limit';
import { YandexSearchProvider } from './yandex-search';
import type { Providers } from '../machine/pipeline';

export interface LiveDeps {
  /** Transport for the official provider endpoints. */
  providerTransport: Transport;
  /** Transport for public web pages (always behind SafeFetcher). */
  webTransport: Transport;
  resolver: Resolver;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  retry?: Partial<RetryPolicy>;
  /** Clock for the Search API limiter (virtual time in tests). */
  clock?: Clock;
}

export type Independence = 'independent' | 'single-model-degraded';

export interface LiveBundle {
  providers: Providers;
  independence: Independence;
  fetcher: SafeFetcher;
  searchCaller: ProviderCaller;
  llmCaller: ProviderCaller;
  searchLimiter: MinIntervalLimiter;
  chat: AIStudioChat;
  summary: ReturnType<typeof describeConfig>;
}

export function buildLiveProviders(cfg: LiveConfig, deps: LiveDeps): LiveBundle {
  const problems = readinessProblems(cfg);
  if (problems.length) throw new LiveConfigError(`Живые провайдеры не готовы: ${problems.join('; ')}`);
  const independence: Independence = modelFamily(cfg.analystModel) === modelFamily(cfg.skepticModel) ? 'single-model-degraded' : 'independent';
  const searchLimiter = new MinIntervalLimiter(cfg.searchMinIntervalMs, deps.clock ?? realClock);
  const searchCaller = new ProviderCaller({ transport: deps.providerTransport, sleep: deps.sleep, random: deps.random, limiter: searchLimiter, policy: { maxTimeoutRetries: 1, ...deps.retry } });
  const llmCaller = new ProviderCaller({ transport: deps.providerTransport, sleep: deps.sleep, random: deps.random, policy: { maxTimeoutRetries: 0, ...deps.retry } });
  const chat = new AIStudioChat(llmCaller, cfg);
  const fetcher = new SafeFetcher(
    { transport: deps.webTransport, resolver: deps.resolver, now: deps.now, sleep: deps.sleep },
    { ...DEFAULT_FETCH_POLICY, timeoutMs: cfg.fetchTimeoutMs, maxBytes: cfg.fetchMaxBytes, hostIntervalMs: cfg.hostIntervalMs },
  );
  const search = new YandexSearchProvider(searchCaller, { url: cfg.searchUrl, folderId: cfg.folderId!, authHeader: cfg.authHeader, pages: cfg.searchPages, groupsOnPage: cfg.searchGroups });
  const llm = new YandexAnalyst(chat, cfg.analystModel, cfg);
  const skeptic = new YandexSkeptic(chat, cfg.skepticModel, cfg);
  const reader = new LiveSourceReader(fetcher, new OfferExtractor(chat, cfg.analystModel));
  return { providers: { search, reader, llm, skeptic }, independence, fetcher, searchCaller, llmCaller, searchLimiter, chat, summary: describeConfig(cfg) };
}
