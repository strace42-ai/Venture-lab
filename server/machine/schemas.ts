/**
 * Runtime validation of every model output (analyst, discovery, skeptic). TypeScript interfaces are not
 * enough: a live LLM can return anything. Invalid output is never scored.
 */
import { z } from 'zod';
import { DIMENSION_KEYS } from '../../src/domain/scoring';

const dim = z.enum(DIMENSION_KEYS as unknown as [string, ...string[]]);
const raw = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const httpUrl = z.string().url().refine((u) => /^https?:\/\//.test(u), 'только http(s)');

/** Boilerplate that can appear on any page and proves nothing about a specific claim. */
const GENERIC_QUOTES = [
  'start now', 'learn more', 'sign up', 'get started', 'read more', 'contact us', 'try for free', 'book a demo',
  'подробнее', 'начать бесплатно', 'попробовать бесплатно', 'узнать больше', 'оставить заявку', 'связаться с нами', 'регистрация',
];
export const MIN_QUOTE_CHARS = 12;

/** A quote must be specific enough to bind a claim to a source: ≥12 chars, ≥2 words, not boilerplate. */
export function quoteProblem(quote: string): string | null {
  const q = quote.trim().toLowerCase().replace(/\s+/g, ' ');
  if (q.length === 0) return 'пустая цитата';
  if (q.length < MIN_QUOTE_CHARS) return `слишком короткая цитата (< ${MIN_QUOTE_CHARS} символов)`;
  if (q.split(' ').filter((w) => /[\p{L}\d]/u.test(w)).length < 2) return 'цитата из одного слова';
  if (GENERIC_QUOTES.some((g) => q === g || q === `${g}.` || q === `${g}!`)) return 'шаблонная фраза страницы, не подтверждает утверждение';
  return null;
}

export const discoverySeedSchema = z.strictObject({
  externalId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
  title: z.string().trim().min(3).max(200),
  pitch: z.string().trim().min(3).max(1000),
  segment: z.enum(['B2B', 'B2C']),
  category: z.string().trim().min(1).max(60),
  primaryJob: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  jobs: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/)).min(1),
  westernProduct: z.string().trim().min(1).max(200),
});

export const proposedClaimSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  dimension: dim,
  text: z.string().trim().min(3).max(1000),
  // Validated for presence/size here; specificity is judged per claim (quoteProblem) so one weak
  // claim does not discard the whole proposal.
  quote: z.string().max(500),
  sourceUrls: z.array(httpUrl).min(1).max(10),
  highImpact: z.boolean().optional(),
  absence: z.strictObject({ market: z.enum(['west', 'ru']), job: z.string().min(1) }).optional(),
});

export const analystProposalSchema = z
  .strictObject({
    model: z.string().min(1).max(120),
    claims: z.array(proposedClaimSchema).max(60),
    scores: z.partialRecord(dim, z.strictObject({ value: raw, claims: z.array(z.string()).max(20) })),
    founderFit: z
      .strictObject({ skills: z.number().int().min(0).max(10), access: z.number().int().min(0).max(10), timeToSale: z.number().int().min(0).max(10), motivation: z.number().int().min(0).max(5), synergy: z.number().int().min(0).max(5) })
      .nullable(),
    ruQueries: z.array(z.string().trim().min(1).max(300)).max(20),
    rationale: z.string().trim().min(3).max(4000),
  })
  .superRefine((p, ctx) => {
    const keys = new Set<string>();
    for (const c of p.claims) {
      if (keys.has(c.key)) ctx.addIssue({ code: 'custom', message: `повтор ключа утверждения ${c.key}` });
      keys.add(c.key);
    }
    for (const [d, s] of Object.entries(p.scores)) {
      for (const k of s!.claims) if (!keys.has(k)) ctx.addIssue({ code: 'custom', message: `${d}: ссылка на несуществующее утверждение ${k}` });
    }
  });

export const skepticFindingsSchema = z.strictObject({
  model: z.string().min(1).max(120),
  claimVerdicts: z.array(
    z.strictObject({
      claimKey: z.string().min(1),
      verdict: z.enum(['supported', 'refuted', 'needs_more_evidence']),
      sourceKeys: z.array(z.string()).max(20),
      reason: z.string().trim().min(3).max(1000),
    }),
  ),
  competitors: z.array(
    z.strictObject({
      name: z.string().trim().min(1).max(200),
      market: z.enum(['west', 'ru']),
      kind: z.enum(['direct', 'adjacent', 'substitute']),
      sourceKey: z.string().min(1),
      reason: z.string().trim().min(3).max(1000),
    }),
  ),
  disputes: z.array(z.strictObject({ claimKey: z.string().nullable(), severity: z.enum(['critical', 'minor']), reason: z.string().trim().min(3).max(1000) })),
  summary: z.string().trim().min(3).max(2000),
});
