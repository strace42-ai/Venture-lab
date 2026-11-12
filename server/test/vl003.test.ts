// @vitest-environment node
/**
 * VL-003 integration tests: approval gate, manual evidence review (append-only, idempotent,
 * isolated, atomic), research journal, evidence queue API, stored-snapshot comparison API and the
 * draft-check helper. Runs against an isolated PostgreSQL schema (TEST_DATABASE_URL).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../api/app';
import type { Pool } from '../db/pool';
import { checkDraft } from '../research/draft';
import { RESEARCH_ROOT } from '../research/files';
import { applyGate, applyImport, validateResearch } from '../research/importer';
import { loadJournal } from '../research/journal';
import { createSnapshot } from '../research/snapshot';
import { reviewEvidence } from '../research/review';
import { ACTOR, count, counts, createTestDb, describeDb, envelope, exampleFile, ideaJson, jsonFile, uniformScores as uniformScoresForTest, type TestDb } from './helpers';

const TODAY = '2026-11-12';

function aiDraft(ideas: unknown[], runId = 'draft-test-001') {
  const env = envelope(runId, '2026-11-10', ideas) as Record<string, unknown>;
  delete env.approval;
  return { ...env, source: 'ai-draft', synthetic: false };
}

/** An idea whose single source is unreviewed (allowed in ai-draft). */
function draftIdea(id: string) {
  const i = ideaJson(id, { assessment: false });
  return { ...i, sources: [{ id: 's1', region: 'west', claim: `claim ${id}`, url: `https://example.org/${id}`, publisher: 'example.org', observedAt: '2026-11-01' }] };
}

// ------------------------------------------------------------------ pure (no DB)

describe('applyGate (founder approval)', () => {
  const parse = (o: unknown) => validateResearch(JSON.stringify(o)).envelope;

  it('blocks ai-draft, files in research/drafts and unapproved human-reviewed files', () => {
    const draft = parse(aiDraft([draftIdea('gate-a')]));
    expect(draft).not.toBeNull();
    expect(applyGate(draft, {}).allowed).toBe(false);

    const unapproved = envelope('gate-run-1', '2026-11-10', [ideaJson('gate-b')]) as Record<string, unknown>;
    delete unapproved.approval;
    const g = applyGate(parse(unapproved), {});
    expect(g.allowed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/approval/);

    const approved = parse(envelope('gate-run-2', '2026-11-10', [ideaJson('gate-c')]));
    expect(applyGate(approved, {}).allowed).toBe(true);
    expect(applyGate(approved, { path: '/x/research/drafts/a.json' }).allowed).toBe(false);
    expect(applyGate(approved, { path: '/x/research/inbox/a.json' }).allowed).toBe(true);

    const synthetic = parse(envelope('gate-run-3', '2026-11-10', [ideaJson('gate-d')], true));
    expect(applyGate(synthetic, {}).allowed).toBe(true);
    expect(applyGate(null, {}).allowed).toBe(false);
  });

  it('schema: an ai-draft cannot mark its own sources checked; approval date cannot be in the future', () => {
    const bad = aiDraft([ideaJson('self-verified', { assessment: false })]); // source is "checked" + reviewedBy
    const v = validateResearch(JSON.stringify(bad));
    expect(v.ok).toBe(false);
    expect(v.diagnostics.some((d) => /AI-черновик/.test(d.message))).toBe(true);

    const future = envelope('future-approval', '2026-11-10', [ideaJson('fa')]) as { approval: { approvedAt: string } };
    future.approval.approvedAt = '2999-01-01';
    expect(validateResearch(JSON.stringify(future)).ok).toBe(false);
  });
});

