/**
 * Read models for the machine dataset (read-only; used by the local API).
 * Every query is scoped to exactly one feed ('fixture' | 'live'); legacy/demo/test data are never read.
 */
import { DIMENSION_KEYS } from '../../src/domain/scoring';
import type {
  MachineAssessment,
  MachineCandidateDetail,
  MachineChange,
  MachineFeed,
  MachineOverview,
  MachineRun,
  MachineRunDiagnostics,
  MachineSnapshotMeta,
  MachineState,
  MachineTopEntry,
  MachineWatchItem,
} from '../../src/domain/machine';
import type { ComponentScores, ISODate, RawScore } from '../../src/domain/types';
import type { Queryable } from '../db/pool';
import { isStale, localToday } from './schedule';
import { DEFAULT_JOB_BUDGET, DEFAULT_MONTHLY_BUDGET, DIM_COLUMN, WORKER_TIMEZONE } from './worker';

type Row = Record<string, unknown>;

function runFrom(r: Row): MachineRun {
  return {
    id: r.id as number,
    jobKey: r.job_key as string,
    feed: r.feed as MachineFeed,
    asOf: r.as_of as string,
    status: r.status as MachineRun['status'],
    attempts: r.attempts as number,
    maxAttempts: r.max_attempts as number,
    spent: r.spent as number,
    budgetLimit: r.budget_limit as number,
    error: (r.error as string | null) ?? null,
    partialReason: (r.partial_reason as string | null) ?? null,
    startedAt: r.started_at ? (r.started_at as Date).toISOString() : null,
    finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null,
    pipelineVersion: r.pipeline_version as string,
  };
}

function assessmentFrom(r: Row): MachineAssessment {
  const scores = Object.fromEntries(DIMENSION_KEYS.map((d) => [d, (r[DIM_COLUMN[d]] as RawScore) ?? null])) as ComponentScores;
  return {
    id: r.id as number,
    jobId: r.job_id as number,
    asOf: r.as_of as string,
    title: r.title as string,
    pitch: r.pitch as string,
    segment: r.segment as 'B2B' | 'B2C',
    category: r.category as string,
    scores,
    confidenceComponents: {
      completeness: r.conf_completeness as number,
      corroboration: r.conf_corroboration as number,
      recency: r.conf_recency as number,
      reliability: r.conf_reliability as number,
      russiaValidation: r.conf_russia_validation as number,
    },
    founderFitComponents:
      r.fit_skills === null
        ? null
        : { skills: r.fit_skills as number, access: r.fit_access as number, timeToSale: r.fit_time_to_sale as number, motivation: r.fit_motivation as number, synergy: r.fit_synergy as number },
    marketScore: r.market_score as number,
    confidence: r.confidence as number,
    founderFit: (r.founder_fit as number | null) ?? null,
    evidenceGrade: r.evidence_grade as MachineAssessment['evidenceGrade'],
    state: r.state as MachineState,
    holdReasons: r.hold_reasons as string[],
    rationale: r.rationale as string,
    dimensionNotes: r.dimension_notes as string[],
    models: r.models as string[],
    pipelineVersion: r.pipeline_version as string,
  };
}

const metaFrom = (r: Row): MachineSnapshotMeta => ({
  asOf: r.as_of as string,
  jobId: r.job_id as number,
  eligibleCount: r.eligible_count as number,
  holdCount: r.hold_count as number,
  publishedAt: (r.published_at as Date).toISOString(),
});

export async function listMachineRuns(db: Queryable, feed: MachineFeed, limit = 30): Promise<MachineRun[]> {
  const r = await db.query('SELECT * FROM mr_jobs WHERE feed = $1 ORDER BY as_of DESC, id DESC LIMIT $2', [feed, limit]);
  return r.rows.map(runFrom);
}

export async function listMachineSnapshots(db: Queryable, feed: MachineFeed): Promise<MachineSnapshotMeta[]> {
  const r = await db.query('SELECT * FROM mr_snapshots WHERE feed = $1 ORDER BY as_of DESC', [feed]);
  return r.rows.map(metaFrom);
}

