// @vitest-environment node
/**
 * VL-004B audit round 2 — an UNPROVEN competitor market is neither proof of competition nor proof of its
 * absence. A possible rival (job proven on its page, market conflicting/unknown):
 *  - is not counted as a proven rival (no refutation, no «≥2 direct» hold, no Russia validation);
 *  - but blocks every benefit to the «empty Russian niche»: no 4/5 cap from an independent RU source,
 *    and a «nobody in Russia does X» claim cannot be supported while it exists.
 */
import { describe, expect, it } from 'vitest';
import { loadLiveConfig } from '../live/config';
import { buildLiveProviders } from '../live/providers';
import { RecordedProviders, RecordedWeb, TEST_ENV } from '../live/recordings/mock';
import { researchCandidate, runPipeline, type Providers } from '../machine/pipeline';
import { FixtureLLMProvider, FixtureSearchProvider, FixtureSkeptic, FixtureSourceReader } from '../machine/providers/fixture';
import { CallContext, type AnalystProposal, type DiscoverySeed, type PageRead, type SkepticFindings, type SkepticInput } from '../machine/types';

const DAY = '2026-11-12';
const seed: DiscoverySeed = { externalId: 'possible-rival', title: 'Тест возможного конкурента', pitch: 'Тестовый кандидат.', segment: 'B2B', category: 'Finance', primaryJob: 'invoice-reminders', jobs: ['invoice-reminders'], westernProduct: 'Invoice Chaser' };
const REVIEW = 'https://example.org/invoice-chaser-review';
const SURVEY = 'https://example.org/ru-freelance-survey';
const RIVAL = 'https://rival.example.com/reminders';

const proposal = (claims: AnalystProposal['claims'], scores: AnalystProposal['scores']): AnalystProposal => ({
  model: 'stub-analyst',
  claims: [{ key: 'w-need', dimension: 'westernNeed', text: 'Есть спрос.', quote: 'send polite automatic payment reminders', sourceUrls: [REVIEW], highImpact: true }, ...claims],
  scores: { westernNeed: { value: 4, claims: ['w-need'] }, ...scores },
  founderFit: null,
  ruQueries: ['нет результатов один', 'нет результатов два', 'нет результатов три'],
  rationale: 'Тест.',
});

/** Fixture world + one extra Russian search hit whose page proves the primary job; its market status is a parameter. */
function providers(p: AnalystProposal, marketStatus: 'verified' | 'conflicting' | 'unknown' | null, skeptic?: (f: SkepticFindings, input: SkepticInput) => SkepticFindings): Providers {
  const search = new FixtureSearchProvider(DAY);
  const reader = new FixtureSourceReader(DAY);
  const fs = new FixtureSkeptic();
  return {
    search: {
      name: 'stub-search',
      search: async (q, region, ctx) => [...(await search.search(q, region, ctx)), ...(marketStatus && region === 'ru' && q === 'нет результатов один' ? [{ url: RIVAL, title: 'Rival' }] : [])],
    },
    reader: {
      name: 'stub-reader',
      read: async (url, ctx): Promise<PageRead> =>
        url === RIVAL
          ? {
              url, status: 'ok', httpStatus: 200, publisher: 'rival.example.com', sourceType: 'company_self_report', region: 'ru', contentHash: 'x',
              text: 'Rival Reminders sends automatic payment reminders to clients.',
              offer: { name: 'Rival Reminders', market: 'ru', jobs: ['invoice-reminders'], grounding: { level: 'partial', jobEvidence: { 'invoice-reminders': 'sends automatic payment reminders' }, uncertain: [], extractor: 'm', marketVerified: marketStatus === 'verified', marketStatus: marketStatus!, marketSignals: [], marketConflicts: [] } },
            }
          : reader.read(url, ctx),
    },
    llm: Object.assign(new FixtureLLMProvider(), { analyse: async () => p }),
    skeptic: { name: fs.name, model: fs.model, counterQueries: (s: DiscoverySeed) => fs.counterQueries(s), challenge: async (i, c) => (skeptic ? skeptic(await fs.challenge(i, c), i) : fs.challenge(i, c)) } as Providers['skeptic'],
  };
}
const research = (p: AnalystProposal, m: 'verified' | 'conflicting' | 'unknown' | null, sk?: (f: SkepticFindings, input: SkepticInput) => SkepticFindings) => researchCandidate(seed, true, DAY, providers(p, m, sk), new CallContext('t', 1, 1_000_000));

