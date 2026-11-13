/**
 * Visible-text extraction from untrusted HTML (VL-004B). No DOM, no script execution: a small
 * tokenizer that keeps only what a human would see. Scripts, styles, templates, SVG, iframes,
 * comments and elements hidden by `hidden`, `aria-hidden="true"` or inline `display:none` /
 * `visibility:hidden` / zero font-size are dropped — hidden text is a classic prompt-injection carrier.
 */
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'canvas', 'head', 'select', 'button', 'form']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'li', 'ul', 'ol', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'dd', 'dt', 'dl', 'blockquote', 'pre', 'figure', 'figcaption', 'td', 'th']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', rub: '₽', euro: '€', copy: '©', reg: '®', trade: '™', times: '×', middot: '·', bull: '•', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bdquo: '„', thinsp: ' ', ensp: ' ', emsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (m) return m[1] ?? m[2] ?? m[3] ?? '';
  return new RegExp(`\\s${name}(?=[\\s>/])`, 'i').test(tag) ? '' : null;
}

function isHidden(tag: string): boolean {
  if (attr(tag, 'hidden') !== null) return true;
  if ((attr(tag, 'aria-hidden') ?? '').toLowerCase() === 'true') return true;
  const style = (attr(tag, 'style') ?? '').toLowerCase().replace(/\s+/g, '');
  return /display:none|visibility:hidden|font-size:0(?![.\d])|opacity:0(?![.\d])/.test(style);
}

export interface ExtractedPage {
  title: string | null;
  description: string | null;
  canonical: string | null;
  lang: string | null;
  text: string;
  /** Characters of text dropped because they were hidden from humans. */
  hiddenChars: number;
  /** Publication metadata used for deterministic provenance checks (never trusted alone). */
  meta: PageMeta;
}

export interface PageMeta {
  ogType: string | null;
  siteName: string | null;
  author: string | null;
  published: string | null;
  /** schema.org @type values from JSON-LD. */
  schemaTypes: string[];
  /** The page uses <article> markup. */
  articleTag: boolean;
}

const EMPTY_META: PageMeta = { ogType: null, siteName: null, author: null, published: null, schemaTypes: [], articleTag: false };

const MAX_TEXT = 200_000;

