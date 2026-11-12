/**
 * Research import: validate → plan (read-only diff against the DB) → apply (single transaction).
 *
 * Integrity rules (docs/research-engine-contract.md):
 * - dry-run by default; `apply` writes everything in ONE transaction or nothing;
 * - idempotency: same runId + same checksum = no-op; same runId + different bytes = conflict;
 * - dedup only by stable externalId; no fuzzy merge; slug may not change;
 * - evidence/competitors/assessments/stage transitions are append-only; a changed immutable
 *   record is a conflict («use a new id»), never an overwrite;
 * - verification status changes are appended as reviews; «checked» without url+publisher+
 *   observedAt is downgraded to «unreviewed»;
 * - scores are never imported as totals — only raw components (strict schema).
 */
import type { Pool, PoolClient } from '../db/pool';
import { canonicalJson, contentHash } from './files';
import { envelopeSchema, type ResearchAssessment, type ResearchEnvelope, type ResearchIdea, type ResearchSource } from './schema';

export interface Diagnostic {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  envelope: ResearchEnvelope | null;
  diagnostics: Diagnostic[];
}

/** Pure schema validation (no database). */
export function validateResearch(input: Buffer | string): ValidationResult {
  let raw: unknown;
  try {
    const textIn = (typeof input === 'string' ? input : input.toString('utf8')).replace(/^\uFEFF/, '');
    raw = JSON.parse(textIn);
  } catch (e) {
    return { ok: false, envelope: null, diagnostics: [{ level: 'error', path: '$', message: `Некорректный JSON: ${(e as Error).message}` }] };
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      envelope: null,
      diagnostics: parsed.error.issues.map((i) => ({
        level: 'error' as const,
        path: i.path.length ? i.path.map(String).join('.') : '$',
        message: i.code === 'unrecognized_keys' ? `неизвестные поля: ${(i as { keys?: string[] }).keys?.join(', ')} (итоговые баллы не принимаются — они вычисляются)` : i.message,
      })),
    };
  }
  const env = parsed.data;
  const warnings: Diagnostic[] = [];
  env.ideas.forEach((idea, i) => {
    idea.sources.forEach((s, j) => {
      if (s.verificationStatus === 'checked' && !isAttributed(s)) {
        warnings.push({ level: 'warning', path: `ideas.${i}.sources.${j}`, message: `источник "${s.id}" помечен checked, но без url/publisher/observedAt — будет сохранён как unreviewed` });
      }
    });
    const fileSourceIds = new Set(idea.sources.map((x) => x.id));
    const outside = [...(idea.assessment?.evidenceIds ?? []), ...idea.westernProducts.flatMap((w) => w.evidenceIds), ...idea.russianCompetitors.flatMap((r) => r.evidenceIds)].filter((id) => !fileSourceIds.has(id));
    if (outside.length) {
      warnings.push({ level: 'warning', path: `ideas.${i}`, message: `ссылки на источники вне файла (${[...new Set(outside)].join(', ')}) будут проверены при импорте по ранее сохранённым источникам идеи` });
    }
    const a = idea.assessment;
    if (a) {
      const nulls = Object.values(a.scores).filter((v) => v === null).length;
      if (nulls > 0 && a.unknowns.length === 0) warnings.push({ level: 'warning', path: `ideas.${i}.assessment`, message: `${nulls} критери(ев) неизвестны, но список unknowns пуст` });
      const unreviewed = a.evidenceIds.filter((id) => idea.sources.find((s) => s.id === id)?.verificationStatus !== 'checked');
      if (unreviewed.length) warnings.push({ level: 'warning', path: `ideas.${i}.assessment.evidenceIds`, message: `оценка опирается на непроверенные источники: ${unreviewed.join(', ')}` });
    }
  });
  return { ok: true, envelope: env, diagnostics: warnings };
}

function isAttributed(s: Pick<ResearchSource, 'url' | 'publisher' | 'observedAt'>): boolean {
  return Boolean(s.url && s.publisher && s.observedAt);
}

