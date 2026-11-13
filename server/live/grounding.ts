/**
 * Deterministic evidence linkage for offers extracted by a model (VL-004B).
 *
 * The extraction model only PROPOSES: product name, market, jobs (each with a verbatim quote) and price.
 * Code keeps a field only if it is literally on the fetched page; everything else is listed as
 * `uncertain` and never used for competition caps. Market comes from page signals (domain, language,
 * currency, script) — the model's opinion only fills a gap and is then marked uncertain.
 */
import { quoteProblem } from '../machine/schemas';
import type { DiscoverySeed, PageOffer, Region } from '../machine/types';

/** Normalisation for literal matching: case, ё/е, quotes, dashes, whitespace, soft hyphens. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[«»“”„"']/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function containsLiteral(haystack: string, needle: string): boolean {
  const n = normText(needle);
  return n.length > 0 && normText(haystack).includes(n);
}

/** Character offset of a quote in the page text (after normalisation), or -1. */
export function quoteOffset(haystack: string, needle: string): number {
  const n = normText(needle);
  return n ? normText(haystack).indexOf(n) : -1;
}

const RU_TLD = /\.(ru|su|xn--p1ai|рф)$/i;

/** Market of a page from deterministic signals only; null when the signals disagree or are absent. */
export function marketSignal(url: string, lang: string | null, text: string): Region | null {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* ignore */
  }
  const sample = text.slice(0, 20_000);
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  const cyr = sample.match(/[Ѐ-ӿ]/g)?.length ?? 0;
  const cyrShare = letters ? cyr / letters : 0;
  const rub = /₽|\bруб\b|руб\.|рублей|\bRUB\b/i.test(sample);
  const ruVotes = [RU_TLD.test(host), (lang ?? '').startsWith('ru'), cyrShare > 0.5, rub].filter(Boolean).length;
  const westVotes = [!!lang && /^(en|de|fr|es|it|pt|nl)/.test(lang), cyrShare < 0.1 && letters > 50, /\$\s?\d|€\s?\d|\d\s?(USD|EUR)\b/.test(sample)].filter(Boolean).length;
  if (ruVotes >= 2 && westVotes <= 1) return 'ru';
  if (westVotes >= 2 && ruVotes === 0) return 'west';
  return null;
}

/**
 * Market of a PRODUCT (where it is sold) from verifiable page signals — three distinct outcomes:
 *  - `verified`    — availability established (see rules);
 *  - `conflicting` — signals point to different markets and nothing strong resolves them;
 *  - `unknown`     — no availability signal at all (e.g. no prices, localisation only).
 * Neither `conflicting` nor `unknown` is evidence that a rival is ABSENT from Russia (the pipeline
 * treats such a rival as a possible competitor: it is not counted as proven, but it also blocks any
 * benefit to the «empty Russian niche» — see pipeline.ts).
 *
 * Strong RU availability (any one establishes «ru», whatever the page language — an English page of a
 * Russian product is still Russian): a price in ₽/руб, a +7 phone, ИНН/ОГРН, Russian payment rails
 * (СБП, карта «Мир», ЮKassa/ЮMoney). A multi-currency page with ₽ IS sold in Russia (also abroad).
 * Weak RU: an RU domain (.ru/.рф/.su) — establishes «ru» only without contradicting western prices;
 * Russian language alone never does (localisation ≠ sales).
 * West: a $/€/£ price with no RU signal at all.
 * NB: page signals, not proof of registration or payment acceptance in Russia.
 */
export type MarketStatus = 'verified' | 'conflicting' | 'unknown';

export interface MarketEvidence {
  status: MarketStatus;
  /** Set only when status = verified. */
  market: Region | null;
  /** Every signal found, labelled with where it was found. */
  signals: string[];
  conflicts: string[];
}

interface RawSignals {
  strongRu: string[];
  weakRu: string[];
  west: string[];
  ruLanguage: boolean;
}

function rawSignals(url: string, lang: string | null, text: string, where = ''): RawSignals {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* ignore */
  }
  const sample = text.slice(0, 50_000);
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  const cyr = sample.match(/[\u0400-\u04ff]/g)?.length ?? 0;
  const tag = (s: string) => (where ? `${s} (${where})` : s);
  const strongRu: string[] = [];
  if (/\d[\d\s\u00a0.,]*\s?(₽|руб\.?|рублей|RUB\b)/iu.test(sample) || /(₽|RUB)\s?\d/u.test(sample)) strongRu.push(tag('цена в рублях'));
  if (/(?:\+7|(?:^|[^\d])8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/.test(sample)) strongRu.push(tag('телефон +7'));
  // (JS \b does not work next to Cyrillic letters — explicit non-letter guards)
  if (/(?:^|[^\p{L}])(?:ИНН\s*\d{10,12}|ОГРН(?:ИП)?\s*\d{13,15})(?!\d)/u.test(sample)) strongRu.push(tag('ИНН/ОГРН'));
  if (/(?:^|[^\p{L}])(?:СБП|карт[аыою]? «?Мир»?|ЮKassa|ЮMoney|ЮКасса)(?![\p{L}])/u.test(sample)) strongRu.push(tag('российские способы оплаты'));
  const weakRu = RU_TLD.test(host) ? [tag(`домен ${host}`)] : [];
  const west: string[] = [];
  if (/[$€£]\s?\d|\d\s?(USD|EUR|GBP)\b/.test(sample)) west.push(tag('цена в $/€/£'));
  return { strongRu, weakRu, west, ruLanguage: (lang ?? '').startsWith('ru') || (letters > 0 && cyr / letters > 0.5) };
}

