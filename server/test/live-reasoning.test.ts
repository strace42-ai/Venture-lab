// @vitest-environment node
/**
 * VL-004B-reasoning — reasoning-aware AI Studio adapter, offline.
 * REAL: the four responses in `recordings/ai-studio-reasoning-2026-11-13.json` (authorised probe, attempt 2).
 * CONSTRUCTED (marked below): «reasoning switched off» and «mode rejected» — no real response exists yet; their
 * shape follows the recorded ones (OpenAI-compatible chat.completion / error body).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AIStudioChat, OfferExtractor, ReasoningModeUnsupported, YandexAnalyst, YandexSkeptic, completionMeta } from '../live/ai-studio';
import { DEFAULT_RETRY } from '../live/provider-http';
import { loadLiveConfig } from '../live/config';
import type { TransportRequest, TransportResponse, Transport } from '../live/net/transport';
import { inputTokenBound, llmCostKop, llmWorstCaseKop, tariffFor } from '../live/prices';
import { probeRateLimits, reasoningOffDiagnostic, runProbe } from '../live/probe';
import { ProviderCaller } from '../live/provider-http';
import { DEFAULT_REASONING_RESERVE, needsReasoningOffDiagnostic, planReasoning, REASONING_POLICY, REASONING_PROFILES, type LlmOperation } from '../live/reasoning';
import { RecordedProviders, TEST_ENV } from '../live/recordings/mock';
import { SEEDS } from '../live/recordings/world';
import { BillingAnomaly, CallContext, InvalidModelOutput, ProviderUnavailable } from '../machine/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const REC = JSON.parse(readFileSync(join(__dirname, '../live/recordings/ai-studio-reasoning-2026-11-13.json'), 'utf8')) as Record<string, { request_max_tokens: number; request_reasoning_effort?: string | null; status: number; response: Json }>;
const cfg = loadLiveConfig(TEST_ENV);
const QWEN = 'qwen3.6-35b-a3b';
const DEEPSEEK = 'deepseek-v4.1-flash';
const mini = z.strictObject({ ok: z.boolean(), word: z.string().max(40) });

/** Replays fixed AI Studio responses in order and records every request body. */
class Replay implements Transport {
  readonly bodies: Json[] = [];
  constructor(private readonly responses: { status: number; body: Json }[]) {}
  async request(req: TransportRequest): Promise<TransportResponse> {
    this.bodies.push(JSON.parse(req.body ?? '{}'));
    const r = this.responses[Math.min(this.bodies.length - 1, this.responses.length - 1)]!;
    return { status: r.status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(r.body)), truncated: false };
  }
}
const chatOver = (t: Transport) => new AIStudioChat(new ProviderCaller({ transport: t, sleep: async () => {}, random: () => 0.5 }), cfg);
const ctx = () => new CallContext('t', 1, 1_000_000);
const ok = (body: Json) => ({ status: 200, body });
const req = (model: string, extra: Record<string, unknown> = {}) => ({ model, task: 'probe_schema' as const, system: 'Верни JSON', data: {}, schema: mini, wire: mini, answerTokens: 60, ...extra });

/** CONSTRUCTED: a successful «reasoning off» answer — no reasoning_content, reasoning_tokens 0. */
const disabledResponse = (model: string) => ({
  id: 'chatcmpl-constructed-off',
  object: 'chat.completion',
  model: `gpt://${model}/latest`,
  choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true,"word":"тест"}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129, completion_tokens_details: { reasoning_tokens: 0 } },
});
/** CONSTRUCTED: a 400 naming the parameter (OpenAI-compatible error body). */
const rejectedBody = { error: { message: "Invalid value for 'reasoning_effort': 'none' is not supported for this model", type: 'invalid_request_error', param: 'reasoning_effort' } };

