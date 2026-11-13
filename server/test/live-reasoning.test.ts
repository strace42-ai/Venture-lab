// @vitest-environment node
/**
 * VL-004B-reasoning — reasoning-aware AI Studio adapter, offline.
 * REAL: the four responses in `recordings/ai-studio-reasoning-2026-11-13.json` (authorised probe, attempt 2).
 * CONSTRUCTED (marked below): «reasoning switched off» and «mode rejected» — no real response exists yet; their
 * shape follows the recorded ones (OpenAI-compatible chat.completion / error body).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AIStudioChat, OfferExtractor, ReasoningModeUnsupported, YandexAnalyst, YandexSkeptic, completionMeta } from '../live/ai-studio';
import { loadLiveConfig } from '../live/config';
import type { TransportRequest, TransportResponse, Transport } from '../live/net/transport';
import { inputTokenBound, llmCostKop, llmWorstCaseKop, tariffFor } from '../live/prices';
import { reasoningOffDiagnostic, runProbe } from '../live/probe';
import { ProviderCaller } from '../live/provider-http';
import { OPERATION_REASONING, planReasoning, REASONING_PROFILES } from '../live/reasoning';
import { RecordedProviders, TEST_ENV } from '../live/recordings/mock';
import { SEEDS } from '../live/recordings/world';
import { BillingAnomaly, CallContext, InvalidModelOutput, ProviderUnavailable } from '../machine/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const REC = JSON.parse(readFileSync(join(__dirname, '../live/recordings/ai-studio-reasoning-2026-11-13.json'), 'utf8')) as Record<string, { request_max_tokens: number; status: number; response: Json }>;
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

describe('reasoning_effort = none (diagnostic only, never sent in production while unverified)', () => {
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
    // without a requested mode the classifier is not applied
    await expect(chatOver(t2).complete(ctx(), req(QWEN))).rejects.toBeInstanceOf(ProviderUnavailable);
  });
});

describe('policy per model and operation', () => {
  const saved = structuredClone(REASONING_PROFILES[QWEN]!);
  afterEach(() => {
    REASONING_PROFILES[QWEN] = structuredClone(saved);
  });

  it('both models: disabling is UNVERIFIED → no reasoning_effort; max_tokens = answer + reserve', () => {
    for (const m of [QWEN, DEEPSEEK]) {
      expect(REASONING_PROFILES[m]!.disable).toBe('unverified');
      for (const op of Object.keys(OPERATION_REASONING) as (keyof typeof OPERATION_REASONING)[]) {
        const p = planReasoning(m, op, 500);
        expect(p.effort).toBeNull();
        expect(p.maxTokens).toBe(500 + OPERATION_REASONING[op].reasoningReserve);
      }
    }
    expect(planReasoning('unknown-model', 'extract_offer', 700)).toMatchObject({ effort: null, maxTokens: 700 + 2048 });
  });

  it('once verified: simple JSON operations send «none» without reserve; reasoned operations keep the reserve', () => {
    REASONING_PROFILES[QWEN]!.disable = 'verified';
    expect(planReasoning(QWEN, 'extract_offer', 700)).toMatchObject({ effort: 'none', maxTokens: 700, mode: 'off' });
    expect(planReasoning(QWEN, 'probe_schema', 60)).toMatchObject({ effort: 'none', maxTokens: 60 });
    expect(planReasoning(QWEN, 'analyse_candidate', 2000)).toMatchObject({ effort: null, maxTokens: 2000 + 4096 });
    expect(planReasoning(QWEN, 'discover_seeds', 2000)).toMatchObject({ effort: null, maxTokens: 6096 });
    REASONING_PROFILES[QWEN]!.disable = 'unsupported';
    expect(planReasoning(QWEN, 'extract_offer', 700)).toMatchObject({ effort: null, maxTokens: 2748 });
  });

  it('pipeline operations send the planned max_tokens (extract_offer, discovery, analyse_candidate, skeptic_challenge)', async () => {
    const t = new RecordedProviders();
    const chat = new AIStudioChat(new ProviderCaller({ transport: t, sleep: async () => {} }), cfg);
    const seed = SEEDS.guest!;
    await new OfferExtractor(chat, QWEN).extract(ctx(), { url: 'https://x.example.com/', title: null, text: 'текст' }, seed);
    const analyst = new YandexAnalyst(chat, QWEN, cfg);
    await analyst.discover('2026-11-13', [], ctx(), [{ url: 'https://touchstay.com/', title: 'Touch Stay', snippet: 's', region: 'world', query: 'q', rank: 1 } as never]);
    await analyst.analyse(seed, '2026-11-13', ctx(), [{ url: 'https://touchstay.com/', title: 't', excerpt: 'e', region: 'world' } as never]).catch(() => undefined);
    await new YandexSkeptic(chat, DEEPSEEK, cfg).challenge({ seed, claims: [], sources: [], rawCompetitors: [], proposal: { claims: [] }, ruQueryCount: 0 } as never, ctx()).catch(() => undefined);
    const sent = Object.fromEntries(t.llmCalls.map((c) => [c.task, c.body as Json]));
    expect(sent.extract_offer.max_tokens).toBe(700 + 2048);
    expect(sent.discover_seeds.max_tokens).toBe(cfg.llmMaxTokens + 4096);
    expect(sent.analyse_candidate.max_tokens).toBe(cfg.llmMaxTokens + 4096);
    expect(sent.skeptic_challenge.max_tokens).toBe(cfg.llmMaxTokens + 4096);
    for (const b of Object.values(sent) as Json[]) expect(b.reasoning_effort).toBeUndefined();
  });
});

describe('money: the reservation covers reasoning', () => {
  it('worst case uses max_tokens incl. the reserve, so it bounds any reply with completion_tokens ≤ max_tokens', () => {
    const t = tariffFor(QWEN)!;
    const msgs = [{ role: 'system', content: 'x'.repeat(500) }, { role: 'user', content: 'y'.repeat(500) }];
    const plan = planReasoning(QWEN, 'probe_schema', 60);
    const worst = llmWorstCaseKop(t, msgs, plan.maxTokens);
    // any reply within the bounds (prompt ≤ byte bound, completion incl. reasoning ≤ max_tokens) costs ≤ the reservation
    expect(worst).toBeGreaterThanOrEqual(llmCostKop(t, { input: inputTokenBound(msgs), output: plan.maxTokens }));
    expect(worst).toBeGreaterThanOrEqual(llmCostKop(t, { input: 137, output: 60 + 1024 }));
    expect(worst).toBeGreaterThan(llmWorstCaseKop(t, msgs, 60)); // the reserve is paid for in the reservation
  });

  it('a reply claiming more completion tokens than max_tokens is a billing anomaly: further calls are refused', async () => {
    const r = structuredClone(REC.deepseek_schema_ok!.response);
    r.usage.completion_tokens = 50_000;
    const c = ctx();
    await chatOver(new Replay([ok(r)])).complete(c, req(DEEPSEEK)).catch(() => undefined);
    expect(c.anomaly).not.toBeNull();
    await expect(chatOver(new Replay([ok(REC.deepseek_schema_ok!.response)])).complete(c, req(DEEPSEEK))).rejects.toBeInstanceOf(BillingAnomaly);
  });
});

describe('probe report: transport ≠ content generation', () => {
  it('replaying the real 13.11.2026 responses: Qwen transport passes but says «no content», Qwen mini-schema fails with the reason', async () => {
    const search = { search: async () => [{ url: 'https://touchstay.com/', title: 't', snippet: 's' }] } as never;
    const t = new Replay([
      ok(REC.qwen_ping_reasoning_exhausted!.response),
      ok(REC.qwen_schema_reasoning_exhausted!.response),
      ok(REC.deepseek_ping_ok!.response),
      ok(REC.deepseek_schema_ok!.response),
      ok(REC.qwen_schema_reasoning_exhausted!.response),
      ok(disabledResponse(DEEPSEEK)),
    ]);
    const checks = await runProbe({ providers: { search } as never, chat: chatOver(t) }, { analyst: QWEN, skeptic: DEEPSEEK }, ctx());
    const by = Object.fromEntries(checks.map((c) => [c.check, c]));
    expect(by[`transport:analyst:${QWEN}`]).toMatchObject({ ok: true, required: true });
    expect(by[`transport:analyst:${QWEN}`]!.detail).toMatch(/транспорт ✔.*генерация содержимого: НЕТ — рассуждение израсходовало лимит/);
    expect(by[`mini-schema:analyst:${QWEN}`]).toMatchObject({ ok: false, required: true });
    expect(by[`mini-schema:analyst:${QWEN}`]!.detail).toMatch(/рассуждение израсходовало весь max_tokens/);
    expect(by[`transport:skeptic:${DEEPSEEK}`]!.detail).toMatch(/генерация содержимого: да/);
    expect(by[`mini-schema:skeptic:${DEEPSEEK}`]).toMatchObject({ ok: true });
    expect(by[`reasoning-off:analyst:${QWEN}`]).toMatchObject({ required: false, ok: false });
    expect(by[`reasoning-off:analyst:${QWEN}`]!.detail).toMatch(/^ignored/);
    expect(by[`reasoning-off:skeptic:${DEEPSEEK}`]).toMatchObject({ required: false, ok: true });
    // what was sent: ping 16, mini-schema 60 + 1024 reserve, diagnostics 60 with «none»
    expect(t.bodies.map((b) => [b.max_tokens, b.reasoning_effort ?? null])).toEqual([[16, null], [1084, null], [16, null], [1084, null], [60, 'none'], [60, 'none']]);
  });
});
