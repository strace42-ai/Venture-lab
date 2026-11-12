import { describe, expect, it } from 'vitest';
import { demoData } from '../data/demo';
import { buildDemoJournal, demoFrozenSnapshots } from '../data/demo-journal';
import { DEFAULT_EVIDENCE_QUERY, buildEvidenceQueue, compareSnapshots, type FrozenSnapshot } from './research-ops';
import { effectiveEvidenceStatus } from './selectors';

function snap(id: string, asOf: string, ranking: [string, number, string?][]): FrozenSnapshot {
  return {
    id,
    asOf,
    kind: 'stored',
    entryCount: ranking.length,
    entries: ranking.map(([ideaId, score, title], i) => ({ ideaId, rank: i + 1, score, confidence: 50 + i, title: title ?? `T ${ideaId}`, slug: ideaId })),
  };
}

describe('compareSnapshots (frozen entries)', () => {
  it('classifies entered/exited with exact detail using the full stored ranking', () => {
    const ids = (n: number, p = 'i') => Array.from({ length: n }, (_, k) => `${p}${k + 1}`);
    // A: i1..i11 (i11 below the cut). B: i11 rises into the top, i10 drops below, i9 leaves the ranking, n1 is new.
    const A = snap('a', '2026-11-01', ids(11).map((x, k) => [x, 100 - k]));
    const B = snap('b', '2026-11-05', [
      ['n1', 99],
      ['i11', 98],
      ...ids(8).map((x, k): [string, number] => [x, 90 - k]),
      ['i10', 50],
    ]);
    const c = compareSnapshots(A, B);
    const row = (id: string) => c.rows.find((r) => r.ideaId === id)!;
    expect(row('n1')).toMatchObject({ change: 'entered', detail: 'new-in-ranking', rankA: null, rankB: 1, scoreDelta: null });
    expect(row('i11')).toMatchObject({ change: 'entered', detail: 'from-below', rankA: 11, rankB: 2, rankDelta: 9 });
    expect(row('i10')).toMatchObject({ change: 'exited', detail: 'below-cut', rankA: 10, rankB: 11 });
    expect(row('i9')).toMatchObject({ change: 'exited', detail: 'left-ranking', rankB: null });
    expect(row('i1')).toMatchObject({ change: 'down', rankA: 1, rankB: 3, scoreDelta: -10, confidenceDelta: 2 });
    expect(c.summary).toEqual({ entered: 2, exited: 2, up: 0, down: 8, same: 0 });
    // Rows ordered by B rank, exits last.
    expect(c.rows.slice(0, 2).map((r) => r.ideaId)).toEqual(['n1', 'i11']);
    expect(c.rows.slice(-2).every((r) => r.change === 'exited')).toBe(true);
    expect(c.topA).toBe(10);
    expect(c.topB).toBe(10);
  });

  it('swaps so that A is the earlier snapshot, and keeps frozen titles per side', () => {
    const early = snap('e', '2026-11-01', [['x', 40, 'Old name'], ['y', 30]]);
    const late = snap('l', '2026-11-03', [['y', 45], ['x', 41, 'New name']]);
    const c = compareSnapshots(late, early);
    expect(c.swapped).toBe(true);
    expect(c.a.id).toBe('e');
    expect(c.rows.find((r) => r.ideaId === 'x')).toMatchObject({ change: 'down', titleA: 'Old name', titleB: 'New name', scoreDelta: 1 });
    expect(c.rows.find((r) => r.ideaId === 'y')).toMatchObject({ change: 'up' });
  });

  it('handles empty and partial snapshots without padding (N/10)', () => {
    const empty = snap('e', '2026-11-01', []);
    const three = snap('t', '2026-11-02', [['a', 3], ['b', 2], ['c', 1]]);
    const c = compareSnapshots(empty, three);
    expect(c.rows).toHaveLength(3);
    expect(c.summary.entered).toBe(3);
    expect(c.topA).toBe(0);
    expect(c.topB).toBe(3);
    expect(compareSnapshots(empty, snap('e2', '2026-11-03', [])).rows).toEqual([]);
    const same = compareSnapshots(three, { ...three, id: 't2', asOf: '2026-11-04' });
    expect(same.summary).toEqual({ entered: 0, exited: 0, up: 0, down: 0, same: 3 });
  });
});