export function extractPage(html: string, contentType: string | null = 'text/html'): ExtractedPage {
  if ((contentType ?? '').toLowerCase().startsWith('text/plain')) {
    return { title: null, description: null, canonical: null, lang: null, text: html.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT), hiddenChars: 0, meta: EMPTY_META };
  }
  const src = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<![^>]*>|<\?[^>]*\?>/g, ' ');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1];
  const metaTags = src.match(/<meta\b[^>]*>/gi) ?? [];
  const description = metaTags.map((t) => ((attr(t, 'name') ?? attr(t, 'property') ?? '').toLowerCase().match(/^(description|og:description)$/) ? attr(t, 'content') : null)).find((x) => x) ?? null;
  const canonical = (src.match(/<link\b[^>]*>/gi) ?? []).map((t) => ((attr(t, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical') ? attr(t, 'href') : null)).find((x) => x) ?? null;
  const lang = attr(/<html\b[^>]*>/i.exec(src)?.[0] ?? '<html>', 'lang');
  const metaBy = (...keys: string[]) => metaTags.map((t) => (keys.includes((attr(t, 'name') ?? attr(t, 'property') ?? attr(t, 'itemprop') ?? '').toLowerCase()) ? attr(t, 'content') : null)).find((x) => x) ?? null;
  const schemaTypes = [
    ...new Set(
      [...src.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].flatMap((m) => [...m[1]!.matchAll(/"@type"\s*:\s*"([A-Za-z]+)"/g)].map((t) => t[1]!)),
    ),
  ].slice(0, 20);
  const metaInfo: PageMeta = {
    ogType: metaBy('og:type'),
    siteName: metaBy('og:site_name', 'application-name'),
    author: metaBy('author', 'article:author'),
    published: metaBy('article:published_time', 'datepublished', 'date'),
    schemaTypes,
    articleTag: /<article\b/i.test(src),
  };

  const out: string[] = [];
  let hiddenChars = 0;
  // stack of open elements we are SKIPPING (tag name), with depth of same-name nesting
  let skip: { name: string; depth: number; hidden: boolean } | null = null;
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [tok, name, txt] = m;
    if (txt !== undefined || tok === '<') {
      const t = txt ?? '<';
      if (skip) {
        if (skip.hidden) hiddenChars += t.trim().length;
      } else out.push(t);
      continue;
    }
    const n = name!.toLowerCase();
    const closing = tok.startsWith('</');
    const selfClosing = tok.endsWith('/>') || VOID.has(n);
    if (skip) {
      if (n === skip.name && !selfClosing) {
        if (closing) {
          if (--skip.depth === 0) skip = null;
        } else skip.depth++;
      }
      continue;
    }
    if (closing) {
      if (BLOCK.has(n)) out.push('\n');
      continue;
    }
    if (!selfClosing && (SKIP.has(n) || isHidden(tok))) {
      skip = { name: n, depth: 1, hidden: !SKIP.has(n) };
      continue;
    }
    if (BLOCK.has(n)) out.push('\n');
    if (n === 'img') {
      const alt = attr(tok, 'alt');
      if (alt) out.push(` ${alt} `);
    }
  }
  const text = decodeEntities(out.join(''))
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '') // zero-width characters (used to split injected phrases)
    .split('\n')
    .map((l) => l.replace(/[ \t\r\f\v\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT);
  const clean = (s: string | null | undefined) => (s ? decodeEntities(s).replace(/\s+/g, ' ').trim() || null : null);
  return {
    title: clean(title),
    description: clean(description),
    canonical: canonical ? canonical.trim() : null,
    lang: lang ? lang.toLowerCase().slice(0, 10) : null,
    text,
    hiddenChars,
    meta: { ...metaInfo, ogType: clean(metaInfo.ogType), siteName: clean(metaInfo.siteName), author: clean(metaInfo.author), published: clean(metaInfo.published) },
  };
}

/**
 * Instruction-like content aimed at an AI reader. A page that matches is quarantined: its content is
 * never passed to a model and never used as evidence (it remains visible as a quarantined source).
 */
const INJECTION = [
  /ignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/i,
  /disregard\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions|prompts?)/i,
  /игнорируй(те)?\s+(все\s+)?(предыдущие|прошлые|прежние|вышеуказанные)\s+(инструкции|указания|правила)/i,
  /забудь(те)?\s+(все\s+)?(предыдущие|прошлые)\s+(инструкции|указания)/i,
  /\b(you are|act as)\s+(now\s+)?(an?\s+)?(ai|assistant|language model|llm)\b.*\b(must|should|will)\b/i,
  /\b(ai|llm|assistant|model|gpt|language model)s?\b[^.\n]{0,40}\b(must|should)\s+(rate|score|approve|mark|verify|rank)/i,
  /\brate\s+this\s+(idea|product|startup|company)\s+\d/i,
  /mark\s+all\s+claims\s+as\s+(verified|true|supported)/i,
  /(оцени(те)?|поставь(те)?)\s+(эту|этот|данную|данный)\s+(идею|продукт|стартап|компанию)\s+(на\s+)?\d/i,
  /(system|developer)\s+(prompt|message)\s*:/i,
  /<\s*(system|assistant|tool)\s*>/i,
  /\bBEGIN\s+(SYSTEM|INSTRUCTIONS)\b/i,
];

export function looksLikeInjection(text: string): string | null {
  for (const r of INJECTION) {
    const m = r.exec(text);
    if (m) return m[0].slice(0, 120);
  }
  return null;
}
