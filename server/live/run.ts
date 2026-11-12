/**
 * Live run assembly (VL-004B): one place that turns a LiveConfig into worker options, so tests (recorded
 * HTTP) and the CLI (`--live --execute`, Phase B only) exercise exactly the same path.
 */
import { YANDEX_TARIFFS, inputTokenBound, llmCostKop, searchCostKop, tariffFor } from './prices';
import { buildLiveProviders, type LiveBundle, type LiveDeps } from './providers';
import type { LiveConfig } from './config';
import type { RunOptions } from '../machine/worker';
import type { ISODate } from '../../src/domain/types';

export interface LiveRunInput {
  asOf: ISODate;
  /** Hard ceiling for THIS job in kopecks (from --max-spend-rub). */
  budgetKop: number;
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
}

/** Worker options for a live run. `bundles` collects the provider bundles created (for audits/tests). */
export function liveRunOptions(cfg: LiveConfig, deps: LiveDeps, input: LiveRunInput, bundles: LiveBundle[] = []): RunOptions & { feed: 'live' } {
  const probe = buildLiveProviders(cfg, deps); // validates config (fail-closed) before any job is created
  return {
    feed: 'live',
    asOf: input.asOf,
    budget: input.budgetKop,
    monthlyBudget: cfg.monthlyBudgetKop,
    maxAttempts: input.maxAttempts ?? 2,
    leaseMs: input.leaseMs ?? 30 * 60_000,
    rateLimits: cfg.rateLimits,
    providers: () => {
      const b = buildLiveProviders(cfg, deps);
      bundles.push(b);
      return b.providers;
    },
    independence: probe.independence,
    maxNew: cfg.maxNew,
    maxRechecks: cfg.maxRechecks,
    carryDays: cfg.carryDays,
    pipeline: { evidenceHits: cfg.evidenceHits, hitsPerQuery: cfg.hitsPerQuery, maxRuQueries: 8 },
    now: input.now,
  };
}

/**
 * Worst-case plan for one live run, computed WITHOUT any request: how many calls the configured bounds
 * allow and what they would cost at most. The job budget (--max-spend-rub) is what actually stops a run.
 */
export function livePlan(cfg: LiveConfig) {
  const candidates = cfg.maxNew + cfg.maxRechecks;
  const ruQueries = 8 + cfg.maxCounterQueries; // analyst + defaults (capped) + skeptic counter-queries
  const searchesPerCandidate = (4 + ruQueries) * cfg.searchPages;
  const searches = Math.min(cfg.rateLimits.search, cfg.discoveryQueries.length * cfg.searchPages + candidates * searchesPerCandidate);
  const readsPerCandidate = 4 * cfg.evidenceHits + ruQueries * cfg.hitsPerQuery;
  const reads = Math.min(cfg.rateLimits.read, candidates * readsPerCandidate);
  const analyst = tariffFor(cfg.analystModel);
  const skeptic = tariffFor(cfg.skepticModel);
  const msg = (bytes: number) => [{ role: 'system', content: 'x'.repeat(3000) }, { role: 'user', content: 'x'.repeat(bytes) }];
  const extractKop = analyst ? llmCostKop(analyst, { input: inputTokenBound(msg(14_000)), output: 700 }) : null;
  const analyseKop = analyst ? llmCostKop(analyst, { input: inputTokenBound(msg(4 * cfg.evidenceHits * 9_000)), output: cfg.llmMaxTokens }) : null;
  const skepticKop = skeptic ? llmCostKop(skeptic, { input: inputTokenBound(msg(60_000)), output: cfg.llmMaxTokens }) : null;
  const llmCalls = Math.min(cfg.rateLimits.llm, 1 + reads + 2 * candidates);
  const worstKop =
    searches * searchCostKop() + (extractKop !== null && analyseKop !== null && skepticKop !== null ? Math.min(llmCalls, reads) * extractKop + candidates * (analyseKop + skepticKop) + analyseKop : Number.POSITIVE_INFINITY);
  return {
    tariffs: { version: YANDEX_TARIFFS.version, searchPerRequestKop: searchCostKop(), analyst: cfg.analystModel, analystTariff: analyst, skeptic: cfg.skepticModel, skepticTariff: skeptic },
    bounds: { candidates, searches, reads, llmCalls },
    worstCaseKop: worstKop,
    note: 'Верхняя граница по лимитам конфигурации; реальный прогон останавливается бюджетом задания (--max-spend-rub) раньше.',
  };
}
