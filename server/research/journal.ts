/**
 * Research Journal (VL-003) — derived ONLY from stored provenance.
 *
 * Every history table already records the research run that wrote it (ideas.first_run_id,
 * idea_revisions.run_id, assessments.run_id, stage_transitions.run_id, evidence.run_id,
 * competitors.run_id, evidence_reviews.run_id). So «what changed in run X» is read, not inferred:
 *   created   = ideas first recorded by X
 *   updated   = idea revisions written by X for ideas created earlier (fields = diff to the previous revision)
 *   assessed  = assessment revisions appended by X (score recomputed by src/domain)
 *   stage     = stage transitions appended by X (from = the previous transition)
 *   evidence / competitors = rows first recorded by X
 *   status    = import review events of X on evidence recorded by an EARLIER run
 * Manual reviews (`research:review`) are listed separately with actor + reason.
 */
import { effectiveEvidenceStatus } from '../../src/domain/selectors';
import { marketScore } from '../../src/domain/scoring';
import { emptyStatusCounts, type FrozenSnapshot, type JournalIdeaChange, type JournalManualReview, type JournalRun, type JournalView } from '../../src/domain/research-ops';
import type { ComponentScores, Stage } from '../../src/domain/types';
import type { Queryable } from '../db/pool';
import { isSyntheticDataset, loadIdeas, todayUtc, type LiveDataset } from './repository';

