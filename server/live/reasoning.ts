/**
 * Model-specific reasoning policy for Yandex AI Studio chat completions (VL-004B-reasoning).
 *
 * Evidence (checked 2026-11-13):
 *  - Recorded responses of the authorised probe, 13.11.2026:
 *    - both models return `message.reasoning_content` by default;
 *    - Qwen3.6 35B spent the whole max_tokens (16 and 60) on reasoning: content was empty, finish_reason
 *      was "length" and completion_tokens equalled max_tokens. So reasoning tokens are counted INSIDE
 *      completion_tokens and are bounded by max_tokens;
 *    - DeepSeek V4.1 Flash reported `completion_tokens_details.reasoning_tokens` (41 of 52).
 *  - Yandex AI Studio docs, «Reasoning mode» (concepts/generation/chain-of-thought):
 *    - `reasoning_effort` is documented with low / medium / high;
 *    - reasoning is ON by default for models that support it;
 *    - «the Qwen family allows you to turn reasoning off but not to choose its depth»;
 *    - the value that turns it off is not named on that page;
 *    - DeepSeek is not mentioned.
 *  - The official Yandex AI Studio Python SDK (yandex-ai-studio-sdk 0.22.1):
 *    - maps its reasoning mode to `reasoning_effort`, with values low / medium / high only;
 *    - reads `reasoning_content` separately from `content`.
 *  - The chat-completions API reference page could not be read from this environment, because it
 *    returned a bot check. Whether `reasoning_effort: "none"` is accepted is therefore NOT verified for
 *    either model.
 *
 * Policy:
 *  - Short structured operations (probe schema, offer extraction) WOULD use `reasoning_effort: "none"`,
 *    but only for a model whose `disable` status is "verified". Until then (now) no reasoning parameter is
 *    sent, and max_tokens includes a reasoning reserve, so reasoning cannot consume the JSON answer.
 *  - Operations that benefit from reasoning (discovery, analysis, skeptic) keep the model default and get a
 *    larger reserve.
 *  - The reserve is part of max_tokens, so the worst-case reservation (`llmWorstCaseKop`) and the per-call
 *    spending bound include it automatically.
 *  - reasoning_content is NEVER used as the answer: the JSON must be in `content` and pass the schema.
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
    disable: 'unverified',
    evidence:
      'Проба 13.11.2026: reasoning_content заполнен, content пуст при max_tokens 16/60. Документация Yandex: Qwen позволяет выключить рассуждения, но значение параметра не названо; SDK 0.22.1 знает только low/medium/high.',
  },
  'deepseek-v4.1-flash': {
    model: 'deepseek-v4.1-flash',
    reasonsByDefault: true,
    disable: 'unverified',
    evidence: 'Проба 13.11.2026: reasoning_tokens 12/14 и 41/52. Документация Yandex управление рассуждениями DeepSeek не описывает.',
  },
};

/** An unknown model is assumed to reason by default and is never sent an unverified parameter. */
export function reasoningProfile(model: string): ModelReasoningProfile {
  return REASONING_PROFILES[model] ?? { model, reasonsByDefault: true, disable: 'unverified', evidence: 'модель без профиля — консервативно: рассуждает, отключение не проверено' };
}

export type LlmOperation = 'probe_schema' | 'extract_offer' | 'discover_seeds' | 'analyse_candidate' | 'skeptic_challenge';

export interface OperationReasoning {
  /** simple: a short JSON answer where reasoning adds nothing; reasoned: reasoning is useful. */
  kind: 'simple' | 'reasoned';
  /** Extra output tokens reserved for reasoning when it cannot be (or is not proven to be) switched off. */
  reasoningReserve: number;
}

export const OPERATION_REASONING: Record<LlmOperation, OperationReasoning> = {
  probe_schema: { kind: 'simple', reasoningReserve: 1_024 },
  extract_offer: { kind: 'simple', reasoningReserve: 2_048 },
  discover_seeds: { kind: 'reasoned', reasoningReserve: 4_096 },
  analyse_candidate: { kind: 'reasoned', reasoningReserve: 4_096 },
  skeptic_challenge: { kind: 'reasoned', reasoningReserve: 4_096 },
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
 * - `forceEffort`: the probe's diagnostic of an UNVERIFIED mode only. It is never used by pipeline
 *   operations. With «none» no reserve is added: the diagnostic observes whether reasoning still appears.
 */
export function planReasoning(model: string, op: LlmOperation, answerTokens: number, forceEffort?: ReasoningEffort): ReasoningPlan {
  const p = reasoningProfile(model);
  const o = OPERATION_REASONING[op];
  if (forceEffort) {
    // Diagnostic of «none»: no reserve — its job is to OBSERVE whether reasoning still appears (cheap);
    // a request that is ignored shows up as reasoning_content / reasoning_tokens, not as a lost answer.
    const reserve = forceEffort === 'none' || !p.reasonsByDefault ? 0 : o.reasoningReserve;
    return { effort: forceEffort, maxTokens: answerTokens + reserve, answerTokens, reserve, mode: forceEffort === 'none' ? 'off' : 'default', why: `диагностика: reasoning_effort=${forceEffort} (${p.disable})` };
  }
  if (o.kind === 'simple' && p.disable === 'verified') {
    return { effort: 'none', maxTokens: answerTokens, answerTokens, reserve: 0, mode: 'off', why: 'простая операция, отключение рассуждений подтверждено' };
  }
  const reserve = p.reasonsByDefault ? o.reasoningReserve : 0;
  const why =
    o.kind === 'simple'
      ? `простая операция, но отключение рассуждений для ${model} ${p.disable === 'unsupported' ? 'не поддерживается' : 'не подтверждено'} — запас ${reserve} токенов на рассуждение`
      : `операция с рассуждением — запас ${reserve} токенов`;
  return { effort: null, maxTokens: answerTokens + reserve, answerTokens, reserve, mode: 'default', why };
}
