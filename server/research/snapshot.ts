/**
 * Explicit, immutable TOP-10 snapshots.
 * A snapshot freezes the FULL ranking (TOP-10 = rank ≤ 10) as of a date, using the stage and the
 * assessment valid on that date (src/domain rankIdeas). It is created only by an explicit command,
 * is idempotent per snapshot id / date, and later imports never rewrite it (DB triggers).
 */
import { SCORING_MODEL_VERSION, rankIdeas } from '../../src/domain/scoring';
import type { Pool } from '../db/pool';
import { isSyntheticDataset, loadIdeas, todayUtc, type LiveDataset } from './repository';

export interface SnapshotPlan {
  status: 'ready' | 'exists' | 'conflict' | 'empty' | 'invalid';
  id: string;
  dataset: LiveDataset;
  asOf: string;
  message: string;
  entries: { rank: number; ideaId: string; slug: string; title: string; score: number; confidence: number }[];
  applied: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{2,79}$/;

/**
 * @param opts.dataset which isolated dataset to snapshot (default `real`). A REAL snapshot can only
 *   ever contain human-reviewed ideas; the DB enforces this with composite foreign keys.
 */
export async function createSnapshot(
  pool: Pool,
  opts: { asOf?: string; id?: string; apply: boolean; actor: string; today?: string; dataset?: LiveDataset },
): Promise<SnapshotPlan> {
  const dataset = opts.dataset ?? 'real';
  const syn = isSyntheticDataset(dataset);
  const today = opts.today ?? todayUtc();
  const asOf = opts.asOf ?? today;
  const id = opts.id ?? `${syn ? 'test-' : ''}top10-${asOf}`;
  const base: SnapshotPlan = { status: 'invalid', id, dataset, asOf, message: '', entries: [], applied: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) return { ...base, message: 'Дата среза должна быть в формате YYYY-MM-DD.' };
  if (asOf > today) return { ...base, message: 'Нельзя создать срез на будущую дату.' };
  if (!ID_RE.test(id)) return { ...base, message: 'Некорректный id среза (a-z, 0-9, . _ -, 3–80 симв.).' };

  const client = await pool.connect();
  try {
    await client.query(opts.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    if (opts.apply) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['vl-research-import']);

    const existing = await client.query<{ id: string; as_of: string; synthetic: boolean }>(
      'SELECT id, as_of, synthetic FROM top10_snapshots WHERE id = $1 OR (as_of = $2 AND synthetic = $3)',
      [id, asOf, syn],
    );
    const ex = existing.rows[0];
    if (ex) {
      await client.query('ROLLBACK');
      if (ex.id === id && ex.as_of === asOf && ex.synthetic === syn) return { ...base, status: 'exists', message: `Срез ${id} на ${asOf} уже существует — он неизменяем, ничего не сделано.` };
      return {
        ...base,
        status: 'conflict',
        message: `Конфликт: срез ${ex.id} (${ex.synthetic ? 'тестовые импорты' : 'реальные данные'}) уже зафиксирован на ${ex.as_of}. Один срез на набор данных и дату; существующие срезы не перезаписываются.`,
      };
    }

    const ideas = await loadIdeas(client, dataset);
    const ranked = rankIdeas(ideas, asOf);
    const entries = ranked.map((s, i) => ({ rank: i + 1, ideaId: s.idea.id, slug: s.idea.slug, title: s.idea.title, score: s.score, confidence: s.confidence }));
    if (entries.length === 0) {
      await client.query('ROLLBACK');
      return { ...base, status: 'empty', message: `На ${asOf} нет оценённых идей, пригодных для рейтинга — срез не создан.` };
    }
    if (!opts.apply) {
      await client.query('ROLLBACK');
      return { ...base, status: 'ready', entries, message: `Будет создан срез ${id} на ${asOf}; позиций в рейтинге: ${entries.length} (ТОП-10 = первые 10). Запустите с --apply.` };
    }
    const lastRun = await client.query<{ run_id: string }>(
      `SELECT i.run_id FROM import_runs i JOIN research_runs r ON r.run_id = i.run_id
        WHERE r.synthetic = $1 ORDER BY i.finished_at DESC, i.id DESC LIMIT 1`,
      [syn],
    );
    await client.query('INSERT INTO top10_snapshots (id, as_of, rubric_version, source_run_id, created_by, entry_count, synthetic) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      id,
      asOf,
      SCORING_MODEL_VERSION,
      lastRun.rows[0]?.run_id ?? null,
      opts.actor,
      entries.length,
      syn,
    ]);
    for (const e of entries) {
      // `synthetic` is part of the composite FK to ideas: a cross-dataset entry is impossible.
      await client.query(
        `INSERT INTO top10_entries (snapshot_id, rank, idea_id, score, confidence, synthetic, title, slug)
         SELECT $1, $2, id, $4, $5, $6, $7, $8 FROM ideas WHERE external_id = $3 AND synthetic = $6`,
        [id, e.rank, e.ideaId, e.score, e.confidence, syn, e.title, e.slug],
      );
    }
    await client.query('COMMIT');
    return { ...base, status: 'ready', entries, applied: true, message: `Срез ${id} на ${asOf} создан; позиций в рейтинге: ${entries.length}.` };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
