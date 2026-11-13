/**
 * Reasoning policy per (model, operation) for Yandex AI Studio chat completions
 * (VL-004B-reasoning, verified by the 13.11.2026 probes).
 *
 * Evidence:
 *  - Probe attempts 2 and 3, 13.11.2026, recorded raw responses:
 *    - both models reason by default; reasoning tokens are part of completion_tokens and are bounded by
 *      max_tokens;
 *    - Qwen3.6 35B with reasoning ON spent the whole max_tokens (16, 60 and 1084: 3998 chars of reasoning)
 *      on a trivial JSON task, so content stayed empty;
 *    - DeepSeek V4.1 Flash with reasoning ON answered within 12–41 reasoning tokens.
 *  - `reasoning_effort: "none"`, probe attempt 3, 13.11.2026:
 *    - Qwen3.6 (request id 625c41ac8ce5512d:…): finish_reason stop, valid JSON in content, no
 *      reasoning_content, completion 12/60;
 *    - DeepSeek V4.1 Flash (request id 7e7dbf897f59c62c:…): finish_reason stop, valid JSON,
 *      reasoning_tokens 0, completion 10/60.
 *  - The Yandex Chat Completions reference lists `none` among the values of `reasoning_effort` (checked by the
 *    founder); the «Reasoning mode» page says the Qwen family can turn reasoning off.
 *
 * Rules:
 *  - Policy per (model, operation), never a global switch. A pair may use `none` ONLY if the model's
 *    `disable` status is `verified`; otherwise the plan falls back to reasoning ON with a reserve.
 *  - With reasoning ON, max_tokens = answer + reserve, so reasoning cannot consume the JSON answer, and
 *    the worst-case reservation (`llmWorstCaseKop` uses max_tokens) covers reasoning.
 *  - With `none`, max_tokens = answer tokens. A reply that still reasons and runs out of tokens is rejected
 *    as truncated (finish_reason=length), never accepted.
 *  - reasoning_content is never used as the answer. Switching reasoning off does not make an analysis
 *    correct: JSON schema validation and the evidence rules stay exactly as strict.
 *  - Unknown models and unknown pairs: reasoning ON with the operation's default reserve; `none` is never sent.
 */

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
/** verified: accepted and observed to work · unverified: not proven, never sent in production · unsupported: proven rejected. */
export type CapabilityStatus = 'verified' | 'unverified' | 'unsupported';

export interface ModelReasoningProfile {
  model: string;
  /** The model reasons by default (observed in a recorded response). */
  reasonsByDefault: boolean;
  /** `reasoning_effort: "none"` — may it be sent in production? */
  disable: CapabilityStatus;
  evidence: string;
}

export const REASONING_PROFILES: Record<string, ModelReasoningProfile> = {
  'qwen3.6-35b-a3b': {
    model: 'qwen3.6-35b-a3b',
    reasonsByDefault: true,
    disable: 'verified',
    evidence:
      'Проба 13.11.2026 (попытка 3): reasoning_effort=none → finish_reason stop, валидный JSON, reasoning_content пуст, completion 12/60 (requestId 625c41ac8ce5512d:…). С рассуждением: 1084/1084 токенов на рассуждение, content пуст.',
  },
  'deepseek-v4.1-flash': {
    model: 'deepseek-v4.1-flash',
    reasonsByDefault: true,
    disable: 'verified',
    evidence:
      'Проба 13.11.2026 (попытка 3): reasoning_effort=none → finish_reason stop, валидный JSON, reasoning_tokens 0, completion 10/60 (requestId 7e7dbf897f59c62c:…). С рассуждением: 12–41 токен рассуждения, ответ укладывается.',
  },
};

/** An unknown model is assumed to reason by default and is never sent an unverified parameter. */
export function reasoningProfile(model: string): ModelReasoningProfile {
  return REASONING_PROFILES[model] ?? { model, reasonsByDefault: true, disable: 'unverified', evidence: 'модель без профиля — консервативно: рассуждает, отключение не проверено' };
}

export type LlmOperation = 'probe_transport' | 'probe_schema' | 'extract_offer' | 'discover_seeds' | 'analyse_candidate' | 'skeptic_challenge';

/** Default reasoning reserve of an operation when reasoning stays ON (unknown pairs, unverified models). */
export const DEFAULT_REASONING_RESERVE: Record<LlmOperation, number> = {
  probe_transport: 0, // transport check only: content is not required from it
  probe_schema: 1_024,
  extract_offer: 2_048,
  discover_seeds: 4_096,
  analyse_candidate: 4_096,
  skeptic_challenge: 4_096,
};

