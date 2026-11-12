// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { demoData } from '../../src/data/demo';
import { fullRanking } from '../../src/domain/selectors';
import { evidenceConfidence, latestAssessment, marketScore, rankIdeas } from '../../src/domain/scoring';
import { resetSchema } from '../db/migrate';
import { applyImport } from '../research/importer';
import { loadDataset, loadIdeas, loadSnapshot } from '../research/repository';
import { createSnapshot } from '../research/snapshot';
import { ACTOR, createTestDb, describeDb, exampleFile, jsonFile, loadExample, type TestDb } from './helpers';

const TODAY = '2026-11-12';

/** The VL-001 DEMO fixture expressed as a synthetic vl-research-1 import (latest assessment per idea). */
function demoAsEnvelope() {
  return {
    schemaVersion: 'vl-research-1',
    runId: 'synthetic-demo-fixture-consistency',
    researchedAt: '2026-11-12',
    source: 'synthetic-test',
    synthetic: true,
    reviewedBy: 'consistency-test',
    ideas: demoData.ideas.map((i) => {
      const a = latestAssessment(i)!;
      return {
        externalId: i.slug,
        title: i.title,
        pitch: i.shortPitch,
        segment: i.segment,
        category: i.category,
        riskFlags: i.riskFlags,
        stage: i.stage,
        stageReason: i.stage === 'rejected' ? 'consistency test' : undefined,
        sources: [{ id: 's1', region: 'west', claim: 'synthetic placeholder claim', verificationStatus: 'unreviewed' }],
        assessment: {
          assessedAt: a.assessedAt,
          assessor: a.assessor,
          rubricVersion: 'v1.0',
          scores: a.scores,
          confidence: a.confidence,
          founderFit: i.founderFit,
          rationale: a.reason.padEnd(20, '.'),
          evidenceIds: ['s1'],
        },
      };
    }),
  };
}

describeDb('scores, ranking and immutable snapshots (integration)', () => {
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

  it('REAL scores and ranking match the unchanged VL-001 rubric for identical components', async () => {
    const r = await applyImport(db.pool, jsonFile(demoAsEnvelope()), ACTOR);
    expect(r.applied).toBe(true);
    const real = await loadIdeas(db.pool);
    for (const demo of demoData.ideas) {
      const ri = real.find((x) => x.slug === demo.slug)!;
      const da = latestAssessment(demo)!;
      expect(marketScore(latestAssessment(ri)!.scores), demo.slug).toBe(marketScore(da.scores));
      expect(evidenceConfidence(latestAssessment(ri)!.confidence)).toBe(evidenceConfidence(da.confidence));
    }
    // Same order as ranking the fixture's current state (latest assessment + current stage).
    const demoOrder = rankIdeas(demoData.ideas).map((s) => s.idea.slug);
    const realOrder = rankIdeas(real, TODAY).map((s) => s.idea.slug);
    expect(realOrder).toEqual(demoOrder);
    // And the DEMO current ranking (VL-001 unit-tested) has the same order too.
    expect(fullRanking(demoData).map((e) => e.idea.slug)).toEqual(demoOrder);
  });

  it('unscored ideas are never ranked and never shown as 0', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    const data = await loadDataset(db.pool, TODAY);
    const ranked = fullRanking(data).map((e) => e.idea.id);
    expect(ranked).not.toContain('test-catalog-photos');
    expect(ranked).toHaveLength(3);
  });

  it('snapshot is explicit, idempotent and conflicts on a second id for the same date', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    const dry = await createSnapshot(db.pool, { asOf: '2026-11-06', apply: false, actor: 't', today: TODAY });
    expect(dry.status).toBe('ready');
    expect(await loadSnapshot(db.pool, { id: 'top10-2026-11-06' })).toBeNull();

    const s1 = await createSnapshot(db.pool, { asOf: '2026-11-06', apply: true, actor: 't', today: TODAY });
    expect(s1.applied).toBe(true);
    expect(s1.entries.map((e) => e.ideaId)).toEqual(['test-invoice-reminders', 'test-tutor-groups', 'test-contract-clauses']);
    expect((await createSnapshot(db.pool, { asOf: '2026-11-06', apply: true, actor: 't', today: TODAY })).status).toBe('exists');
    expect((await createSnapshot(db.pool, { asOf: '2026-11-06', id: 'other-id', apply: true, actor: 't', today: TODAY })).status).toBe('conflict');
    expect((await createSnapshot(db.pool, { asOf: '2026-12-01', apply: true, actor: 't', today: TODAY })).status).toBe('invalid');
    expect((await createSnapshot(db.pool, { asOf: '2026-11-01', apply: true, actor: 't', today: TODAY })).status).toBe('empty');
  });

  it('a later reassessment and rejection never rewrite a stored snapshot; movement uses the stored snapshot', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    await createSnapshot(db.pool, { asOf: '2026-11-06', apply: true, actor: 't', today: TODAY });
    const before = await loadSnapshot(db.pool, { id: 'top10-2026-11-06' });

    await applyImport(db.pool, exampleFile('synthetic-run-2.json'), ACTOR); // reassess + reject + new idea
    const after = await loadSnapshot(db.pool, { id: 'top10-2026-11-06' });
    expect(after).toEqual(before);
    expect(after!.entries.map((e) => [e.rank, e.ideaId, e.score])).toEqual([
      [1, 'test-invoice-reminders', 73],
      [2, 'test-tutor-groups', 71],
      [3, 'test-contract-clauses', 64],
    ]);

    // Current ranking vs the stored baseline: rejected idea gone, new idea «new», reassessed idea +2.
    const data = await loadDataset(db.pool, TODAY);
    expect(data.baseline).toMatchObject({ kind: 'stored', snapshotId: 'top10-2026-11-06' });
    const now = fullRanking(data);
    expect(now.map((e) => e.idea.id)).toEqual(['test-invoice-reminders', 'test-coffee-waste', 'test-contract-clauses']);
    expect(now[0]).toMatchObject({ score: 75, scoreDelta: 2, movement: { kind: 'same', previousRank: 1 } });
    expect(now[1]!.movement).toEqual({ kind: 'new' });
    expect(now[2]!.movement).toEqual({ kind: 'same', previousRank: 3 });

    // A snapshot for a date before the second run still reflects the first run (as-of semantics).
    const s = await createSnapshot(db.pool, { asOf: '2026-11-07', apply: true, actor: 't', today: TODAY });
    expect(s.entries.map((e) => e.ideaId)).toEqual(['test-invoice-reminders', 'test-tutor-groups', 'test-contract-clauses']);
  });

  it('no stored snapshot → no movement is claimed', async () => {
    await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR);
    const data = await loadDataset(db.pool, TODAY);
    expect(data.baseline).toBeNull();
    expect(fullRanking(data).every((e) => e.movement.kind === 'none')).toBe(true);
  });

  it('an empty database yields an honest empty dataset', async () => {
    const data = await loadDataset(db.pool, TODAY);
    expect(data).toMatchObject({ mode: 'real', ideas: [], researchRuns: [], experiments: [], builds: [], activity: [], baseline: null });
  });

  it('rejects inconsistent rubric versions at the import boundary', async () => {
    const env = loadExample('synthetic-run-1.json');
    env.runId = 'synthetic-rubric-v2';
    (env.ideas[0]!.assessment as Record<string, unknown>).rubricVersion = 'v2.0';
    const r = await applyImport(db.pool, jsonFile(env), ACTOR);
    expect(r.applied).toBe(false);
    expect(r.diagnostics.some((d) => /рубрика v1.0/.test(d.message))).toBe(true);
  });
});