// ------------------------------------------------------------------ planning

type Status = 'ready' | 'already-imported' | 'conflict' | 'invalid';

export interface ImportCounts {
  ideas: { inserted: number; updated: number; unchanged: number };
  stageTransitions: number;
  evidence: { inserted: number; unchanged: number; reviewsAppended: number; downgraded: number };
  competitors: { inserted: number; unchanged: number };
  assessments: { inserted: number; unchanged: number };
  rejectedIdeas: number;
}

interface IdeaContent {
  slug: string;
  title: string;
  pitch: string;
  segment: string;
  category: string;
  geography: string;
  targetPersona: string | null;
  problem: string | null;
  ruUnmetJob: string | null;
  whyNow: string | null;
  thesis: string | null;
  monetization: string | null;
  priceHypothesis: string | null;
  distribution: string | null;
  mvp: string | null;
  nextAction: string | null;
  excludedFeatures: string[];
  originMarkets: string[];
  riskFlags: string[];
}

interface EvidenceContent {
  region: string;
  claim: string;
  url: string | null;
  title: string | null;
  publisher: string | null;
  sourceType: string;
  language: string | null;
  publishedAt: string | null;
  observedAt: string | null;
  retrievedAt: string | null;
  dimensions: string[];
  supportNote: string | null;
}

interface CompetitorContent {
  name: string;
  market: 'west' | 'ru';
  url: string | null;
  kind: string;
  coverage: string;
  functions: string | null;
  gap: string | null;
  observedAt: string | null;
  evidenceIds: string[];
}

interface IdeaAction {
  externalId: string;
  existingId: number | null;
  change: 'insert' | 'update' | 'unchanged';
  content: IdeaContent;
  hash: string;
  stage: { stage: string; effectiveAt: string; reason: string | null } | null;
  evidenceInserts: { externalId: string; content: EvidenceContent; hash: string; status: string }[];
  reviewAppends: { externalId: string; status: string }[];
  competitorInserts: { externalId: string; content: CompetitorContent; hash: string }[];
  assessmentInsert: { a: ResearchAssessment; assessedAt: string; hash: string } | null;
}

export interface ImportPlan {
  status: Status;
  runId: string | null;
  checksum: string;
  fileName: string;
  origin: ResearchEnvelope['source'] | null;
  synthetic: boolean | null;
  diagnostics: Diagnostic[];
  counts: ImportCounts;
  /** Human-readable per-idea summary for the dry-run report. */
  ideas: { externalId: string; change: IdeaAction['change']; notes: string[] }[];
  actions: IdeaAction[];
  envelope: ResearchEnvelope | null;
}

function emptyCounts(): ImportCounts {
  return {
    ideas: { inserted: 0, updated: 0, unchanged: 0 },
    stageTransitions: 0,
    evidence: { inserted: 0, unchanged: 0, reviewsAppended: 0, downgraded: 0 },
    competitors: { inserted: 0, unchanged: 0 },
    assessments: { inserted: 0, unchanged: 0 },
    rejectedIdeas: 0,
  };
}

const n = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

/** Descriptive fields with PATCH semantics on re-import. */
const PATCHABLE_TEXT = ['targetPersona', 'problem', 'ruUnmetJob', 'whyNow', 'thesis', 'monetization', 'priceHypothesis', 'distribution', 'mvp', 'nextAction'] as const;
const PATCHABLE_LIST = ['excludedFeatures', 'originMarkets', 'riskFlags'] as const;

export interface MergeResult {
  content: IdeaContent;
  /** Fields whose stored value changes. */
  changed: (keyof IdeaContent)[];
  /** Fields that had a value and are cleared by an explicit null / []. */
  cleared: (keyof IdeaContent)[];
}

