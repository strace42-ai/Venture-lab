/**
 * Live run assembly (VL-004B): one place that turns a LiveConfig into worker options, so tests (recorded
 * HTTP) and the CLI (`--live --execute`, Phase B only) exercise exactly the same path.
 */
import { YANDEX_TARIFFS, inputTokenBound, llmCostKop, searchCostKop, tariffFor } from './prices';
import { planReasoning } from './reasoning';
import { buildLiveProviders, type LiveBundle, type LiveDeps } from './providers';
import type { LiveConfig } from './config';
import { jobKeyFor, runWorkerJob, TrialRefused, workerToday, type RunOptions, type RunResult, type TrialSpec } from '../machine/worker';
import { discoverySeedSchema } from '../machine/schemas';
import type { DiscoverySeed } from '../machine/types';
import type { Pool } from '../db/pool';
import { withPaidExecutionLock } from './paid-lock';
import { PROBE_DIAGNOSTIC_CALLS, PROBE_REQUIRED_CHECKS, runProbe, type ProbeCheck } from './probe';
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
  // Output bound = max_tokens actually sent: answer tokens + the model's reasoning reserve (reasoning.ts).
  const extractKop = analyst ? llmCostKop(analyst, { input: inputTokenBound(msg(14_000)), output: planReasoning(cfg.analystModel, 'extract_offer', 700).maxTokens }) : null;
  const analyseKop = analyst ? llmCostKop(analyst, { input: inputTokenBound(msg(4 * cfg.evidenceHits * 9_000)), output: planReasoning(cfg.analystModel, 'analyse_candidate', cfg.llmMaxTokens).maxTokens }) : null;
  const skepticKop = skeptic ? llmCostKop(skeptic, { input: inputTokenBound(msg(60_000)), output: planReasoning(cfg.skepticModel, 'skeptic_challenge', cfg.llmMaxTokens).maxTokens }) : null;
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

/** Seeds file of a trial stage: a JSON array of discovery seeds, validated; at most 5, unique ids. */
export function parseSeeds(json: unknown): DiscoverySeed[] {
  if (!Array.isArray(json) || json.length === 0 || json.length > 5) throw new Error('файл кандидатов: нужен непустой JSON-массив, не больше 5 кандидатов');
  const seeds = json.map((x, i) => {
    const r = discoverySeedSchema.safeParse(x);
    if (!r.success) throw new Error(`кандидат №${i + 1}: ${r.error.issues.slice(0, 2).map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
    return r.data as DiscoverySeed;
  });
  if (new Set(seeds.map((s) => s.externalId)).size !== seeds.length) throw new Error('файл кандидатов: повторяющиеся externalId');
  return seeds;
}

/**
 * One paid stage of a live trial, behind the paid gate (already passed by the caller): exclusive
 * paid-execution lock (host + DB), the real date, the cumulative trial ceiling, the stage ceiling, no
 * discovery, no publication into the live TOP-10. The probe runs the transport + mini-schema checks only.
 */
export async function runPaidStage(
  pool: Pool,
  cfg: LiveConfig,
  gate: { trial: TrialSpec; maxSpendKop: number },
  deps: LiveDeps,
  x: { seeds?: DiscoverySeed[]; lockFile: string; now?: () => Date; retry?: boolean },
): Promise<RunResult & { probe?: ProbeCheck[] }> {
  return withPaidExecutionLock(pool, x.lockFile, async () => {
    const now = x.now ?? (() => new Date());
    const asOf = workerToday(now());
    // A failed stage (e.g. a failed probe) is never re-run implicitly: only with an explicit --retry. The new
    // attempt shares the stage's job budget and the trial ledger — nothing is reset.
    const prev = (await pool.query<{ status: string; attempts: number; max_attempts: number }>('SELECT status, attempts, max_attempts FROM mr_jobs WHERE job_key = $1', [jobKeyFor('live', asOf, gate.trial)])).rows[0];
    if (prev && prev.status !== 'succeeded' && prev.status !== 'running' && !x.retry) {
      throw new TrialRefused(`ступень ${gate.trial.stage} испытания ${gate.trial.id} завершилась со статусом «${prev.status}» (попыток ${prev.attempts}/${prev.max_attempts}); повтор — только явно с --retry, расходы прошлых попыток остаются в журнале`);
    }
    if (x.retry && (!prev || prev.status === 'succeeded')) throw new TrialRefused(`--retry: ступень ${gate.trial.stage} не завершалась неуспешно — повторять нечего`);
    if (gate.trial.stage === 'probe') {
      if (x.seeds) throw new Error('пробный вызов не принимает кандидатов');
      const bundle = buildLiveProviders(cfg, deps);
      const r = await runWorkerJob(pool, {
        feed: 'live',
        asOf,
        budget: gate.maxSpendKop,
        monthlyBudget: cfg.monthlyBudgetKop,
        maxAttempts: 3, // the first try + at most 2 explicit --retry, all within the same 5 ₽ stage budget
        rateLimits: { search: 2, read: 0, llm: 4 + PROBE_DIAGNOSTIC_CALLS },
        trial: gate.trial,
        independence: bundle.independence,
        now,
        probe: async (ctx) => {
          const checks = await runProbe(bundle, { analyst: cfg.analystModel, skeptic: cfg.skepticModel }, ctx);
          // Only the required checks decide; reasoning-off diagnostics are reported, never failing.
          const required = checks.filter((c) => c.required);
          const failed = required.filter((c) => !c.ok);
          return { passed: failed.length === 0 && required.length === PROBE_REQUIRED_CHECKS, report: checks, failure: failed.map((c) => `${c.check}: ${c.detail}`).join('; ') || undefined };
        },
      });
      return r as RunResult & { probe?: ProbeCheck[] };
    }
    if (!x.seeds?.length) throw new Error(`ступень ${gate.trial.stage} требует заданных кандидатов (--seeds)`);
    const base = liveRunOptions(cfg, deps, { asOf, budgetKop: gate.maxSpendKop, now });
    return (await runWorkerJob(pool, { ...base, trial: gate.trial, seeds: x.seeds, discovery: false, maxNew: 0, maxRechecks: 0 })) as RunResult;
  });
}