describe('draft-check helper (no DB)', () => {
  it('reports structure/coverage and never claims truth', async () => {
    const r = await checkDraft(JSON.stringify(aiDraft([draftIdea('dc-one'), { ...draftIdea('dc-two'), sources: [] }])));
    expect(r.ok).toBe(false); // an idea without sources is an error, but the file itself parsed
    expect(r.source).toBe('ai-draft');
    expect(r.verdict).toBe('needs-work');
    const two = r.ideas.find((i) => i.externalId === 'dc-two')!;
    expect(two.findings.some((f) => f.level === 'error' && /нет ни одного источника/.test(f.message))).toBe(true);
    const one = r.ideas.find((i) => i.externalId === 'dc-one')!;
    expect(one.findings.some((f) => /РФ|российск/i.test(f.message))).toBe(true);
    expect(r.nextSteps.join(' ')).toMatch(/human-reviewed/);
  });

  it('warns (does not fail) on duplicate source URLs', async () => {
    const a = draftIdea('dup-a');
    const b = { ...draftIdea('dup-b'), sources: [{ ...draftIdea('dup-b').sources[0]!, url: 'https://www.example.org/dup-a/' }] };
    const r = await checkDraft(JSON.stringify(aiDraft([a, b])));
    const all = [...r.findings, ...r.ideas.flatMap((i) => i.findings)];
    expect(all.some((f) => f.level === 'warning' && /повтор|дубл/i.test(f.message))).toBe(true);
    expect(all.some((f) => f.level === 'error' && /повтор|дубл/i.test(f.message))).toBe(false);
  });

  it('invalid JSON → verdict invalid', async () => {
    const r = await checkDraft('{"schemaVersion":"vl-research-1"');
    expect(r.verdict).toBe('invalid');
    expect(r.ok).toBe(false);
  });

  it('the committed pilot draft is a valid ai-draft that the importer refuses to apply', async () => {
    const path = join(RESEARCH_ROOT, 'drafts', 'draft-2026-11-12-pilot-001.json');
    const bytes = readFileSync(path);
    const r = await checkDraft(bytes);
    expect(r.ok).toBe(true);
    expect(r.source).toBe('ai-draft');
    const env = validateResearch(bytes).envelope!;
    // Every source unreviewed, no AI self-scoring.
    expect(env.ideas.every((i) => i.sources.every((s) => s.verificationStatus === 'unreviewed' && !s.reviewedBy))).toBe(true);
    expect(env.ideas.every((i) => !i.assessment)).toBe(true);
    expect(applyGate(env, { path }).allowed).toBe(false);
  });
});

// ------------------------------------------------------------------ database