function judge(r: RawSignals): MarketEvidence {
  const signals = [...r.strongRu, ...r.weakRu, ...r.west, ...(r.ruLanguage && !r.strongRu.length && !r.weakRu.length ? ['русский язык страницы (локализация ≠ продажи в РФ)'] : [])];
  const conflicts: string[] = [];
  if (r.strongRu.length) {
    // Sold for roubles / Russian entity: available in Russia even if also sold abroad.
    if (r.west.length) conflicts.push(`мультивалютная страница: ${[...r.strongRu, ...r.west].join(', ')} — доступен в РФ и за рубежом`);
    return { status: 'verified', market: 'ru', signals, conflicts };
  }
  if (r.weakRu.length && r.west.length) return { status: 'conflicting', market: null, signals, conflicts: [`${r.weakRu.join(', ')}, но цены только в $/€/£ (${r.west.join(', ')})`] };
  if (r.weakRu.length) return { status: 'verified', market: 'ru', signals, conflicts };
  if (r.west.length) return { status: 'verified', market: 'west', signals, conflicts };
  return { status: 'unknown', market: null, signals, conflicts };
}

export function marketEvidence(url: string, lang: string | null, text: string): MarketEvidence {
  return judge(rawSignals(url, lang, text));
}

/**
 * Product page + the site's home page. The home page may only FILL a gap (page status `unknown`);
 * it never overrides a page that is verified or conflicting. All signals are pooled and re-judged, so a
 * contradiction between the two pages is kept (e.g. the page only sells in $ but the home page shows ₽
 * → the combined verdict records the conflict instead of silently picking one).
 */
export function combinedMarketEvidence(page: { url: string; lang: string | null; text: string }, home: { url: string; lang: string | null; text: string } | null): MarketEvidence & { via: 'страница' | 'страница + главная' } {
  const p = rawSignals(page.url, page.lang, page.text);
  const own = judge(p);
  if (own.status !== 'unknown' || !home) return { ...own, via: 'страница' };
  const h = rawSignals(home.url, home.lang, home.text, 'главная страница сайта');
  const merged = judge({ strongRu: [...p.strongRu, ...h.strongRu], weakRu: [...p.weakRu, ...h.weakRu], west: [...p.west, ...h.west], ruLanguage: p.ruLanguage || h.ruLanguage });
  return { ...merged, via: 'страница + главная' };
}

export interface ExtractedOffer {
  isProductPage: boolean;
  name: string | null;
  market: 'ru' | 'west' | 'unknown';
  jobs: { job: string; quote: string }[];
  price: string | null;
  pageKind: 'vendor' | 'independent' | 'marketplace' | 'forum' | 'unknown';
}

export interface Grounded {
  offer: PageOffer | null;
  /** Fields the model claimed that code could not find on the page. */
  uncertain: string[];
}

/** Promotional copy (discounts, sales) proves a campaign, never a product function. */
const PROMO = /black\s*friday|cyber\s*monday|\b\d{1,2}\s?%\s?off\b|\bsale\b|\bdiscount|promo\s?code|скидк|распродаж|промокод|акци[яи]\b/i;

const words = (x: string) =>
  x
    .toLowerCase()
    .replace(/(\p{L})-(\p{L})/gu, '$1$2') // check-in → checkin
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
/** A crude, language-agnostic stem: 3-letter words exact, otherwise the first 5 letters (4 for 4–5 letter words). */
const stem = (w: string) => (w.length <= 3 ? w : w.length <= 5 ? w.slice(0, 4) : w.slice(0, 5));
/** A quote word matches a vocabulary stem by prefix (guidebook ↔ guid, гостей ↔ гост); 3-letter stems exactly. */
const matches = (word: string, st: string) => (st.length <= 3 ? word === st : word.startsWith(st));

/**
 * Does a verbatim quote plausibly describe THIS job? (VL-004B-strict, P2 regression of 13.11.2026)
 *  - promotional copy (Black Friday, % off, скидка…) never proves a function;
 *  - the quote must share at least one term with the job: a word of the job slug (guest, guide, checkin,
 *    instructions…) or of the candidate's Russian keywords (гид, гостя, инструкция, заселению…), compared by
 *    a crude stem.
 * This is a NECESSARY condition, not a semantic proof: a quote that mentions guests but describes guest
 * identification still passes (a known gap; a semantic check is separate work).
 */
