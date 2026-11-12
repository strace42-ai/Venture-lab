/**
 * Read side: load persisted research into the shared domain model (src/domain/types.ts) so the
 * SAME scoring/ranking/selectors run for REAL data as for the DEMO fixture.
 */
import { SCORING_MODEL_VERSION } from '../../src/domain/scoring';
import type {
  Assessment,
  BaselineEntry,
  Competitor,
  ComponentScores,
  ConfidenceComponents,
  Dataset,
  Evidence,
  EvidenceReview,
  FounderFitComponents,
  Idea,
  RankBaseline,
  ResearchRun,
  RiskFlag,
  Stage,
  StageChange,
} from '../../src/domain/types';
import type { LiveDataset } from '../../src/domain/types';
import type { Queryable } from '../db/pool';

/**
 * Every read is scoped to exactly ONE dataset: `real` (human-reviewed research) or `test`
 * (synthetic imports). There is deliberately no «all» option, so synthetic rows can never reach
 * REAL rankings, KPIs, research runs or snapshots. The DB enforces the same split (migration 002).
 */
export type { LiveDataset };
export const isSyntheticDataset = (d: LiveDataset): boolean => d === 'test';

const isoDay = (d: Date | string): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

interface IdeaRow {
  id: number;
  external_id: string;
  slug: string;
  title: string;
  pitch: string;
  segment: 'B2B' | 'B2C';
  category: string;
  geography: string;
  target_persona: string | null;
  problem: string | null;
  ru_unmet_job: string | null;
  why_now: string | null;
  thesis: string | null;
  monetization: string | null;
  price_hypothesis: string | null;
  next_action: string | null;
  risk_flags: string[];
  synthetic: boolean;
  first_researched_at: string;
  last_researched_at: string;
}