async function snapshotEntries(db: Queryable, snapshotId: number, firstJobId: number): Promise<MachineTopEntry[]> {
  const r = await db.query(
    `SELECT e.*, c.external_id, c.first_job_id, a.category, a.segment, a.founder_fit, to_char(a.as_of, 'YYYY-MM-DD') AS assessed_as_of
       FROM mr_snapshot_entries e
       JOIN mr_candidates c ON c.id = e.candidate_id
       JOIN mr_assessments a ON a.id = e.assessment_id
      WHERE e.snapshot_id = $1 ORDER BY e.rank`,
    [snapshotId],
  );
  return r.rows.map((x: Row) => ({
    rank: x.rank as number,
    externalId: x.external_id as string,
    title: x.title as string,
    category: x.category as string,
    segment: x.segment as 'B2B' | 'B2C',
    marketScore: x.market_score as number,
    confidence: x.confidence as number,
    founderFit: (x.founder_fit as number | null) ?? null,
    evidenceGrade: x.evidence_grade as MachineTopEntry['evidenceGrade'],
    prevRank: (x.prev_rank as number | null) ?? null,
    scoreDelta: (x.score_delta as number | null) ?? null,
    isNew: x.first_job_id === firstJobId,
    assessedAsOf: x.assessed_as_of as string,
    carried: x.assessment_job_id !== null && x.assessment_job_id !== undefined,
  }));
}

/** What happened in one run: coverage, failures, validated rivals, contradictions, money (estimated vs observed). */
export async function runDiagnostics(db: Queryable, jobId: number): Promise<MachineRunDiagnostics | null> {
  const j = (await db.query('SELECT id, to_char(as_of, \'YYYY-MM-DD\') AS as_of, status, independence, partial_reason, error FROM mr_jobs WHERE id = $1', [jobId])).rows[0];
  if (!j) return null;
  const q = async (sql: string) => (await db.query(sql, [jobId])).rows as Row[];
  const searches = await q("SELECT region, count(*)::int AS n, count(*) FILTER (WHERE status <> 'ok')::int AS failed FROM mr_searches WHERE job_id = $1 GROUP BY region");
  const pages = await q('SELECT fetch_status, count(DISTINCT url)::int AS n FROM mr_sources WHERE job_id = $1 GROUP BY fetch_status');
  const comps = await q(
    "SELECT count(*) FILTER (WHERE market = 'ru' AND kind = 'direct' AND market_status IN ('verified', 'declared'))::int AS direct, count(*) FILTER (WHERE market = 'ru' AND kind = 'adjacent' AND market_status IN ('verified', 'declared'))::int AS adjacent, count(DISTINCT name) FILTER (WHERE market = 'ru' AND market_status IN ('verified', 'declared'))::int AS distinct_ru, count(*) FILTER (WHERE market_status IS NULL OR market_status IN ('conflicting', 'unknown'))::int AS unverified FROM mr_competitors WHERE job_id = $1",
  );
  const indep = await q("SELECT count(DISTINCT url)::int AS n FROM mr_sources WHERE job_id = $1 AND provenance->>'independence' = 'unverified'");
  const contra = await q("SELECT count(*)::int AS n FROM mr_claims WHERE job_id = $1 AND status = 'contradicted'");
  const cost = await q(
    `SELECT COALESCE(SUM(COALESCE(estimated_cost, cost)), 0)::int AS estimated, COALESCE(SUM(cost), 0)::int AS charged, COALESCE(SUM(actual_cost), 0)::int AS observed,
            count(*) FILTER (WHERE reconciliation IN ('unknown', 'estimate_only'))::int AS unknown, count(*) FILTER (WHERE reconciliation = 'anomaly_over_estimate')::int AS anomalies
       FROM mr_usage WHERE job_id = $1`,
  );
  const conf = await q('SELECT round(avg(confidence))::int AS c FROM mr_assessments WHERE job_id = $1');
  const carried = await q('SELECT COALESCE(max(carried_count), 0)::int AS n FROM mr_snapshots WHERE job_id = $1');
  const by = (region: string) => searches.find((x) => x.region === region)?.n as number | undefined;
  const byStatus = Object.fromEntries(pages.map((p) => [p.fetch_status as string, p.n as number]));
  const ok = (byStatus.ok as number | undefined) ?? 0;
  return {
    jobId,
    asOf: j.as_of as string,
    status: j.status as MachineRunDiagnostics['status'],
    independence: (j.independence as MachineRunDiagnostics['independence']) ?? null,
    searches: { ru: by('ru') ?? 0, west: by('west') ?? 0, world: by('world') ?? 0, failed: searches.reduce((a, x) => a + (x.failed as number), 0) },
    pages: { ok, failed: Object.values(byStatus).reduce((a, n) => a + n, 0) - ok, byStatus },
    competitors: { ruDirect: comps[0]!.direct as number, ruAdjacent: comps[0]!.adjacent as number, distinctRu: comps[0]!.distinct_ru as number, marketUnverified: comps[0]!.unverified as number },
    independenceUnverified: indep[0]!.n as number,
    contradictions: contra[0]!.n as number,
    cost: { estimated: cost[0]!.estimated as number, charged: cost[0]!.charged as number, observed: cost[0]!.observed as number, unknownCalls: cost[0]!.unknown as number, anomalies: cost[0]!.anomalies as number },
    averageConfidence: (conf[0]!.c as number | null) ?? null,
    partialReason: (j.partial_reason as string | null) ?? null,
    error: (j.error as string | null) ?? null,
    carried: carried[0]!.n as number,
  };
}

