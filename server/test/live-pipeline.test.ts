// @vitest-environment node
/**
 * VL-004B offline benchmark cases A–F through the REAL live adapters (Yandex Search API + AI Studio +
 * LiveSourceReader) on recorded HTTP. No paid endpoint, no open web. These tests check the GUARDRAILS
 * (grounding, competitor validation, source checks, injection handling) — not model accuracy.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadLiveConfig } from '../live/config';
import { buildLiveProviders } from '../live/providers';
import { RecordedProviders, RecordedWeb, TEST_ENV } from '../live/recordings/mock';
import { runBenchmark } from '../live/benchmark';
import { runPipeline } from '../machine/pipeline';
import { CallContext, type CandidateResult, type PipelineResult } from '../machine/types';

const AS_OF = '2026-11-12';
const OPTS = { maxNew: 6, evidenceHits: 3, hitsPerQuery: 3, maxRuQueries: 8 };

async function liveRun(env = TEST_ENV, hooks: ConstructorParameters<typeof RecordedProviders>[0] = {}) {
  const web = new RecordedWeb();
  const prov = new RecordedProviders(hooks);
  const b = buildLiveProviders(loadLiveConfig(env), { providerTransport: prov, webTransport: web, resolver: web, sleep: async () => {} });
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
  it('RealtyCalendar «Автопилот», RYNTO and GuestCom are validated DIRECT Russian rivals; the gap claim is contradicted; idea held', () => {
    const c = cand(base.result, 'str-guest-guide');
    expect(ruDirect(c)).toEqual(['GuestCom', 'RYNTO', 'RealtyCalendar «Автопилот»'].sort());
    const gap = c.claims.find((x) => x.key === 'ru-gap')!;
    expect(gap.status).toBe('contradicted');
    expect(c.assessment.scores.ruUnmetJob).toBe(0);
    expect(c.assessment.state).toBe('RESEARCH_HOLD');
    expect(c.assessment.holdReasons.join(' ')).toMatch(/Пробел опровергнут: в РФ уже есть .*RYNTO/);
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

  it('a market claimed by the extraction model but contradicted by the page is corrected and flagged', () => {
    const c = cand(base.result, 'str-guest-guide');
    const rynto = c.sources.find((s) => s.url === 'https://rynto.io/ru/guest-portal')!;
    expect(rynto.offer?.market).toBe('ru');
    expect(rynto.offer?.grounding?.uncertain.join(' ')).toMatch(/модель указала west/);
    expect(rynto.sourceType).toBe('company_self_report');
  });
});

describe('Case B — VAGLOGS vs VAG Report: adjacent, not direct', () => {
  it('VAGLOGS (CSV logs) is ADJACENT: the Auto-Scan job claimed by the extraction model is not on its page', () => {
    const c = cand(base.result, 'vag-autoscan-report');
    expect(c.competitors.map((x) => `${x.name}:${x.kind}`)).toEqual(['VAGLOGS:adjacent']);
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
  it('ВНИКЛИ and Vortholm are direct; the unsupported RU-gap claim is removed (contradicted → 0) and the idea held', () => {
    const c = cand(base.result, 'supplier-quote-compare');
    expect(ruDirect(c)).toEqual(['Vortholm', 'ВНИКЛИ']);
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
    expect(b.competitors).toMatchObject({ fp: 0, fn: 0, phantomsDropped: b.competitors.phantoms });
    expect(b.competitors.modelOnly.fp).toBeGreaterThan(0);
    expect(b.claims).toMatchObject({ fp: 0 });
    expect(b.claims.modelOnly.fp).toBeGreaterThan(0);
    expect(b.costKop.charged).toBeLessThanOrEqual(b.costKop.reserved);
  });
});