describe('real recorded shapes (probe 13.11.2026)', () => {
  it('Qwen: reasoning_content filled, content null, finish_reason=length → NOT a result; reasoning never used as the answer', async () => {
    const t = new Replay([ok(REC.qwen_schema_reasoning_exhausted!.response)]);
    const c = ctx();
    const p = chatOver(t).complete(c, req(QWEN));
    await expect(p).rejects.toBeInstanceOf(InvalidModelOutput);
    await expect(chatOver(new Replay([ok(REC.qwen_schema_reasoning_exhausted!.response)])).complete(ctx(), req(QWEN))).rejects.toThrow(/рассуждение израсходовало весь max_tokens/);
    // the call is still billed from usage (60 completion tokens incl. reasoning)
    expect(c.usage[0]).toMatchObject({ reconciliation: 'reconciled', tokensOut: 60 });
  });

  it('meta of the real Qwen ping: transport OK, NO content generated, reasoning exhausted', () => {
    const m = completionMeta(REC.qwen_ping_reasoning_exhausted!.response, 'probe_transport', { effort: null, maxTokens: 16 });
    expect(m).toMatchObject({ transportOk: true, contentGenerated: false, reasoningExhausted: true, finishReason: 'length', contentChars: 0, completionTokens: 16 });
  });

  it('DeepSeek: non-empty valid JSON in content passes; reasoning tokens are part of completion_tokens and billed', async () => {
    const t = new Replay([ok(REC.deepseek_schema_ok!.response)]);
    const c = ctx();
    const { value, meta } = await chatOver(t).completeWithMeta(c, req(DEEPSEEK));
    expect(value).toEqual({ ok: true, word: 'пример' });
    expect(meta).toMatchObject({ reasoningTokens: 41, completionTokens: 52, contentGenerated: true, reasoningExhausted: false });
    // ledger 13.11.2026: 12 kop = (286 × 0.30 + 52 × 0.50) / 1000 ₽ rounded up
    expect(c.usage[0]).toMatchObject({ reconciliation: 'reconciled', cost: 12, tokensOut: 52 });
    expect(c.usage[0]!.estimatedCost).toBeGreaterThanOrEqual(12);
  });
});

describe('content is the only answer', () => {
  it('finish_reason=length with partial content is truncated, not a result', async () => {
    const r = structuredClone(REC.deepseek_schema_ok!.response);
    r.choices[0].message.content = '{"ok":tr';
    r.choices[0].finish_reason = 'length';
    await expect(chatOver(new Replay([ok(r)])).complete(ctx(), req(DEEPSEEK))).rejects.toThrow(/обрезан по max_tokens/);
  });

  it('valid JSON only inside reasoning_content + empty content → refused', async () => {
    const r = structuredClone(REC.deepseek_schema_ok!.response);
    r.choices[0].message.reasoning_content = '{"ok":true,"word":"из-рассуждения"}';
    r.choices[0].message.content = '';
    await expect(chatOver(new Replay([ok(r)])).complete(ctx(), req(DEEPSEEK))).rejects.toThrow(/пустой content.*reasoning_content не используется/);
  });
});