export function jobQuoteProblem(quote: string, job: string, seed: Pick<DiscoverySeed, 'ruKeywords'>): string | null {
  if (PROMO.test(quote)) return 'рекламный текст (акция/скидка) не подтверждает функцию продукта';
  const vocab = new Set([...words(job.replace(/-/g, ' ')), ...(seed.ruKeywords ?? []).flatMap(words)].filter((w) => w.length >= 3).map(stem));
  const q = words(quote);
  for (const v of vocab) if (q.some((w) => matches(w, v))) return null;
  return 'цитата не содержит ни одного термина задачи — не подтверждает именно эту работу';
}

/** A price must state an amount with a currency, or a free tier — not any sentence that contains a digit. */
const CTA = /^(get started|start|try|sign up|join|начать|попробовать|зарегистрироваться)( it| now| for)? (free|бесплатно)\W*$/i;

export function priceProblem(price: string): string | null {
  const p = price.trim();
  if (p.length > 80) return 'слишком длинный фрагмент для цены';
  if (CTA.test(p)) return 'призыв к действию («начать бесплатно»), а не тариф';
  if (/(\d[\d\s.,]*\s?(₽|руб|р\.|rub|\$|€|£|usd|eur|gbp))|((\$|€|£)\s?\d)|бесплат|\bfree\b/i.test(p)) return null;
  return 'нет суммы с валютой и нет бесплатного тарифа';
}

export function groundOffer(
  x: ExtractedOffer,
  page: { url: string; title: string | null; lang: string | null; text: string },
  seed: DiscoverySeed,
  extractor: string,
  /** Extra page (e.g. the site's home page) fetched automatically to re-check an undetermined market. */
  probe?: { url: string; lang: string | null; text: string } | null,
): Grounded {
  const uncertain: string[] = [];
  if (!x.isProductPage || !x.name) return { offer: null, uncertain };
  const visible = `${page.title ?? ''}\n${page.text}`;
  const name = x.name.trim();
  if (name.length < 2 || name.length > 80 || !containsLiteral(visible, name)) {
    return { offer: null, uncertain: [`название «${name.slice(0, 80)}» не найдено на странице — предложение не принято`] };
  }
  const jobEvidence: Record<string, string> = {};
  for (const j of x.jobs) {
    if (!seed.jobs.includes(j.job)) {
      uncertain.push(`работа ${j.job}: не из списка работ идеи`);
      continue;
    }
    const qp = quoteProblem(j.quote) ?? jobQuoteProblem(j.quote, j.job, seed);
    if (qp) uncertain.push(`работа ${j.job}: ${qp}`);
    else if (!containsLiteral(page.text, j.quote)) uncertain.push(`работа ${j.job}: цитата «${j.quote.slice(0, 80)}» не найдена на странице`);
    else jobEvidence[j.job] ??= j.quote.trim();
  }
  let price: string | undefined;
  if (x.price) {
    const pp = priceProblem(x.price);
    if (pp) uncertain.push(`цена «${x.price.slice(0, 60)}» не принята: ${pp}`);
    else if (containsLiteral(page.text, x.price)) price = x.price.trim();
    else uncertain.push(`цена «${x.price.slice(0, 60)}» не найдена на странице`);
  }
  const ev = combinedMarketEvidence(page, probe ?? null);
  let market: Region;
  if (ev.status === 'verified') {
    if (x.market !== 'unknown' && x.market !== ev.market) uncertain.push(`рынок: модель указала ${x.market}, признаки (${ev.via}) — ${ev.market}`);
    market = ev.market!;
  } else {
    // Not established: the model's guess is kept only as a label — never a proven rival, never proof of absence.
    // A «ru» label is not given to a page with no Russian text at all (13.11.2026: Touch Stay, English pages,
    // was labelled «ru» by the model). The possible-rival rules use `marketVerified`, not this label.
    const cyr = (page.text.match(/[а-яё]/giu) ?? []).length;
    const lat = (page.text.match(/[a-z]/gi) ?? []).length;
    const russianText = cyr > 0 && cyr >= 0.1 * (cyr + lat);
    market = x.market === 'ru' && russianText ? 'ru' : 'west';
    if (x.market === 'ru' && !russianText) uncertain.push('модель указала рынок РФ, но на странице нет русского текста и признаков РФ — метка «ru» не присвоена');
    uncertain.push(
      `рынок ${ev.status === 'conflicting' ? 'противоречив' : 'не подтверждён'} (${ev.via}; модель: ${x.market})${ev.conflicts.length ? `; противоречия: ${ev.conflicts.join('; ')}` : ''}${ev.signals.length ? `; найдено: ${ev.signals.join(', ')}` : ''}`,
    );
  }
  const marketVerified = ev.status === 'verified';
  const jobs = Object.keys(jobEvidence);
  return {
    offer: {
      name,
      market,
      jobs,
      ...(price ? { price } : {}),
      grounding: { level: uncertain.length ? 'partial' : 'grounded', jobEvidence, uncertain, extractor, marketVerified, marketStatus: ev.status, marketSignals: ev.signals, marketConflicts: ev.conflicts },
    },
    uncertain,
  };
}
