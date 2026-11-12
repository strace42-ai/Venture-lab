/**
 * VL-003 research operations — pure, shared by the DEMO adapter and the local API:
 *  - evidence review queue (filtering/sorting over the domain model);
 *  - TOP-10 snapshot comparison from FROZEN snapshot entries;
 *  - research journal types (built from stored provenance on the server, from the fixture in DEMO).
 * No scoring rules live here: scores always come from src/domain/scoring.ts or frozen snapshots.
 */
import { effectiveEvidenceStatus, type EffectiveEvidenceStatus } from './selectors';
import { latestAssessment } from './scoring';
import type { DataMode, Dataset, DimensionKey, Evidence, EvidenceReview, ISODate, RiskFlag, SourceType, Stage } from './types';

// ------------------------------------------------------------------ evidence queue

export type EvidenceStatusFilter = EffectiveEvidenceStatus | 'all' | 'needs-review';

export interface EvidenceQuery {
  status: EvidenceStatusFilter;
  market: 'all' | 'west' | 'ru';
  sourceType: SourceType | 'all';
  idea: string | 'all';
  /** Only evidence observed at least this many days ago (stale); null = any age. */
  minAgeDays: number | null;
  missingUrl: boolean;
  dimension: DimensionKey | 'all';
  risk: RiskFlag | 'all';
}

export const DEFAULT_EVIDENCE_QUERY: EvidenceQuery = {
  status: 'needs-review',
  market: 'all',
  sourceType: 'all',
  idea: 'all',
  minAgeDays: null,
  missingUrl: false,
  dimension: 'all',
  risk: 'all',
};

export interface EvidenceRow {
  evidence: Evidence;
  status: EffectiveEvidenceStatus;
  idea: { id: string; slug: string; title: string; stage: Stage; riskFlags: RiskFlag[] };
  /** Cited by the idea's CURRENT assessment (a review here directly affects a live score's basis). */
  usedInAssessment: boolean;
  /** Days since the observation date; null when the date is unknown. */
  ageDays: number | null;
  lastReview: EvidenceReview | null;
}

export interface EvidenceQueueView {
  mode: DataMode;
  asOf: ISODate;
  rows: EvidenceRow[];
  total: number;
  totalAll: number;
  page: number;
  pageSize: number;
  counts: Record<EffectiveEvidenceStatus, number>;
  ideas: { id: string; title: string }[];
}

function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const STATUS_PRIORITY: Record<EffectiveEvidenceStatus, number> = { unattributed: 0, unreviewed: 1, rejected: 2, checked: 3 };

export function buildEvidenceQueue(data: Dataset, query: EvidenceQuery, page = { page: 1, pageSize: 500 }): EvidenceQueueView {
  const all: EvidenceRow[] = [];
  for (const idea of data.ideas) {
    const cited = new Set(latestAssessment(idea)?.evidenceIds ?? []);
    for (const ev of idea.evidence) {
      const reviews = ev.reviews ?? [];
      all.push({
        evidence: ev,
        status: effectiveEvidenceStatus(ev),
        idea: { id: idea.id, slug: idea.slug, title: idea.title, stage: idea.stage, riskFlags: idea.riskFlags },
        usedInAssessment: cited.has(ev.id),
        ageDays: ev.observedAt ? daysBetween(ev.observedAt, data.asOf) : null,
        lastReview: reviews[reviews.length - 1] ?? null,
      });
    }
  }
  const counts: EvidenceQueueView['counts'] = { checked: 0, unreviewed: 0, rejected: 0, unattributed: 0 };
  for (const r of all) counts[r.status]++;

  const rows = all.filter((r) => {
    if (query.status === 'needs-review' && r.status !== 'unreviewed' && r.status !== 'unattributed') return false;
    if (query.status !== 'all' && query.status !== 'needs-review' && r.status !== query.status) return false;
    if (query.market !== 'all' && r.evidence.market !== query.market) return false;
    if (query.sourceType !== 'all' && r.evidence.sourceType !== query.sourceType) return false;
    if (query.idea !== 'all' && r.idea.id !== query.idea && r.idea.slug !== query.idea) return false;
    if (query.minAgeDays !== null && (r.ageDays === null || r.ageDays < query.minAgeDays)) return false;
    if (query.missingUrl && r.evidence.url) return false;
    if (query.dimension !== 'all' && !r.evidence.dimensions.includes(query.dimension)) return false;
    if (query.risk !== 'all' && !r.idea.riskFlags.includes(query.risk)) return false;
    return true;
  });
  rows.sort(
    (a, b) =>
      STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] ||
      Number(b.usedInAssessment) - Number(a.usedInAssessment) ||
      (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
      a.idea.title.localeCompare(b.idea.title, 'ru') ||
      a.evidence.id.localeCompare(b.evidence.id),
  );
  const start = (page.page - 1) * page.pageSize;
  return {
    mode: data.mode,
    asOf: data.asOf,
    rows: rows.slice(start, start + page.pageSize),
    total: rows.length,
    totalAll: all.length,
    page: page.page,
    pageSize: page.pageSize,
    counts,
    ideas: data.ideas.map((i) => ({ id: i.id, title: i.title })).sort((a, b) => a.title.localeCompare(b.title, 'ru')),
  };
}