describe('reasoning_effort = none diagnostic (for models not yet verified)', () => {
  it('CONSTRUCTED success: accepted, no reasoning → «disabled»; request carried reasoning_effort=none and max_tokens 60', async () => {
    const t = new Replay([ok(disabledResponse(QWEN))]);
    const r = await reasoningOffDiagnostic({ chat: chatOver(t) }, QWEN, ctx());
    expect(r.outcome).toBe('disabled');
    expect(t.bodies[0]).toMatchObject({ reasoning_effort: 'none', max_tokens: 60 });
  });

  it('REAL shape when the parameter is ignored (reasoning still present) → «ignored»', async () => {
    const t = new Replay([ok(REC.qwen_schema_reasoning_exhausted!.response)]);
    expect((await reasoningOffDiagnostic({ chat: chatOver(t) }, QWEN, ctx())).outcome).toBe('ignored');
    const t2 = new Replay([ok(REC.deepseek_schema_ok!.response)]);
    expect((await reasoningOffDiagnostic({ chat: chatOver(t2) }, DEEPSEEK, ctx())).outcome).toBe('ignored');
  });

  it('CONSTRUCTED rejection (HTTP 400 naming reasoning_effort) → ReasoningModeUnsupported / «rejected», not retried, worst case kept', async () => {
    const t = new Replay([{ status: 400, body: rejectedBody }]);
    const c = ctx();
    await expect(chatOver(t).complete(c, req(QWEN, { forceEffort: 'none' }))).rejects.toBeInstanceOf(ReasoningModeUnsupported);
    expect(t.bodies).toHaveLength(1);
    expect(c.usage[0]).toMatchObject({ reconciliation: 'unknown', httpStatus: 400 });
    const t2 = new Replay([{ status: 400, body: rejectedBody }]);
    expect((await reasoningOffDiagnostic({ chat: chatOver(t2) }, QWEN, ctx())).outcome).toBe('rejected');
  });

  it('a 400 that does not name reasoning stays a generic provider error', async () => {
    const t = new Replay([{ status: 400, body: { error: { message: 'bad schema' } } }]);
    await expect(chatOver(t).complete(ctx(), req(QWEN, { forceEffort: 'none' }))).rejects.toBeInstanceOf(ProviderUnavailable);
    const t2 = new Replay([{ status: 400, body: rejectedBody }]);
    // without a requested mode (unverified model → no reasoning_effort) the classifier is not applied
    await withUnverified(() => expect(chatOver(t2).complete(ctx(), req(QWEN))).rejects.toBeInstanceOf(ProviderUnavailable));
  });
});

/** Temporarily mark both models' «none» as unverified (the state before 13.11 attempt 3). */
function withUnverified<T>(f: () => Promise<T> | T): Promise<T> {
  const saved = { q: REASONING_PROFILES[QWEN]!.disable, d: REASONING_PROFILES[DEEPSEEK]!.disable };
  REASONING_PROFILES[QWEN]!.disable = 'unverified';
  REASONING_PROFILES[DEEPSEEK]!.disable = 'unverified';
  return Promise.resolve()
    .then(f)
    .finally(() => {
      REASONING_PROFILES[QWEN]!.disable = saved.q;
      REASONING_PROFILES[DEEPSEEK]!.disable = saved.d;
    });
}

describe('verified «none» (real responses of 13.11.2026, attempt 3)', () => {
  it('both models are verified with recorded evidence', () => {
    expect(REASONING_PROFILES[QWEN]).toMatchObject({ disable: 'verified' });
    expect(REASONING_PROFILES[DEEPSEEK]).toMatchObject({ disable: 'verified' });
    expect(REC.a3_qwen_none_ok!.request_reasoning_effort).toBe('none');
    expect(REC.a3_deepseek_none_ok!.request_reasoning_effort).toBe('none');
  });

  it('REAL: Qwen with «none» → valid JSON in content, no reasoning, finish stop', async () => {
    const t = new Replay([ok(REC.a3_qwen_none_ok!.response)]);
    const c = ctx();
    const { value, meta, plan } = await chatOver(t).completeWithMeta(c, req(QWEN));
    expect(value).toEqual({ ok: true, word: 'example' });
    expect(plan).toMatchObject({ effort: 'none', maxTokens: 60 });
    expect(meta).toMatchObject({ finishReason: 'stop', reasoningChars: 0, contentGenerated: true, completionTokens: 12 });
    expect(t.bodies[0]).toMatchObject({ reasoning_effort: 'none', max_tokens: 60 });
    expect(c.usage[0]).toMatchObject({ reconciliation: 'reconciled', tokensOut: 12 });
  });

  it('REAL: DeepSeek with «none» → valid JSON, reasoning_tokens 0', async () => {
    const t = new Replay([ok(REC.a3_deepseek_none_ok!.response)]);
    const { value, meta } = await chatOver(t).completeWithMeta(ctx(), req(DEEPSEEK));
    expect(value).toEqual({ ok: true, word: 'пример' });
    expect(meta).toMatchObject({ reasoningTokens: 0, finishReason: 'stop', contentGenerated: true });
  });

  it('REAL: Qwen with reasoning ON spent 1084/1084 tokens — exactly why every Qwen pilot operation is «none»', async () => {
    await expect(chatOver(new Replay([ok(REC.a3_qwen_schema_reasoning_1084_exhausted!.response)])).complete(ctx(), req(QWEN))).rejects.toThrow(/рассуждение израсходовало весь max_tokens/);
  });

  it('a «none» reply that still runs out of tokens is rejected (no silent acceptance)', async () => {
    const r = structuredClone(REC.a3_qwen_none_ok!.response);
    r.choices[0].message.content = '{"ok": tr';
    r.choices[0].finish_reason = 'length';
    await expect(chatOver(new Replay([ok(r)])).complete(ctx(), req(QWEN))).rejects.toThrow(/обрезан по max_tokens/);
  });

  it('schema stays strict with reasoning off: an extra field or a wrong type is refused', async () => {
    const r = structuredClone(REC.a3_qwen_none_ok!.response);
    r.choices[0].message.content = '{"ok":"yes","word":"x","extra":1}';
    await expect(chatOver(new Replay([ok(r)])).complete(ctx(), req(QWEN))).rejects.toBeInstanceOf(InvalidModelOutput);
  });
});