/**
 * Merge an imported idea into the stored dossier.
 *
 * PATCH semantics (the research base is cumulative — a short daily update must never silently
 * erase an earlier full dossier):
 * - required fields (title, pitch, segment, category) are always taken from the import;
 * - an ABSENT optional field (key not present) keeps the stored value;
 * - an explicit `null` (text) or `[]` (list) clears it — reported as a warning;
 * - `slug` may be omitted on re-import (kept), but never changed.
 * For a new idea, absent fields become null / [] and geography defaults to «Россия».
 */
export function mergeIdeaContent(idea: ResearchIdea, existing: IdeaContent | null): MergeResult {
  const base: IdeaContent = existing ?? {
    slug: idea.slug ?? idea.externalId,
    title: idea.title,
    pitch: idea.pitch,
    segment: idea.segment,
    category: idea.category,
    geography: 'Россия',
    targetPersona: null,
    problem: null,
    ruUnmetJob: null,
    whyNow: null,
    thesis: null,
    monetization: null,
    priceHypothesis: null,
    distribution: null,
    mvp: null,
    nextAction: null,
    excludedFeatures: [],
    originMarkets: [],
    riskFlags: [],
  };
  const next: IdeaContent = { ...base, title: idea.title, pitch: idea.pitch, segment: idea.segment, category: idea.category };
  if (idea.slug !== undefined) next.slug = idea.slug;
  if (idea.geography !== undefined) next.geography = idea.geography;
  for (const k of PATCHABLE_TEXT) {
    if (idea[k] !== undefined) next[k] = idea[k] ?? null;
  }
  for (const k of PATCHABLE_LIST) {
    const v = idea[k];
    if (v !== undefined) next[k] = k === 'riskFlags' ? [...v].sort() : [...v];
  }
  const changed: (keyof IdeaContent)[] = [];
  const cleared: (keyof IdeaContent)[] = [];
  if (existing) {
    for (const k of Object.keys(next) as (keyof IdeaContent)[]) {
      if (canonicalJson(next[k]) === canonicalJson(existing[k])) continue;
      changed.push(k);
      const was = existing[k];
      const now = next[k];
      const hadValue = Array.isArray(was) ? was.length > 0 : was !== null;
      const isEmpty = Array.isArray(now) ? now.length === 0 : now === null;
      if (hadValue && isEmpty) cleared.push(k);
    }
  }
  return { content: next, changed, cleared };
}

function evidenceContent(s: ResearchSource): EvidenceContent {
  return {
    region: s.region,
    claim: s.claim,
    url: n(s.url),
    title: n(s.title),
    publisher: n(s.publisher),
    sourceType: s.sourceType,
    language: n(s.language),
    publishedAt: n(s.publishedAt),
    observedAt: n(s.observedAt),
    retrievedAt: n(s.retrievedAt),
    dimensions: [...s.dimensions].sort(),
    supportNote: n(s.supportNote),
  };
}

/** Assessment instant in UTC ISO form (dates are midnight UTC). */
export function assessmentInstant(v: string): string {
  return (v.length === 10 ? new Date(`${v}T00:00:00Z`) : new Date(v)).toISOString();
}

function assessmentContent(a: ResearchAssessment) {
  return {
    assessedAt: assessmentInstant(a.assessedAt),
    assessor: a.assessor,
    rubricVersion: a.rubricVersion,
    scores: a.scores,
    confidence: a.confidence,
    founderFit: n(a.founderFit),
    rationale: a.rationale,
    evidenceIds: [...a.evidenceIds].sort(),
    unknowns: a.unknowns,
    revisionReason: n(a.revisionReason),
  };
}

interface Existing {
  idea: { id: number; slug: string; synthetic: boolean; content_hash: string; content: IdeaContent } | null;
  stage: { stage: string; effective_at: Date } | null;
  evidence: Map<string, { hash: string; status: string }>;
  competitors: Map<string, string>;
  assessmentHashes: Set<string>;
  latestAssessmentAt: Date | null;
}

