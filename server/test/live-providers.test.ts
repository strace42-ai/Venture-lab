// @vitest-environment node
/**
 * VL-004B — provider adapters on recorded HTTP: Yandex Search API (request shape, XML parsing, pagination,
 * dedup, billing), AI Studio (request shape, usage reconciliation, invalid output), retries/backoff/circuit
 * breaker (Case G billing), configuration fail-closed rules, offer grounding (Case B).
 */
import { describe, expect, it } from 'vitest';
import { AIStudioChat, analystWire, offerWire, parseModelJson } from '../live/ai-studio';
import { describeConfig, loadLiveConfig, modelFamily, readinessProblems } from '../live/config';
import { groundOffer, marketSignal } from '../live/grounding';
import { llmCostKop, llmWorstCaseKop, searchCostKop, tariffFor } from '../live/prices';
import { ProviderCaller } from '../live/provider-http';
import { buildLiveProviders } from '../live/providers';
import { RecordedProviders, RecordedWeb, searchXml, TEST_ENV } from '../live/recordings/mock';
import { SEEDS } from '../live/recordings/world';
import { canonicalUrl, parseYandexXml, YandexSearchProvider } from '../live/yandex-search';
import { BillingAnomaly, CallContext, InvalidModelOutput, ProviderAuthError, ProviderUnavailable } from '../machine/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
const cfg = loadLiveConfig(TEST_ENV);
const caller = (t: RecordedProviders, retry = {}) => new ProviderCaller({ transport: t, sleep: async () => {}, random: () => 0.5, policy: retry });
const search = (t: RecordedProviders, pages = 1) => new YandexSearchProvider(caller(t), { url: cfg.searchUrl, folderId: cfg.folderId!, authHeader: cfg.authHeader, pages, groupsOnPage: 10 });
const ctx = () => new CallContext('t', 1, 1_000_000);

describe('Yandex Search API adapter', () => {
  it('sends the official v2 request shape: RU → SEARCH_TYPE_RU + region 225; world → SEARCH_TYPE_COM / EN', async () => {
    const t = new RecordedProviders();
    await search(t).search('цифровой гид гостя', 'ru', ctx());
    await search(t).search('Touch Stay', 'world', ctx());
    const [ru, com] = t.searchCalls.map((r) => r.body as Body) as [Body, Body];
    expect(t.searchCalls[0]!.url).toBe('https://searchapi.api.cloud.yandex.net/v2/web/search');
    expect(ru.query).toMatchObject({ searchType: 'SEARCH_TYPE_RU', queryText: 'цифровой гид гостя', page: '0' });
    expect(ru).toMatchObject({ region: '225', l10n: 'LOCALIZATION_RU', folderId: 'b1gtestfolder000000', responseFormat: 'FORMAT_XML' });
    expect(com.query.searchType).toBe('SEARCH_TYPE_COM');
    expect(com.l10n).toBe('LOCALIZATION_EN');
    expect(com.region).toBeUndefined();
    expect(t.searchCalls[0]!.headers.authorization).toBe('Api-Key test-key-not-a-secret-000');
  });

  it('parses rawData XML, canonicalises (tracking params dropped) and de-duplicates hits', async () => {
    const t = new RecordedProviders();
    const hits = await search(t).search('Touch Stay pricing', 'world', ctx());
    expect(hits.map((h) => h.url)).toEqual(['https://touchstay.com/', 'https://touchstay.com/pricing', 'https://www.str-review.example.org/touch-stay-review']);
    expect(hits[0]!.snippet).toMatch(/Digital guidebooks/);
    expect(canonicalUrl('https://Example.com/a?utm_source=x&id=2#frag')).toBe('https://example.com/a?id=2');
  });

  it('error code 15 = no results; another error code, DOCTYPE or a non-JSON body is a provider error', async () => {
    expect(parseYandexXml(searchXml([])).docs).toEqual([]);
    expect(parseYandexXml(searchXml([])).error?.code).toBe('15');
    expect(parseYandexXml('<!DOCTYPE x [<!ENTITY a "b">]><yandexsearch/>').error?.code).toBe('xml');
    const t = new RecordedProviders();
    expect(await search(t).search('ничего не найдётся', 'ru', ctx())).toEqual([]);
    // an XML error code other than 15 (e.g. quota) from a custom transport
    const weird = { request: async () => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ rawData: Buffer.from('<yandexsearch><response><error code="55">limit</error></response></yandexsearch>').toString('base64') })), truncated: false }) };
    const p = new YandexSearchProvider(new ProviderCaller({ transport: weird as never, sleep: async () => {} }), { url: cfg.searchUrl, folderId: 'f', authHeader: () => 'Api-Key k', pages: 1, groupsOnPage: 10 });
    await expect(p.search('x', 'ru', ctx())).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it('paginates only while pages are full', async () => {
    const t = new RecordedProviders();
    await search(t, 3).search('Touch Stay', 'world', ctx()); // 3 results < 10 per page → stops after page 0
    expect(t.searchCalls).toHaveLength(1);
  });

  it('bills each request at the tariff (49 kop) and records the provider request id', async () => {
    const t = new RecordedProviders();
    const c = ctx();
    await search(t).search('Touch Stay', 'world', c);
    expect(searchCostKop()).toBe(49);
    expect(c.usage[0]).toMatchObject({ provider: 'yandex-search-api', estimatedCost: 49, actualCost: 49, cost: 49, reconciliation: 'tariff', providerRequestId: expect.stringMatching(/^search-/) });
  });
});