describe('policy per (model, operation)', () => {
  const ALL: LlmOperation[] = ['probe_transport', 'probe_schema', 'extract_offer', 'discover_seeds', 'analyse_candidate', 'skeptic_challenge'];

  it('Qwen: «none» in every pilot operation, incl. the 16-token ping; max_tokens = answer tokens', () => {
    for (const op of ['probe_transport', 'probe_schema', 'extract_offer', 'discover_seeds', 'analyse_candidate'] as const) {
      expect(planReasoning(QWEN, op, 500), op).toMatchObject({ effort: 'none', maxTokens: 500, reserve: 0 });
    }
  });

  it('DeepSeek: «none» for simple operations; skeptic_challenge keeps reasoning with a 4096 reserve', () => {
    for (const op of ['probe_transport', 'probe_schema', 'extract_offer'] as const) expect(planReasoning(DEEPSEEK, op, 60)).toMatchObject({ effort: 'none', maxTokens: 60 });
    expect(planReasoning(DEEPSEEK, 'skeptic_challenge', 2000)).toMatchObject({ effort: null, maxTokens: 6096, reserve: 4096 });
    // not in the table → reasoning ON with the default reserve
    expect(planReasoning(DEEPSEEK, 'analyse_candidate', 2000)).toMatchObject({ effort: null, maxTokens: 2000 + DEFAULT_REASONING_RESERVE.analyse_candidate });
  });

  it('a pair asking for «none» falls back to reasoning ON + reserve when the model is not verified (no global switch)', async () => {
    await withUnverified(() => {
      for (const op of ALL) expect(planReasoning(QWEN, op, 100).effort, op).toBeNull();
      expect(planReasoning(QWEN, 'extract_offer', 700)).toMatchObject({ maxTokens: 2748 });
      expect(planReasoning(QWEN, 'probe_transport', 16)).toMatchObject({ maxTokens: 16 });
    });
    REASONING_PROFILES[QWEN]!.disable = 'unsupported';
    try {
      expect(planReasoning(QWEN, 'analyse_candidate', 2000)).toMatchObject({ effort: null, maxTokens: 6096 });
      // the other model is unaffected: policy is per pair
      expect(planReasoning(DEEPSEEK, 'probe_schema', 60)).toMatchObject({ effort: 'none' });
    } finally {
      REASONING_PROFILES[QWEN]!.disable = 'verified';
    }
  });

  it('unknown model: reasoning ON with the default reserve, never «none»', () => {
    for (const op of ALL) expect(planReasoning('some-new-model', op, 100)).toMatchObject({ effort: null, maxTokens: 100 + DEFAULT_REASONING_RESERVE[op] });
    expect(REASONING_POLICY['some-new-model']).toBeUndefined();
  });

  it('pipeline operations send the planned request (extract_offer, discovery, analyse_candidate, skeptic_challenge)', async () => {
    const t = new RecordedProviders();
    const chat = new AIStudioChat(new ProviderCaller({ transport: t, sleep: async () => {} }), cfg);
    const seed = SEEDS.guest!;
    await new OfferExtractor(chat, QWEN).extract(ctx(), { url: 'https://x.example.com/', title: null, text: 'текст' }, seed);
    const analyst = new YandexAnalyst(chat, QWEN, cfg);
    await analyst.discover('2026-11-13', [], ctx(), [{ url: 'https://touchstay.com/', title: 'Touch Stay', snippet: 's', region: 'world', query: 'q', rank: 1 } as never]);
    await analyst.analyse(seed, '2026-11-13', ctx(), [{ url: 'https://touchstay.com/', title: 't', excerpt: 'e', region: 'world' } as never]).catch(() => undefined);
    await new YandexSkeptic(chat, DEEPSEEK, cfg).challenge({ seed, claims: [], sources: [], rawCompetitors: [], proposal: { claims: [] }, ruQueryCount: 0 } as never, ctx()).catch(() => undefined);
    const sent = Object.fromEntries(t.llmCalls.map((c) => [c.task, c.body as Json])) as Record<string, Json>;
    expect([sent.extract_offer.max_tokens, sent.extract_offer.reasoning_effort]).toEqual([700, 'none']);
    expect([sent.discover_seeds.max_tokens, sent.discover_seeds.reasoning_effort]).toEqual([cfg.llmMaxTokens, 'none']);
    expect([sent.analyse_candidate.max_tokens, sent.analyse_candidate.reasoning_effort]).toEqual([cfg.llmMaxTokens, 'none']);
    expect([sent.skeptic_challenge.max_tokens, sent.skeptic_challenge.reasoning_effort]).toEqual([cfg.llmMaxTokens + 4096, undefined]);
  });
});