export async function loadIdeas(db: Queryable, dataset: LiveDataset): Promise<Idea[]> {
  const syn = isSyntheticDataset(dataset);
  const inDataset = 'idea_id IN (SELECT id FROM ideas WHERE synthetic = $1)';
  // Dates shown in the UI come from the research runs (when the idea was researched), not from
  // database insertion timestamps.
  const ideas = await db.query<IdeaRow>(
    `SELECT i.*, f.researched_at AS first_researched_at, l.researched_at AS last_researched_at
       FROM ideas i
       JOIN research_runs f ON f.run_id = i.first_run_id
       JOIN research_runs l ON l.run_id = i.last_run_id
      WHERE i.synthetic = $1
      ORDER BY i.id`,
    [syn],
  );
  if (ideas.rows.length === 0) return [];

  // Sequential on purpose: `db` may be a single transaction client (snapshot creation).
  const stages = await db.query<{ idea_id: number; stage: Stage; effective_at: Date; reason: string | null }>(`SELECT idea_id, stage, effective_at, reason FROM stage_transitions WHERE ${inDataset} ORDER BY effective_at, id`, [syn]);
  const assessments = await db.query<{
      idea_id: number;
      rubric_version: string;
      assessed_at: Date;
      assessor: string;
      scores: ComponentScores;
      confidence: ConfidenceComponents;
      founder_fit: FounderFitComponents | null;
      rationale: string;
      evidence_refs: string[];
      unknowns: string[];
    }>(`SELECT * FROM assessments WHERE ${inDataset} ORDER BY assessed_at, id`, [syn]);
  const evidence = await db.query<{
      idea_id: number;
      external_id: string;
      region: 'west' | 'ru';
      claim: string;
      url: string | null;
      title: string | null;
      publisher: string | null;
      source_type: Evidence['sourceType'];
      language: string | null;
      published_at: string | null;
      observed_at: string | null;
      retrieved_at: string | null;
      dimensions: Evidence['dimensions'];
      support_note: string | null;
      id: number;
      run_id: string;
    }>(`SELECT e.* FROM evidence e WHERE e.${inDataset} ORDER BY e.id`, [syn]);
  // Full append-only review history (import + manual). Legacy import rows have no actor: it is the
  // run's reviewer (research_runs.reviewed_by).
  const reviews = await db.query<{ evidence_id: number; status: Evidence['verificationStatus']; reviewed_at: Date; origin: 'import' | 'manual'; actor: string | null; reason: string | null; run_id: string | null }>(
    `SELECT r.evidence_id, r.status, r.reviewed_at, r.origin, COALESCE(r.actor, rr.reviewed_by) AS actor, r.reason, r.run_id
       FROM evidence_reviews r
       JOIN evidence e ON e.id = r.evidence_id
       LEFT JOIN research_runs rr ON rr.run_id = r.run_id
      WHERE e.${inDataset}
      ORDER BY r.id`,
    [syn],
  );
  const reviewsBy = new Map<number, EvidenceReview[]>();
  for (const r of reviews.rows) {
    const arr = reviewsBy.get(r.evidence_id) ?? [];
    arr.push({ status: r.status, at: r.reviewed_at.toISOString(), origin: r.origin, actor: r.actor, reason: r.reason, runId: r.run_id });
    reviewsBy.set(r.evidence_id, arr);
  }
  const competitors = await db.query<{
      idea_id: number;
      external_id: string;
      name: string;
      market: 'west' | 'ru';
      url: string | null;
      kind: Competitor['kind'];
      coverage: Competitor['coverage'];
      gap: string | null;
      observed_at: string | null;
      evidence_refs: string[];
    }>(`SELECT * FROM competitors WHERE ${inDataset} ORDER BY id`, [syn]);

  const group = <T extends { idea_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) {
      const arr = m.get(r.idea_id) ?? [];
      arr.push(r);
      m.set(r.idea_id, arr);
    }
    return m;
  };
  const stBy = group(stages.rows);
  const asBy = group(assessments.rows);
  const evBy = group(evidence.rows);
  const coBy = group(competitors.rows);

  return ideas.rows.map((r): Idea => {
    const stageHistory: StageChange[] = (stBy.get(r.id) ?? []).map((s) => ({ at: isoDay(s.effective_at), stage: s.stage, reason: s.reason }));
    const assessmentList: Assessment[] = (asBy.get(r.id) ?? []).map((a) => ({
      assessedAt: isoDay(a.assessed_at),
      modelVersion: a.rubric_version,
      assessor: a.assessor,
      scores: a.scores,
      confidence: a.confidence,
      founderFit: a.founder_fit,
      reason: a.rationale,
      evidenceIds: a.evidence_refs,
      unknowns: a.unknowns,
    }));
    const last = (xs: string[]) => xs.reduce((m, x) => (x > m ? x : m), r.last_researched_at);
    return {
      id: r.external_id,
      slug: r.slug,
      title: r.title,
      shortPitch: r.pitch,
      segment: r.segment,
      category: r.category,
      geography: r.geography,
      stage: stageHistory[stageHistory.length - 1]?.stage ?? 'discovered',
      createdAt: r.first_researched_at,
      updatedAt: last([...stageHistory.map((s) => s.at), ...assessmentList.map((a) => a.assessedAt)]),
      primaryProblem: r.problem ?? r.ru_unmet_job,
      targetPersona: r.target_persona,
      offer: [r.monetization, r.price_hypothesis].filter(Boolean).join(' · ') || null,
      nextAction: r.next_action,
      thesis: r.thesis,
      whyNow: r.why_now,
      evidence: (evBy.get(r.id) ?? []).map(
        (e): Evidence => ({
          id: e.external_id,
          market: e.region,
          claim: e.claim,
          dimensions: e.dimensions,
          url: e.url,
          title: e.title,
          publisher: e.publisher,
          sourceType: e.source_type,
          language: e.language,
          publishedAt: e.published_at,
          observedAt: e.observed_at,
          retrievedAt: e.retrieved_at,
          verificationStatus: (reviewsBy.get(e.id) ?? []).at(-1)?.status ?? 'unreviewed',
          supportNote: e.support_note,
          reviews: reviewsBy.get(e.id) ?? [],
          runId: e.run_id,
        }),
      ),
      competitors: (coBy.get(r.id) ?? []).map(
        (c): Competitor => ({ id: c.external_id, name: c.name, market: c.market, url: c.url, kind: c.kind, coverage: c.coverage, gap: c.gap, observedAt: c.observed_at, evidenceIds: c.evidence_refs }),
      ),
      riskFlags: r.risk_flags as RiskFlag[],
      founderFit: null,
      validationPlan: null,
      assessments: assessmentList,
      stageHistory,
      synthetic: r.synthetic,
    };
  });
}

export async function loadResearchRuns(db: Queryable, dataset: LiveDataset): Promise<ResearchRun[]> {
  const r = await db.query<{
    run_id: string;
    researched_at: string;
    synthetic: boolean;
    title: string | null;
    coverage: string | null;
    limitations: string | null;
    markets: string[];
    discovered_count: number;
    rejected_count: number;
    sources_count: number;
  }>('SELECT * FROM research_runs WHERE synthetic = $1 ORDER BY researched_at DESC, created_at DESC', [isSyntheticDataset(dataset)]);
  return r.rows.map((x) => ({
    id: x.run_id,
    date: x.researched_at,
    marketsExamined: x.markets,
    newCandidates: x.discovered_count,
    rejectedCandidates: x.rejected_count,
    sourcesReviewed: x.sources_count,
    conclusion: [x.title, x.limitations && `Ограничения: ${x.limitations}`].filter(Boolean).join(' — '),
    synthetic: x.synthetic,
  }));
}

