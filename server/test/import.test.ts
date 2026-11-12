// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetSchema } from '../db/migrate';
import { FileAccessError, readResearchFile } from '../research/files';
import { applyImport, dryRunImport, validateResearch } from '../research/importer';
import { loadIdeas } from '../research/repository';
import { ACTOR, count, counts, createTestDb, describeDb, exampleFile, jsonFile, loadExample, type TestDb } from './helpers';

// ------------------------------------------------------------- schema validation (no DB)
describe('vl-research-1 schema validation', () => {
  const base = () => loadExample('synthetic-run-1.json');

  it('accepts both shipped synthetic examples', () => {
    for (const f of ['synthetic-run-1.json', 'synthetic-run-2.json']) {
      const v = validateResearch(exampleFile(f).bytes);
      expect(v.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.envelope!.synthetic).toBe(true);
    }
  });

  it('rejects malformed JSON with a diagnostic, not a crash', () => {
    const v = validateResearch('{ "schemaVersion": ');
    expect(v.ok).toBe(false);
    expect(v.diagnostics[0]!.message).toMatch(/Некорректный JSON/);
  });

  it('rejects user-supplied aggregate scores (unknown keys)', () => {
    const env = base();
    (env.ideas[0]!.assessment as Record<string, unknown>).total = 99;
    const v = validateResearch(JSON.stringify(env));
    expect(v.ok).toBe(false);
    expect(v.diagnostics.some((d) => /итоговые баллы не принимаются/.test(d.message))).toBe(true);
  });

  it('rejects non-http URLs, credentials in URLs, impossible dates, out-of-range scores and other rubric versions', () => {
    const cases: [string, (e: ReturnType<typeof base>) => void][] = [
      ['javascript url', (e) => ((e.ideas[0]!.sources as Record<string, unknown>[])[0]!.url = 'javascript:alert(1)')],
      ['credentials', (e) => ((e.ideas[0]!.sources as Record<string, unknown>[])[0]!.url = 'https://user:pw@example.org/x')],
      ['bad date', (e) => ((e.ideas[0]!.sources as Record<string, unknown>[])[0]!.observedAt = '2026-02-30')],
      ['future date', (e) => ((e.ideas[0]!.sources as Record<string, unknown>[])[0]!.observedAt = '2999-01-01')],
      ['score 6', (e) => (((e.ideas[0]!.assessment as Record<string, Record<string, unknown>>).scores!).westernNeed = 6)],
      ['missing dimension', (e) => delete ((e.ideas[0]!.assessment as Record<string, Record<string, unknown>>).scores!).retention],
      ['rubric v2', (e) => ((e.ideas[0]!.assessment as Record<string, unknown>).rubricVersion = 'v2.0')],
      ['unknown evidence ref', (e) => ((e.ideas[0]!.assessment as Record<string, unknown>).evidenceIds = ['nope'])],
      ['no evidence ref', (e) => ((e.ideas[0]!.assessment as Record<string, unknown>).evidenceIds = [])],
      ['short rationale', (e) => ((e.ideas[0]!.assessment as Record<string, unknown>).rationale = 'too short')],
      ['synthetic flag mismatch', (e) => (e.synthetic = false)],
      ['duplicate externalId', (e) => (e.ideas[1]!.externalId = e.ideas[0]!.externalId)],
      ['control characters', (e) => (e.ideas[0]!.title = 'Bad\u0007title')],
      ['bad schema version', (e) => (e.schemaVersion = 'vl-research-2')],
      ['rejected without reason', (e) => (e.ideas[0]!.stage = 'rejected')],
    ];
    for (const [name, mutate] of cases) {
      const env = base();
      mutate(env);
      const v = validateResearch(JSON.stringify(env));
      expect(v.ok, name).toBe(false);
    }
  });

  it('warns that «checked» claims without url/publisher/date will NOT be stored as verified', () => {
    const v = validateResearch(exampleFile('synthetic-run-1.json').bytes);
    expect(v.diagnostics.some((d) => d.level === 'warning' && /будет сохранён как unreviewed/.test(d.message))).toBe(true);
  });
});

