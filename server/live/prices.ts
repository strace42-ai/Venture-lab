/**
 * Yandex tariffs used for PRE-CALL worst-case reservation and POST-CALL reconciliation (VL-004B).
 *
 * Checked on 2026-11-12 against the official pages (prices in RUB include VAT):
 *  - Search API: https://aistudio.yandex.ru/ru/docs/search-api/pricing
 *      synchronous web search, daytime 488 ₽ / 1000 requests (night 366 ₽); errors 5xx and
 *      authorization errors are documented as not billed.
 *  - AI Studio: https://aistudio.yandex.ru/ru/docs/ai-studio/pricing (synchronous mode, per 1000 tokens)
 *      Qwen3.6 35B: input 0.20 ₽, cached input 0.05 ₽, output 0.30 ₽
 *      DeepSeek V4.1 Flash: input 0.30 ₽, cached input 0.075 ₽, output 0.50 ₽
 * Ledger unit = 1 kopeck (integer), always rounded UP per call. The application limit is NOT a
 * provider billing guarantee: set budgets/alerts in Yandex Cloud Billing as well
 * (docs/live-provider-setup.md).
 */
export const YANDEX_PRICE_VERSION = 'yandex-2026-11-12';

export interface LlmTariff {
  /** ₽ per 1000 tokens, incl. VAT */
  input: number;
  cachedInput: number;
  output: number;
}

export const YANDEX_TARIFFS = {
  version: YANDEX_PRICE_VERSION,
  checkedOn: '2026-11-12',
  currency: 'RUB, incl. VAT',
  /** ₽ per 1000 synchronous web-search requests. The daytime price is always reserved (conservative). */
  searchSyncPer1000: 488,
  searchSyncNightPer1000: 366,
  llm: {
    'qwen3.6-35b-a3b': { input: 0.2, cachedInput: 0.05, output: 0.3 },
    'deepseek-v4.1-flash': { input: 0.3, cachedInput: 0.075, output: 0.5 },
  } as Record<string, LlmTariff>,
} as const;

/** Kopecks for one search request (daytime tariff, rounded up): 48.8 → 49. */
export function searchCostKop(): number {
  return Math.ceil((YANDEX_TARIFFS.searchSyncPer1000 / 1000) * 100 - 1e-9);
}

export function tariffFor(model: string): LlmTariff | null {
  return YANDEX_TARIFFS.llm[model] ?? null;
}

/** Kopecks for given token counts (rounded up). */
export function llmCostKop(t: LlmTariff, tokens: { input: number; cachedInput?: number; output: number }): number {
  const cached = Math.min(tokens.cachedInput ?? 0, tokens.input);
  const rub = ((tokens.input - cached) * t.input + cached * t.cachedInput + tokens.output * t.output) / 1000;
  return Math.ceil(rub * 100 - 1e-9);
}

/**
 * Upper bound of input tokens WITHOUT a tokenizer: byte-level BPE tokenizers never emit more tokens than
 * UTF-8 bytes, plus a per-message and per-request framing allowance.
 */
export function inputTokenBound(messages: { role: string; content: string }[]): number {
  return messages.reduce((a, m) => a + Buffer.byteLength(m.content, 'utf8') + Buffer.byteLength(m.role, 'utf8') + 16, 0) + 256;
}

/** Worst-case kopecks for one chat call: every input byte is a token and the output hits max_tokens. */
export function llmWorstCaseKop(t: LlmTariff, messages: { role: string; content: string }[], maxTokens: number): number {
  return llmCostKop(t, { input: inputTokenBound(messages), output: maxTokens });
}