describe('money: reservation and overspend protection', () => {
  it('reasoning ON (skeptic): the reservation uses max_tokens incl. the reserve, so it bounds any reply ≤ max_tokens', () => {
    const t = tariffFor(DEEPSEEK)!;
    const msgs = [{ role: 'system', content: 'x'.repeat(500) }, { role: 'user', content: 'y'.repeat(500) }];
    const plan = planReasoning(DEEPSEEK, 'skeptic_challenge', 2000);
    const worst = llmWorstCaseKop(t, msgs, plan.maxTokens);
    expect(worst).toBeGreaterThanOrEqual(llmCostKop(t, { input: inputTokenBound(msgs), output: plan.maxTokens }));
    expect(worst).toBeGreaterThan(llmWorstCaseKop(t, msgs, 2000)); // the reserve is paid for in the reservation
  });

  it('reasoning OFF: reservation = answer tokens only, and the real «none» replies stay far below it', async () => {
    const c = ctx();
    await chatOver(new Replay([ok(REC.a3_qwen_none_ok!.response)])).complete(c, req(QWEN));
    await chatOver(new Replay([ok(REC.a3_deepseek_none_ok!.response)])).complete(c, req(DEEPSEEK));
    for (const u of c.usage) expect(u.cost).toBeLessThanOrEqual(u.estimatedCost!);
    expect(c.usage.map((u) => u.reconciliation)).toEqual(['reconciled', 'reconciled']);
  });

  it('a reply claiming more completion tokens than max_tokens is a billing anomaly: further calls are refused', async () => {
    const r = structuredClone(REC.deepseek_schema_ok!.response);
    r.usage.completion_tokens = 50_000;
    const c = ctx();
    await chatOver(new Replay([ok(r)])).complete(c, req(DEEPSEEK)).catch(() => undefined);
    expect(c.anomaly).not.toBeNull();
    await expect(chatOver(new Replay([ok(REC.a3_deepseek_none_ok!.response)])).complete(c, req(DEEPSEEK))).rejects.toBeInstanceOf(BillingAnomaly);
  });

  it('the job budget still caps everything: a call whose reservation exceeds the remaining budget is never sent', async () => {
    const t = new Replay([ok(REC.a3_qwen_none_ok!.response)]);
    const tiny = new CallContext('t', 1, 1);
    await expect(chatOver(t).complete(tiny, req(QWEN))).rejects.toThrow(/бюджет исчерпан/);
    expect(t.bodies).toHaveLength(0);
  });
});

