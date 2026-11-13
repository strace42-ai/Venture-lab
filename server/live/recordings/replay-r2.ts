/**
 * Offline replay of the REAL stage2 r2 (Touch Stay, 13.11.2026) through the whole pipeline (test support only).
 * REAL (recorded): the 4 Search API result sets, the 7 extract_offer replies with the page texts Qwen saw, and
 * the analyse_candidate reply (`stage2-r2-2026-11-13.json`).
 * RECONSTRUCTED: page HTML is rebuilt from the visible text the model received (same text, simple markup); the
 * 4 pages r2 could not read keep their failure (YouTube: unsupported content, G2: 403, Trustpilot: robots.txt).
 * SIMULATED (no real data exists): the skeptic reply (DeepSeek never ran on a full research), and the results of
 * the Russian competitor / counter queries — they reuse the ONE recorded Russian result set
 * («цифровой гид гостя»); any other query returns nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecordedProviders, RecordedWeb } from './mock';

export interface R2Recording {
  searches: { type: string; text: string; requestId: string | null; docs: { url: string; title: string; passage: string }[] }[];
  extractions: { url: string; title: string | null; text: string; reply: Record<string, unknown>; requestId: string | null }[];
  analyst: { requestId: string; finish_reason: string; usage: Record<string, unknown>; evidence: { url: string; title: string | null; excerpt: string | null }[]; content: string };
}

export const R2: R2Recording = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'stage2-r2-2026-11-13.json'), 'utf8'));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = (title: string | null, text: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title ?? '')}</title></head><body><main>${text
    .split(/\n+/)
    .filter((l) => l.trim())
    .map((l) => `<p>${esc(l)}</p>`)
    .join('')}</main></body></html>`;

/** Deterministic public test addresses for every host that appears in the recorded results. */
function dnsFor(urls: string[]): Record<string, string[]> {
  const hosts = [...new Set(urls.map((u) => new URL(u).hostname))].sort();
  return Object.fromEntries(hosts.map((h, i) => [h, [`151.101.${100 + Math.floor(i / 250)}.${(i % 250) + 1}`]]));
}

/** The simulated skeptic: supports a claim only where CODE found the quote; classifies every raw rival as «direct» (code corrects it). */
function simulatedSkeptic(data: Record<string, unknown>): string {
  const claims = (data.claims as { key: string; supportingKeys: string[] }[]) ?? [];
  const raws = (data.rawCompetitors as { name: string; market: 'ru' | 'west'; sourceKey: string }[]) ?? [];
  return JSON.stringify({
    claimVerdicts: claims.map((c) =>
      c.supportingKeys.length
        ? { claimKey: c.key, verdict: 'supported', sourceKeys: c.supportingKeys, reason: 'цитата найдена кодом в источнике (ИМИТАЦИЯ скептика)' }
        : { claimKey: c.key, verdict: 'needs_more_evidence', sourceKeys: [], reason: 'источник не подтверждает (ИМИТАЦИЯ скептика)' },
    ),
    competitors: raws.map((r) => ({ name: r.name, market: r.market, kind: 'direct', sourceKey: r.sourceKey, reason: 'ИМИТАЦИЯ скептика: всё «direct», класс решает код' })),
    disputes: [],
    summary: 'ИМИТАЦИЯ скептика для офлайн-replay r2 (реального ответа DeepSeek нет).',
  });
}

export function replayR2(): { providers: RecordedProviders; web: RecordedWeb } {
  const ru = R2.searches.find((s) => s.type === 'SEARCH_TYPE_RU')!;
  const allUrls = [...R2.searches.flatMap((s) => s.docs.map((d) => d.url)), ...R2.extractions.map((e) => e.url)];
  const pages: Record<string, { status: number; body?: string; contentType?: string }> = {};
  for (const e of R2.extractions) pages[e.url.replace(/\/$/, '/')] = { status: 200, body: html(e.title, e.text) };
  pages['https://www.youtube.com/channel/UCKgowcDVvJR3_q95JXBSAlQ'] = { status: 200, body: '', contentType: 'video/mp4' };
  pages['https://www.g2.com/products/touch-stay/pricing'] = { status: 403, body: 'Forbidden' };
  pages['https://www.g2.com/sellers/touch-stay'] = { status: 403, body: 'Forbidden' };
  pages['https://www.trustpilot.com/robots.txt'] = { status: 200, body: 'User-agent: *\nDisallow: /\n', contentType: 'text/plain' };
  const web = new RecordedWeb({ dns: dnsFor(allUrls), pages });
  const providers = new RecordedProviders({
    search: (q) => {
      const rec = R2.searches.find((s) => s.text === q.text && s.type === q.type && q.page === 0);
      if (rec) return { results: rec.docs };
      return { results: q.type === 'SEARCH_TYPE_RU' && q.page === 0 ? ru.docs : [] }; // SIMULATED mapping
    },
    llm: (task, data) => {
      if (task === 'extract_offer') {
        const url = (data.page as { url?: string } | undefined)?.url;
        const rec = R2.extractions.find((e) => e.url === url);
        return { content: JSON.stringify(rec ? rec.reply : { isProductPage: false, name: null, market: 'unknown', jobs: [], price: null, pageKind: 'unknown' }) };
      }
      if (task === 'analyse_candidate') return { content: R2.analyst.content };
      if (task === 'skeptic_challenge') return { content: simulatedSkeptic(data) };
      return undefined;
    },
  });
  return { providers, web };
}
