/**
 * `vl-research-1` — versioned import envelope for human-reviewed (or explicitly synthetic) research.
 * Documented in docs/research-import-format.md. Every object is strict: unknown keys are rejected,
 * which also rules out user-supplied score totals («aggregate as authority»).
 */
import { z } from 'zod';
import { DIMENSION_KEYS } from '../../src/domain/scoring';
import type { DimensionKey } from '../../src/domain/types';

export const SCHEMA_VERSION = 'vl-research-1';

// eslint-disable-next-line no-control-regex -- intentionally matching control characters to reject them
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Trimmed text without control characters. Rendered as plain text by React (no HTML). */
export const text = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min, `не короче ${min} симв.`)
    .max(max, `не длиннее ${max} симв.`)
    .refine((s) => !CONTROL_CHARS.test(s), 'содержит управляющие символы');

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const isoDate = z.iso.date('дата в формате YYYY-MM-DD').refine(isRealDate, 'несуществующая дата');

/** Date or full ISO datetime with offset (stored as UTC instant). */
export const isoDateOrTime = z.union([isoDate, z.iso.datetime({ offset: true, message: 'дата YYYY-MM-DD или ISO-время с часовым поясом' })]);

/**
 * http(s) URL only; credentials rejected; canonicalised (host lower-cased by WHATWG URL,
 * fragment dropped). No fuzzy normalisation beyond that.
 */
export const httpUrl = z
  .string()
  .trim()
  .max(2048, 'URL длиннее 2048 симв.')
  .transform((s, ctx) => {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'некорректный URL' });
      return z.NEVER;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      ctx.addIssue({ code: 'custom', message: 'разрешены только http(s) URL' });
      return z.NEVER;
    }
    if (u.username || u.password) {
      ctx.addIssue({ code: 'custom', message: 'URL не должен содержать логин/пароль' });
      return z.NEVER;
    }
    u.hash = '';
    return u.toString();
  });

export const slugId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/, 'только a-z, 0-9 и дефис, 2–80 симв.');
export const localId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'только a-z, 0-9, точка, дефис, подчёркивание, ≤ 64 симв.');

export const STAGES = ['discovered', 'researching', 'scored', 'validation_planned', 'validating', 'paid_signal', 'build_candidate', 'building', 'launched', 'monetizing', 'paused', 'rejected'] as const;
export const RISK_FLAGS = ['legal', 'lockedApi', 'demandUnverified', 'coldStart', 'networkEffect', 'lowRetention', 'dataPrivacy', 'highCogs', 'competitionUnverified'] as const;

const rawScore = z.union([z.int().min(0).max(5), z.null()]);
const pct = z.int().min(0).max(100);

const scoresShape = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, rawScore])) as Record<DimensionKey, typeof rawScore>;

export const sourceSchema = z.strictObject({
  id: localId,
  region: z.enum(['west', 'ru']),
  claim: text(1000),
  url: httpUrl.nullable().optional(),
  title: text(300).nullable().optional(),
  publisher: text(200).nullable().optional(),
  sourceType: z.enum(['independent', 'company_self_report', 'primary_data', 'unknown']).default('unknown'),
  language: z.string().regex(/^[a-z]{2}$/, 'код языка ISO 639-1').nullable().optional(),
  publishedAt: isoDate.nullable().optional(),
  observedAt: isoDate.nullable().optional(),
  retrievedAt: isoDate.nullable().optional(),
  dimensions: z.array(z.enum(DIMENSION_KEYS as [DimensionKey, ...DimensionKey[]])).max(12).default([]),
  supportNote: text(1000).nullable().optional(),
  verificationStatus: z.enum(['unreviewed', 'checked', 'rejected']).default('unreviewed'),
  /**
   * The HUMAN who checked/rejected this source (VL-003). In a human-reviewed import a `checked` or
   * `rejected` status without `reviewedBy` is stored as `unreviewed`; an AI draft may not carry
   * `checked`/`rejected` at all. Per-source review after import: `npm run research:review`.
   */
  reviewedBy: text(120).nullable().optional(),
});

export const westernProductSchema = z.strictObject({
  id: localId,
  name: text(200),
  url: httpUrl.nullable().optional(),
  kind: z.enum(['direct', 'adjacent', 'substitute']).default('direct'),
  coverage: z.enum(['high', 'partial', 'low', 'unknown']).default('unknown'),
  functions: text(1000).nullable().optional(),
  note: text(1000).nullable().optional(),
  observedAt: isoDate.nullable().optional(),
  evidenceIds: z.array(localId).max(50).default([]),
});

