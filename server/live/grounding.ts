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
 * Market of a PRODUCT (where it is sold), from verifiable page signals only. Stricter than `marketSignal`
 * (which only says what language/region a page is written for): Russian-language text alone does NOT
 * prove the product is offered in Russia. «ru» needs an availability signal (RU domain, price in ₽/руб,
 * +7 phone, Russian legal identifiers) AND Russian-language content, with no western price signal;
 * «west» needs a $/€/£ price and an English (or other western) page with no RU availability signal.
 * Anything else is null = not established (the offer is kept, but never used as a proven rival).
 * NB: these are page signals, not proof of registration or payment acceptance in Russia.
 */
export interface MarketEvidence {
  market: Region | null;
  signals: string[];
  conflicts: string[];
}

export function marketEvidence(url: string, lang: string | null, text: string): MarketEvidence {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* ignore */
  }
  const sample = text.slice(0, 50_000);
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  const cyr = sample.match(/[\u0400-\u04ff]/g)?.length ?? 0;
  const cyrShare = letters ? cyr / letters : 0;
  const ru: string[] = [];
  if (RU_TLD.test(host)) ru.push(`домен ${host}`);
  if (/\d[\d\s\u00a0]*\s?(₽|руб\.?|рублей)/i.test(sample)) ru.push('цена в рублях');
  if (/(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/.test(sample)) ru.push('телефон +7');
  // (JS \b does not work next to Cyrillic letters — explicit non-letter guards)
  if (/(?:^|[^\p{L}])(?:ИНН\s*\d{10,12}|ОГРН(?:ИП)?\s*\d{13,15})(?!\d)/u.test(sample)) ru.push('ИНН/ОГРН');
  const ruLang = (lang ?? '').startsWith('ru') || cyrShare > 0.5;
  const west: string[] = [];
  if (/[$€£]\s?\d|\d\s?(USD|EUR|GBP)\b/.test(sample)) west.push('цена в $/€/£');
  const westLang = (!!lang && /^(en|de|fr|es|it|pt|nl)/.test(lang)) || (letters > 50 && cyrShare < 0.1);
  const conflicts: string[] = [];
  if (ru.length && west.length) conflicts.push(`признаки РФ (${ru.join(', ')}) и Запада (${west.join(', ')}) одновременно`);
  if (ru.length && !ruLang) conflicts.push(`признаки РФ (${ru.join(', ')}), но страница не на русском`);
  if (ru.length && ruLang && west.length === 0) return { market: 'ru', signals: [...ru, 'русский язык страницы'], conflicts };
  if (west.length && westLang && ru.length === 0) return { market: 'west', signals: [...west, `язык страницы ${lang ?? 'латиница'}`], conflicts };
  return { market: null, signals: [...ru, ...west, ...(ruLang ? ['русский язык страницы (локализация ≠ продажи в РФ)'] : [])], conflicts };
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
    const qp = quoteProblem(j.quote);
    if (qp) uncertain.push(`работа ${j.job}: ${qp}`);
    else if (!containsLiteral(page.text, j.quote)) uncertain.push(`работа ${j.job}: цитата «${j.quote.slice(0, 80)}» не найдена на странице`);
    else jobEvidence[j.job] ??= j.quote.trim();
  }
  let price: string | undefined;
  if (x.price) {
    if (/\d|бесплат|free/i.test(x.price) && containsLiteral(page.text, x.price)) price = x.price.trim();
    else uncertain.push(`цена «${x.price.slice(0, 60)}» не найдена на странице`);
  }
  let ev = marketEvidence(page.url, page.lang, page.text);
  let via = 'страница';
  if (!ev.market && probe) {
    // Automatic second check on the same site (home page): still only verifiable page signals.
    const p = marketEvidence(probe.url, probe.lang, probe.text);
    if (p.market) {
      ev = { market: p.market, signals: p.signals.map((x) => `${x} (главная страница сайта)`), conflicts: [...ev.conflicts, ...p.conflicts] };
      via = 'главная страница сайта';
    }
  }
  let market: Region;
  let marketVerified: boolean;
  if (ev.market) {
    if (x.market !== 'unknown' && x.market !== ev.market) uncertain.push(`рынок: модель указала ${x.market}, признаки (${via}) — ${ev.market}`);
    market = ev.market;
    marketVerified = true;
  } else {
    // Not established: the model's guess is kept only as a label — the rival never counts as a proven RU/West competitor.
    market = x.market === 'ru' ? 'ru' : 'west';
    marketVerified = false;
    uncertain.push(`рынок не подтверждён признаками страницы (модель: ${x.market})${ev.conflicts.length ? `; противоречия: ${ev.conflicts.join('; ')}` : ''}${ev.signals.length ? `; найдено: ${ev.signals.join(', ')}` : ''}`);
  }
  const jobs = Object.keys(jobEvidence);
  return {
    offer: {
      name,
      market,
      jobs,
      ...(price ? { price } : {}),
      grounding: { level: uncertain.length ? 'partial' : 'grounded', jobEvidence, uncertain, extractor, marketVerified, marketSignals: ev.signals },
    },
    uncertain,
  };
}