describe('probe', () => {
  const search = { search: async () => [{ url: 'https://touchstay.com/', title: 't', snippet: 's' }] } as never;
  /** CONSTRUCTED: a «none» ping answer (no real «none» ping exists yet). */
  const pingNone = (model: string) => ({ ...disabledResponse(model), choices: [{ index: 0, message: { role: 'assistant', content: 'ок' }, finish_reason: 'stop' }] });

  it('verified models: 4 LLM calls, all with «none» (16 / 60 tokens), no diagnostics — nothing paid twice; all 6 required pass', async () => {
    const t = new Replay([ok(pingNone(QWEN)), ok(REC.a3_qwen_none_ok!.response), ok(pingNone(DEEPSEEK)), ok(REC.a3_deepseek_none_ok!.response)]);
    const checks = await runProbe({ providers: { search } as never, chat: chatOver(t) }, { analyst: QWEN, skeptic: DEEPSEEK }, ctx());
    expect(checks.map((c) => `${c.check}:${c.ok}:${c.required}`)).toEqual([
      'search:ru:true:true', 'search:world:true:true',
      `transport:analyst:${QWEN}:true:true`, `mini-schema:analyst:${QWEN}:true:true`,
      `transport:skeptic:${DEEPSEEK}:true:true`, `mini-schema:skeptic:${DEEPSEEK}:true:true`,
    ]);
    expect(checks[2]!.detail).toMatch(/генерация содержимого: да/);
    expect(t.bodies.map((b) => [b.max_tokens, b.reasoning_effort ?? null])).toEqual([[16, 'none'], [60, 'none'], [16, 'none'], [60, 'none']]);
    expect(needsReasoningOffDiagnostic(QWEN) || needsReasoningOffDiagnostic(DEEPSEEK)).toBe(false);
    expect(probeRateLimits({ analyst: QWEN, skeptic: DEEPSEEK }, DEFAULT_RETRY)).toEqual({ search: 6, read: 0, llm: 12 });
  });

  it('(state before verification) replaying the real attempt-2 responses: transport ≠ content, Qwen schema fails with the reason, diagnostics run', async () => {
    await withUnverified(async () => {
      const t = new Replay([
        ok(REC.qwen_ping_reasoning_exhausted!.response),
        ok(REC.qwen_schema_reasoning_exhausted!.response),
        ok(REC.deepseek_ping_ok!.response),
        ok(REC.deepseek_schema_ok!.response),
        ok(REC.a3_qwen_none_ok!.response),
        ok(REC.a3_deepseek_none_ok!.response),
      ]);
      const checks = await runProbe({ providers: { search } as never, chat: chatOver(t) }, { analyst: QWEN, skeptic: DEEPSEEK }, ctx());
      const by = Object.fromEntries(checks.map((c) => [c.check, c]));
      expect(by[`transport:analyst:${QWEN}`]).toMatchObject({ ok: true, required: true });
      expect(by[`transport:analyst:${QWEN}`]!.detail).toMatch(/транспорт ✔.*генерация содержимого: НЕТ — рассуждение израсходовало лимит/);
      expect(by[`mini-schema:analyst:${QWEN}`]).toMatchObject({ ok: false, required: true });
      expect(by[`reasoning-off:analyst:${QWEN}`]!.detail).toMatch(/^disabled/);
      expect(by[`reasoning-off:skeptic:${DEEPSEEK}`]!.detail).toMatch(/^disabled/);
      expect(t.bodies.map((b) => [b.max_tokens, b.reasoning_effort ?? null])).toEqual([[16, null], [1084, null], [16, null], [1084, null], [60, 'none'], [60, 'none']]);
      expect(probeRateLimits({ analyst: QWEN, skeptic: DEEPSEEK }, DEFAULT_RETRY).llm).toBe(18);
    });
  });
});