describeDb('VL-003 approval gate (integration)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('ai-draft and unapproved REAL files are blocked and write nothing', async () => {
    const before = await counts(db.pool);
    const d = await applyImport(db.pool, jsonFile(aiDraft([draftIdea('blocked-a')])), ACTOR);
    expect(d.status).toBe('blocked');
    expect(d.applied).toBe(false);

    const unapproved = envelope('unapproved-run', '2026-11-10', [ideaJson('blocked-b')]) as Record<string, unknown>;
    delete unapproved.approval;
    const u = await applyImport(db.pool, jsonFile(unapproved), ACTOR);
    expect(u.status).toBe('blocked');

    const inDrafts = await applyImport(db.pool, { ...jsonFile(envelope('drafts-run', '2026-11-10', [ideaJson('blocked-c')])), path: join(RESEARCH_ROOT, 'drafts', 'x.json') }, ACTOR);
    expect(inDrafts.status).toBe('blocked');
    expect(await counts(db.pool)).toEqual(before);
  });

  it('an approved REAL import stores the approval; a checked source without reviewedBy is stored unreviewed', async () => {
    const idea = ideaJson('approved-a');
    const noReviewer = { ...idea, sources: [{ ...idea.sources[0]!, reviewedBy: undefined }] };
    const r = await applyImport(db.pool, jsonFile(envelope('approved-run', '2026-11-10', [noReviewer])), ACTOR);
    expect(r.applied).toBe(true);
    expect(r.diagnostics.some((x) => x.level === 'warning' && /reviewedBy|проверил/i.test(x.message))).toBe(true);
    const run = await db.pool.query('SELECT approved_by, approved_at, approval_statement FROM import_runs WHERE run_id = $1', ['approved-run']);
    expect(run.rows[0]).toMatchObject({ approved_by: 'founder (test)', approval_statement: expect.stringMatching(/Approved/) });
    const st = await db.pool.query(`SELECT r.status, r.origin FROM evidence_reviews r JOIN evidence e ON e.id = r.evidence_id JOIN ideas i ON i.id = e.idea_id WHERE i.external_id = 'approved-a'`);
    expect(st.rows).toEqual([{ status: 'unreviewed', origin: 'import' }]);
  });

  it('DB constraint: a human-reviewed import run cannot be inserted without approval', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO import_runs (run_id, checksum, schema_version, file_name, origin, actor, counts, diagnostics, started_at)
         VALUES ('raw-unapproved', 'x', 'vl-research-1', 'x.json', 'human-reviewed', 'raw', '{}', '[]', now())`,
      ),
    ).rejects.toThrow();
  });
});

describeDb('research:review (integration)', () => {
  let db: TestDb;
  const req = (o: Record<string, unknown> = {}) => ({ dataset: 'test', ideaId: 'rev-a', evidenceId: 's1', status: 'rejected', reason: 'Страница не содержит этого утверждения', actor: 'founder', ...o });
  const reviewsOf = async (ext: string) =>
    (await db.pool.query<{ status: string; origin: string; actor: string | null; reason: string | null }>(
      `SELECT r.status, r.origin, r.actor, r.reason FROM evidence_reviews r JOIN evidence e ON e.id = r.evidence_id JOIN ideas i ON i.id = e.idea_id WHERE i.external_id = $1 AND e.external_id = 's1' ORDER BY r.id`,
      [ext],
    )).rows;

  beforeAll(async () => {
    db = await createTestDb();
    const noUrl = ideaJson('rev-nourl', { assessment: false });
    await applyImport(db.pool, jsonFile(envelope('rev-test-1', '2026-11-01', [ideaJson('rev-a'), { ...noUrl, sources: [{ id: 's1', region: 'ru', claim: 'no url claim' }] }], true)), ACTOR);
    await applyImport(db.pool, jsonFile(envelope('rev-real-1', '2026-11-01', [ideaJson('rev-real')])), ACTOR);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('dry-run shows the plan and writes nothing', async () => {
    const before = await count(db.pool, 'evidence_reviews');
    const p = await reviewEvidence(db.pool, req(), { apply: false });
    expect(p.status).toBe('ready');
    expect(p.applied).toBe(false);
    expect(p.evidence).toMatchObject({ ideaId: 'rev-a', evidenceId: 's1', currentStatus: 'checked' });
    expect(await count(db.pool, 'evidence_reviews')).toBe(before);
  });

  it('apply appends exactly one manual event; the claim is untouched; repeating is a no-op', async () => {
    const claimBefore = (await db.pool.query(`SELECT e.claim, e.content_hash FROM evidence e JOIN ideas i ON i.id = e.idea_id WHERE i.external_id = 'rev-a'`)).rows[0];
    const p = await reviewEvidence(db.pool, req(), { apply: true });
    expect(p.applied).toBe(true);
    const rows = await reviewsOf('rev-a');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'checked', origin: 'import' });
    expect(rows[1]).toEqual({ status: 'rejected', origin: 'manual', actor: 'founder', reason: 'Страница не содержит этого утверждения' });
    expect((await db.pool.query(`SELECT e.claim, e.content_hash FROM evidence e JOIN ideas i ON i.id = e.idea_id WHERE i.external_id = 'rev-a'`)).rows[0]).toEqual(claimBefore);

    const again = await reviewEvidence(db.pool, req(), { apply: true });
    expect(again.status).toBe('unchanged');
    expect(again.applied).toBe(false);
    expect(await reviewsOf('rev-a')).toHaveLength(2);
    expect(again.evidence!.history.map((h) => h.status)).toEqual(['checked', 'rejected']);
  });

  it('review history is append-only at the database level', async () => {
    await expect(db.pool.query("UPDATE evidence_reviews SET status = 'checked' WHERE origin = 'manual'")).rejects.toThrow();
    await expect(db.pool.query("DELETE FROM evidence_reviews WHERE origin = 'manual'")).rejects.toThrow();
    await expect(
      db.pool.query("INSERT INTO evidence_reviews (evidence_id, status, origin, actor, reason) SELECT id, 'checked', 'manual', 'x', 'short' FROM evidence LIMIT 1"),
    ).rejects.toThrow(); // reason < 10 chars violates the origin-shape check
  });

  it('rejects invalid input, unknown evidence and unattributed checked', async () => {
    const before = await count(db.pool, 'evidence_reviews');
    expect((await reviewEvidence(db.pool, req({ reason: 'коротко' }), { apply: true })).status).toBe('invalid');
    expect((await reviewEvidence(db.pool, req({ status: 'verified' }), { apply: true })).status).toBe('invalid');
    expect((await reviewEvidence(db.pool, req({ dataset: 'demo' }), { apply: true })).status).toBe('invalid');
    expect((await reviewEvidence(db.pool, req({ actor: '' }), { apply: true })).status).toBe('invalid');
    expect((await reviewEvidence(db.pool, req({ extra: 1 }), { apply: true })).status).toBe('invalid');
    expect((await reviewEvidence(db.pool, req({ evidenceId: 'nope' }), { apply: true })).status).toBe('not-found');
    const unattributed = await reviewEvidence(db.pool, req({ ideaId: 'rev-nourl', status: 'checked' }), { apply: true });
    expect(unattributed.status).toBe('invalid');
    expect(unattributed.message).toMatch(/атрибуц/);
    // …but an unattributed claim can be rejected.
    expect((await reviewEvidence(db.pool, req({ ideaId: 'rev-nourl', status: 'rejected' }), { apply: false })).status).toBe('ready');
    expect(await count(db.pool, 'evidence_reviews')).toBe(before);
  });

  it('cross-dataset review is rejected in both directions', async () => {
    const a = await reviewEvidence(db.pool, req({ dataset: 'real' }), { apply: true });
    expect(a.status).toBe('invalid');
    expect(a.message).toMatch(/набор/);
    const b = await reviewEvidence(db.pool, req({ dataset: 'test', ideaId: 'rev-real' }), { apply: true });
    expect(b.status).toBe('invalid');
    expect((await reviewEvidence(db.pool, req({ dataset: 'real', ideaId: 'rev-real' }), { apply: false })).status).toBe('ready');
  });

  it('rolls back when the write fails mid-transaction', async () => {
    const before = await count(db.pool, 'evidence_reviews');
    const failing: Pool = {
      ...db.pool,
      connect: async () => {
        const c = await db.pool.connect();
        const q = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
        return new Proxy(c, {
          get(t, p) {
            if (p === 'query')
              return async (...a: unknown[]) => {
                const r = await q(...a);
                if (typeof a[0] === 'string' && a[0].startsWith('INSERT INTO evidence_reviews')) throw new Error('injected failure');
                return r;
              };
            const v = Reflect.get(t, p);
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      },
    } as unknown as Pool;
    await expect(reviewEvidence(failing, req({ status: 'unreviewed' }), { apply: true })).rejects.toThrow(/injected/);
    expect(await count(db.pool, 'evidence_reviews')).toBe(before);
  });

  it('a later import never overrides a manual review', async () => {
    // rev-a/s1 is manually rejected. A new run re-asserts it as checked (with reviewer).
    const r = await applyImport(db.pool, jsonFile(envelope('rev-test-2', '2026-11-05', [ideaJson('rev-a', { assessment: false })], true)), ACTOR);
    expect(r.applied).toBe(true);
    const rows = await reviewsOf('rev-a');
    expect(rows[rows.length - 1]).toMatchObject({ status: 'rejected', origin: 'manual' });
  });

  it('the journal lists the manual review with its previous status (TEST only)', async () => {
    const test = await loadJournal(db.pool, 'test', TODAY);
    const m = test.manualReviews.find((x) => x.idea.id === 'rev-a' || x.idea.slug === 'rev-a');
    expect(m).toMatchObject({ status: 'rejected', previousStatus: 'checked', actor: 'founder', evidenceId: 's1' });
    const real = await loadJournal(db.pool, 'real', TODAY);
    expect(real.manualReviews).toEqual([]);
    expect(real.runs.map((x) => x.id)).toEqual(['rev-real-1']);
    expect(test.runs.map((x) => x.id).sort()).toEqual(['rev-test-1', 'rev-test-2']);
  });
});

describeDb('journal + evidence + snapshot APIs (integration)', () => {
  let db: TestDb;
  let app: FastifyInstance;
  const get = async (url: string) => app.inject({ method: 'GET', url });

  beforeAll(async () => {
    db = await createTestDb();
    app = await buildApp({ pool: db.pool, today: () => TODAY });
    // Run 1: three scored ideas.
    await applyImport(
      db.pool,
      jsonFile(envelope('cmp-run-1', '2026-11-01', [ideaJson('cmp-a', { score: 4 }), ideaJson('cmp-b', { score: 3, title: 'Старое имя B' }), ideaJson('cmp-c', { score: 2 })], true)),
      ACTOR,
    );
    await createSnapshot(db.pool, { asOf: '2026-11-02', apply: true, actor: 'test', today: TODAY, dataset: 'test' });
    // Run 2: new idea D on top, B renamed + downgraded, C rejected.
    await applyImport(
      db.pool,
      jsonFile(
        envelope(
          'cmp-run-2',
          '2026-11-05',
          [
            ideaJson('cmp-d', { score: 5, assessedAt: '2026-11-05' }),
            ideaJson('cmp-b', { score: 1, assessedAt: '2026-11-05', title: 'Новое имя B' }),
            ideaJson('cmp-c', { assessment: false, extra: { stage: 'rejected', stageReason: 'Проверка показала отсутствие спроса' } }),
          ],
          true,
        ),
      ),
      ACTOR,
    );
    await createSnapshot(db.pool, { asOf: '2026-11-06', apply: true, actor: 'test', today: TODAY, dataset: 'test' });
    // A REAL idea, to prove isolation.
    await applyImport(db.pool, jsonFile(envelope('cmp-real-1', '2026-11-03', [ideaJson('cmp-real', { score: 5 })])), ACTOR);
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('/api/journal derives per-run changes from stored history', async () => {
    const res = await get('/api/journal?dataset=test');
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.mode).toBe('test');
    const [r2, r1] = j.runs;
    expect(r2.id).toBe('cmp-run-2');
    expect(r1.id).toBe('cmp-run-1');
    expect(r1.counts).toMatchObject({ ideasCreated: 3, ideasUpdated: 0, assessmentsAdded: 3, rejected: 0, evidenceAdded: 3 });
    // «updated» = descriptive fields changed (B's title); C only changed stage → counted as rejected.
    expect(r2.counts).toMatchObject({ ideasCreated: 1, ideasUpdated: 1, assessmentsAdded: 2, rejected: 1, stageChanges: 1 });
    const b = r2.ideas.find((i: { ideaId: string; slug: string }) => i.slug === 'cmp-b');
    expect(b.updatedFields).toContain('title');
    expect(b.assessmentAdded).toBe(true);
    expect(b.assessmentScore).toBe(20);
    const c = r2.ideas.find((i: { slug: string }) => i.slug === 'cmp-c');
    expect(c.stage).toMatchObject({ to: 'rejected', reason: expect.stringMatching(/спроса/) });
    expect(r2.approval).toBeNull(); // synthetic runs carry no founder approval

    const real = (await get('/api/journal?dataset=real')).json();
    expect(real.runs.map((r: { id: string }) => r.id)).toEqual(['cmp-real-1']);
    expect(real.runs[0].approval).toMatchObject({ by: 'founder (test)' });
    expect((await get('/api/journal?dataset=demo')).statusCode).toBe(400);
  });

  it('/api/evidence filters, paginates and validates', async () => {
    const all = (await get('/api/evidence?dataset=test&status=all')).json();
    expect(all.totalAll).toBe(all.total);
    expect(all.rows.every((r: { idea: { slug: string } }) => r.idea.slug.startsWith('cmp-'))).toBe(true);
    expect(all.rows.some((r: { idea: { slug: string } }) => r.idea.slug === 'cmp-real')).toBe(false);
    const checked = (await get('/api/evidence?dataset=test&status=checked')).json();
    expect(checked.total).toBe(all.counts.checked);
    const needs = (await get('/api/evidence?dataset=test')).json();
    expect(needs.total).toBe(all.counts.unreviewed + all.counts.unattributed);
    const one = (await get('/api/evidence?dataset=test&status=all&idea=cmp-a')).json();
    expect(one.total).toBe(1);
    const paged = (await get('/api/evidence?dataset=test&status=all&pageSize=1&page=2')).json();
    expect(paged.rows).toHaveLength(1);
    expect(paged.page).toBe(2);
    expect((await get('/api/evidence?dataset=test&status=all&missingUrl=true')).json().total).toBe(0);
    expect((await get('/api/evidence?dataset=test&status=all&market=ru')).json().total).toBe(0);
    expect((await get('/api/evidence?dataset=test&status=all&minAgeDays=365')).json().total).toBe(0);
    for (const bad of ['status=verified', 'pageSize=1000', 'page=0', 'market=eu', 'missingUrl=yes', 'dataset=demo', 'dimension=nope']) {
      expect((await get(`/api/evidence?dataset=test&${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it('/api/snapshots lists only the requested dataset', async () => {
    const t = (await get('/api/snapshots?dataset=test')).json();
    expect(t.snapshots.map((s: { asOf: string }) => s.asOf).sort()).toEqual(['2026-11-02', '2026-11-06']);
    expect((await get('/api/snapshots?dataset=real')).json().snapshots).toEqual([]);
  });

  it('/api/snapshots/compare uses frozen entries: entered, exited, moved, frozen titles, swap', async () => {
    const ids = (await get('/api/snapshots?dataset=test')).json().snapshots.map((s: { id: string; asOf: string }) => s);
    const early = ids.find((s: { asOf: string }) => s.asOf === '2026-11-02').id;
    const late = ids.find((s: { asOf: string }) => s.asOf === '2026-11-06').id;
    const res = await get(`/api/snapshots/compare?dataset=test&a=${late}&b=${early}`);
    expect(res.statusCode).toBe(200);
    const cmp = res.json();
    expect(cmp.swapped).toBe(true);
    expect(cmp.a.asOf).toBe('2026-11-02');
    const row = (slug: string) => cmp.rows.find((r: { slug: string }) => r.slug === slug);
    expect(row('cmp-d')).toMatchObject({ change: 'entered', detail: 'new-in-ranking', rankA: null, rankB: 1 });
    expect(row('cmp-c')).toMatchObject({ change: 'exited', detail: 'left-ranking', rankB: null });
    expect(row('cmp-b')).toMatchObject({ change: 'down', titleA: 'Старое имя B', titleB: 'Новое имя B', scoreA: 60, scoreB: 20, scoreDelta: -40 });
    expect(row('cmp-a')).toMatchObject({ change: 'down', rankA: 1, rankB: 2, scoreDelta: 0 });
    expect(cmp.summary).toEqual({ entered: 1, exited: 1, up: 0, down: 2, same: 0 });
    expect(cmp.topA).toBe(3);
    expect(cmp.topB).toBe(3); // N/10 — never padded

    // Frozen: a later rename does not change the stored snapshot titles.
    await applyImport(db.pool, jsonFile(envelope('cmp-run-3', '2026-11-08', [ideaJson('cmp-b', { assessment: false, title: 'Третье имя B' })], true)), ACTOR);
    const again = (await get(`/api/snapshots/compare?dataset=test&a=${early}&b=${late}`)).json();
    expect(again.swapped).toBe(false);
    expect(again.rows.find((r: { slug: string }) => r.slug === 'cmp-b')).toMatchObject({ titleA: 'Старое имя B', titleB: 'Новое имя B' });
  });

  it('/api/snapshots/compare rejects same ids, other-dataset ids and unknown ids', async () => {
    const [s] = (await get('/api/snapshots?dataset=test')).json().snapshots;
    expect((await get(`/api/snapshots/compare?dataset=test&a=${s.id}&b=${s.id}`)).statusCode).toBe(400);
    expect((await get(`/api/snapshots/compare?dataset=real&a=${s.id}&b=nope-snapshot`)).statusCode).toBe(404);
    expect((await get(`/api/snapshots/compare?dataset=test&a=${s.id}&b=nope-snapshot`)).statusCode).toBe(404);
    expect((await get('/api/snapshots/compare?dataset=test&a=x')).statusCode).toBe(400);
    const realSnap = await createSnapshot(db.pool, { asOf: '2026-11-04', apply: true, actor: 'test', today: TODAY, dataset: 'real' });
    expect(realSnap.applied).toBe(true);
    // A REAL snapshot id is not visible through the TEST dataset.
    expect((await get(`/api/snapshots/compare?dataset=test&a=${s.id}&b=${realSnap.id}`)).statusCode).toBe(404);
  });
});