export async function machineSnapshot(db: Queryable, feed: MachineFeed, asOf: ISODate) {
  const s = (await db.query('SELECT * FROM mr_snapshots WHERE feed = $1 AND as_of = $2', [feed, asOf])).rows[0];
  if (!s) return null;
  return { ...metaFrom(s), entries: await snapshotEntries(db, s.id as number, s.job_id as number) };
}

async function assessmentsOfJob(db: Queryable, jobId: number) {
  const r = await db.query(
    `SELECT a.*, c.external_id, c.first_job_id FROM mr_assessments a JOIN mr_candidates c ON c.id = a.candidate_id WHERE a.job_id = $1 ORDER BY a.id`,
    [jobId],
  );
  return r.rows as Row[];
}

export async function machineOverview(db: Queryable, feed: MachineFeed, now = new Date()): Promise<MachineOverview> {
  const today = localToday(now);
  const latest = (await db.query('SELECT * FROM mr_jobs WHERE feed = $1 ORDER BY as_of DESC, id DESC LIMIT 1', [feed])).rows[0];
  const success = (await db.query("SELECT * FROM mr_jobs WHERE feed = $1 AND status = 'succeeded' ORDER BY as_of DESC LIMIT 1", [feed])).rows[0];
  const snaps = (await db.query('SELECT * FROM mr_snapshots WHERE feed = $1 ORDER BY as_of DESC LIMIT 2', [feed])).rows;
  const [cur, prev] = snaps;
  const snapshot = cur ? { ...metaFrom(cur), entries: await snapshotEntries(db, cur.id as number, cur.job_id as number) } : null;

  let newToday: MachineWatchItem[] = [];
  let watchlist: MachineWatchItem[] = [];
  const changes: MachineChange[] = [];
  const totals = { candidates: 0, passed: 0, held: 0, discovered: 0 };
  if (cur) {
    const rows = await assessmentsOfJob(db, cur.job_id as number);
    const item = (a: Row): MachineWatchItem => ({
      externalId: a.external_id as string,
      title: a.title as string,
      state: a.state as MachineState,
      marketScore: a.market_score as number,
      confidence: a.confidence as number,
      evidenceGrade: a.evidence_grade as MachineWatchItem['evidenceGrade'],
      holdReasons: a.hold_reasons as string[],
      isNew: a.first_job_id === cur.job_id,
    });
    newToday = rows.filter((a) => a.first_job_id === cur.job_id).map(item);
    watchlist = rows.filter((a) => a.state !== 'AUTOMATED_EVIDENCE_PASSED').map(item);
    totals.candidates = rows.length;
    totals.passed = rows.filter((a) => a.state === 'AUTOMATED_EVIDENCE_PASSED').length;
    totals.held = rows.filter((a) => a.state === 'RESEARCH_HOLD').length;
    totals.discovered = rows.filter((a) => a.state === 'DISCOVERED').length;

    if (prev && snapshot) {
      const prevEntries = await snapshotEntries(db, prev.id as number, prev.job_id as number);
      const prevBy = new Map(prevEntries.map((e) => [e.externalId, e]));
      const curBy = new Map(snapshot.entries.map((e) => [e.externalId, e]));
      for (const e of snapshot.entries) {
        const p = prevBy.get(e.externalId);
        if (!p) changes.push({ kind: 'entered', externalId: e.externalId, title: e.title, from: null, to: e.rank, scoreDelta: null });
        else if (p.rank !== e.rank) changes.push({ kind: e.rank < p.rank ? 'up' : 'down', externalId: e.externalId, title: e.title, from: p.rank, to: e.rank, scoreDelta: e.marketScore - p.marketScore });
        else if (e.marketScore !== p.marketScore) changes.push({ kind: e.marketScore > p.marketScore ? 'up' : 'down', externalId: e.externalId, title: e.title, from: p.rank, to: e.rank, scoreDelta: e.marketScore - p.marketScore });
      }
      for (const p of prevEntries) if (!curBy.has(p.externalId)) changes.push({ kind: 'exited', externalId: p.externalId, title: p.title, from: p.rank, to: null, scoreDelta: null });

      const prevStates = new Map((await assessmentsOfJob(db, prev.job_id as number)).map((a) => [a.external_id as string, a.state as MachineState]));
      for (const a of rows) {
        const before = prevStates.get(a.external_id as string) ?? null;
        if (before !== null && before !== a.state) changes.push({ kind: 'state', externalId: a.external_id as string, title: a.title as string, fromState: before, toState: a.state as MachineState, reasons: a.hold_reasons as string[] });
      }
      const comp = await db.query(
        `SELECT c.external_id, a.title, k.name, k.market, k.kind, k.url
           FROM mr_competitors k JOIN mr_candidates c ON c.id = k.candidate_id
           JOIN mr_assessments a ON a.candidate_id = k.candidate_id AND a.job_id = k.job_id
          WHERE k.job_id = $1 AND c.first_job_id <> $1
            AND NOT EXISTS (SELECT 1 FROM mr_competitors o WHERE o.job_id = $2 AND o.candidate_id = k.candidate_id AND o.name = k.name AND o.market = k.market)
          ORDER BY c.external_id, k.name`,
        [cur.job_id, prev.job_id],
      );
      for (const k of comp.rows as Row[]) {
        changes.push({ kind: 'competitor', externalId: k.external_id as string, title: k.title as string, competitor: k.name as string, market: k.market as 'west' | 'ru', competitorKind: k.kind as 'direct', url: (k.url as string | null) ?? null });
      }
    }
  }
  // Committed month spend from the attempt ledger (actual usage, or the full reservation while unknown).
  const month = (
    await db.query<{ s: number }>(
      `SELECT COALESCE(SUM(COALESCE(used, reserved)), 0)::int AS s FROM mr_attempts WHERE feed = $1 AND month = date_trunc('month', $2::date)::date`,
      [feed, (latest?.as_of as string | undefined) ?? today],
    )
  ).rows[0]!.s;
  const priceVersion = latest ? ((await db.query('SELECT price_version FROM mr_usage WHERE job_id = $1 LIMIT 1', [latest.id])).rows[0]?.price_version ?? null) : null;
  return {
    feed,
    timezone: WORKER_TIMEZONE,
    today,
    latestRun: latest ? runFrom(latest) : null,
    lastSuccess: success ? runFrom(success) : null,
    stale: isStale((success?.as_of as string | undefined) ?? null, today),
    snapshot,
    previousSnapshot: prev ? metaFrom(prev) : null,
    newToday,
    watchlist,
    changes,
    costs: { lastRun: (latest?.spent as number | undefined) ?? 0, month, budgetPerRun: (latest?.budget_limit as number | undefined) ?? DEFAULT_JOB_BUDGET, monthlyBudget: (latest?.monthly_cap as number | undefined) ?? DEFAULT_MONTHLY_BUDGET, priceVersion },
    totals,
    diagnostics: latest ? await runDiagnostics(db, latest.id as number) : null,
  };
}

