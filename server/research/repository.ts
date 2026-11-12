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
  FounderFitComponents,
  Idea,
  RankBaseline,
  ResearchRun,
  RiskFlag,
  Stage,
  StageChange,
} from '../../src/domain/types';
import type { Queryable } from '../db/pool';

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

export async function loadIdeas(db: Queryable): Promise<Idea[]> {
  // Dates shown in the UI come from the research runs (when the idea was researched), not from
  // database insertion timestamps.
  const ideas = await db.query<IdeaRow>(
    `SELECT i.*, f.researched_at AS first_researched_at, l.researched_at AS last_researched_at
       FROM ideas i
       JOIN research_runs f ON f.run_id = i.first_run_id
       JOIN research_runs l ON l.run_id = i.last_run_id
      ORDER BY i.id`,
  );
  if (ideas.rows.length === 0) return [];

  // Sequential on purpose: `db` may be a single transaction client (snapshot creation).
  const stages = await db.query<{ idea_id: number; stage: Stage; effective_at: Date; reason: string | null }>('SELECT idea_id, stage, effective_at, reason FROM stage_transitions ORDER BY effective_at, id');
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
    }>('SELECT * FROM assessments ORDER BY assessed_at, id');
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
      status: Evidence['verificationStatus'];
    }>(
      `SELECT e.*, (SELECT r.status FROM evidence_reviews r WHERE r.evidence_id = e.id ORDER BY r.id DESC LIMIT 1) AS status
         FROM evidence e ORDER BY e.id`,
    );
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
    }>('SELECT * FROM competitors ORDER BY id');

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
          verificationStatus: e.status,
          supportNote: e.support_note,
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

export async function loadResearchRuns(db: Queryable): Promise<ResearchRun[]> {
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
  }>('SELECT * FROM research_runs ORDER BY researched_at DESC, created_at DESC');
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

export interface StoredSnapshot {
  id: string;
  asOf: string;
  rubricVersion: string;
  sourceRunId: string | null;
  createdBy: string;
  createdAt: string;
  entries: (BaselineEntry & { confidence: number; slug: string; title: string })[];
}

export async function listSnapshots(db: Queryable): Promise<Omit<StoredSnapshot, 'entries'>[]> {
  const r = await db.query<{ id: string; as_of: string; rubric_version: string; source_run_id: string | null; created_by: string; created_at: Date }>(
    'SELECT * FROM top10_snapshots ORDER BY as_of DESC',
  );
  return r.rows.map((x) => ({ id: x.id, asOf: x.as_of, rubricVersion: x.rubric_version, sourceRunId: x.source_run_id, createdBy: x.created_by, createdAt: x.created_at.toISOString() }));
}

/** Latest stored snapshot with as_of ≤ `onOrBefore` (the movement baseline), with all ranked entries. */
export async function loadSnapshot(db: Queryable, opts: { id?: string; onOrBefore?: string }): Promise<StoredSnapshot | null> {
  const r = opts.id
    ? await db.query<{ id: string; as_of: string; rubric_version: string; source_run_id: string | null; created_by: string; created_at: Date }>('SELECT * FROM top10_snapshots WHERE id = $1', [opts.id])
    : await db.query<{ id: string; as_of: string; rubric_version: string; source_run_id: string | null; created_by: string; created_at: Date }>(
        'SELECT * FROM top10_snapshots WHERE as_of <= $1 ORDER BY as_of DESC LIMIT 1',
        [opts.onOrBefore ?? todayUtc()],
      );
  const s = r.rows[0];
  if (!s) return null;
  const e = await db.query<{ rank: number; external_id: string; slug: string; title: string; score: number; confidence: number }>(
    `SELECT t.rank, i.external_id, i.slug, i.title, t.score, t.confidence
       FROM top10_entries t JOIN ideas i ON i.id = t.idea_id
      WHERE t.snapshot_id = $1 ORDER BY t.rank`,
    [s.id],
  );
  return {
    id: s.id,
    asOf: s.as_of,
    rubricVersion: s.rubric_version,
    sourceRunId: s.source_run_id,
    createdBy: s.created_by,
    createdAt: s.created_at.toISOString(),
    entries: e.rows.map((x) => ({ ideaId: x.external_id, rank: x.rank, score: x.score, confidence: x.confidence, slug: x.slug, title: x.title })),
  };
}

/** Build the REAL dataset: current ranking at `today`, movement vs the latest stored snapshot. */
export async function loadDataset(db: Queryable, today = todayUtc()): Promise<Dataset> {
  const [ideas, runs, snap] = await Promise.all([loadIdeas(db), loadResearchRuns(db), loadSnapshot(db, { onOrBefore: today })]);
  const baseline: RankBaseline | null = snap ? { kind: 'stored', snapshotId: snap.id, asOf: snap.asOf, entries: snap.entries.map(({ ideaId, rank, score }) => ({ ideaId, rank, score })) } : null;
  return {
    mode: 'real',
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