export const russianCompetitorSchema = z.strictObject({
  id: localId,
  name: text(200),
  url: httpUrl.nullable().optional(),
  kind: z.enum(['direct', 'adjacent', 'substitute']),
  coverage: z.enum(['high', 'partial', 'low', 'unknown']).default('unknown'),
  functions: text(1000).nullable().optional(),
  gap: text(1000).nullable().optional(),
  observedAt: isoDate.nullable().optional(),
  evidenceIds: z.array(localId).max(50).default([]),
});

export const assessmentSchema = z.strictObject({
  assessedAt: isoDateOrTime,
  assessor: text(120),
  rubricVersion: z.literal('v1.0', { message: 'поддерживается только рубрика v1.0' }),
  scores: z.strictObject(scoresShape),
  confidence: z.strictObject({ completeness: pct, corroboration: pct, recency: pct, reliability: pct, russiaValidation: pct }),
  founderFit: z
    .strictObject({
      skills: z.int().min(0).max(10),
      access: z.int().min(0).max(10),
      timeToSale: z.int().min(0).max(10),
      motivation: z.int().min(0).max(5),
      synergy: z.int().min(0).max(5),
    })
    .nullable()
    .optional(),
  rationale: text(4000, 20),
  evidenceIds: z.array(localId).min(1, 'оценка должна ссылаться хотя бы на один источник').max(100),
  unknowns: z.array(text(300)).max(30).default([]),
  revisionReason: text(1000).nullable().optional(),
});

export const ideaSchema = z.strictObject({
  externalId: slugId,
  slug: slugId.optional(),
  title: text(200, 3),
  pitch: text(1000),
  segment: z.enum(['B2B', 'B2C']),
  category: text(60),
  // Descriptive fields use PATCH semantics on re-import (docs/research-import-format.md):
  // absent key = keep the stored value, explicit null / [] = clear it. No defaults here on purpose.
  geography: text(80).optional(),
  targetPersona: text(1000).nullable().optional(),
  problem: text(2000).nullable().optional(),
  ruUnmetJob: text(2000).nullable().optional(),
  whyNow: text(2000).nullable().optional(),
  thesis: text(2000).nullable().optional(),
  monetization: text(2000).nullable().optional(),
  priceHypothesis: text(1000).nullable().optional(),
  distribution: text(2000).nullable().optional(),
  mvp: text(2000).nullable().optional(),
  nextAction: text(1000).nullable().optional(),
  excludedFeatures: z.array(text(300)).max(30).optional(),
  originMarkets: z.array(text(60)).max(20).optional(),
  riskFlags: z.array(z.enum(RISK_FLAGS)).max(RISK_FLAGS.length).optional(),
  stage: z.enum(STAGES).optional(),
  stageReason: text(1000).nullable().optional(),
  stageChangedAt: isoDate.optional(),
  sources: z.array(sourceSchema).max(200).default([]),
  westernProducts: z.array(westernProductSchema).max(50).default([]),
  russianCompetitors: z.array(russianCompetitorSchema).max(50).default([]),
  assessment: assessmentSchema.nullable().optional(),
});

