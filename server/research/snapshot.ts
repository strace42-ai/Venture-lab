/**
 * Explicit, immutable TOP-10 snapshots.
 * A snapshot freezes the FULL ranking (TOP-10 = rank ≤ 10) as of a date, using the stage and the
 * assessment valid on that date (src/domain rankIdeas). It is created only by an explicit command,
 * is idempotent per snapshot id / date, and later imports never rewrite it (DB triggers).
 */
import { SCORING_MODEL_VERSION, rankIdeas } from '../../src/domain/scoring';
import type { Pool } from '../db/pool';
import { loadIdeas, todayUtc } from './repository';

export interface SnapshotPlan {
  status: 'ready' | 'exists' | 'conflict' | 'empty' | 'invalid';
  id: string;
  asOf: string;
  message: string;
  entries: { rank: number; ideaId: string; title: string; score: number; confidence: number }[];
  applied: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{2,79}$/;

export async function createSnapshot(pool: Pool, opts: { asOf?: string; id?: string; apply: boolean; actor: string; today?: string }): Promise<SnapshotPlan> {
  const today = opts.today ?? todayUtc();
  const asOf = opts.asOf ?? today;
  const id = opts.id ?? `top10-${asOf}`;
  const base: SnapshotPlan = { status: 'invalid', id, asOf, message: '', entries: [], applied: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) return { ...base, message: 'Дата среза должна быть в формате YYYY-MM-DD.' };
  if (asOf > today) return { ...base, message: 'Нельзя создать срез на будущую дату.' };
  if (!ID_RE.test(id)) return { ...base, message: 'Некорректный id среза (a-z, 0-9, . _ -, 3–80 симв.).' };

  const client = await pool.connect();
  try {
    await client.query(opts.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    if (opts.apply) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['vl-research-import']);

    const existing = await client.query<{ id: string; as_of: string }>('SELECT id, as_of FROM top10_snapshots WHERE id = $1 OR as_of = $2', [id, asOf]);
    const ex = existing.rows[0];
    if (ex) {
      await client.query('ROLLBACK');
      if (ex.id === id && ex.as_of === asOf) return { ...base, status: 'exists', message: `Срез ${id} на ${asOf} уже существует — он неизменяем, ничего не сделано.` };
      return { ...base, status: 'conflict', message: `Конфликт: срез ${ex.id} уже зафиксирован на ${ex.as_of}. Один срез на дату; существующие срезы не перезаписываются.` };
    }

    const ideas = await loadIdeas(client);
    const ranked = rankIdeas(ideas, asOf);
    const entries = ranked.map((s, i) => ({ rank: i + 1, ideaId: s.idea.id, title: s.idea.title, score: s.score, confidence: s.confidence }));
    if (entries.length === 0) {
      await client.query('ROLLBACK');
      return { ...base, status: 'empty', message: `На ${asOf} нет оценённых идей, пригодных для рейтинга — срез не создан.` };
    }
    if (!opts.apply) {
      await client.query('ROLLBACK');
      return { ...base, status: 'ready', entries, message: `Будет создан срез ${id} на ${asOf}; позиций в рейтинге: ${entries.length} (ТОП-10 = первые 10). Запустите с --apply.` };
    }
    const lastRun = await client.query<{ run_id: string }>('SELECT run_id FROM import_runs ORDER BY finished_at DESC, id DESC LIMIT 1');
    await client.query('INSERT INTO top10_snapshots (id, as_of, rubric_version, source_run_id, created_by, entry_count) VALUES ($1, $2, $3, $4, $5, $6)', [
      id,
      asOf,
      SCORING_MODEL_VERSION,
      lastRun.rows[0]?.run_id ?? null,
      opts.actor,
      entries.length,
    ]);
    for (const e of entries) {
      await client.query(
        `INSERT INTO top10_entries (snapshot_id, rank, idea_id, score, confidence)
         SELECT $1, $2, id, $4, $5 FROM ideas WHERE external_id = $3`,
        [id, e.rank, e.ideaId, e.score, e.confidence],
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