describe('buildEvidenceQueue', () => {
  const all = { ...DEFAULT_EVIDENCE_QUERY, status: 'all' as const };

  it('counts statuses honestly (missing attribution never counts as checked)', () => {
    const v = buildEvidenceQueue(demoData, all);
    const evs = demoData.ideas.flatMap((i) => i.evidence);
    expect(v.totalAll).toBe(evs.length);
    expect(v.total).toBe(evs.length);
    expect(v.counts.checked).toBe(evs.filter((e) => effectiveEvidenceStatus(e) === 'checked').length);
    expect(v.rows.filter((r) => r.status === 'checked').every((r) => r.evidence.url && r.evidence.publisher && r.evidence.observedAt)).toBe(true);
  });

  it('default "needs-review" shows unreviewed + unattributed, most urgent first', () => {
    const v = buildEvidenceQueue(demoData, DEFAULT_EVIDENCE_QUERY);
    expect(v.total).toBe(v.counts.unreviewed + v.counts.unattributed);
    const order = { unattributed: 0, unreviewed: 1, rejected: 2, checked: 3 };
    for (let k = 1; k < v.rows.length; k++) expect(order[v.rows[k - 1]!.status]).toBeLessThanOrEqual(order[v.rows[k]!.status]);
  });

  it('filters by market, idea, source type, missing URL, dimension, risk and age', () => {
    const ru = buildEvidenceQueue(demoData, { ...all, market: 'ru' });
    expect(ru.rows.every((r) => r.evidence.market === 'ru')).toBe(true);
    const idea = demoData.ideas[0]!;
    const one = buildEvidenceQueue(demoData, { ...all, idea: idea.slug });
    expect(one.total).toBe(idea.evidence.length);
    expect(buildEvidenceQueue(demoData, { ...all, idea: idea.id }).total).toBe(idea.evidence.length);
    const nourl = buildEvidenceQueue(demoData, { ...all, missingUrl: true });
    expect(nourl.rows.every((r) => !r.evidence.url)).toBe(true);
    const dim = buildEvidenceQueue(demoData, { ...all, dimension: 'ruWeakness' });
    expect(dim.rows.every((r) => r.evidence.dimensions.includes('ruWeakness'))).toBe(true);
    const risk = buildEvidenceQueue(demoData, { ...all, risk: 'legal' });
    expect(risk.rows.every((r) => r.idea.riskFlags.includes('legal'))).toBe(true);
    const old = buildEvidenceQueue(demoData, { ...all, minAgeDays: 10_000 });
    expect(old.total).toBe(0);
  });

  it('paginates', () => {
    const p1 = buildEvidenceQueue(demoData, { ...DEFAULT_EVIDENCE_QUERY, status: 'all' }, { page: 1, pageSize: 2 });
    const p2 = buildEvidenceQueue(demoData, { ...DEFAULT_EVIDENCE_QUERY, status: 'all' }, { page: 2, pageSize: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p2.rows[0]!.evidence).not.toBe(p1.rows[0]!.evidence);
  });
});

describe('DEMO journal', () => {
  it('is honest: synthetic, no provenance and an explicit note', () => {
    const j = buildDemoJournal(demoData);
    expect(j.mode).toBe('demo');
    expect(j.runs.length).toBe(demoData.researchRuns.length);
    expect(j.runs.every((r) => r.checksum === null && r.approval === null)).toBe(true);
    expect(j.notes.join(' ')).toMatch(/демо/i);
  });

  it('demo snapshots are marked reconstructed, never stored', () => {
    const s = demoFrozenSnapshots(demoData);
    expect(s.every((x) => x.kind === 'reconstructed')).toBe(true);
  });
});