export async function machineCandidate(db: Queryable, feed: MachineFeed, externalId: string): Promise<MachineCandidateDetail | null> {
  const c = (await db.query('SELECT * FROM mr_candidates WHERE feed = $1 AND external_id = $2', [feed, externalId])).rows[0];
  if (!c) return null;
  const hist = (await db.query('SELECT * FROM mr_assessments WHERE candidate_id = $1 ORDER BY as_of DESC, id DESC', [c.id])).rows.map(assessmentFrom);
  const current = hist[0]!;
  const job = current.jobId;
  const q = async (sql: string) => (await db.query(sql, [job, c.id])).rows as Row[];
  const rank = (
    await db.query(
      `SELECT e.rank FROM mr_snapshot_entries e JOIN mr_snapshots s ON s.id = e.snapshot_id
        WHERE s.id = (SELECT id FROM mr_snapshots WHERE feed = $1 ORDER BY as_of DESC LIMIT 1) AND e.candidate_id = $2`,
      [feed, c.id],
    )
  ).rows[0]?.rank as number | undefined;
  return {
    feed,
    externalId,
    firstSeen: c.first_seen as string,
    primaryJob: c.primary_job as string,
    westernProduct: c.western_product as string,
    current,
    rank: rank ?? null,
    history: hist,
    sources: (await q('SELECT * FROM mr_sources WHERE job_id = $1 AND candidate_id = $2 ORDER BY id')).map((s) => ({
      key: s.source_key as string,
      url: s.url as string,
      publisher: (s.publisher as string | null) ?? null,
      region: s.region as 'west' | 'ru',
      sourceType: s.source_type as MachineCandidateDetail['sources'][number]['sourceType'],
      fetchStatus: s.fetch_status as MachineCandidateDetail['sources'][number]['fetchStatus'],
      httpStatus: (s.http_status as number | null) ?? null,
      excerpt: (s.excerpt as string | null) ?? null,
      agent: s.agent as 'analyst' | 'skeptic',
      canonicalUrl: (s.canonical_url as string | null) ?? null,
      fetchedAt: s.fetched_at ? (s.fetched_at as Date).toISOString() : null,
      failure: (s.failure as string | null) ?? null,
      offerUncertain: ((s.offer as { grounding?: { uncertain?: string[] } } | null)?.grounding?.uncertain ?? []).slice(0, 10),
      provenance: (s.provenance as MachineCandidateDetail['sources'][number]['provenance']) ?? null,
    })),
    claims: (await q('SELECT * FROM mr_claims WHERE job_id = $1 AND candidate_id = $2 ORDER BY id')).map((x) => ({
      key: x.claim_key as string,
      dimension: x.dimension as MachineCandidateDetail['claims'][number]['dimension'],
      text: x.text as string,
      quote: (x.quote as string | null) ?? null,
      sourceKeys: x.source_keys as string[],
      status: x.status as MachineCandidateDetail['claims'][number]['status'],
      reason: x.status_reason as string,
      highImpact: x.high_impact as boolean,
      supportingKeys: x.supporting_source_keys as string[],
      skepticVerdict: x.skeptic_verdict as MachineCandidateDetail['claims'][number]['skepticVerdict'],
      skepticReason: (x.skeptic_reason as string | null) ?? null,
    })),
    searches: (await q('SELECT * FROM mr_searches WHERE job_id = $1 AND candidate_id = $2 ORDER BY id')).map((x) => ({
      agent: x.agent as 'analyst' | 'skeptic',
      purpose: x.purpose as string,
      region: x.region as 'west' | 'ru' | 'world',
      query: x.query as string,
      resultCount: x.result_count as number,
      status: x.status as string,
    })),
    competitors: (await q('SELECT * FROM mr_competitors WHERE job_id = $1 AND candidate_id = $2 ORDER BY market, kind, name')).map((x) => ({
      name: x.name as string,
      url: (x.url as string | null) ?? null,
      market: x.market as 'west' | 'ru',
      kind: x.kind as 'direct' | 'adjacent' | 'substitute',
      foundBy: x.found_by as 'analyst' | 'skeptic',
      note: (x.note as string | null) ?? null,
      reason: x.classification_reason as string,
      // Historical rows (before 006) have no status: their market was never assessed → not «verified».
      marketStatus: (x.market_status as MachineCandidateDetail['competitors'][number]['marketStatus']) ?? 'not_assessed',
      marketVerified: x.market_status === 'verified' || x.market_status === 'declared',
    })),
    reviews: (await q('SELECT * FROM mr_reviews WHERE job_id = $1 AND candidate_id = $2 ORDER BY id')).map((x) => ({
      reviewer: x.reviewer as MachineCandidateDetail['reviews'][number]['reviewer'],
      model: x.model as string,
      decision: x.decision as string,
      summary: x.summary as string,
      findings: x.findings as string[],
    })),
  };
}