export async function loadJournal(db: Queryable, dataset: LiveDataset, today = todayUtc()): Promise<JournalView> {
  const syn = isSyntheticDataset(dataset);
  const inDataset = 'idea_id IN (SELECT id FROM ideas WHERE synthetic = $1)';

  const runs = await db.query<{
    run_id: string;
    researched_at: string;
    origin: string;
    synthetic: boolean;
    reviewed_by: string;
    title: string | null;
    coverage: string | null;
    limitations: string | null;
    markets: string[];
    source_refs: string[];
    checksum: string;
    file_name: string;
    actor: string;
    finished_at: Date;
    approved_by: string | null;
    approved_at: string | null;
    approval_statement: string | null;
  }>(
    `SELECT rr.*, ir.checksum, ir.file_name, ir.actor, ir.finished_at, ir.approved_by, ir.approved_at, ir.approval_statement
       FROM research_runs rr JOIN import_runs ir ON ir.run_id = rr.run_id
      WHERE rr.synthetic = $1
      ORDER BY rr.researched_at DESC, ir.finished_at DESC`,
    [syn],
  );

  const ideaRows = await db.query<{ id: number; external_id: string; slug: string; title: string; first_run_id: string }>(
    'SELECT id, external_id, slug, title, first_run_id FROM ideas WHERE synthetic = $1',
    [syn],
  );
  const ideaById = new Map(ideaRows.rows.map((r) => [r.id, r]));
  const dbIdByExternal = new Map(ideaRows.rows.map((r) => [r.external_id, r.id]));
  const revisions = await db.query<{ idea_id: number; run_id: string; content: Record<string, unknown> }>(`SELECT idea_id, run_id, content FROM idea_revisions WHERE ${inDataset} ORDER BY id`, [syn]);
  const assessments = await db.query<{ idea_id: number; run_id: string; scores: ComponentScores }>(`SELECT idea_id, run_id, scores FROM assessments WHERE ${inDataset} ORDER BY id`, [syn]);
  const stages = await db.query<{ idea_id: number; run_id: string; stage: Stage; reason: string | null }>(
    `SELECT idea_id, run_id, stage, reason FROM stage_transitions WHERE ${inDataset} ORDER BY effective_at, id`,
    [syn],
  );
  const competitors = await db.query<{ idea_id: number; run_id: string }>(`SELECT idea_id, run_id FROM competitors WHERE ${inDataset}`, [syn]);
  const importReviews = await db.query<{ idea_id: number; run_id: string; evidence_run: string }>(
    `SELECT e.idea_id, r.run_id, e.run_id AS evidence_run
       FROM evidence_reviews r JOIN evidence e ON e.id = r.evidence_id
      WHERE r.origin = 'import' AND e.${inDataset}`,
    [syn],
  );
  const ideas = await loadIdeas(db, dataset); // evidence with full review history + current status

  type Acc = Map<string, Map<number, JournalIdeaChange>>;
  const acc: Acc = new Map();
  const changeFor = (runId: string, ideaId: number): JournalIdeaChange | null => {
    const idea = ideaById.get(ideaId);
    if (!idea) return null;
    let perRun = acc.get(runId);
    if (!perRun) acc.set(runId, (perRun = new Map()));
    let c = perRun.get(ideaId);
    if (!c) {
      c = {
        ideaId: idea.external_id,
        slug: idea.slug,
        title: idea.title,
        created: false,
        updatedFields: [],
        assessmentAdded: false,
        assessmentScore: null,
        stage: null,
        evidenceAdded: 0,
        competitorsAdded: 0,
        statusChanges: 0,
      };
      perRun.set(ideaId, c);
    }
    return c;
  };

  for (const i of ideaRows.rows) changeFor(i.first_run_id, i.id)!.created = true;

  const prevRevision = new Map<number, Record<string, unknown>>();
  for (const r of revisions.rows) {
    const prev = prevRevision.get(r.idea_id);
    if (prev) {
      const fields = Object.keys(r.content).filter((k) => JSON.stringify(r.content[k]) !== JSON.stringify(prev[k]));
      const c = changeFor(r.run_id, r.idea_id);
      if (c && fields.length) c.updatedFields = [...new Set([...c.updatedFields, ...fields])];
    }
    prevRevision.set(r.idea_id, r.content);
  }
  for (const a of assessments.rows) {
    const c = changeFor(a.run_id, a.idea_id);
    if (c) {
      c.assessmentAdded = true;
      c.assessmentScore = marketScore(a.scores);
    }
  }
  const lastStage = new Map<number, Stage>();
  for (const st of stages.rows) {
    const c = changeFor(st.run_id, st.idea_id);
    if (c) c.stage = { from: lastStage.get(st.idea_id) ?? null, to: st.stage, reason: st.reason };
    lastStage.set(st.idea_id, st.stage);
  }
  for (const co of competitors.rows) {
    const c = changeFor(co.run_id, co.idea_id);
    if (c) c.competitorsAdded++;
  }
  for (const r of importReviews.rows) {
    if (r.run_id === r.evidence_run) continue; // initial status recorded together with the evidence
    const c = changeFor(r.run_id, r.idea_id);
    if (c) c.statusChanges++;
  }

  const evidenceStatusByRun = new Map<string, ReturnType<typeof emptyStatusCounts>>();
  const manualReviews: JournalManualReview[] = [];
  for (const idea of ideas) {
    const dbId = dbIdByExternal.get(idea.id)!;
    for (const ev of idea.evidence) {
      if (ev.runId) {
        const c = changeFor(ev.runId, dbId);
        if (c) c.evidenceAdded++;
        const counts = evidenceStatusByRun.get(ev.runId) ?? emptyStatusCounts();
        counts[effectiveEvidenceStatus(ev)]++;
        evidenceStatusByRun.set(ev.runId, counts);
      }
      const reviews = ev.reviews ?? [];
      reviews.forEach((rv, k) => {
        if (rv.origin !== 'manual') return;
        manualReviews.push({
          at: rv.at,
          actor: rv.actor ?? '—',
          reason: rv.reason ?? '',
          status: rv.status,
          previousStatus: k > 0 ? reviews[k - 1]!.status : null,
          evidenceId: ev.id,
          claim: ev.claim,
          url: ev.url,
          idea: { id: idea.id, slug: idea.slug, title: idea.title },
        });
      });
    }
  }
  manualReviews.sort((a, b) => b.at.localeCompare(a.at));

  const journalRuns: JournalRun[] = runs.rows.map((r) => {
    const changes = [...(acc.get(r.run_id)?.values() ?? [])].sort((a, b) => Number(b.created) - Number(a.created) || a.title.localeCompare(b.title, 'ru'));
    return {
      id: r.run_id,
      date: r.researched_at,
      title: r.title,
      synthetic: r.synthetic,
      origin: r.origin,
      reviewedBy: r.reviewed_by,
      coverage: r.coverage,
      limitations: r.limitations,
      markets: r.markets,
      sourceRefs: r.source_refs,
      importedAt: r.finished_at.toISOString(),
      importedBy: r.actor,
      fileName: r.file_name,
      checksum: r.checksum,
      approval: r.approved_by && r.approved_at && r.approval_statement ? { by: r.approved_by, at: r.approved_at, statement: r.approval_statement } : null,
      counts: {
        ideasCreated: changes.filter((c) => c.created).length,
        ideasUpdated: changes.filter((c) => !c.created && c.updatedFields.length > 0).length,
        assessmentsAdded: changes.filter((c) => c.assessmentAdded).length,
        stageChanges: changes.filter((c) => c.stage && c.stage.from !== null).length,
        rejected: changes.filter((c) => c.stage?.to === 'rejected').length,
        evidenceAdded: changes.reduce((n, c) => n + c.evidenceAdded, 0),
        competitorsAdded: changes.reduce((n, c) => n + c.competitorsAdded, 0),
        statusChanges: changes.reduce((n, c) => n + c.statusChanges, 0),
      },
      evidenceStatus: evidenceStatusByRun.get(r.run_id) ?? emptyStatusCounts(),
      ideas: changes,
    };
  });

  const notes: string[] = [];
  if (journalRuns.some((r) => !r.approval && r.origin === 'human-reviewed')) {
    notes.push('Некоторые реальные прогоны импортированы до VL-003, когда запись одобрения основателя ещё не велась.');
  }
  return { mode: dataset, asOf: today, runs: journalRuns, manualReviews, notes };
}

/** A stored snapshot with its FROZEN entries (rank/score/confidence/title/slug at snapshot time). */
export async function loadFrozenSnapshot(db: Queryable, dataset: LiveDataset, id: string): Promise<FrozenSnapshot | null> {
  const syn = isSyntheticDataset(dataset);
  const s = await db.query<{ id: string; as_of: string; entry_count: number }>('SELECT id, as_of, entry_count FROM top10_snapshots WHERE id = $1 AND synthetic = $2', [id, syn]);
  const row = s.rows[0];
  if (!row) return null;
  const e = await db.query<{ external_id: string; rank: number; score: number; confidence: number; title: string; slug: string }>(
    `SELECT i.external_id, t.rank, t.score, t.confidence, t.title, t.slug
       FROM top10_entries t JOIN ideas i ON i.id = t.idea_id
      WHERE t.snapshot_id = $1 AND t.synthetic = $2 ORDER BY t.rank`,
    [id, syn],
  );
  return {
    id: row.id,
    asOf: row.as_of,
    entryCount: row.entry_count,
    kind: 'stored',
    entries: e.rows.map((x) => ({ ideaId: x.external_id, rank: x.rank, score: x.score, confidence: x.confidence, title: x.title, slug: x.slug })),
  };
}