describe('safe research file access', () => {
  it('reads only .json files inside research/', () => {
    expect(readResearchFile('research/examples/synthetic-run-1.json').name).toBe('synthetic-run-1.json');
    expect(() => readResearchFile('package.json')).toThrow(FileAccessError);
    expect(() => readResearchFile('research/../package.json')).toThrow(FileAccessError);
    expect(() => readResearchFile('/etc/passwd')).toThrow(FileAccessError);
    expect(() => readResearchFile('research/inbox/README.md')).toThrow(FileAccessError);
    expect(() => readResearchFile('research/inbox/missing.json')).toThrow(FileAccessError);
  });
});

// ------------------------------------------------------------- DB integration
describeDb('research import (integration, isolated schema)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await resetSchema(db.pool);
  });

  it('dry-run reports the diff but writes nothing', async () => {
    const plan = await dryRunImport(db.pool, exampleFile('synthetic-run-1.json'));
    expect(plan.status).toBe('ready');
    expect(plan.counts.ideas.inserted).toBe(4);
    expect(plan.counts.evidence.inserted).toBe(7);
    expect(plan.counts.evidence.downgraded).toBe(1);
    expect(Object.values(await counts(db.pool)).every((n) => n === 0)).toBe(true);
  });

  it('first import persists ideas, provenance, evidence, competitors, assessments and stages', async () => {
    const r = await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    expect(r.applied).toBe(true);
    const c = await counts(db.pool);
    expect(c).toMatchObject({ import_runs: 1, research_runs: 1, ideas: 4, idea_revisions: 4, evidence: 7, evidence_reviews: 7, competitors: 2, assessments: 3, stage_transitions: 4 });
    const run = await db.pool.query('SELECT checksum, origin, actor, counts FROM import_runs');
    expect(run.rows[0]).toMatchObject({ checksum: exampleFile('synthetic-run-1.json').checksum, origin: 'synthetic-test', actor: 'test-suite' });

    const ideas = await loadIdeas(db.pool);
    const inv = ideas.find((i) => i.id === 'test-invoice-reminders')!;
    expect(inv.synthetic).toBe(true);
    const w1 = inv.evidence.find((e) => e.id === 'w1')!;
    expect(w1).toMatchObject({ url: 'https://example.org/synthetic/invoice-category', publisher: 'example.org (тест)', observedAt: '2026-11-04', verificationStatus: 'unreviewed' });
    // «checked» without attribution was downgraded.
    expect(inv.evidence.find((e) => e.id === 'r2')!.verificationStatus).toBe('unreviewed');
    expect(inv.competitors.map((c) => c.name)).toEqual(['Example Invoice Tool (вымышленный)', 'Тестовый конкурент А (вымышленный)']);
    // Unscored idea stays unscored (no fabricated assessment).
    const photos = ideas.find((i) => i.id === 'test-catalog-photos')!;
    expect(photos.assessments).toEqual([]);
    expect(photos.stage).toBe('researching');
  });

  it('re-importing the exact same file is a no-op (no duplicates, no history change)', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    const before = await counts(db.pool);
    const again = await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    expect(again.status).toBe('already-imported');
    expect(again.applied).toBe(false);
    expect(await counts(db.pool)).toEqual(before);
  });

  it('same runId with different bytes is a conflict and writes nothing', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    const before = await counts(db.pool);
    const env = loadExample('synthetic-run-1.json');
    env.title = 'changed title';
    const r = await applyImport(db.pool, jsonFile(env), ACTOR);
    expect(r.status).toBe('conflict');
    expect(r.diagnostics.some((d) => /ДРУГИМ содержимым/.test(d.message))).toBe(true);
    expect(await counts(db.pool)).toEqual(before);
  });

  it('an invalid item rejects the whole file (no partial writes)', async () => {
    const env = loadExample('synthetic-run-1.json');
    (env.ideas[3]!.sources as Record<string, unknown>[])[0]!.url = 'ftp://example.org/x';
    const r = await applyImport(db.pool, jsonFile(env), ACTOR);
    expect(r.applied).toBe(false);
    expect(Object.values(await counts(db.pool)).every((n) => n === 0)).toBe(true);
  });

  it('a failure in the middle of writing rolls back everything (transaction atomicity)', async () => {
    await expect(applyImport(db.pool, exampleFile('synthetic-run-1.json'), { ...ACTOR, failAfterIdeas: 2 })).rejects.toThrow(/fault injection/);
    expect(Object.values(await counts(db.pool)).every((n) => n === 0)).toBe(true);
    // And a clean retry still works.
    expect((await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR)).applied).toBe(true);
  });

  it('a later run appends a new assessment revision, a stage transition and a review — history is preserved', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    const firstAssessments = (await db.pool.query('SELECT id, content_hash, scores FROM assessments ORDER BY id')).rows;
    const r = await applyImport(db.pool, exampleFile('synthetic-run-2.json'), ACTOR);
    expect(r.applied).toBe(true);
    expect(r.counts).toMatchObject({ ideas: { inserted: 1, unchanged: 2 }, assessments: { inserted: 2 }, rejectedIdeas: 1, evidence: { reviewsAppended: 1 } });
    const after = (await db.pool.query('SELECT id, content_hash, scores FROM assessments ORDER BY id')).rows;
    expect(after.slice(0, firstAssessments.length)).toEqual(firstAssessments);

    const ideas = await loadIdeas(db.pool);
    const inv = ideas.find((i) => i.id === 'test-invoice-reminders')!;
    expect(inv.assessments).toHaveLength(2);
    expect(inv.evidence.find((e) => e.id === 'w1')!.verificationStatus).toBe('checked');
    expect(await count(db.pool, 'evidence_reviews')).toBe(7 + 2 + 1);
    const tutor = ideas.find((i) => i.id === 'test-tutor-groups')!;
    expect(tutor.stage).toBe('rejected');
    expect(tutor.stageHistory.map((s) => s.stage)).toEqual(['scored', 'rejected']);
  });

  it('immutable records cannot be silently changed: evidence content change is a conflict', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    const env = loadExample('synthetic-run-1.json');
    env.runId = 'synthetic-example-edit';
    (env.ideas[0]!.sources as Record<string, unknown>[])[0]!.claim = 'ТЕСТ: изменённое утверждение';
    const r = await applyImport(db.pool, jsonFile(env), ACTOR);
    expect(r.status).toBe('invalid');
    expect(r.diagnostics.some((d) => /доказательства неизменяемы/.test(d.message))).toBe(true);
    expect(await count(db.pool, 'import_runs')).toBe(1);
  });

  it('rejects back-dated assessments, slug changes and mixing synthetic with real data', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);

    const back = loadExample('synthetic-run-1.json');
    back.runId = 'synthetic-backdated';
    const a = back.ideas[0]!.assessment as Record<string, unknown>;
    a.assessedAt = '2026-10-01';
    a.rationale = 'Ревизия задним числом — должна быть отклонена импортом.';
    expect((await applyImport(db.pool, jsonFile(back), ACTOR)).diagnostics.some((d) => /раньше последней сохранённой/.test(d.message))).toBe(true);

    const slug = loadExample('synthetic-run-1.json');
    slug.runId = 'synthetic-slug';
    slug.ideas[0]!.slug = 'another-slug';
    expect((await applyImport(db.pool, jsonFile(slug), ACTOR)).diagnostics.some((d) => /slug нельзя менять/.test(d.message))).toBe(true);

    const real = loadExample('synthetic-run-1.json');
    real.runId = 'real-mix';
    real.source = 'human-reviewed';
    real.synthetic = false;
    const r = await applyImport(db.pool, jsonFile(real), ACTOR);
    expect(r.applied).toBe(false);
    expect(r.diagnostics.some((d) => /смешивать синтетические и реальные/.test(d.message))).toBe(true);
    expect(await count(db.pool, 'import_runs')).toBe(1);
  });

  it('data survives a restart (new connection pool)', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    const fresh = db.reconnect();
    expect((await loadIdeas(fresh)).map((i) => i.id).sort()).toEqual(['test-catalog-photos', 'test-contract-clauses', 'test-invoice-reminders', 'test-tutor-groups']);
  });
});