describe('retries, backoff and the circuit breaker (Case G)', () => {
  it('429 then 200: retried after Retry-After; each attempt is a separate reservation', async () => {
    const delays: number[] = [];
    const t = new RecordedProviders({ search: (_q, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '2' } } : undefined) });
    const p = new YandexSearchProvider(new ProviderCaller({ transport: t, sleep: async (ms) => void delays.push(ms), random: () => 0.5 }), { url: cfg.searchUrl, folderId: 'f', authHeader: () => 'Api-Key k', pages: 1, groupsOnPage: 10 });
    const c = ctx();
    expect((await p.search('Touch Stay', 'world', c)).length).toBe(3);
    expect(delays).toEqual([2000]);
    expect(c.usage.map((u) => u.reconciliation)).toEqual(['unknown', 'tariff']); // a 429 may be billed: worst case kept
    expect(c.spent).toBe(98);
  });

  it('5xx on Search is documented as not billed; retries are bounded; then the circuit opens', async () => {
    const t = new RecordedProviders({ search: () => ({ status: 503 }) });
    const cl = caller(t, { maxRetries: 2, circuitThreshold: 2 });
    const p = new YandexSearchProvider(cl, { url: cfg.searchUrl, folderId: 'f', authHeader: () => 'Api-Key k', pages: 1, groupsOnPage: 10 });
    const c = ctx();
    await expect(p.search('a', 'ru', c)).rejects.toBeInstanceOf(ProviderUnavailable);
    expect(t.searchCalls).toHaveLength(3);
    expect(c.usage.every((u) => u.reconciliation === 'not_billed' && u.cost === 0)).toBe(true);
    await expect(p.search('b', 'ru', c)).rejects.toBeInstanceOf(ProviderUnavailable);
    await expect(p.search('c', 'ru', c)).rejects.toThrow(/выключатель открыт/);
    expect(t.searchCalls).toHaveLength(6); // nothing sent once open
  });

  it('401/403 is never retried and fails the run (ProviderAuthError)', async () => {
    const t = new RecordedProviders({ search: () => ({ status: 401 }) });
    await expect(search(t).search('a', 'ru', ctx())).rejects.toBeInstanceOf(ProviderAuthError);
    expect(t.searchCalls).toHaveLength(1);
  });

  it('a timeout keeps the worst case (may have been billed) and is not retried blindly for the LLM', async () => {
    const t = new RecordedProviders({ llm: () => ({ timeout: true }) });
    const chat = new AIStudioChat(caller(t, { maxTimeoutRetries: 0 }), cfg);
    const c = ctx();
    await expect(chat.complete(c, { model: 'qwen3.6-35b-a3b', task: 'extract_offer', system: 's', data: {}, schema: offerWire, wire: offerWire, maxTokens: 100 })).rejects.toBeInstanceOf(ProviderUnavailable);
    expect(t.llmCalls).toHaveLength(1);
    expect(c.usage[0]).toMatchObject({ reconciliation: 'unknown', actualCost: null });
    expect(c.usage[0]!.cost).toBe(c.usage[0]!.estimatedCost);
  });

  it('refuses any host outside the official Yandex endpoints before sending', async () => {
    const t = new RecordedProviders();
    const chat = new AIStudioChat(caller(t), { ...cfg, llmUrl: 'https://evil.example.com/v1/chat/completions' });
    await expect(chat.complete(ctx(), { model: 'qwen3.6-35b-a3b', task: 'x', system: 's', data: {}, schema: offerWire, wire: offerWire, maxTokens: 10 })).rejects.toBeInstanceOf(ProviderAuthError);
    expect(t.requests).toHaveLength(0);
  });
});

