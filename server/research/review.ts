/**
 * Manual evidence review (VL-003): `npm run research:review`.
 *
 * - dry-run by default; `apply` writes ONE append-only `evidence_reviews` row (origin 'manual',
 *   actor, reason, UTC timestamp) in a transaction, serialized with imports by an advisory lock;
 * - the original claim is never modified; review history is never edited;
 * - scoped to exactly one dataset: evidence of the other dataset is rejected explicitly;
 * - idempotent: requesting the current status is a no-op;
 * - `checked` requires attribution (url + publisher + observedAt) — a claim without a source cannot
 *   be verified. Opening a URL is not proof: the reason must say what was checked.
 * There is deliberately NO HTTP write endpoint for this (local CLI only).
 */
import { z } from 'zod';
import type { Pool, PoolClient } from '../db/pool';
import { isSyntheticDataset, type LiveDataset } from './repository';

export const reviewRequestSchema = z.strictObject({
  dataset: z.enum(['real', 'test']),
  ideaId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/, 'некорректный id идеи'),
  evidenceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'некорректный id источника'),
  status: z.enum(['checked', 'rejected', 'unreviewed']),
  reason: z.string().trim().min(10, 'причина: не короче 10 символов — опишите, что именно проверено').max(2000),
  actor: z.string().trim().min(1).max(120),
});

export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export interface ReviewPlan {
  status: 'ready' | 'unchanged' | 'invalid' | 'not-found';
  message: string;
  applied: boolean;
  evidence?: {
    ideaId: string;
    ideaTitle: string;
    evidenceId: string;
    claim: string;
    url: string | null;
    publisher: string | null;
    observedAt: string | null;
    currentStatus: string;
    history: { status: string; at: string; origin: string; actor: string | null; reason: string | null }[];
  };
}

async function plan(c: PoolClient, raw: unknown): Promise<ReviewPlan & { evidenceDbId?: number; req?: ReviewRequest }> {
  const parsed = reviewRequestSchema.safeParse(raw);
  if (!parsed.success) return { status: 'invalid', applied: false, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'запрос'}: ${i.message}`).join('; ') };
  const req = parsed.data;
  const found = await c.query<{ id: number; synthetic: boolean; title: string; claim: string; url: string | null; publisher: string | null; observed_at: string | null }>(
    `SELECT e.id, i.synthetic, i.title, e.claim, e.url, e.publisher, e.observed_at
       FROM evidence e JOIN ideas i ON i.id = e.idea_id
      WHERE i.external_id = $1 AND e.external_id = $2`,
    [req.ideaId, req.evidenceId],
  );
  const ev = found.rows[0];
  if (!ev) return { status: 'not-found', applied: false, message: `Источник "${req.evidenceId}" идеи "${req.ideaId}" не найден.` };
  if (ev.synthetic !== isSyntheticDataset(req.dataset as LiveDataset)) {
    return {
      status: 'invalid',
      applied: false,
      message: `Источник принадлежит набору «${ev.synthetic ? 'test' : 'real'}», а не «${req.dataset}». Ревью между наборами данных запрещено.`,
    };
  }
  const hist = await c.query<{ status: string; reviewed_at: Date; origin: string; actor: string | null; reason: string | null }>(
    `SELECT r.status, r.reviewed_at, r.origin, COALESCE(r.actor, rr.reviewed_by) AS actor, r.reason
       FROM evidence_reviews r LEFT JOIN research_runs rr ON rr.run_id = r.run_id
      WHERE r.evidence_id = $1 ORDER BY r.id`,
    [ev.id],
  );
  const history = hist.rows.map((h) => ({ status: h.status, at: h.reviewed_at.toISOString(), origin: h.origin, actor: h.actor, reason: h.reason }));
  const currentStatus = history.at(-1)?.status ?? 'unreviewed';
  const evidence = { ideaId: req.ideaId, ideaTitle: ev.title, evidenceId: req.evidenceId, claim: ev.claim, url: ev.url, publisher: ev.publisher, observedAt: ev.observed_at, currentStatus, history };
  if (req.status === 'checked' && !(ev.url && ev.publisher && ev.observed_at)) {
    return { status: 'invalid', applied: false, evidence, message: 'Нельзя отметить checked: у утверждения нет полной атрибуции (url, издатель, дата наблюдения). Добавьте источник новым импортом или отклоните (rejected).' };
  }
  if (currentStatus === req.status) return { status: 'unchanged', applied: false, evidence, message: `Статус уже «${req.status}» — ничего не изменено.` };
  return { status: 'ready', applied: false, evidence, evidenceDbId: ev.id, req, message: `Будет добавлено событие ревью: ${currentStatus} → ${req.status} (${req.actor}).` };
}

/** Drop internal fields (DB id, parsed request) from a plan before returning it. */
function publicPlan(p: ReviewPlan): ReviewPlan {
  return { status: p.status, message: p.message, applied: p.applied, ...(p.evidence ? { evidence: p.evidence } : {}) };
}

export async function reviewEvidence(pool: Pool, raw: unknown, opts: { apply: boolean }): Promise<ReviewPlan> {
  const client = await pool.connect();
  try {
    await client.query(opts.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    if (opts.apply) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['vl-research-import']);
    const p = await plan(client, raw);
    if (!opts.apply || p.status !== 'ready') {
      await client.query('ROLLBACK');
      return publicPlan(p);
    }
    await client.query("INSERT INTO evidence_reviews (evidence_id, status, origin, actor, reason) VALUES ($1, $2, 'manual', $3, $4)", [p.evidenceDbId, p.req!.status, p.req!.actor, p.req!.reason]);
    await client.query('COMMIT');
    return { ...publicPlan(p), applied: true, message: `Событие ревью записано: ${p.evidence!.currentStatus} → ${p.req!.status}.` };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