describe('possible rivals never raise the Russian niche', () => {
  const gap = proposal([{ key: 'ru-gap', dimension: 'ruUnmetJob', text: 'В РФ напоминания отправляют вручную.', quote: 'напоминания отправляют вручную', sourceUrls: [SURVEY] }], { ruUnmetJob: { value: 5, claims: ['ru-gap'] } });

  it('baseline: no rival + independent RU source → cap 4 (VL-004A rule unchanged)', async () => {
    expect((await research(gap, null)).assessment.scores.ruUnmetJob).toBe(4);
  });

  it('a rival with a CONFLICTING or UNKNOWN market keeps the cap at 3 (competition unclear), never 4', async () => {
    for (const m of ['conflicting', 'unknown'] as const) {
      const r = await research(gap, m);
      expect(r.competitors.find((c) => c.name === 'Rival Reminders')).toMatchObject({ kind: 'direct', marketVerified: false, marketStatus: m });
      expect(r.assessment.scores.ruUnmetJob).toBe(3);
      expect(r.assessment.dimensionNotes.join(' ')).toMatch(/потолок 3 — есть возможные конкуренты с неустановленным рынком \(Rival Reminders\)/);
      // not counted as proven: no «≥2 direct / free» hold, and Russia validation does not count it
      expect(r.assessment.holdReasons.join(' ')).not.toMatch(/Пробел опровергнут/);
    }
  });

  it('a PROVEN rival (verified market) caps the dimension at 2 as before', async () => {
    expect((await research(gap, 'verified')).assessment.scores.ruUnmetJob).toBeLessThanOrEqual(2);
  });

  it('«nobody in Russia does it» cannot be SUPPORTED while a possible direct rival exists (skeptic says supported)', async () => {
    const absence = proposal(
      [{ key: 'ru-gap', dimension: 'ruUnmetJob', text: 'В РФ нет сервиса напоминаний.', quote: 'напоминания отправляют вручную', sourceUrls: [SURVEY], highImpact: true, absence: { market: 'ru', job: 'invoice-reminders' } }],
      { ruUnmetJob: { value: 5, claims: ['ru-gap'] } },
    );
    // the skeptic model wrongly SUPPORTS the gap, citing exactly the source that contains the quote
    const supportGap = (f: SkepticFindings, input: SkepticInput): SkepticFindings => ({
      ...f,
      claimVerdicts: f.claimVerdicts.map((v) => (v.claimKey === 'ru-gap' ? { ...v, verdict: 'supported', sourceKeys: input.claims.find((x) => x.key === 'ru-gap')!.supportingKeys, reason: 'пробел подтверждён' } : v)),
      disputes: [],
    });
    const r = await research(absence, 'unknown', supportGap);
    expect(r.claims.find((x) => x.key === 'ru-gap')!.supportingKeys.length).toBeGreaterThan(0); // the quote IS on the page
    const c = r.claims.find((x) => x.key === 'ru-gap')!;
    expect(c.skepticVerdict).toBe('needs_more_evidence');
    expect(c.skepticReason).toMatch(/возможный прямой конкурент с неустановленным рынком/);
    expect(r.assessment.scores.ruUnmetJob).toBeNull();
  });
});

describe('recorded corpus: Quote Compare with rivals whose pages lose every RU signal', () => {
  it('the gap is NOT proven and NOT refuted: rivals shown as possible, ruUnmetJob unknown (null), never raised', async () => {
    const strip = (body: string) => body.replace(/Тариф от 2 900 ₽ в месяц\./, '').replace(/Первые 10 сравнений бесплатно\./, '');
    const base = new RecordedWeb();
    const pages = Object.fromEntries(
      ['https://vnikli.ru/sravnenie-kommercheskih-predlozheniy/', 'https://vortholm.ru/solutions/procurement/supplier-quotes-comparison/'].map((u) => [u.replace('.ru/', '.example.com/'), { ...base.pages[u]!, body: strip(base.pages[u]!.body!) }]),
    );
    // same pages moved to a neutral .com host (no RU domain, no ₽): the market becomes unknown
    const web = new RecordedWeb({ dns: { 'vnikli.example.com': ['151.101.98.1'], 'vortholm.example.com': ['151.101.98.2'] }, pages });
    const prov = new RecordedProviders({
      search: (q) =>
        q.type === 'SEARCH_TYPE_RU' && /коммерческих предложений|кп поставщиков|sourceday rfq альтернатива|аналог sourceday|sourceday rfq alternative russian/i.test(q.text)
          ? { results: Object.keys(pages).map((u) => ({ url: u, title: u, passage: 'сравнение КП' })) }
          : undefined,
      llm: (task, data) => {
        const url = (data.page as { url?: string } | undefined)?.url ?? '';
        if (task === 'extract_offer' && url.includes('vnikli.example.com')) return { content: JSON.stringify({ isProductPage: true, name: 'ВНИКЛИ', market: 'ru', jobs: [{ job: 'quote-comparison', quote: 'загрузите КП в PDF или Excel и получите сравнительную таблицу условий' }], price: null, pageKind: 'vendor' }) };
        if (task === 'extract_offer' && url.includes('vortholm.example.com')) return { content: JSON.stringify({ isProductPage: true, name: 'Vortholm', market: 'ru', jobs: [{ job: 'quote-comparison', quote: 'сводит коммерческие предложения поставщиков в одну таблицу' }], price: null, pageKind: 'vendor' }) };
        return undefined;
      },
    });
    const b = buildLiveProviders(loadLiveConfig(TEST_ENV), { providerTransport: prov, webTransport: web, resolver: web, sleep: async () => {} });
    const r = await runPipeline(DAY, [], b.providers, new CallContext('t', 1, 1_000_000), { maxNew: 6, evidenceHits: 3, hitsPerQuery: 3, maxRuQueries: 8 });
    const c = r.candidates.find((x) => x.externalId === 'supplier-quote-compare')!;
    expect(c.competitors.map((x) => `${x.name}:${x.kind}:${x.marketStatus}`).sort()).toEqual(['Vortholm:direct:unknown', 'ВНИКЛИ:direct:unknown']);
    const gap = c.claims.find((x) => x.key === 'ru-gap')!;
    expect(gap.status).not.toBe('contradicted'); // not refuted by unproven rivals …
    expect(gap.skepticVerdict).toBe('needs_more_evidence');
    expect(c.assessment.scores.ruUnmetJob).toBeNull(); // … and never counted as a free niche (the analyst proposed 5)
  });
});