async function loadExisting(c: PoolClient, externalId: string): Promise<Existing> {
  const ideaRow = await c.query<{
    id: number;
    slug: string;
    synthetic: boolean;
    content_hash: string;
    title: string;
    pitch: string;
    segment: string;
    category: string;
    geography: string;
    target_persona: string | null;
    problem: string | null;
    ru_unmet_job: string | null;
    why_now: string | null;
    thesis: string | null;
    monetization: string | null;
    price_hypothesis: string | null;
    distribution: string | null;
    mvp: string | null;
    next_action: string | null;
    excluded_features: string[];
    origin_markets: string[];
    risk_flags: string[];
  }>('SELECT * FROM ideas WHERE external_id = $1', [externalId]);
  const r = ideaRow.rows[0];
  const idea = r
    ? {
        id: r.id,
        slug: r.slug,
        synthetic: r.synthetic,
        content_hash: r.content_hash,
        content: {
          slug: r.slug,
          title: r.title,
          pitch: r.pitch,
          segment: r.segment,
          category: r.category,
          geography: r.geography,
          targetPersona: r.target_persona,
          problem: r.problem,
          ruUnmetJob: r.ru_unmet_job,
          whyNow: r.why_now,
          thesis: r.thesis,
          monetization: r.monetization,
          priceHypothesis: r.price_hypothesis,
          distribution: r.distribution,
          mvp: r.mvp,
          nextAction: r.next_action,
          excludedFeatures: r.excluded_features,
          originMarkets: r.origin_markets,
          riskFlags: [...r.risk_flags].sort(),
        },
      }
    : null;
  const ex: Existing = { idea, stage: null, evidence: new Map(), competitors: new Map(), assessmentHashes: new Set(), latestAssessmentAt: null };
  if (!idea) return ex;
  const st = await c.query<{ stage: string; effective_at: Date }>(
    'SELECT stage, effective_at FROM stage_transitions WHERE idea_id = $1 ORDER BY effective_at DESC, id DESC LIMIT 1',
    [idea.id],
  );
  ex.stage = st.rows[0] ?? null;
  const ev = await c.query<{ external_id: string; content_hash: string; status: string }>(
    `SELECT e.external_id, e.content_hash,
            (SELECT r.status FROM evidence_reviews r WHERE r.evidence_id = e.id ORDER BY r.id DESC LIMIT 1) AS status
       FROM evidence e WHERE e.idea_id = $1`,
    [idea.id],
  );
  for (const r of ev.rows) ex.evidence.set(r.external_id, { hash: r.content_hash, status: r.status });
  const co = await c.query<{ external_id: string; content_hash: string }>('SELECT external_id, content_hash FROM competitors WHERE idea_id = $1', [idea.id]);
  for (const r of co.rows) ex.competitors.set(r.external_id, r.content_hash);
  const as = await c.query<{ content_hash: string; assessed_at: Date }>('SELECT content_hash, assessed_at FROM assessments WHERE idea_id = $1 ORDER BY assessed_at', [idea.id]);
  for (const r of as.rows) ex.assessmentHashes.add(r.content_hash);
  ex.latestAssessmentAt = as.rows.length ? as.rows[as.rows.length - 1]!.assessed_at : null;
  return ex;
}

/**
 * Compute the full diff against the database without writing anything.
 * Must be called inside a transaction (read-only for dry-run, read-write + lock for apply).
 */
