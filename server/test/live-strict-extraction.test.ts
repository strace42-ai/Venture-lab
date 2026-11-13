// @vitest-environment node
/**
 * VL-004B-strict (audit of the first stage2, 13.11.2026):
 *  1. every wire schema sent with json_schema strict=true is strict-safe and uses only constructs
 *     Yandex accepted, with a regression test for the exact rejection «all fields must be required»;
 *  2. the strict analyst wire is converted explicitly into the internal proposal: unscored stays null,
 *     never 0; formulas and evidence rules unchanged;
 *  3. extraction regressions on the REAL stage2 extractions (page text + Qwen reply).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AIStudioChat, analystFromWire, analystStrictWire, analystWire, discoveryWire, offerWire, skepticWire } from '../live/ai-studio';
import { loadLiveConfig } from '../live/config';
import { groundOffer, jobQuoteProblem, jobQuoteSupport, priceProblem, type ExtractedOffer } from '../live/grounding';
import { assessProvenance } from '../live/provenance';
import type { PageMeta } from '../live/html';
import type { TransportRequest, TransportResponse, Transport } from '../live/net/transport';
import { ProviderCaller } from '../live/provider-http';
import { buildLiveProviders } from '../live/providers';
import { RecordedProviders, RecordedWeb, TEST_ENV, toStrictAnalyst, virtualClock } from '../live/recordings/mock';
import { SEEDS } from '../live/recordings/world';
import { PROVEN_STRICT_KEYWORDS, StrictSchemaError, strictModeViolations, strictWireJson } from '../live/strict-schema';
import { researchCandidate } from '../machine/pipeline';
import { analystProposalSchema } from '../machine/schemas';
import { CallContext, InvalidModelOutput, type DiscoverySeed } from '../machine/types';
import { DIMENSION_KEYS } from '../../src/domain/scoring';

const cfg = loadLiveConfig(TEST_ENV);
const mini = z.strictObject({ ok: z.boolean(), word: z.string().max(40) });
const WIRES = { offerWire, discoveryWire, analystStrictWire, skepticWire, probeMini: mini };

function keywordsOf(node: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((x) => keywordsOf(x, acc));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      acc.add(k);
      if (k === 'properties') Object.values(v as object).forEach((x) => keywordsOf(x, acc));
      else keywordsOf(v, acc);
    }
  }
  return acc;
}

describe('strict json_schema: what is sent to Yandex', () => {
  it('REGRESSION 13.11.2026: the old analyst schema violates «all fields must be required» (highImpact, absence) and has a dictionary', () => {
    const raw = z.toJSONSchema(analystWire, { unrepresentable: 'any' });
    const v = strictModeViolations(raw).join('\n');
    expect(v).toMatch(/highImpact: all fields must be required/);
    expect(v).toMatch(/absence: all fields must be required/);
    expect(v).toMatch(/propertyNames|словари/);
    expect(() => strictWireJson(analystWire, 'analyse_candidate')).toThrow(StrictSchemaError);
  });

  it.each(Object.entries(WIRES))('%s: no violation; every object requires all fields; only proven keywords', (_n, w) => {
    const json = strictWireJson(w as z.ZodType, 'x');
    expect(strictModeViolations(json)).toEqual([]);
    for (const k of keywordsOf(json)) {
      // property names are not keywords: only check schema keywords
      if (['properties'].includes(k)) continue;
      expect(PROVEN_STRICT_KEYWORDS.has(k) || !/^[a-z$]/i.test(k) || isPropertyName(json, k), k).toBe(true);
    }
  });

  it('the validator catches every unsupported construct (nested optional, dictionaries, non-null anyOf, missing additionalProperties, $ref)', () => {
    const bad = {
      type: 'object',
      properties: {
        a: { type: 'object', properties: { b: { type: 'string' } }, required: [], additionalProperties: false },
        d: { type: 'object', propertyNames: { enum: ['x'] }, additionalProperties: { type: 'number' } },
        u: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        o: { type: 'object', properties: { z: { type: 'string' } }, required: ['z'] },
        r: { $ref: '#/$defs/x' },
        p: { type: 'string', pattern: '^x$' },
      },
      required: ['a', 'd', 'u', 'o', 'r', 'p'],
      additionalProperties: false,
    };
    const v = strictModeViolations(bad).join('\n');
    expect(v).toMatch(/\$\.a\.b: all fields must be required/);
    expect(v).toMatch(/\$\.d: конструкция «propertyNames»/);
    expect(v).toMatch(/\$\.u: anyOf допускается только как «T \| null»/);
    expect(v).toMatch(/\$\.o: нужно «additionalProperties: false»/);
    expect(v).toMatch(/\$\.r: конструкция «\$ref»/);
    expect(v).toMatch(/\$\.p: ключевое слово «pattern» не подтверждено/);
  });

  it('a schema that is not strict-safe is refused BEFORE any reservation or request (no money spent)', async () => {
    const sent: TransportRequest[] = [];
    const t: Transport = { request: async (r): Promise<TransportResponse> => (sent.push(r), { status: 200, headers: {}, body: Buffer.from('{}'), truncated: false }) };
    const chat = new AIStudioChat(new ProviderCaller({ transport: t, sleep: async () => {} }), cfg);
    const ctx = new CallContext('t', 1, 1_000_000);
    await expect(chat.complete(ctx, { model: 'qwen3.6-35b-a3b', task: 'analyse_candidate', system: 's', data: {}, schema: analystWire, wire: analystWire, answerTokens: 100 })).rejects.toBeInstanceOf(InvalidModelOutput);
    expect(sent).toHaveLength(0);
    expect(ctx.usage).toHaveLength(0);
  });

  it('nullable fields are sent in the proven form anyOf [T, null] (as in the accepted extract_offer schema)', () => {
    const json = strictWireJson(skepticWire, 'skeptic_challenge') as { properties: { disputes: { items: { properties: { claimKey: unknown } } } } };
    expect(json.properties.disputes.items.properties.claimKey).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
  });
});

function isPropertyName(json: unknown, k: string): boolean {
  let found = false;
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      for (const [key, v] of Object.entries(n)) {
        if (key === 'properties' && v && typeof v === 'object' && k in (v as object)) found = true;
        walk(v);
      }
    }
  };
  walk(json);
  return found;
}

describe('strict analyst wire → internal proposal (explicit conversion)', () => {
  const base = {
    claims: [
      { key: 'west-need', dimension: 'westernNeed', text: 'Хосты платят за гид', quote: 'Digital guidebooks loved by hosts', sourceUrls: ['https://touchstay.com/'], highImpact: true, absence: null },
      { key: 'ru-gap', dimension: 'ruUnmetJob', text: 'В РФ нет аналога', quote: 'нет такого сервиса в России', sourceUrls: ['https://vc.example.ru/a'], highImpact: false, absence: { market: 'ru', job: 'guest-guide' } },
    ],
    scores: Object.fromEntries(DIMENSION_KEYS.map((d) => [d, { value: d === 'westernNeed' ? 4 : null, claims: d === 'westernNeed' ? ['west-need'] : [] }])),
    founderFit: null,
    ruQueries: ['цифровой гид гостя'],
    rationale: 'Обоснование',
  };

  it('every field is present on the wire; null score → NO score (never 0); absence null → no absence; highImpact kept', () => {
    const wire = analystStrictWire.parse(base);
    const p = analystFromWire(wire, 'qwen3.6-35b-a3b');
    expect(Object.keys(p.scores)).toEqual(['westernNeed']);
    expect(p.scores.westernNeed).toEqual({ value: 4, claims: ['west-need'] });
    expect(p.claims[0]).not.toHaveProperty('absence');
    expect(p.claims[1]).toMatchObject({ absence: { market: 'ru', job: 'guest-guide' }, highImpact: false });
    expect(p.claims[0]!.highImpact).toBe(true);
    expect(analystProposalSchema.safeParse(p).success).toBe(true);
  });

  it('strict wire refuses missing fields and the legacy partial dictionary; local validation still refuses out-of-range values', () => {
    const { highImpact: _h, ...noHigh } = base.claims[0]!;
    void _h;
    expect(analystStrictWire.safeParse({ ...base, claims: [noHigh] }).success).toBe(false);
    expect(analystStrictWire.safeParse({ ...base, scores: { westernNeed: { value: 4, claims: [] } } }).success).toBe(false);
    expect(analystStrictWire.safeParse({ ...base, scores: { ...base.scores, westernNeed: { value: 7, claims: [] } } }).success).toBe(false);
    // a claim key that does not exist is still refused by the unchanged proposal rules
    const bad = analystFromWire(analystStrictWire.parse({ ...base, scores: { ...base.scores, westernNeed: { value: 4, claims: ['nope'] } } }), 'm');
    expect(analystProposalSchema.safeParse(bad).success).toBe(false);
  });

  it('the recorded proposals replayed through the strict wire give the same proposal as before', () => {
    const legacy = { claims: [{ key: 'k', dimension: 'westernNeed', text: 'ttt', quote: 'q', sourceUrls: ['https://x.example.com/'] }], scores: { westernNeed: { value: 3, claims: ['k'] } }, founderFit: null, ruQueries: [], rationale: 'rrr' };
    const p = analystFromWire(analystStrictWire.parse(toStrictAnalyst(legacy)), 'm');
    expect(p.scores).toEqual(legacy.scores);
    expect(p.claims[0]).toEqual({ ...legacy.claims[0], highImpact: false });
  });
});

// ------------------------------------------------------------------ P2: the real stage2 extractions
type Call = { url: string; title: string | null; text: string; reply: ExtractedOffer };
const REC = JSON.parse(readFileSync(join(__dirname, '../live/recordings/stage2-extractions-2026-11-13.json'), 'utf8')) as { calls: Call[] };
const SEED = JSON.parse(readFileSync(join(__dirname, '../../research/phase-b/seeds-stage2.json'), 'utf8'))[0] as DiscoverySeed;
const call = (url: string) => REC.calls.find((c) => c.url === url)!;
const NO_META: PageMeta = { ogType: null, siteName: null, author: null, published: null, schemaTypes: [], articleTag: false };
const ground = (c: Call, reply = c.reply) => groundOffer(reply, { url: c.url, title: c.title, lang: null, text: c.text }, SEED, 'qwen3.6-35b-a3b');

describe('P2 regressions on the REAL stage2 extractions (13.11.2026)', () => {
  it('«Black Friday … 30% OFF» does not prove the guest-guide function', () => {
    const c = call('https://touchstay.com/pricing');
    expect(c.reply.jobs.find((j) => j.job === 'guest-guide')!.quote).toMatch(/Black Friday/);
    const g = ground(c);
    expect(g.offer!.jobs).not.toContain('guest-guide');
    expect(g.uncertain.join(' ')).toMatch(/guest-guide: рекламный текст/);
    expect(jobQuoteProblem('Celebrate Black Friday with 30% OFF Touch Stay Guidebooks', 'guest-guide', SEED)).toMatch(/рекламный текст/);
    expect(jobQuoteProblem('Скидка 20% на тариф до конца месяца', 'guest-guide', SEED)).toMatch(/рекламный текст/);
  });

  it('a quote with no term of the job does not prove it («Create moments…» ≠ check-in instructions)', () => {
    const g = ground(call('https://touchstay.com/pricing'));
    expect(g.offer!.jobs).not.toContain('checkin-instructions');
    expect(jobQuoteProblem('Create moments, not just stays.', 'checkin-instructions', SEED)).toMatch(/ни одного термина/);
    // the real, relevant quotes still pass
    expect(jobQuoteProblem('Share everything your guests need before and during the stay, from check-in instructions to local recommendations.', 'checkin-instructions', SEED)).toBeNull();
    expect(jobQuoteProblem('The guidebook your guests actually use.', 'guest-guide', SEED)).toBeNull();
    expect(ground(call('https://touchstay.com/')).offer!.jobs).toEqual(['guest-guide', 'checkin-instructions']);
  });

  it('a product page is not a «marketplace» just because the model said so: the label is not stored and can only LOWER trust', () => {
    expect(REC.calls.filter((c) => c.reply.pageKind === 'marketplace').length).toBe(7); // every real reply said «marketplace»
    for (const c of REC.calls) {
      const g = ground(c);
      if (g.offer) expect(g.offer).not.toHaveProperty('pageKind');
      // source type comes from code (grounded offer, product site, brand in domain, verifiable article markup)
      const prov = assessProvenance({ url: c.url, meta: NO_META, hasGroundedOffer: !!g.offer, modelPageKind: c.reply.pageKind, seed: SEED, productSites: new Set() });
      expect(prov.sourceType, c.url).not.toBe('independent');
      if (g.offer) expect(prov.sourceType, c.url).toBe('company_self_report'); // a product page stays the company's own page
    }
    // even a model's «independent» is only a claim: without verifiable markup it is «type not established»
    expect(assessProvenance({ url: 'https://blog.example.org/post', meta: NO_META, hasGroundedOffer: false, modelPageKind: 'independent', seed: SEED, productSites: new Set() }).sourceType).not.toBe('independent');
    for (const f of ['../machine/pipeline.ts', '../live/grounding.ts']) expect(readFileSync(join(__dirname, f), 'utf8').match(/pageKind/g)?.length ?? 0, f).toBeLessThanOrEqual(1); // type declaration only
  });

  it('a price is accepted only when the page states an amount or a free tier', () => {
    const pricing = ground(call('https://touchstay.com/pricing'));
    expect(pricing.offer!.price).toBeUndefined();
    expect(pricing.uncertain.join(' ')).toMatch(/цена .* не принята/);
    expect(ground(call('https://strstack.co/tools/touch-stay/pricing')).offer!.price).toBe('From $8.25/listing');
    expect(ground(call('https://touchstay.com/about')).offer!.price).toBeUndefined(); // «Get started free» is a call to action
    expect(priceProblem('Get started free')).toMatch(/призыв/);
    expect(priceProblem('Tell us a bit more about the size of your event on this form and we will get you a price within 24 hours')).not.toBeNull();
    expect(priceProblem('от 990 ₽ в месяц')).toBeNull();
    expect(priceProblem('$199')).toBeNull();
    expect(priceProblem('Бесплатный тариф для одного объекта')).toBeNull();
  });

  it('a foreign product does not get the Russian market without grounds (the model said «ru» for Touch Stay)', () => {
    for (const url of ['https://touchstay.com/', 'https://touchstay.com/about', 'https://touchstay.com/pricing']) {
      const c = call(url);
      expect(c.reply.market).toBe('ru');
      const g = ground(c);
      expect(g.offer!.market).toBe('west');
      expect(g.offer!.grounding!.marketVerified).toBe(false);
      expect(g.uncertain.join(' ')).toMatch(/метка «ru» не присвоена/);
    }
    // a Russian page with RU signals is established by code, not by the model
    const rc = ground(call('https://new.realtycalendar.ru/products/autopilot'));
    expect(rc.offer).toMatchObject({ name: 'Автопилот', market: 'ru', jobs: ['guest-guide', 'checkin-instructions'] });
    expect(rc.offer!.grounding!.marketVerified).toBe(true);
  });

  it('syntactically valid JSON with unproven facts proves nothing: quotes not on the page → no job, no direct rival', () => {
    const c = call('https://new.realtycalendar.ru/products/autopilot');
    const fake: ExtractedOffer = { ...c.reply, jobs: c.reply.jobs.map((j) => ({ job: j.job, quote: 'цифровой гид гостя с QR-кодом для каждой квартиры' })), price: '490 ₽ в месяц' };
    const g = ground(c, fake);
    expect(g.offer!.jobs).toEqual([]);
    expect(g.offer!.price).toBeUndefined();
    expect(g.uncertain.join(' ')).toMatch(/не найдена на странице/);
  });

  it('…and in the pipeline: citing fabricated quotes gives NO advantage over prose; evidence dimensions stay unknown; no 5 without a proven source', async () => {
    const run = async (cite: boolean) => {
      const web = new RecordedWeb();
      const hook: ConstructorParameters<typeof RecordedProviders>[0] = {
        llm: (task) =>
          task === 'analyse_candidate'
            ? {
                content: JSON.stringify(
                  toStrictAnalyst({
                    claims: DIMENSION_KEYS.map((d) => ({ key: `f-${d.toLowerCase()}`, dimension: d, text: 'Сильный факт', quote: 'This exact sentence does not appear on any page at all', sourceUrls: ['https://touchstay.com/'] })),
                    scores: Object.fromEntries(DIMENSION_KEYS.map((d) => [d, { value: 5, claims: cite ? [`f-${d.toLowerCase()}`] : [] }])),
                    founderFit: null,
                    ruQueries: ['цифровой гид гостя'],
                    rationale: 'Всё отлично',
                  }),
                ),
              }
            : undefined,
      };
      const b = buildLiveProviders(cfg, { providerTransport: new RecordedProviders(hook), webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() });
      return researchCandidate(SEEDS.guest!, true, '2026-11-12', b.providers, new CallContext('t', 1, 10_000_000));
    };
    const cited = await run(true);
    const prose = await run(false);
    expect(cited.incomplete).toBeUndefined(); // the research ran to its end — a RESULT, not a technical stop
    expect(cited.claims.every((c) => c.status === 'unknown' || c.status === 'unretrievable')).toBe(true);
    expect(cited.assessment.state).not.toBe('AUTOMATED_EVIDENCE_PASSED');
    // evidence dimensions: never scored from unproven claims
    for (const d of ['westernNeed', 'westernPay', 'ruWeakness', 'ruUnmetJob', 'monetization', 'distribution'] as const) expect(cited.assessment.scores[d], d).toBeNull();
    // judgement dimensions: a cited-but-unproven claim is treated like no source (cap 4, as for prose)
    expect(Math.max(...(Object.values(cited.assessment.scores) as (number | null)[]).map((v) => v ?? 0))).toBeLessThanOrEqual(4);
    expect(cited.assessment.marketScore).toBeLessThanOrEqual(prose.assessment.marketScore);
    expect(cited.assessment.dimensionNotes.join('\n')).toMatch(/суждение без подтверждённого источника ограничено/);
  });

  it('FIXED: a quote about guest IDENTIFICATION does not prove the guest-guide function — UNKNOWN, not a proven job', () => {
    const g = ground(call('https://eregcard-id.ru/'));
    expect(g.offer!.jobs).not.toContain('guest-guide');
    expect(g.offer!.grounding!.uncertainJobs).toEqual({ 'guest-guide': 'Подключите быструю идентификацию гостей' });
    expect(g.uncertain.join(' ')).toMatch(/guest-guide: смысловое соответствие не доказано: совпало одно слово \(«гостей»\) — UNKNOWN/);
    expect(jobQuoteSupport('Подключите быструю идентификацию гостей', 'guest-guide', SEED)).toMatchObject({ level: 'uncertain', matched: ['гостей'] });
  });

  it('negative cases: one shared word (user, entity, generic product noun) never proves a job', () => {
    for (const [quote, job] of [
      ['Электронная регистрация гостей в отеле', 'guest-guide'], // guests, not a guide
      ['Онлайн-оплата проживания для гостей', 'guest-guide'],
      ['Digital guidebook (PWA)', 'guest-guide'], // guide, but for whom/what job is not stated
      ['Самостоятельное заселение по коду замка', 'checkin-instructions'], // check-in, but no instructions
      ['Contact collection', 'checkin-instructions'],
    ] as const) {
      expect(jobQuoteSupport(quote, job, SEED).level, quote).not.toBe('proven');
    }
    // and the positive real quotes stay proven
    expect(jobQuoteSupport('The guidebook your guests actually use.', 'guest-guide', SEED)).toMatchObject({ level: 'proven' });
    expect(jobQuoteSupport('Инструкции по заселению и выезду;', 'checkin-instructions', SEED)).toMatchObject({ level: 'proven' });
    expect(jobQuoteSupport('Цифровой гид гостя с правилами дома', 'guest-guide', SEED)).toMatchObject({ level: 'proven' });
  });

  it('in the pipeline: a rival whose primary job is UNKNOWN is a possible rival — never a proven direct competitor, never proof of an empty niche', async () => {
    const web = new RecordedWeb();
    // GuestCom's page with its guest-guide quote replaced by an identification-only phrase present on the page
    const hook: ConstructorParameters<typeof RecordedProviders>[0] = {
      llm: (task, data) =>
        task === 'extract_offer' && (data.page as { url: string }).url === 'https://gcom.host/'
          ? { content: JSON.stringify({ isProductPage: true, name: 'GuestCom', market: 'ru', jobs: [{ job: 'guest-guide', quote: 'Электронный гид для гостей апартаментов'.replace('Электронный гид для', 'Регистрация') }], price: null, pageKind: 'vendor' }) }
          : undefined,
    };
    const b = buildLiveProviders(cfg, { providerTransport: new RecordedProviders(hook), webTransport: web, resolver: web, sleep: async () => {}, clock: virtualClock() });
    const r = await researchCandidate(SEEDS.guest!, true, '2026-11-12', b.providers, new CallContext('t', 1, 10_000_000));
    const gc = r.competitors.find((c) => c.name === 'GuestCom');
    if (gc) {
      expect(gc.kind).not.toBe('direct');
      expect(gc.primaryJobStatus).not.toBe('proven');
    }
    for (const c of r.competitors.filter((x) => x.kind === 'direct')) expect(c.primaryJobStatus, c.name).toBe('proven');
  });
});