export const envelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION, { message: `schemaVersion должен быть "${SCHEMA_VERSION}"` }),
    runId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,99}$/, 'runId: a-z, 0-9, точка, дефис, подчёркивание, 3–100 симв.'),
    researchedAt: isoDate,
    /**
     * - `ai-draft`: produced by an AI/research assistant, NOT approved — can be validated and
     *   dry-run, never applied;
     * - `human-reviewed`: founder-approved REAL research (requires `approval` to apply);
     * - `synthetic-test`: synthetic test data for the isolated TEST dataset.
     */
    source: z.enum(['human-reviewed', 'synthetic-test', 'ai-draft']),
    synthetic: z.boolean(),
    reviewedBy: text(120),
    /** Founder sign-off; required to APPLY a `human-reviewed` (REAL) import. */
    approval: z
      .strictObject({
        approvedBy: text(120),
        approvedAt: isoDate,
        statement: text(2000, 20),
      })
      .optional(),
    title: text(200).nullable().optional(),
    coverage: text(2000).nullable().optional(),
    limitations: text(2000).nullable().optional(),
    markets: z.array(text(60)).max(30).default([]),
    sourceReferences: z.array(httpUrl).max(100).default([]),
    ideas: z.array(ideaSchema).min(1, 'нужна хотя бы одна идея').max(500),
  })
  .superRefine((env, ctx) => {
    if (env.synthetic !== (env.source === 'synthetic-test')) {
      ctx.addIssue({ code: 'custom', path: ['synthetic'], message: 'synthetic=true обязателен для source="synthetic-test" и запрещён для "human-reviewed"/"ai-draft"' });
    }
    if (env.approval && env.approval.approvedAt > new Date().toISOString().slice(0, 10)) {
      ctx.addIssue({ code: 'custom', path: ['approval', 'approvedAt'], message: 'дата одобрения в будущем' });
    }
    if (env.source === 'ai-draft') {
      env.ideas.forEach((idea, i) =>
        idea.sources.forEach((s, j) => {
          if (s.verificationStatus !== 'unreviewed' || s.reviewedBy) {
            ctx.addIssue({ code: 'custom', path: ['ideas', i, 'sources', j, 'verificationStatus'], message: 'AI-черновик не может отмечать источники как checked/rejected — это делает человек (research:review)' });
          }
        }),
      );
    }
    const today = new Date().toISOString().slice(0, 10);
    if (env.researchedAt > today) ctx.addIssue({ code: 'custom', path: ['researchedAt'], message: 'дата исследования в будущем' });

    const ext = new Set<string>();
    const slugs = new Set<string>();
    env.ideas.forEach((idea, i) => {
      const p = ['ideas', i];
      if (ext.has(idea.externalId)) ctx.addIssue({ code: 'custom', path: [...p, 'externalId'], message: `повтор externalId "${idea.externalId}" в файле` });
      ext.add(idea.externalId);
      const slug = idea.slug ?? idea.externalId;
      if (slugs.has(slug)) ctx.addIssue({ code: 'custom', path: [...p, 'slug'], message: `повтор slug "${slug}" в файле` });
      slugs.add(slug);

      const sourceIds = new Set<string>();
      idea.sources.forEach((s, j) => {
        if (sourceIds.has(s.id)) ctx.addIssue({ code: 'custom', path: [...p, 'sources', j, 'id'], message: `повтор id источника "${s.id}"` });
        sourceIds.add(s.id);
        for (const [k, v] of [['publishedAt', s.publishedAt], ['observedAt', s.observedAt], ['retrievedAt', s.retrievedAt]] as const) {
          if (v && v > today) ctx.addIssue({ code: 'custom', path: [...p, 'sources', j, k], message: 'дата в будущем' });
        }
      });
      const compIds = new Set<string>();
      const lists = [
        ['westernProducts', idea.westernProducts],
        ['russianCompetitors', idea.russianCompetitors],
      ] as const;
      for (const [key, list] of lists) {
        list.forEach((c, j) => {
          if (compIds.has(c.id)) ctx.addIssue({ code: 'custom', path: [...p, key, j, 'id'], message: `повтор id конкурента/аналога "${c.id}"` });
          compIds.add(c.id);
          // Evidence references are resolved by the importer against this file's sources AND the
          // evidence already stored for the idea (cumulative updates), see planImport.
        });
      }
      const a = idea.assessment;
      if (a) {
        if (a.assessedAt.slice(0, 10) > today) ctx.addIssue({ code: 'custom', path: [...p, 'assessment', 'assessedAt'], message: 'дата оценки в будущем' });
      }
      if (idea.stage === 'rejected' && !idea.stageReason) {
        ctx.addIssue({ code: 'custom', path: [...p, 'stageReason'], message: 'для стадии rejected нужна причина (stageReason)' });
      }
      if (idea.stageChangedAt && idea.stageChangedAt > today) {
        ctx.addIssue({ code: 'custom', path: [...p, 'stageChangedAt'], message: 'дата в будущем' });
      }
    });
  });

export type ResearchEnvelope = z.infer<typeof envelopeSchema>;
export type ResearchIdea = ResearchEnvelope['ideas'][number];
export type ResearchSource = ResearchIdea['sources'][number];
export type ResearchAssessment = NonNullable<ResearchIdea['assessment']>;