export interface PairPolicy {
  /** `none` = reasoning off (requires a verified profile); null = model default (reasoning ON). */
  effort: 'none' | null;
  /** Reserve added to max_tokens when reasoning stays ON. */
  reserve: number;
  why: string;
}

const OFF = (why: string): PairPolicy => ({ effort: 'none', reserve: 0, why });
const ON = (reserve: number, why: string): PairPolicy => ({ effort: null, reserve, why });

/** The explicit policy table. Pairs not listed fall back to reasoning ON with the default reserve. */
export const REASONING_POLICY: Record<string, Partial<Record<LlmOperation, PairPolicy>>> = {
  // Qwen3.6 is the analyst/extractor of the pilot: with reasoning ON it spent >1084 tokens on a trivial JSON,
  // so every pilot operation runs with reasoning OFF (including the 16-token transport ping).
  'qwen3.6-35b-a3b': {
    probe_transport: OFF('Qwen: рассуждения выключены — иначе 16 токенов уходят на рассуждение'),
    probe_schema: OFF('Qwen: рассуждения выключены (подтверждено пробой 13.11)'),
    extract_offer: OFF('Qwen: рассуждения выключены — короткий JSON с цитатами'),
    discover_seeds: OFF('Qwen: рассуждения выключены — рассуждение съедает лимит; качество проверяют схема и правила доказательств'),
    analyse_candidate: OFF('Qwen: рассуждения выключены — рассуждение съедает лимит; качество проверяют схема, скептик и правила доказательств'),
  },
  // DeepSeek V4.1 Flash is the skeptic: simple operations off, the challenge keeps reasoning with a bounded reserve.
  'deepseek-v4.1-flash': {
    probe_transport: OFF('DeepSeek: простая операция — рассуждения выключены'),
    probe_schema: OFF('DeepSeek: простая операция — рассуждения выключены'),
    extract_offer: OFF('DeepSeek: простая операция — рассуждения выключены'),
    skeptic_challenge: ON(4_096, 'DeepSeek-скептик: рассуждение полезно, запас 4096 токенов входит в max_tokens и в резерв'),
  },
};

export interface ReasoningPlan {
  /** Sent as `reasoning_effort` when set; absent = model default. */
  effort: ReasoningEffort | null;
  /** max_tokens actually sent = answer tokens + reasoning reserve (when reasoning stays on). */
  maxTokens: number;
  answerTokens: number;
  reserve: number;
  mode: 'off' | 'default';
  why: string;
}

/**
 * The plan for one call.
 * - `forceEffort`: the probe's diagnostic of an UNVERIFIED mode only (never used by pipeline operations).
 *   With «none» no reserve is added: the diagnostic observes whether reasoning still appears.
 */
export function planReasoning(model: string, op: LlmOperation, answerTokens: number, forceEffort?: ReasoningEffort): ReasoningPlan {
  const p = reasoningProfile(model);
  if (forceEffort) {
    const reserve = forceEffort === 'none' || !p.reasonsByDefault ? 0 : DEFAULT_REASONING_RESERVE[op];
    return { effort: forceEffort, maxTokens: answerTokens + reserve, answerTokens, reserve, mode: forceEffort === 'none' ? 'off' : 'default', why: `диагностика: reasoning_effort=${forceEffort} (${p.disable})` };
  }
  const pair = REASONING_POLICY[model]?.[op];
  if (pair?.effort === 'none' && p.disable === 'verified') {
    return { effort: 'none', maxTokens: answerTokens, answerTokens, reserve: 0, mode: 'off', why: pair.why };
  }
  const reserve = !p.reasonsByDefault ? 0 : pair && pair.effort === null ? pair.reserve : DEFAULT_REASONING_RESERVE[op];
  const why =
    pair?.effort === 'none'
      ? `политика просит отключить рассуждения, но для ${model} отключение ${p.disable === 'unsupported' ? 'не поддерживается' : 'не подтверждено'} — рассуждение включено, запас ${reserve}`
      : (pair?.why ?? `пара ${model}/${op} не задана — рассуждение по умолчанию, запас ${reserve}`);
  return { effort: null, maxTokens: answerTokens + reserve, answerTokens, reserve, mode: 'default', why };
}

/** Models whose «none» still needs a diagnostic call (verified models never spend money on it again). */
export function needsReasoningOffDiagnostic(model: string): boolean {
  return reasoningProfile(model).disable !== 'verified';
}