// ------------------------------------------------------------------ snapshot comparison

export interface FrozenSnapshotEntry {
  ideaId: string;
  rank: number;
  score: number;
  confidence: number;
  /** Title/slug as stored at snapshot time — never today's values. */
  title: string;
  slug: string;
}

export interface SnapshotMeta {
  id: string;
  asOf: ISODate;
  entryCount: number;
  /** `stored` = immutable DB snapshot; `reconstructed` = DEMO fixture history. */
  kind: 'stored' | 'reconstructed';
}

export interface FrozenSnapshot extends SnapshotMeta {
  entries: FrozenSnapshotEntry[];
}

/** Metadata of a snapshot without its entries. */
export function snapshotMeta(s: SnapshotMeta): SnapshotMeta {
  return { id: s.id, asOf: s.asOf, entryCount: s.entryCount, kind: s.kind };
}

export type CompareChange = 'entered' | 'exited' | 'up' | 'down' | 'same';

export interface CompareRow {
  ideaId: string;
  slug: string;
  titleA: string | null;
  titleB: string | null;
  rankA: number | null;
  rankB: number | null;
  scoreA: number | null;
  scoreB: number | null;
  confidenceA: number | null;
  confidenceB: number | null;
  change: CompareChange;
  /** For `entered`: was it ranked (below the cut) in A or absent? For `exited`: still ranked below the cut, or not ranked in B at all? */
  detail: 'new-in-ranking' | 'from-below' | 'below-cut' | 'left-ranking' | null;
  scoreDelta: number | null;
  confidenceDelta: number | null;
  /** Rank delta within the full stored ranking (positive = moved up). */
  rankDelta: number | null;
}

export interface SnapshotComparison {
  a: SnapshotMeta;
  b: SnapshotMeta;
  /** Swapped so that A is always the earlier snapshot. */
  swapped: boolean;
  cut: number;
  topA: number;
  topB: number;
  rows: CompareRow[];
  summary: Record<CompareChange, number>;
}

/**
 * Compare two FROZEN snapshots. Uses only stored entries (rank, score, confidence, title/slug at
 * snapshot time). Rows = ideas in the TOP-`cut` of A or B. Entries store the full ranking, so an idea
 * outside the cut can still be classified exactly («ниже 10» vs «выбыла из рейтинга»).
 */