export async function planImport(c: PoolClient, file: { bytes: Buffer | string; checksum: string; name: string }): Promise<ImportPlan> {
  const v = validateResearch(file.bytes);
  const base: ImportPlan = {
    status: 'invalid',
    runId: v.envelope?.runId ?? null,
    checksum: file.checksum,
    fileName: file.name,
    origin: v.envelope?.source ?? null,
    synthetic: v.envelope?.synthetic ?? null,
    diagnostics: [...v.diagnostics],
    counts: emptyCounts(),
    ideas: [],
    actions: [],
    envelope: v.envelope,
  };
  if (!v.ok || !v.envelope) return base;
  const env = v.envelope;

  const prior = await c.query<{ checksum: string }>('SELECT checksum FROM import_runs WHERE run_id = $1', [env.runId]);
  if (prior.rows[0]) {
    if (prior.rows[0].checksum === file.checksum) {
      return { ...base, status: 'already-imported', diagnostics: [...base.diagnostics, { level: 'warning', path: 'runId', message: `прогон "${env.runId}" с той же контрольной суммой уже импортирован — изменений нет` }] };
    }
    return {
      ...base,
      status: 'conflict',
      diagnostics: [...base.diagnostics, { level: 'error', path: 'runId', message: `прогон "${env.runId}" уже импортирован с ДРУГИМ содержимым (checksum ${prior.rows[0].checksum.slice(0, 12)}…). Провенанс не перезаписывается: используйте новый runId.` }],
    };
  }

  const diags = base.diagnostics;
  const counts = emptyCounts();
  const actions: IdeaAction[] = [];
  const summary: ImportPlan['ideas'] = [];
  const researchedInstant = `${env.researchedAt}T00:00:00.000Z`;

  for (const [i, idea] of env.ideas.entries()) {
    const path = `ideas.${i}(${idea.externalId})`;
    const notes: string[] = [];
    const ex = await loadExisting(c, idea.externalId);
    const merged = mergeIdeaContent(idea, ex.idea?.content ?? null);
    const content = merged.content;
    const hash = contentHash(content);
    let change: IdeaAction['change'] = 'insert';

    if (ex.idea) {
      if (ex.idea.synthetic !== env.synthetic) {
        diags.push({ level: 'error', path, message: `идея уже существует как ${ex.idea.synthetic ? 'синтетическая' : 'реальная'} — смешивать синтетические и реальные данные нельзя` });
      }
      if (ex.idea.slug !== content.slug) diags.push({ level: 'error', path: `${path}.slug`, message: `slug нельзя менять ("${ex.idea.slug}" → "${content.slug}")` });
      change = merged.changed.length === 0 ? 'unchanged' : 'update';
      if (merged.cleared.length) {
        diags.push({ level: 'warning', path, message: `явно очищены поля досье (null/[]): ${merged.cleared.join(', ')} — прежние значения останутся только в истории ревизий` });
      }
    } else {
      const taken = await c.query('SELECT external_id FROM ideas WHERE slug = $1', [content.slug]);
      if (taken.rows[0]) diags.push({ level: 'error', path: `${path}.slug`, message: `slug "${content.slug}" уже занят другой идеей` });
    }
    if (change === 'insert') counts.ideas.inserted++;
    else if (change === 'update') {
      counts.ideas.updated++;
      notes.push(`обновлены поля: ${merged.changed.join(', ')} (остальные сохранены; прежняя версия — в истории)`);
    } else counts.ideas.unchanged++;

    // Evidence
    const evidenceInserts: IdeaAction['evidenceInserts'] = [];
    const reviewAppends: IdeaAction['reviewAppends'] = [];
    for (const [j, s] of idea.sources.entries()) {
      const ec = evidenceContent(s);
      const eh = contentHash(ec);
      let status: string = s.verificationStatus;
      if (status === 'checked' && !isAttributed(s)) {
        status = 'unreviewed';
        counts.evidence.downgraded++;
      }
      const prev = ex.evidence.get(s.id);
      if (!prev) {
        evidenceInserts.push({ externalId: s.id, content: ec, hash: eh, status });
        counts.evidence.inserted++;
      } else if (prev.hash !== eh) {
        diags.push({ level: 'error', path: `${path}.sources.${j}`, message: `источник "${s.id}" уже сохранён с другим содержимым — доказательства неизменяемы, используйте новый id` });
      } else {
        counts.evidence.unchanged++;
        if (prev.status !== status) {
          reviewAppends.push({ externalId: s.id, status });
          counts.evidence.reviewsAppended++;
          notes.push(`статус источника ${s.id}: ${prev.status} → ${status}`);
        }
      }
    }

    // Evidence references: this file's sources ∪ evidence already stored for this idea.
    const knownEvidence = new Set([...idea.sources.map((x) => x.id), ...ex.evidence.keys()]);
    const checkRefs = (refs: string[], where: string) => {
      for (const ref of refs) {
        if (!knownEvidence.has(ref)) diags.push({ level: 'error', path: `${path}.${where}`, message: `ссылка на неизвестный источник "${ref}" (нет ни в файле, ни среди сохранённых источников идеи)` });
      }
    };
    if (idea.assessment) checkRefs(idea.assessment.evidenceIds, 'assessment.evidenceIds');
    idea.westernProducts.forEach((w, j) => checkRefs(w.evidenceIds, `westernProducts.${j}.evidenceIds`));
    idea.russianCompetitors.forEach((r, j) => checkRefs(r.evidenceIds, `russianCompetitors.${j}.evidenceIds`));

    // Competitors / Western products
    const competitorInserts: IdeaAction['competitorInserts'] = [];
    const comps: { id: string; content: CompetitorContent; key: string }[] = [
      ...idea.westernProducts.map((w) => ({
        id: w.id,
        key: 'westernProducts',
        content: { name: w.name, market: 'west' as const, url: n(w.url), kind: w.kind, coverage: w.coverage, functions: n(w.functions), gap: n(w.note), observedAt: n(w.observedAt), evidenceIds: [...w.evidenceIds].sort() },
      })),
      ...idea.russianCompetitors.map((r) => ({
        id: r.id,
        key: 'russianCompetitors',
        content: { name: r.name, market: 'ru' as const, url: n(r.url), kind: r.kind, coverage: r.coverage, functions: n(r.functions), gap: n(r.gap), observedAt: n(r.observedAt), evidenceIds: [...r.evidenceIds].sort() },
      })),
    ];
    for (const comp of comps) {
      const ch = contentHash(comp.content);
      const prev = ex.competitors.get(comp.id);
      if (!prev) {
        competitorInserts.push({ externalId: comp.id, content: comp.content, hash: ch });
        counts.competitors.inserted++;
      } else if (prev !== ch) {
        diags.push({ level: 'error', path: `${path}.${comp.key}(${comp.id})`, message: `запись "${comp.id}" уже сохранена с другим содержимым — используйте новый id` });
      } else counts.competitors.unchanged++;
    }

    // Assessment (append-only revisions)
    let assessmentInsert: IdeaAction['assessmentInsert'] = null;
    if (idea.assessment) {
      const ac = assessmentContent(idea.assessment);
      const ah = contentHash(ac);
      if (ex.assessmentHashes.has(ah)) counts.assessments.unchanged++;
      else if (ex.latestAssessmentAt && new Date(ac.assessedAt) < ex.latestAssessmentAt) {
        diags.push({ level: 'error', path: `${path}.assessment.assessedAt`, message: `новая оценка датирована раньше последней сохранённой (${ex.latestAssessmentAt.toISOString().slice(0, 10)}) — история оценок только дописывается` });
      } else {
        assessmentInsert = { a: idea.assessment, assessedAt: ac.assessedAt, hash: ah };
        counts.assessments.inserted++;
        notes.push(ex.assessmentHashes.size ? 'добавлена новая ревизия оценки (предыдущие сохранены)' : 'добавлена оценка');
      }
    } else if (!ex.idea || ex.assessmentHashes.size === 0) {
      notes.push('без оценки — будет «не оценено», в рейтинг не попадёт');
    }

    // Stage transition (append-only)
    let stage: IdeaAction['stage'] = null;
    const currentStage = ex.stage?.stage ?? null;
    let desired: string | null = idea.stage ?? null;
    if (!desired) {
      if (!currentStage) desired = idea.assessment ? 'scored' : 'researching';
      else if (assessmentInsert && (currentStage === 'discovered' || currentStage === 'researching')) desired = 'scored';
    }
    if (desired && desired !== currentStage) {
      const effectiveAt = idea.stageChangedAt ? `${idea.stageChangedAt}T00:00:00.000Z` : researchedInstant;
      if (ex.stage && new Date(effectiveAt) < ex.stage.effective_at) {
        diags.push({ level: 'error', path: `${path}.stage`, message: `переход стадии датирован раньше предыдущего (${ex.stage.effective_at.toISOString().slice(0, 10)})` });
      } else {
        stage = { stage: desired, effectiveAt, reason: n(idea.stageReason) };
        counts.stageTransitions++;
        if (desired === 'rejected') counts.rejectedIdeas++;
        notes.push(`стадия: ${currentStage ?? '—'} → ${desired}`);
      }
    }

    actions.push({ externalId: idea.externalId, existingId: ex.idea?.id ?? null, change, content, hash, stage, evidenceInserts, reviewAppends, competitorInserts, assessmentInsert });
    summary.push({ externalId: idea.externalId, change, notes });
  }

  const hasErrors = diags.some((d) => d.level === 'error');
  return { ...base, status: hasErrors ? 'invalid' : 'ready', diagnostics: diags, counts, ideas: summary, actions };
}