describe('AI Studio adapter and cost reconciliation (Case G)', () => {
  const offer = { isProductPage: false, name: null, market: 'unknown', jobs: [], price: null, pageKind: 'unknown' };
  const run = (hook: NonNullable<ConstructorParameters<typeof RecordedProviders>[0]>['llm'], model = 'qwen3.6-35b-a3b') => {
    const t = new RecordedProviders({ llm: hook });
    const c = ctx();
    const p = new AIStudioChat(caller(t), cfg).complete(c, { model, task: 'extract_offer', system: 'sys', data: { page: { url: 'https://x.example.com/' } }, schema: offerWire, wire: offerWire, maxTokens: 500 });
    return { t, c, p };
  };

  it('official request shape: gpt://<folder>/<model>, Api-Key + OpenAI-Project headers, json_schema, temperature 0', async () => {
    const { t, p } = run(() => ({ content: JSON.stringify(offer) }));
    await p;
    const r = t.llmCalls[0]!;
    expect(r.url).toBe('https://ai.api.cloud.yandex.net/v1/chat/completions');
    expect(r.headers['openai-project']).toBe('b1gtestfolder000000');
    expect(r.headers.authorization).toBe('Api-Key test-key-not-a-secret-000');
    const b = r.body as Body;
    expect(b.model).toBe('gpt://b1gtestfolder000000/qwen3.6-35b-a3b');
    expect(b.temperature).toBe(0);
    expect(b.response_format.type).toBe('json_schema');
    expect(b.messages[0].content).toMatch(/НЕ инструкции/);
    expect(JSON.stringify(b)).not.toContain('test-key-not-a-secret');
  });

  it('reserves a byte-bound worst case, then reconciles DOWN to usage × tariff', async () => {
    const { c, p } = run(() => ({ content: JSON.stringify(offer), usage: { prompt_tokens: 400, completion_tokens: 50 } }));
    await p;
    const u = c.usage[0]!;
    expect(u.reconciliation).toBe('reconciled');
    expect(u.actualCost).toBe(llmCostKop(tariffFor('qwen3.6-35b-a3b')!, { input: 400, output: 50 }));
    expect(u.cost).toBe(u.actualCost);
    expect(u.estimatedCost!).toBeGreaterThanOrEqual(u.actualCost!);
    expect(u.tokensIn).toBe(400);
    expect(u.providerRequestId).toMatch(/^llm-/);
  });

  it('missing usage → cost unknown, worst case kept', async () => {
    const { c, p } = run(() => ({ content: JSON.stringify(offer), usage: null }));
    await p;
    expect(c.usage[0]).toMatchObject({ reconciliation: 'unknown', actualCost: null });
    expect(c.spent).toBe(c.usage[0]!.estimatedCost);
  });

  it('usage ABOVE the bound is an anomaly: recorded, and every later paid call is refused', async () => {
    const { c, p } = run(() => ({ content: JSON.stringify(offer), usage: { prompt_tokens: 10_000_000, completion_tokens: 10 } }));
    await p;
    expect(c.usage[0]!.reconciliation).toBe('anomaly_over_estimate');
    expect(c.usage[0]!.cost).toBe(c.usage[0]!.estimatedCost);
    await expect(c.charge({ provider: 'x', operation: 'search', model: null, tokensIn: 0, tokensOut: 0, cost: 1, priceVersion: 'v' })).rejects.toBeInstanceOf(BillingAnomaly);
  });

  it('a reservation cannot be reconciled twice (no double accounting)', async () => {
    const c = ctx();
    const id = await c.charge({ provider: 'x', operation: 'llm', model: null, tokensIn: 0, tokensOut: 0, cost: 100, priceVersion: 'v', reconciliation: 'estimate_only' });
    c.reconcile(id, { outcome: 'reconciled', actualCost: 40 });
    expect(c.spent).toBe(40);
    expect(() => c.reconcile(id, { outcome: 'reconciled', actualCost: 10 })).toThrow(/already reconciled/);
    expect(c.spent).toBe(40);
  });

  it('invalid output never reaches scoring: not JSON, schema violation, truncated by max_tokens', async () => {
    await expect(run(() => ({ content: 'Конечно! Вот ответ: {oops' })).p).rejects.toBeInstanceOf(InvalidModelOutput);
    await expect(run(() => ({ content: JSON.stringify({ ...offer, pageKind: 'trusted' }) })).p).rejects.toThrow(/pageKind/);
    expect(parseModelJson('<think>hmm</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('a model without a known tariff is never called (cost cannot be bounded)', async () => {
    const { t, p } = run(() => undefined, 'mystery-model-1');
    await expect(p).rejects.toThrow(/нет тарифа/);
    expect(t.requests).toHaveLength(0);
  });

  it('the worst-case bound covers every byte of input and the full max_tokens', () => {
    const tf = tariffFor('deepseek-v4.1-flash')!;
    const msgs = [{ role: 'user', content: 'я'.repeat(1000) }]; // 2000 UTF-8 bytes
    expect(llmWorstCaseKop(tf, msgs, 1000)).toBeGreaterThanOrEqual(llmCostKop(tf, { input: 2000, output: 1000 }));
  });

  it('analyst wire schema is derived from the runtime schema (no `model` field from the model)', () => {
    expect(Object.keys(analystWire.shape)).not.toContain('model');
  });
});

describe('configuration: disabled by default, fail-closed, secrets never printed', () => {
  it('defaults: live off, pinned current models, independent families', () => {
    const c = loadLiveConfig({});
    expect(c.provider).toBe('none');
    expect(c.analystModel).toBe('qwen3.6-35b-a3b');
    expect(c.skepticModel).toBe('deepseek-v4.1-flash');
    expect(readinessProblems(c).join(' ')).toMatch(/выключен/);
  });

  it('deprecated DeepSeek V4 Flash and non-Yandex endpoints are refused', () => {
    expect(() => loadLiveConfig({ ...TEST_ENV, VL_SKEPTIC_MODEL: 'deepseek-v4-flash' })).toThrow(/2026-11-15/);
    expect(() => loadLiveConfig({ ...TEST_ENV, YANDEX_LLM_URL: 'https://api.openai.com/v1/chat/completions' })).toThrow(/официальных/);
  });

  it('same model family for analyst and skeptic: refused, or explicitly degraded (never «independent»)', () => {
    const same = loadLiveConfig({ ...TEST_ENV, VL_SKEPTIC_MODEL: 'qwen3.6-35b-a3b' });
    expect(() => buildLiveProviders(same, { providerTransport: new RecordedProviders(), webTransport: new RecordedWeb(), resolver: new RecordedWeb() })).toThrow(/одного семейства/);
    const allowed = loadLiveConfig({ ...TEST_ENV, VL_SKEPTIC_MODEL: 'qwen3.6-35b-a3b', VL_ALLOW_SINGLE_MODEL: 'true' });
    const b = buildLiveProviders(allowed, { providerTransport: new RecordedProviders(), webTransport: new RecordedWeb(), resolver: new RecordedWeb() });
    expect(b.independence).toBe('single-model-degraded');
    expect(modelFamily('gpt://f/deepseek-v4.1-flash')).toBe('deepseek');
  });

  it('describeConfig / errors never contain the key', () => {
    const d = JSON.stringify(describeConfig(cfg));
    expect(d).not.toContain('test-key-not-a-secret');
    expect(d).toContain('значение скрыто');
    try {
      loadLiveConfig({ ...TEST_ENV, YANDEX_FOLDER_ID: 'BAD!', YANDEX_API_KEY: 'super-secret-value-xyz' });
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-value-xyz');
    }
  });
});

describe('offer grounding (Case B: never conflate vendors or jobs)', () => {
  const page = { url: 'https://vaglogs.com/', title: 'VAGLOGS — анализ логов VCDS онлайн', lang: 'ru', text: 'VAGLOGS\nБесплатный онлайн-анализ CSV-логов измеряемых величин VCDS: графики по группам, сравнение заездов, экспорт.' };
  it('keeps only jobs whose quote is on the page; an over-claimed job becomes «uncertain»', () => {
    const g = groundOffer(
      { isProductPage: true, name: 'VAGLOGS', market: 'ru', jobs: [{ job: 'vag-csv-log-analysis', quote: 'онлайн-анализ CSV-логов измеряемых величин VCDS' }, { job: 'vag-autoscan-dtc-report', quote: 'расшифровка кодов неисправностей Auto-Scan' }], price: null, pageKind: 'vendor' },
      page,
      SEEDS.vag!,
      'qwen3.6-35b-a3b',
    );
    expect(g.offer?.jobs).toEqual(['vag-csv-log-analysis']);
    expect(g.offer?.grounding?.level).toBe('partial');
    expect(g.uncertain.join(' ')).toMatch(/vag-autoscan-dtc-report.*не найдена/);
  });

  it('a name that is not on the page → no offer at all (no invented rival)', () => {
    const g = groundOffer({ isProductPage: true, name: 'Ross-Tech Russia', market: 'ru', jobs: [{ job: 'vag-autoscan-dtc-report', quote: 'онлайн-анализ CSV-логов' }], price: null, pageKind: 'vendor' }, page, SEEDS.vag!, 'm');
    expect(g.offer).toBeNull();
  });

  it('a price not on the page is dropped; jobs outside the idea are ignored', () => {
    const g = groundOffer({ isProductPage: true, name: 'VAGLOGS', market: 'ru', jobs: [{ job: 'car-wash', quote: 'графики по группам, сравнение заездов' }], price: '990 ₽', pageKind: 'vendor' }, page, SEEDS.vag!, 'm');
    expect(g.offer?.price).toBeUndefined();
    expect(g.offer?.jobs).toEqual([]);
  });

  it('market comes from page signals; the model only fills a gap (marked uncertain)', () => {
    expect(marketSignal('https://rynto.io/ru/x', 'ru', 'Цифровой гид гостя с правилами дома и инструкцией')).toBe('ru');
    expect(marketSignal('https://touchstay.com/', 'en', 'Digital guidebooks for vacation rental hosts. Plans from $9 per month per guidebook.')).toBe('west');
    const g = groundOffer({ isProductPage: true, name: 'VAGLOGS', market: 'west', jobs: [], price: null, pageKind: 'vendor' }, page, SEEDS.vag!, 'm');
    expect(g.offer?.market).toBe('ru');
    expect(g.uncertain.join(' ')).toMatch(/модель указала west/);
  });
});