describeDb('full TEST import scenario is reproducible (examples)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('run 1 → snapshot → run 2 → snapshot → journal shows both runs, compare works', async () => {
    expect((await applyImport(db.pool, exampleFile('synthetic-run-1.json'), ACTOR)).applied).toBe(true);
    const s1 = await createSnapshot(db.pool, { asOf: '2026-11-06', apply: true, actor: 'test', today: TODAY, dataset: 'test' });
    expect((await applyImport(db.pool, exampleFile('synthetic-run-2.json'), ACTOR)).applied).toBe(true);
    const s2 = await createSnapshot(db.pool, { asOf: '2026-11-11', apply: true, actor: 'test', today: TODAY, dataset: 'test' });
    expect(s1.applied && s2.applied).toBe(true);
    const j = await loadJournal(db.pool, 'test', TODAY);
    expect(j.runs).toHaveLength(2);
    expect(j.runs.every((r) => r.synthetic)).toBe(true);
    expect((await loadJournal(db.pool, 'real', TODAY)).runs).toEqual([]);
  });
});

describeDb('evidence integrity: a rejected cited source blocks the recommendation (integration)', () => {
  let db: TestDb;
  let app: FastifyInstance;
  const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
  const strongAssessment = (assessedAt: string, evidenceIds: string[], revisionReason?: string) => ({
    assessedAt,
    assessor: 'founder (test)',
    rubricVersion: 'v1.0',
    scores: uniformScoresForTest(5),
    confidence: { completeness: 80, corroboration: 80, recency: 80, reliability: 80, russiaValidation: 80 },
    rationale: 'Сильная оценка, опирающаяся на один проверенный источник.',
    evidenceIds,
    ...(revisionReason ? { revisionReason } : {}),
  });
  const src = (id: string) => ({ id, region: 'west', claim: `claim ${id}`, url: `https://example.org/int/${id}`, publisher: 'example.org', observedAt: '2026-11-01', verificationStatus: 'checked', reviewedBy: 'founder (human)' });

  beforeAll(async () => {
    db = await createTestDb();
    app = await buildApp({ pool: db.pool, today: () => TODAY });
    await applyImport(
      db.pool,
      jsonFile(
        envelope('int-run-1', '2026-11-01', [
          { ...ideaJson('int-lead'), sources: [src('s1')], assessment: strongAssessment('2026-11-01', ['s1']) },
          // Second idea: lower score, its cited source is only unreviewed → weak, but NOT excluded.
          { ...ideaJson('int-second', { score: 4 }), sources: [{ ...src('s1'), verificationStatus: 'unreviewed', reviewedBy: undefined }], assessment: { ...strongAssessment('2026-11-01', ['s1']), scores: uniformScoresForTest(4) } },
        ]),
      ),
      ACTOR,
    );
    await createSnapshot(db.pool, { asOf: '2026-11-02', apply: true, actor: 'test', today: TODAY, dataset: 'real' });
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('before rejection: the lead is recommended and counted as a strong, substantiated idea', async () => {
    const o = await get('/api/overview');
    expect(o.lead.idea.slug).toBe('int-lead');
    expect(o.ranking[0].integrity).toMatchObject({ status: 'verified', rejected: [] });
    expect(o.ranking[1].integrity).toMatchObject({ status: 'unverified', unverified: ['s1'] });
    expect(o.kpis).toMatchObject({ highConfidenceLeads: 2, assessmentsNeedingReview: 0 });
  });

  it('after a manual rejection: flagged with concrete ids, not recommended; score, assessments and snapshot unchanged', async () => {
    const snapBefore = (await db.pool.query('SELECT * FROM top10_entries ORDER BY rank')).rows;
    const assessmentsBefore = await count(db.pool, 'assessments');
    const scoreBefore = (await get('/api/overview')).ranking[0].score;

    const r = await reviewEvidence(db.pool, { dataset: 'real', ideaId: 'int-lead', evidenceId: 's1', status: 'rejected', reason: 'На странице нет этого утверждения', actor: 'founder' }, { apply: true });
    expect(r.applied).toBe(true);

    const o = await get('/api/overview');
    const lead = o.ranking.find((e: { idea: { slug: string } }) => e.idea.slug === 'int-lead');
    expect(lead.integrity).toMatchObject({ status: 'needs-review', rejected: ['s1'] });
    expect(lead.score).toBe(scoreBefore); // the rubric is not silently changed
    expect(lead.rank).toBe(1); // still visible in the ranking, with a flag
    expect(o.lead.idea.slug).toBe('int-second'); // unreviewed ≠ refuted: the next idea is recommended
    expect(o.kpis).toMatchObject({ highConfidenceLeads: 1, assessmentsNeedingReview: 1 });
    const detail = await get('/api/ideas/int-lead');
    expect(detail.entry.integrity.status).toBe('needs-review');
    const top = await get('/api/top10');
    expect(top.current[0].integrity.status).toBe('needs-review');

    expect(await count(db.pool, 'assessments')).toBe(assessmentsBefore);
    expect((await db.pool.query('SELECT * FROM top10_entries ORDER BY rank')).rows).toEqual(snapBefore);
  });

  it('a new assessment revision that does not rely on the rejected source lifts the block (history kept)', async () => {
    await applyImport(
      db.pool,
      jsonFile(
        envelope('int-run-2', '2026-11-05', [
          { ...ideaJson('int-lead', { assessment: false }), sources: [src('s2')], assessment: strongAssessment('2026-11-05', ['s2'], 'Источник s1 отклонён; оценка пересмотрена на основе s2') },
        ]),
      ),
      ACTOR,
    );
    const o = await get('/api/overview');
    expect(o.lead.idea.slug).toBe('int-lead');
    expect(o.ranking[0].integrity).toMatchObject({ status: 'verified', rejected: [] });
    expect(o.kpis.assessmentsNeedingReview).toBe(0);
    const d = await get('/api/ideas/int-lead');
    expect(d.idea.assessments).toHaveLength(2); // the refuted revision stays in history
    expect(d.idea.evidence.find((e: { id: string }) => e.id === 's1').verificationStatus).toBe('rejected');
  });

  it('a revision that still cites the rejected source stays flagged', async () => {
    await applyImport(
      db.pool,
      jsonFile(envelope('int-run-3', '2026-11-06', [{ ...ideaJson('int-lead', { assessment: false }), sources: [], assessment: strongAssessment('2026-11-06', ['s1', 's2']) }])),
      ACTOR,
    );
    const o = await get('/api/overview');
    expect(o.ranking.find((e: { idea: { slug: string } }) => e.idea.slug === 'int-lead').integrity).toMatchObject({ status: 'needs-review', rejected: ['s1'] });
    expect(o.lead.idea.slug).toBe('int-second');
  });
});
