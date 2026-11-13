/**
 * Stage-1 probe of a live trial (VL-004B-prep, reasoning-aware since VL-004B-reasoning): the cheapest proof
 * that the real providers behave as the adapters expect — WITHOUT the production schemas.
 *  - Search API: one RU and one COM query → the XML is parsed into documents (2 required checks).
 *  - Per model (analyst + skeptic), 2 required checks each:
 *    - TRANSPORT: a tiny plain completion. HTTP 200 + usage prove transport and billing ONLY. Empty content
 *      or finish_reason=length is reported as «no content generated», never as a generated answer.
 *    - MINIMAL SCHEMA: the operation `probe_schema` with the production reasoning policy (reasoning.ts).
 *      It passes only with JSON in `content` that matches the schema; reasoning_content never counts.
 *  - Per model whose `none` is NOT yet verified, 1 diagnostic (NOT required): `reasoning_effort: "none"`.
 *    Verified models are not re-tested (no money spent twice). Its outcome never fails the probe.
 *  - Search: exactly two LOGICAL searches (RU, World). Each may use up to 1 + maxRetries HTTP attempts
 *    (a 5xx is retried), so the per-run HTTP limit is 2 × (1 + maxRetries); every attempt is still reserved
 *    in advance and spaced ≥ 1.1 s by the limiter.
 * Checks never stop each other (except auth failures): the report says exactly what passed.
 */
import { z } from 'zod';
import { InvalidModelOutput, ProviderAuthError, RateLimited, type CallContext } from '../machine/types';
import { describeMeta, ReasoningModeUnsupported } from './ai-studio';
import { maxHttpAttempts, type RetryPolicy } from './provider-http';
import type { LiveBundle } from './providers';
import { needsReasoningOffDiagnostic } from './reasoning';

export const PROBE_QUERIES = [
  { query: 'цифровой гид гостя', region: 'ru' as const },
  { query: 'Touch Stay', region: 'world' as const },
];

/** 2 searches + (transport + minimal schema) × 2 models — every one is required for a passed probe. */
export const PROBE_REQUIRED_CHECKS = PROBE_QUERIES.length + 2 * 2;

/** Models that still need the (non-required) `none` diagnostic: only those not yet verified. */
export function probeDiagnosticModels(models: { analyst: string; skeptic: string }): string[] {
  return [...new Set([models.analyst, models.skeptic])].filter(needsReasoningOffDiagnostic);
}

/**
 * Per-run HTTP limits of the probe: logical calls × maximum HTTP attempts per call (retry policy). Finite, and
 * a retried 5xx can no longer starve the second logical search.
 */
export function probeRateLimits(models: { analyst: string; skeptic: string }, policy: Pick<RetryPolicy, 'maxRetries'>): { search: number; read: number; llm: number } {
  const per = maxHttpAttempts(policy);
  return { search: PROBE_QUERIES.length * per, read: 0, llm: (4 + probeDiagnosticModels(models).length) * per };
}

const miniSchema = z.strictObject({ ok: z.boolean(), word: z.string().max(40) });
const MINI_PROMPT = 'Верни JSON-объект: ok=true и word — одно любое слово.';
const MINI_ANSWER_TOKENS = 60;

export interface ProbeCheck {
  check: string;
  ok: boolean;
  /** Required checks decide the probe; diagnostics only inform. */
  required: boolean;
  detail: string;
}

export type ReasoningOffOutcome = 'disabled' | 'ignored' | 'rejected' | 'inconclusive';