// ------------------------------------------------------------------ apply

export interface ImportFile {
  bytes: Buffer | string;
  checksum: string;
  name: string;
}

export interface ApplyOptions {
  actor: string;
  /** Test-only fault injection: throw after writing N ideas to prove atomic rollback. */
  failAfterIdeas?: number;
}

export async function dryRunImport(pool: Pool, file: ImportFile): Promise<ImportPlan> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    return await planImport(client, file);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Apply atomically. Returns the plan; `status === 'ready'` means it was committed. */
export async function applyImport(pool: Pool, file: ImportFile, opts: ApplyOptions): Promise<ImportPlan & { applied: boolean }> {
  const client = await pool.connect();
  const startedAt = new Date();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['vl-research-import']);
    const plan = await planImport(client, file);
    if (plan.status !== 'ready' || !plan.envelope) {
      await client.query('ROLLBACK');
      return { ...plan, applied: false };
    }
    const env = plan.envelope;
    await client.query(
      `INSERT INTO import_runs (run_id, checksum, schema_version, file_name, origin, actor, counts, diagnostics, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [env.runId, file.checksum, env.schemaVersion, file.name, env.source, opts.actor, JSON.stringify(plan.counts), JSON.stringify(plan.diagnostics), startedAt],
    );
    await client.query(
      `INSERT INTO research_runs (run_id, researched_at, origin, synthetic, reviewed_by, title, coverage, limitations, markets, source_refs,
                                  discovered_count, updated_count, rejected_count, sources_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        env.runId,
        env.researchedAt,
        env.source,
        env.synthetic,
        env.reviewedBy,
        n(env.title),
        n(env.coverage),
        n(env.limitations),
        env.markets,
        env.sourceReferences,
        plan.counts.ideas.inserted,
        plan.counts.ideas.updated,
        plan.counts.rejectedIdeas,
        env.ideas.reduce((acc, i) => acc + i.sources.length, 0),
      ],
    );

    let written = 0;
    for (const a of plan.actions) {
      const ideaId = await writeIdea(client, a, env);
      for (const e of a.evidenceInserts) {
        const r = await client.query<{ id: number }>(
          `INSERT INTO evidence (idea_id, external_id, region, claim, url, title, publisher, source_type, language, published_at, observed_at, retrieved_at, dimensions, support_note, run_id, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [ideaId, e.externalId, e.content.region, e.content.claim, e.content.url, e.content.title, e.content.publisher, e.content.sourceType, e.content.language, e.content.publishedAt, e.content.observedAt, e.content.retrievedAt, e.content.dimensions, e.content.supportNote, env.runId, e.hash],
        );
        await client.query('INSERT INTO evidence_reviews (evidence_id, status, run_id) VALUES ($1, $2, $3)', [r.rows[0]!.id, e.status, env.runId]);
      }
      for (const rv of a.reviewAppends) {
        await client.query(
          `INSERT INTO evidence_reviews (evidence_id, status, run_id)
           SELECT id, $3, $4 FROM evidence WHERE idea_id = $1 AND external_id = $2`,
          [ideaId, rv.externalId, rv.status, env.runId],
        );
      }
      for (const co of a.competitorInserts) {
        await client.query(
          `INSERT INTO competitors (idea_id, external_id, name, market, url, kind, coverage, functions, gap, observed_at, evidence_refs, run_id, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [ideaId, co.externalId, co.content.name, co.content.market, co.content.url, co.content.kind, co.content.coverage, co.content.functions, co.content.gap, co.content.observedAt, co.content.evidenceIds, env.runId, co.hash],
        );
      }
      if (a.assessmentInsert) {
        const x = a.assessmentInsert.a;
        await client.query(
          `INSERT INTO assessments (idea_id, rubric_version, assessed_at, assessor, scores, confidence, founder_fit, rationale, evidence_refs, unknowns, revision_reason, run_id, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [ideaId, x.rubricVersion, a.assessmentInsert.assessedAt, x.assessor, JSON.stringify(x.scores), JSON.stringify(x.confidence), x.founderFit ? JSON.stringify(x.founderFit) : null, x.rationale, x.evidenceIds, x.unknowns, n(x.revisionReason), env.runId, a.assessmentInsert.hash],
        );
      }
      if (a.stage) {
        await client.query('INSERT INTO stage_transitions (idea_id, stage, effective_at, actor, reason, run_id) VALUES ($1,$2,$3,$4,$5,$6)', [ideaId, a.stage.stage, a.stage.effectiveAt, env.reviewedBy, a.stage.reason, env.runId]);
      }
      written++;
      if (opts.failAfterIdeas !== undefined && written >= opts.failAfterIdeas) throw new Error('fault injection: simulated failure mid-import');
    }
    await client.query('COMMIT');
    return { ...plan, applied: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function writeIdea(c: PoolClient, a: IdeaAction, env: ResearchEnvelope): Promise<number> {
  const x = a.content;
  const cols = [x.slug, x.title, x.pitch, x.segment, x.category, x.geography, x.targetPersona, x.problem, x.ruUnmetJob, x.whyNow, x.thesis, x.monetization, x.priceHypothesis, x.distribution, x.mvp, x.nextAction, x.excludedFeatures, x.originMarkets, x.riskFlags];
  let id: number;
  if (a.change === 'insert') {
    const r = await c.query<{ id: number }>(
      `INSERT INTO ideas (slug, title, pitch, segment, category, geography, target_persona, problem, ru_unmet_job, why_now, thesis, monetization, price_hypothesis, distribution, mvp, next_action, excluded_features, origin_markets, risk_flags,
                          external_id, synthetic, first_run_id, last_run_id, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22,$23) RETURNING id`,
      [...cols, a.externalId, env.synthetic, env.runId, a.hash],
    );
    id = r.rows[0]!.id;
  } else {
    id = a.existingId!;
    if (a.change === 'update') {
      await c.query(
        `UPDATE ideas SET slug=$1, title=$2, pitch=$3, segment=$4, category=$5, geography=$6, target_persona=$7, problem=$8, ru_unmet_job=$9, why_now=$10, thesis=$11,
                          monetization=$12, price_hypothesis=$13, distribution=$14, mvp=$15, next_action=$16, excluded_features=$17, origin_markets=$18, risk_flags=$19,
                          last_run_id=$20, content_hash=$21, updated_at=now()
          WHERE id=$22`,
        [...cols, env.runId, a.hash, id],
      );
    } else {
      return id;
    }
  }
  await c.query('INSERT INTO idea_revisions (idea_id, run_id, content, content_hash) VALUES ($1, $2, $3, $4)', [id, env.runId, JSON.stringify(x), a.hash]);
  return id;
}
