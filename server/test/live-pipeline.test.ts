// @vitest-environment node
/**
 * VL-004B offline benchmark cases A–F through the REAL live adapters (Yandex Search API + AI Studio +
 * LiveSourceReader) on recorded HTTP. No paid endpoint, no open web. These tests check the GUARDRAILS
 * (grounding, competitor validation, source checks, injection handling) — not model accuracy.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadLiveConfig } from '../live/config';
import { buildLiveProviders } from '../live/providers';
import { RecordedProviders, RecordedWeb, TEST_ENV, virtualClock } from '../live/recordings/mock';
import { runBenchmark } from '../live/benchmark';
import { runPipeline } from '../machine/pipeline';
import { CallContext, type CandidateResult, type PipelineResult } from '../machine/types';

const AS_OF = '2026-11-12';
const OPTS = { maxNew: 6, evidenceHits: 3, hitsPerQuery: 3, maxRuQueries: 8 };

async function liveRun(env = TEST_ENV, hooks: ConstructorParameters<typeof RecordedProviders>[0] = {}, webOver: ConstructorParameters<typeof RecordedWeb>[0] = {}) {
  const web = new RecordedWeb(webOver);
  const prov = new RecordedProviders(hooks);
  const b = buildLiveProviders(loadLiveConfig(env), { providerTransport: prov, webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() });
  const ctx = new CallContext('t', 1, 1_000_000);
  const result = await runPipeline(AS_OF, [], b.providers, ctx, OPTS);
  return { result, web, prov, ctx, bundle: b };
}

let base: Awaited<ReturnType<typeof liveRun>>;
const cand = (r: PipelineResult, id: string) => r.candidates.find((c) => c.externalId === id) as CandidateResult;
const ruDirect = (c: CandidateResult) => c.competitors.filter((x) => x.market === 'ru' && x.kind === 'direct').map((x) => x.name).sort();

beforeAll(async () => {
  base = await liveRun();
});

describe('discovery: seeds only from real search hits', () => {
  it('proposes candidates found on discovery hits; an invented product (source not in the hits) is dropped', () => {
    const ids = base.result.candidates.map((c) => c.externalId);
    expect(ids).toEqual(['str-guest-guide', 'vag-autoscan-report', 'supplier-quote-compare', 'meeting-notes-ai', 'ai-call-receptionist', 'resume-screening-ai']);
    expect(ids).not.toContain('phantom-saas');
    expect(base.result.discoverySearches.map((s) => s.region)).toEqual(['world', 'world', 'world']);
    expect(base.web.requests.some((r) => r.url.hostname === 'phantom-saas.example.com')).toBe(false);
  });
});

describe('Case A — digital guest guide: real RU rivals remove the «empty niche»', () => {
  it('RealtyCalendar «Автопилот» and GuestCom are DIRECT Russian rivals with a proven market; the gap claim is contradicted; idea held', () => {
    const c = cand(base.result, 'str-guest-guide');
    expect(ruDirect(c)).toEqual(['GuestCom', 'RealtyCalendar «Автопилот»']);
    expect(c.competitors.filter((x) => x.marketVerified !== false).map((x) => x.name).sort()).toEqual(['GuestCom', 'RealtyCalendar «Автопилот»']);
    const gap = c.claims.find((x) => x.key === 'ru-gap')!;
    expect(gap.status).toBe('contradicted');
    expect(c.assessment.scores.ruUnmetJob).toBe(0);
    expect(c.assessment.state).toBe('RESEARCH_HOLD');
    expect(c.assessment.holdReasons.join(' ')).toMatch(/Пробел опровергнут: в РФ уже есть RealtyCalendar «Автопилот», GuestCom/);
    expect(c.assessment.holdReasons.join(' ')).not.toMatch(/RYNTO/);
  });

  it('a rival invented by the skeptic model (Bnovo Гид on an article page) is dropped', () => {
    const c = cand(base.result, 'str-guest-guide');
    expect(c.competitors.map((x) => x.name)).not.toContain('Bnovo Гид');
    expect(c.reviews.find((r) => r.reviewer === 'skeptic')!.findings.join(' ')).toMatch(/«Bnovo Гид».*не найден на загруженной странице/);
  });

  it('GuestCom is only reached through a synonym query — every Russian query is logged, including zero-hit ones', () => {
    const c = cand(base.result, 'str-guest-guide');
    const ru = c.searches.filter((s) => s.region === 'ru');
    expect(ru.length).toBeGreaterThanOrEqual(3);
    expect(ru.some((s) => /инструкция по заселению/.test(s.query))).toBe(true);
    expect(c.searches.some((s) => s.resultCount === 0)).toBe(true);
  });

  it('RYNTO: Russian-language page, but no RU availability signal (no ₽, RU domain, +7, ИНН) → market NOT established; shown, never counted', () => {
    const c = cand(base.result, 'str-guest-guide');
    const rynto = c.sources.find((s) => s.url === 'https://rynto.io/ru/guest-portal')!;
    expect(rynto.offer?.grounding?.marketVerified).toBe(false);
    expect(rynto.offer?.grounding?.uncertain.join(' ')).toMatch(/рынок не подтверждён.*локализация ≠ продажи в РФ/);
    expect(rynto.sourceType).toBe('company_self_report');
    // the automatic re-check on the home page ran (and found nothing: 404)
    expect(base.web.requests.some((r) => r.url.toString() === 'https://rynto.io/')).toBe(true);
    const comp = c.competitors.find((x) => x.name === 'RYNTO')!;
    expect(comp.marketVerified).toBe(false);
    expect(c.reviews.find((r) => r.reviewer === 'skeptic')!.findings.join(' ')).toMatch(/«RYNTO»: рынок не подтверждён/);
    const rc = c.sources.find((s) => s.url === 'https://new.realtycalendar.ru/products/autopilot')!;
    expect(rc.offer?.grounding).toMatchObject({ marketVerified: true, marketSignals: expect.arrayContaining(['домен new.realtycalendar.ru', 'цена в рублях']) });
  });
});

describe('Case B — VAGLOGS vs VAG Report: adjacent, not direct', () => {
  it('VAGLOGS (CSV logs) is ADJACENT: the Auto-Scan job claimed by the extraction model is not on its page', () => {
    const c = cand(base.result, 'vag-autoscan-report');
    expect(c.competitors.map((x) => `${x.name}:${x.kind}`)).toEqual(['VAGLOGS:adjacent']);
    expect(c.competitors[0]!.marketVerified).toBe(false); // vaglogs.com, Russian text, no RU availability signal
    const src = c.sources.find((s) => s.url === 'https://vaglogs.com/')!;
    expect(src.offer?.jobs).toEqual(['vag-csv-log-analysis']);
    expect(src.offer?.grounding?.uncertain.join(' ')).toMatch(/vag-autoscan-dtc-report/);
  });

  it('the skeptic model\'s «direct» label and its refutation built on VAGLOGS are rejected by code', () => {
    const c = cand(base.result, 'vag-autoscan-report');
    const gap = c.claims.find((x) => x.key === 'ru-gap')!;
    expect(gap.status).not.toBe('contradicted');
    expect(gap.skepticVerdict).toBe('needs_more_evidence');
    const f = c.reviews.find((r) => r.reviewer === 'skeptic')!.findings.join(' ');
    expect(f).toMatch(/«VAGLOGS»: скептик указал «direct», по подтверждённым на странице работам — «adjacent»/);
    expect(c.assessment.holdReasons.join(' ')).not.toMatch(/КРИТИЧЕСКИЙ|критический спор/);
  });

  it('the western analogue (Ross-Tech VCDS) is never counted as a rival; the 403 forum page stays unretrievable', () => {
    const c = cand(base.result, 'vag-autoscan-report');
    expect(c.competitors.some((x) => /VCDS|Ross/.test(x.name))).toBe(false);
    expect(c.sources.find((s) => s.url.includes('drive2.ru'))!.fetchStatus).toBe('blocked');
    expect(c.claims.find((x) => x.key === 'ru-gap')!.status).toBe('unretrievable');
  });
});

describe('Case C — crowded quote comparison', () => {
  it('ВНИКЛИ is direct, Vortholm a POSSIBLE rival (primary job UNKNOWN); the unsupported RU-gap claim is removed (contradicted → 0) and the idea held', () => {
    const c = cand(base.result, 'supplier-quote-compare');
    // audit of PR #13 (P2): Vortholm's quote names only the object («коммерческие предложения поставщиков»), not the
    // function («сравнение») → UNKNOWN; the outcome (score, state) is unchanged — ВНИКЛИ alone refutes the gap
    expect(ruDirect(c)).toEqual(['ВНИКЛИ']);
    expect(c.competitors.find((x) => x.name === 'Vortholm')).toMatchObject({ primaryJobStatus: 'unknown' });
    expect(c.claims.find((x) => x.key === 'ru-gap')!.status).toBe('contradicted');
    expect(c.assessment.scores.ruUnmetJob).toBe(0);
    expect(c.assessment.state).toBe('RESEARCH_HOLD');
  });
});

describe('Case D — popularity is not revenue', () => {
  it('«10,000 companies use» never verifies «10,000 companies pay», even when the skeptic model agrees', () => {
    const c = cand(base.result, 'meeting-notes-ai');
    const pay = c.claims.find((x) => x.key === 'w-pay')!;
    expect(pay.status).toBe('unknown');
    expect(pay.reason).toMatch(/популярности/);
    expect(c.assessment.scores.westernPay).toBeNull();
    expect(c.claims.find((x) => x.key === 'w-need')!.status).toBe('single_source'); // popularity may support NEED
  });
});

describe('Case E — unreachable primary sources are unknown, never filled by generated text', () => {
  it('robots.txt-disallowed pages are not fetched; the claims citing them are unretrievable; idea held', () => {
    const c = cand(base.result, 'ai-call-receptionist');
    expect(c.sources.filter((s) => s.url.startsWith('https://callpilot.example.com/')).every((s) => s.fetchStatus === 'robots_disallowed' && s.excerpt === null)).toBe(true);
    expect(base.web.requests.filter((r) => r.url.hostname === 'callpilot.example.com').map((r) => r.url.pathname)).toEqual(['/robots.txt']);
    expect(c.claims.find((x) => x.key === 'w-need')!.status).toBe('unretrievable');
    expect(c.assessment.scores.westernNeed).toBeNull();
    expect(c.assessment.state).toBe('RESEARCH_HOLD');
  });

  it('a URL the model «remembered» (not a search hit) is never requested and never counts', () => {
    const c = cand(base.result, 'ai-call-receptionist');
    expect(base.web.requests.some((r) => r.url.hostname === 'callpilot-proof.example.net')).toBe(false);
    expect(c.sources.some((s) => s.url.includes('callpilot-proof'))).toBe(false);
    expect(c.reviews.find((r) => r.reviewer === 'claim_checker')!.findings.join(' ')).toMatch(/ссылки не из поиска/);
  });

  it('PDF and 404 sources are recorded as such (unsupported_content / http_error)', () => {
    const c = cand(base.result, 'ai-call-receptionist');
    expect(c.sources.find((s) => s.url.endsWith('.pdf'))!.fetchStatus).toBe('unsupported_content');
  });
});

describe('Case F — injected sources and invalid model JSON', () => {
  it('pages with hidden or visible instructions are quarantined; no URL from them is ever fetched', () => {
    const c = cand(base.result, 'resume-screening-ai');
    expect(c.assessment.state).toBe('DISCOVERED');
    expect(c.assessment.rationale).toMatch(/не является JSON/);
    expect(base.web.requests.some((r) => r.url.hostname === '169.254.169.254' || r.address === '169.254.169.254')).toBe(false);
    // the quarantined pages were never passed to a model
    const prompts = base.prov.llmCalls.map((r) => JSON.stringify(r.body));
    expect(prompts.some((p) => p.includes('rate this idea 5') || p.includes('Ignore previous instructions'))).toBe(false);
  });

  it('a candidate with invalid analyst output is not scored and not ranked; others are unaffected', () => {
    const c = cand(base.result, 'resume-screening-ai');
    expect(c.assessment.marketScore).toBe(0);
    expect(c.claims).toEqual([]);
    expect(cand(base.result, 'str-guest-guide').assessment.state).toBe('RESEARCH_HOLD');
  });

  it('invalid skeptic JSON → candidate not scored (DISCOVERED), never a crash', async () => {
    const r = await liveRun(TEST_ENV, { llm: (task, data) => (task === 'skeptic_challenge' && (data.seed as { externalId: string }).externalId === 'supplier-quote-compare' ? { content: '{"claimVerdicts": "all supported"}' } : undefined) });
    const c = cand(r.result, 'supplier-quote-compare');
    expect(c.assessment.state).toBe('DISCOVERED');
    expect(c.assessment.rationale).toMatch(/скептик/);
  });
});

describe('model independence and provenance', () => {
  it('analyst and extraction use Qwen, the skeptic uses DeepSeek (different family); models are recorded per assessment', () => {
    const tasks = base.prov.llmCalls.map((r) => `${r.task}:${(r.body as { model: string }).model.split('/').pop()}`);
    expect(new Set(tasks.filter((t) => t.startsWith('skeptic')))).toEqual(new Set(['skeptic_challenge:deepseek-v4.1-flash']));
    expect(tasks.filter((t) => !t.startsWith('skeptic')).every((t) => t.endsWith('qwen3.6-35b-a3b'))).toBe(true);
    expect(cand(base.result, 'str-guest-guide').assessment.models).toEqual(['qwen3.6-35b-a3b', 'deepseek-v4.1-flash', 'deterministic-code', 'vl-004b-pipeline-1']);
  });

  it('single-model-degraded (explicitly allowed) holds every candidate — never presented as independent review', async () => {
    const r = await liveRun({ ...TEST_ENV, VL_SKEPTIC_MODEL: 'qwen3.6-35b-a3b', VL_ALLOW_SINGLE_MODEL: 'true' }, { llm: (task, data) => (task === 'skeptic_challenge' ? { content: JSON.stringify({ claimVerdicts: (data.claims as { key: string; supportingKeys: string[] }[]).map((c) => ({ claimKey: c.key, verdict: 'supported', sourceKeys: c.supportingKeys, reason: 'ок' })), competitors: [], disputes: [], summary: 'ок' }) } : undefined) });
    expect(r.bundle.independence).toBe('single-model-degraded');
    for (const c of r.result.candidates.filter((x) => x.assessment.state !== 'DISCOVERED')) {
      expect(c.assessment.state).toBe('RESEARCH_HOLD');
      expect(c.assessment.holdReasons.join(' ')).toMatch(/single-model-degraded/);
    }
  });

  it('sources carry provenance: canonical URL, fetch time, content hash, quote location', () => {
    const c = cand(base.result, 'str-guest-guide');
    const s = c.sources.find((x) => x.url === 'https://touchstay.com/pricing')!;
    expect(s).toMatchObject({ fetchStatus: 'ok', canonicalUrl: 'https://touchstay.com/pricing', fetchedAt: expect.stringMatching(/^\d{4}-/), contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const pay = c.claims.find((x) => x.key === 'w-pay')!;
    expect(pay.quoteLocations?.[0]).toMatchObject({ sourceKey: s.key, offset: expect.any(Number) });
    expect(pay.quoteLocations![0]!.offset).toBeGreaterThanOrEqual(0);
  });

  it('no credential ever appears in a request body, and every paid call is metered and reconciled', () => {
    expect(base.prov.requests.every((r) => !JSON.stringify(r.body).includes('test-key-not-a-secret'))).toBe(true);
    const paid = base.ctx.usage.filter((u) => u.operation !== 'read');
    expect(paid.length).toBe(base.prov.requests.length);
    expect(paid.every((u) => u.reconciliation === 'tariff' || u.reconciliation === 'reconciled')).toBe(true);
    expect(paid.every((u) => u.cost <= u.estimatedCost!)).toBe(true);
  });
});

describe('offline benchmark (recorded corpus)', () => {
  it('guardrails remove the model\'s false «direct» rivals and false «supported» claims; nothing real is lost', async () => {
    const b = await runBenchmark();
    // fn 1 = Vortholm, now a POSSIBLE rival (primary job UNKNOWN), not lost: shown, caps RU at 3, blocks «no rivals»
    // (precision over recall — audit of PR #13). No false «direct» rival.
    expect(b.competitors).toMatchObject({ fp: 0, fn: 1, phantomsDropped: b.competitors.phantoms });
    expect(b.competitors.modelOnly.fp).toBeGreaterThan(0);
    expect(b.claims).toMatchObject({ fp: 0 });
    expect(b.claims.modelOnly.fp).toBeGreaterThan(0);
    expect(b.costKop.charged).toBeLessThanOrEqual(b.costKop.reserved);
  });
});

describe('audit P1 — unproven competitor geography never moves the score or the TOP (integration)', () => {
  const RIVAL = 'https://autoscanreader.example.com/';
  // An extra hit for the VAG Russian queries: a product page that DOES prove the primary job (Auto-Scan report).
  const hooks = (page: string): ConstructorParameters<typeof RecordedProviders>[0] => ({
    search: (q) => (q.type === 'SEARCH_TYPE_RU' && /автоскан/i.test(q.text) ? { appendResults: [{ url: page, title: 'AutoScan Reader', passage: 'Auto-Scan report' }] } : undefined),
    llm: (task, data) =>
      task === 'extract_offer' && (data.page as { url: string }).url === page
        ? { content: JSON.stringify({ isProductPage: true, name: 'AutoScan Reader', market: 'ru', jobs: [{ job: 'vag-autoscan-dtc-report', quote: 'turns a VCDS Auto-Scan into a plain report' }], price: null, pageKind: 'vendor' }) }
        : undefined,
  });
  const neutral = { status: 200, body: '<html lang="en"><head><title>AutoScan Reader</title></head><body><p>AutoScan Reader turns a VCDS Auto-Scan into a plain report for car owners everywhere.</p></body></html>' };
  const russian = { status: 200, body: '<html lang="ru"><head><title>AutoScan Reader</title></head><body><p>AutoScan Reader: turns a VCDS Auto-Scan into a plain report. Отчёт по автоскану для владельцев. Стоимость 390 ₽ за отчёт, поддержка +7 (495) 123-45-67.</p></body></html>' };

  it('model says «ru» on a neutral English .com: the direct rival is shown (market not proven) and the VAG score / state are unchanged', async () => {
    const r = await liveRun(TEST_ENV, hooks(RIVAL), { dns: { 'autoscanreader.example.com': ['151.101.99.1'] }, pages: { [RIVAL]: neutral } });
    const c = cand(r.result, 'vag-autoscan-report');
    const b = cand(base.result, 'vag-autoscan-report');
    const rival = c.competitors.find((x) => x.name === 'AutoScan Reader')!;
    expect(rival).toMatchObject({ kind: 'direct', marketVerified: false });
    expect(c.assessment.scores).toEqual(b.assessment.scores);
    expect(c.assessment.marketScore).toBe(b.assessment.marketScore);
    expect(c.assessment.state).toBe(b.assessment.state);
    // the home page was re-checked automatically (it is the same URL here, so no extra request) and nothing proved RU
    expect(c.reviews.find((x) => x.reviewer === 'skeptic')!.findings.join(' ')).toMatch(/«AutoScan Reader»: рынок не подтверждён/);
  });

  it('the same rival with RU availability signals (₽ price, +7) IS a proven direct RU rival and caps the Russian dimensions', async () => {
    const r = await liveRun(TEST_ENV, hooks(RIVAL), { dns: { 'autoscanreader.example.com': ['151.101.99.1'] }, pages: { [RIVAL]: russian } });
    const c = cand(r.result, 'vag-autoscan-report');
    const b = cand(base.result, 'vag-autoscan-report');
    expect(c.competitors.find((x) => x.name === 'AutoScan Reader')).toMatchObject({ kind: 'direct', market: 'ru', marketVerified: true });
    expect(c.assessment.scores.ruWeakness!).toBeLessThan(b.assessment.scores.ruWeakness!);
    expect(c.assessment.marketScore).toBeLessThan(b.assessment.marketScore);
  });
});

describe('audit P1 — unverified «independent» never raises the evidence grade (integration)', () => {
  it('the vendor\'s own page called «independent» by the extractor stays a company self-report', () => {
    const c = cand(base.result, 'str-guest-guide');
    const pricing = c.sources.find((s) => s.url === 'https://touchstay.com/pricing')!;
    expect(pricing.sourceType).toBe('company_self_report');
    expect(c.claims.find((x) => x.key === 'w-pay')!.status).toBe('vendor_claim');
  });

  it('a third-party page WITHOUT verifiable publication provenance is «type not established» and the grade drops (B → C)', async () => {
    const REVIEW = 'https://www.str-review.example.org/touch-stay-review';
    const b = cand(base.result, 'str-guest-guide');
    expect(b.sources.find((s) => s.url === REVIEW)).toMatchObject({ sourceType: 'independent', provenance: { independence: 'verified' } });
    expect(b.assessment.evidenceGrade).toBe('B');
    // same text, same extractor verdict («independent») — but no publication markup / publisher / author
    const bare = { status: 200, body: '<html lang="en"><head><title>Touch Stay review</title></head><body><p>We tested Touch Stay for three months: hosts reported fewer guest questions at check-in, and the paid plan was worth it for multi-property hosts.</p></body></html>' };
    const r = await liveRun(TEST_ENV, {}, { pages: { [REVIEW]: bare } });
    const c = cand(r.result, 'str-guest-guide');
    const src = c.sources.find((s) => s.url === REVIEW)!;
    expect(src).toMatchObject({ sourceType: 'unknown', provenance: { independence: 'unverified' } });
    expect(src.provenance!.reason).toMatch(/не подтверждено/);
    expect(c.assessment.evidenceGrade).toBe('C');
    expect(c.assessment.confidence.reliability).toBeLessThan(b.assessment.confidence.reliability);
  });
});
