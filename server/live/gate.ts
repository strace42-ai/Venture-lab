/**
 * The ONE gate in front of every paid live action (VL-004B-prep). `--probe` and stage runs are both paid
 * executions and pass exactly the same conditions:
 *  - explicit `--live --once --execute`;
 *  - activation flag VL_LIVE_EXECUTE=phase-b-authorized (credentials alone never enable paid calls);
 *  - never in CI;
 *  - live configuration ready (provider, folder, credentials, independent model families);
 *  - both models are allowed = pinned in the tariff table (cost can be bounded);
 *  - a trial id and the cumulative trial budget (≤ 300 ₽), a known stage and an explicit
 *    `--max-spend-rub` not above that stage's ceiling (5 / 60 / 235 ₽ = 300 ₽);
 *  - stage 2/3 only with `--seeds <file> --no-discovery`; no `--as-of` (a paid run is dated with the real day).
 * The gate does no I/O and makes no request.
 */
import { readinessProblems, type LiveConfig } from './config';
import { tariffFor } from './prices';
import type { TrialSpec, TrialStage } from '../machine/worker';

export const TRIAL_BUDGET_RUB = 300;
export const STAGE_CAPS_RUB: Record<TrialStage, number> = { probe: 5, stage2: 60, stage3: 235 };

export interface PaidFlags {
  once: boolean;
  execute: boolean;
  probe: boolean;
  stage?: string;
  maxSpendRub?: number;
  asOf?: string;
  seedsFile?: string;
  noDiscovery: boolean;
}

export type GateResult = { ok: true; trial: TrialSpec; maxSpendKop: number } | { ok: false; problems: string[] };

export function paidRunGate(env: NodeJS.ProcessEnv, f: PaidFlags, cfg: LiveConfig | null, cfgError?: string): GateResult {
  const p: string[] = [];
  if (!f.once) p.push('нужен --once (разовый запуск)');
  if (!f.execute) p.push(`${f.probe ? '--probe' : 'платный запуск'} требует --execute`);
  if (env.CI) p.push('платные live-вызовы запрещены в CI');
  if (env.VL_LIVE_EXECUTE !== 'phase-b-authorized') p.push('не активирован: требуется VL_LIVE_EXECUTE=phase-b-authorized (ставится только после разрешения Phase B)');
  if (cfgError) p.push(cfgError);
  if (cfg) {
    p.push(...readinessProblems(cfg));
    for (const m of [cfg.analystModel, cfg.skepticModel]) if (!tariffFor(m)) p.push(`модель ${m} не разрешена: нет закреплённого тарифа — стоимость нельзя ограничить`);
  }
  const trialId = env.VL_TRIAL_ID ?? '';
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(trialId)) p.push('нужен VL_TRIAL_ID (идентификатор испытания: латиница, цифры, дефис)');
  const budgetRub = Number(env.VL_TRIAL_BUDGET_RUB ?? TRIAL_BUDGET_RUB);
  if (!Number.isFinite(budgetRub) || budgetRub <= 0 || budgetRub > TRIAL_BUDGET_RUB) p.push(`VL_TRIAL_BUDGET_RUB должен быть в (0; ${TRIAL_BUDGET_RUB}] ₽ — общий потолок испытания`);
  let stage: TrialStage | null = null;
  if (f.probe && f.stage) p.push('--probe и --stage несовместимы');
  else if (f.probe) stage = 'probe';
  else if (f.stage === 'stage2' || f.stage === 'stage3') stage = f.stage;
  else p.push('укажите ступень: --probe или --stage stage2|stage3');
  if (stage === 'probe' && (f.seedsFile || f.noDiscovery)) p.push('--probe не принимает --seeds/--no-discovery');
  if (stage && stage !== 'probe') {
    if (!f.seedsFile) p.push(`ступень ${stage} требует --seeds <файл>`);
    if (!f.noDiscovery) p.push(`ступень ${stage} требует --no-discovery`);
  }
  if (f.asOf) p.push('--as-of запрещён для платного запуска: дата — фактический день запуска (без искусственного датирования)');
  const cap = stage ? STAGE_CAPS_RUB[stage] : 0;
  if (f.maxSpendRub === undefined || !Number.isFinite(f.maxSpendRub) || f.maxSpendRub <= 0) p.push('нужен явный --max-spend-rub N');
  else if (stage && f.maxSpendRub > cap) p.push(`--max-spend-rub ${f.maxSpendRub} выше потолка ступени ${stage} (${cap} ₽)`);
  if (p.length || !stage) return { ok: false, problems: p };
  return { ok: true, trial: { id: trialId, budgetKop: Math.round(budgetRub * 100), stage }, maxSpendKop: Math.floor(f.maxSpendRub! * 100) };
}