export function compareSnapshots(x: FrozenSnapshot, y: FrozenSnapshot, cut = 10): SnapshotComparison {
  const swapped = x.asOf > y.asOf;
  const [A, B] = swapped ? [y, x] : [x, y];
  const byA = new Map(A.entries.map((e) => [e.ideaId, e]));
  const byB = new Map(B.entries.map((e) => [e.ideaId, e]));
  const ids = new Set<string>();
  for (const e of A.entries) if (e.rank <= cut) ids.add(e.ideaId);
  for (const e of B.entries) if (e.rank <= cut) ids.add(e.ideaId);

  const rows: CompareRow[] = [...ids].map((id) => {
    const a = byA.get(id) ?? null;
    const b = byB.get(id) ?? null;
    const inA = !!a && a.rank <= cut;
    const inB = !!b && b.rank <= cut;
    let change: CompareChange;
    let detail: CompareRow['detail'] = null;
    if (!inA && inB) {
      change = 'entered';
      detail = a ? 'from-below' : 'new-in-ranking';
    } else if (inA && !inB) {
      change = 'exited';
      detail = b ? 'below-cut' : 'left-ranking';
    } else if (a!.rank > b!.rank) change = 'up';
    else if (a!.rank < b!.rank) change = 'down';
    else change = 'same';
    return {
      ideaId: id,
      slug: (b ?? a)!.slug,
      titleA: a?.title ?? null,
      titleB: b?.title ?? null,
      rankA: a?.rank ?? null,
      rankB: b?.rank ?? null,
      scoreA: a?.score ?? null,
      scoreB: b?.score ?? null,
      confidenceA: a?.confidence ?? null,
      confidenceB: b?.confidence ?? null,
      change,
      detail,
      scoreDelta: a && b ? b.score - a.score : null,
      confidenceDelta: a && b ? b.confidence - a.confidence : null,
      rankDelta: a && b ? a.rank - b.rank : null,
    };
  });
  const NONE = Number.MAX_SAFE_INTEGER;
  rows.sort((p, q) => {
    const pb = p.rankB !== null && p.rankB <= cut ? p.rankB : NONE;
    const qb = q.rankB !== null && q.rankB <= cut ? q.rankB : NONE;
    return pb - qb || (p.rankA ?? NONE) - (q.rankA ?? NONE) || p.ideaId.localeCompare(q.ideaId);
  });
  const summary: SnapshotComparison['summary'] = { entered: 0, exited: 0, up: 0, down: 0, same: 0 };
  for (const r of rows) summary[r.change]++;
  return {
    a: snapshotMeta(A),
    b: snapshotMeta(B),
    swapped,
    cut,
    topA: A.entries.filter((e) => e.rank <= cut).length,
    topB: B.entries.filter((e) => e.rank <= cut).length,
    rows,
    summary,
  };
}

// ------------------------------------------------------------------ research journal

export interface JournalIdeaChange {
  ideaId: string;
  slug: string;
  /** Current title (the journal links to today's dossier). */
  title: string;
  created: boolean;
  updatedFields: string[];
  assessmentAdded: boolean;
  /** Market score of the assessment added in this run (recomputed by src/domain). */
  assessmentScore: number | null;
  stage: { from: Stage | null; to: Stage; reason: string | null } | null;
  evidenceAdded: number;
  competitorsAdded: number;
  statusChanges: number;
}

export interface JournalRun {
  id: string;
  date: ISODate;
  title: string | null;
  synthetic: boolean;
  origin: string;
  reviewedBy: string;
  coverage: string | null;
  limitations: string | null;
  markets: string[];
  sourceRefs: string[];
  importedAt: string | null;
  importedBy: string | null;
  fileName: string | null;
  checksum: string | null;
  approval: { by: string; at: ISODate; statement: string } | null;
  counts: {
    ideasCreated: number;
    ideasUpdated: number;
    assessmentsAdded: number;
    stageChanges: number;
    rejected: number;
    evidenceAdded: number;
    competitorsAdded: number;
    statusChanges: number;
  };
  /** CURRENT effective status of the evidence first recorded in this run. */
  evidenceStatus: Record<EffectiveEvidenceStatus, number>;
  ideas: JournalIdeaChange[];
}

export interface JournalManualReview {
  at: string;
  actor: string;
  reason: string;
  status: Evidence['verificationStatus'];
  previousStatus: Evidence['verificationStatus'] | null;
  evidenceId: string;
  claim: string;
  url: string | null;
  idea: { id: string; slug: string; title: string };
}

export interface JournalView {
  mode: DataMode;
  asOf: ISODate;
  runs: JournalRun[];
  manualReviews: JournalManualReview[];
  /** Honest notes about what could not be derived (e.g. DEMO has no stored provenance). */
  notes: string[];
}

export function emptyStatusCounts(): Record<EffectiveEvidenceStatus, number> {
  return { checked: 0, unreviewed: 0, rejected: 0, unattributed: 0 };
}