export interface StoredSnapshotEntry extends BaselineEntry {
  confidence: number;
  /** Title/slug frozen at snapshot time (migration 002); later renames do not rewrite history. */
  slug: string;
  title: string;
}

export interface StoredSnapshot {
  id: string;
  dataset: LiveDataset;
  asOf: string;
  rubricVersion: string;
  sourceRunId: string | null;
  createdBy: string;
  createdAt: string;
  entryCount: number;
  entries: StoredSnapshotEntry[];
}

type SnapshotRow = { id: string; as_of: string; rubric_version: string; source_run_id: string | null; created_by: string; created_at: Date; synthetic: boolean; entry_count: number };

const snapMeta = (x: SnapshotRow): Omit<StoredSnapshot, 'entries'> => ({
  id: x.id,
  dataset: x.synthetic ? 'test' : 'real',
  asOf: x.as_of,
  rubricVersion: x.rubric_version,
  sourceRunId: x.source_run_id,
  createdBy: x.created_by,
  createdAt: x.created_at.toISOString(),
  entryCount: x.entry_count,
});

export async function listSnapshots(db: Queryable, dataset: LiveDataset): Promise<Omit<StoredSnapshot, 'entries'>[]> {
  const r = await db.query<SnapshotRow>('SELECT * FROM top10_snapshots WHERE synthetic = $1 ORDER BY as_of DESC', [isSyntheticDataset(dataset)]);
  return r.rows.map(snapMeta);
}

/**
 * Load one stored snapshot of `dataset` with all ranked entries:
 * - `id`: that snapshot (must belong to the dataset);
 * - `before`: the latest snapshot strictly BEFORE that date (the movement baseline);
 * - `onOrBefore`: the latest snapshot on or before that date.
 */
export async function loadSnapshot(db: Queryable, dataset: LiveDataset, sel: { id: string } | { before: string } | { onOrBefore: string }): Promise<StoredSnapshot | null> {
  const syn = isSyntheticDataset(dataset);
  const r =
    'id' in sel
      ? await db.query<SnapshotRow>('SELECT * FROM top10_snapshots WHERE id = $1 AND synthetic = $2', [sel.id, syn])
      : 'before' in sel
        ? await db.query<SnapshotRow>('SELECT * FROM top10_snapshots WHERE synthetic = $2 AND as_of < $1 ORDER BY as_of DESC LIMIT 1', [sel.before, syn])
        : await db.query<SnapshotRow>('SELECT * FROM top10_snapshots WHERE synthetic = $2 AND as_of <= $1 ORDER BY as_of DESC LIMIT 1', [sel.onOrBefore, syn]);
  const s = r.rows[0];
  if (!s) return null;
  const e = await db.query<{ rank: number; external_id: string; slug: string; title: string; score: number; confidence: number }>(
    `SELECT t.rank, i.external_id, t.slug, t.title, t.score, t.confidence
       FROM top10_entries t JOIN ideas i ON i.id = t.idea_id
      WHERE t.snapshot_id = $1 AND t.synthetic = $2 ORDER BY t.rank`,
    [s.id, syn],
  );
  return { ...snapMeta(s), entries: e.rows.map((x) => ({ ideaId: x.external_id, rank: x.rank, score: x.score, confidence: x.confidence, slug: x.slug, title: x.title })) };
}

/**
 * Build a live dataset: the current ranking at `today` with movement against the latest stored
 * snapshot STRICTLY BEFORE `today`.
 *
 * Why strictly before: a snapshot taken today is the frozen record OF today; comparing today's
 * live ranking with it would hide every change since yesterday (all «same»). So:
 * - before today's snapshot exists → baseline = latest earlier snapshot;
 * - after `research:snapshot --as-of today` → baseline is still the latest earlier snapshot;
 * - imports later the same day → still compared with the earlier snapshot.
 */
export async function loadDataset(db: Queryable, dataset: LiveDataset, today = todayUtc()): Promise<Dataset> {
  const ideas = await loadIdeas(db, dataset);
  const runs = await loadResearchRuns(db, dataset);
  const snap = await loadSnapshot(db, dataset, { before: today });
  const baseline: RankBaseline | null = snap ? { kind: 'stored', snapshotId: snap.id, asOf: snap.asOf, entries: snap.entries.map(({ ideaId, rank, score }) => ({ ideaId, rank, score })) } : null;
  return {
    mode: dataset,
    asOf: today,
    rankAsOf: today,
    modelVersion: SCORING_MODEL_VERSION,
    baseline,
    ideas,
    researchRuns: runs,
    // VL-002 imports no experiments, builds, payments or agent activity — never fabricated.
    experiments: [],
    builds: [],
    activity: [],
  };
}