export async function runProbe(bundle: Pick<LiveBundle, 'providers' | 'chat'>, models: { analyst: string; skeptic: string }, ctx: CallContext): Promise<ProbeCheck[]> {
  const out: ProbeCheck[] = [];
  const guard = async (check: string, f: () => Promise<string>) => {
    try {
      out.push({ check, ok: true, required: true, detail: await f() });
    } catch (e) {
      if (e instanceof ProviderAuthError) throw e; // credentials/roles wrong: stop everything
      if (e instanceof InvalidModelOutput || e instanceof RateLimited) out.push({ check, ok: false, required: true, detail: e.message.slice(0, 400) });
      else throw e;
    }
  };
  for (const q of PROBE_QUERIES) {
    await guard(`search:${q.region}`, async () => {
      const hits = await bundle.providers.search.search(q.query, q.region, ctx);
      if (hits.length === 0) throw new InvalidModelOutput(`поиск «${q.query}» вернул 0 документов — проверьте разбор XML по сохранённому сырому ответу`);
      return `${hits.length} документов; первый: ${hits[0]!.url}`;
    });
  }
  for (const [role, model] of [['analyst', models.analyst], ['skeptic', models.skeptic]] as const) {
    await guard(`transport:${role}:${model}`, async () => {
      const r = await bundle.chat.ping(ctx, model);
      if (!r.meta.transportOk) throw new InvalidModelOutput('ответ без usage — стоимость не сверяется');
      const gen = r.meta.contentGenerated
        ? `генерация содержимого: да («${r.content}»)`
        : `генерация содержимого: НЕТ — ${r.meta.reasoningExhausted ? 'рассуждение израсходовало лимит' : 'content пуст или обрезан'} (это не считается ответом)`;
      return `транспорт ✔ (HTTP 200, usage есть); ${gen}; ${describeMeta(r.meta)}`;
    });
    await guard(`mini-schema:${role}:${model}`, async () => {
      const { value, meta, plan } = await bundle.chat.completeWithMeta(ctx, { model, task: 'probe_schema', system: MINI_PROMPT, data: {}, schema: miniSchema, wire: miniSchema, answerTokens: MINI_ANSWER_TOKENS });
      return `валидный JSON в content по мини-схеме (ok=${value.ok}); политика: ${plan.why}; ${describeMeta(meta)}`;
    });
  }
  for (const [role, model] of [['analyst', models.analyst], ['skeptic', models.skeptic]] as const) {
    if (!needsReasoningOffDiagnostic(model)) continue; // already verified: never pay for it again
    const check = `reasoning-off:${role}:${model}`;
    try {
      const outcome = await reasoningOffDiagnostic(bundle, model, ctx);
      out.push({ check, ok: outcome.outcome === 'disabled', required: false, detail: `${outcome.outcome}: ${outcome.detail} (диагностика, не влияет на итог пробы)` });
    } catch (e) {
      if (e instanceof ProviderAuthError) throw e;
      if (e instanceof RateLimited || e instanceof InvalidModelOutput) out.push({ check, ok: false, required: false, detail: `inconclusive: ${e.message.slice(0, 300)} (диагностика, не влияет на итог пробы)` });
      else throw e;
    }
  }
  return out;
}

/**
 * One call with `reasoning_effort: "none"`:
 *  - disabled: accepted, no reasoning (no reasoning_content, reasoning_tokens 0 or absent) and valid JSON in content;
 *  - ignored: accepted but reasoning still present;
 *  - rejected: a 4xx naming the parameter;
 *  - inconclusive: accepted, no reasoning, but no valid JSON.
 */
export async function reasoningOffDiagnostic(bundle: Pick<LiveBundle, 'chat'>, model: string, ctx: CallContext): Promise<{ outcome: ReasoningOffOutcome; detail: string }> {
  try {
    const { meta } = await bundle.chat.completeWithMeta(ctx, { model, task: 'probe_schema', system: MINI_PROMPT, data: {}, schema: miniSchema, wire: miniSchema, answerTokens: MINI_ANSWER_TOKENS, forceEffort: 'none' });
    const reasoned = meta.reasoningChars > 0 || (meta.reasoningTokens ?? 0) > 0;
    return reasoned ? { outcome: 'ignored', detail: `параметр принят, но модель рассуждала; ${describeMeta(meta)}` } : { outcome: 'disabled', detail: `рассуждений нет, валидный JSON; ${describeMeta(meta)}` };
  } catch (e) {
    if (e instanceof ReasoningModeUnsupported) return { outcome: 'rejected', detail: e.message.slice(0, 300) };
    if (e instanceof InvalidModelOutput) {
      // Reasoning that ate the (small) budget means the parameter was ignored.
      if (/рассуждение израсходовало/.test(e.message)) return { outcome: 'ignored', detail: e.message.slice(0, 300) };
      return { outcome: 'inconclusive', detail: e.message.slice(0, 300) };
    }
    throw e;
  }
}
