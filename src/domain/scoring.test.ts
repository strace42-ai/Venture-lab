import { describe, expect, it } from 'vitest';
import { demoData } from '../data/demo';
import {
  DIMENSIONS,
  DIMENSION_KEYS,
  MAX_TOTAL,
  compareRank,
  contribution,
  evidenceConfidence,
  founderFit,
  marketScore,
  rankIdeas,
  rankWithMovement,
  scoreIdea,
} from './scoring';
import { computeKpis, fullRanking, radarRows, strongestFind, topN } from './selectors';
import type { ComponentScores, Idea, RawScore } from './types';

function scores(v: RawScore): ComponentScores {
  return Object.fromEntries(DIMENSION_KEYS.map((k) => [k, v])) as ComponentScores;
}

function makeIdea(id: string, overrides: Partial<Idea> = {}, s: ComponentScores = scores(3), assessedAt = '2026-11-01'): Idea {
  const base = demoData.ideas[0]!;
  return {
    ...base,
    id,
    slug: id,
    stage: 'scored',
    riskFlags: [],
    assessments: [{ ...base.assessments[0]!, assessedAt, scores: s }],
    ...overrides,
  };
}

describe('scoring model v1.0', () => {
  it('has 12 dimensions whose weights sum to 100', () => {
    expect(DIMENSIONS).toHaveLength(12);
    expect(MAX_TOTAL).toBe(100);
  });

  it('computes weighted contribution as max × raw / 5', () => {
    expect(contribution(12, 5)).toBe(12);
    expect(contribution(12, 3)).toBeCloseTo(7.2);
    expect(contribution(4, 0)).toBe(0);
    expect(() => contribution(8, 6 as RawScore)).toThrow(RangeError);
  });

  it('gives 100 for all 5s, 0 for all 0s, 60 for all 3s', () => {
    expect(marketScore(scores(5))).toBe(100);
    expect(marketScore(scores(0))).toBe(0);
    expect(marketScore(scores(3))).toBe(60);
  });

  it('rounds only the final total, not each component', () => {
    // 12×1/5 = 2.4 twice → 4.8 → 5. Per-component rounding would wrongly give 2 + 2 = 4.
    const s = scores(0);
    s.westernNeed = 1;
    s.ruWeakness = 1;
    expect(marketScore(s)).toBe(5);
  });

  it('treats unknown (null) as 0 points but not as evidence', () => {
    const s = scores(5);
    s.riskManageable = null;
    expect(marketScore(s)).toBe(96);
  });

  it('weights evidence confidence 30/25/15/20/10', () => {
    expect(evidenceConfidence({ completeness: 100, corroboration: 0, recency: 0, reliability: 0, russiaValidation: 0 })).toBe(30);
    expect(evidenceConfidence({ completeness: 0, corroboration: 100, recency: 0, reliability: 0, russiaValidation: 0 })).toBe(25);
    expect(evidenceConfidence({ completeness: 100, corroboration: 100, recency: 100, reliability: 100, russiaValidation: 100 })).toBe(100);
  });

  it('caps founder fit at 40 and keeps it out of the market score', () => {
    expect(founderFit({ skills: 10, access: 10, timeToSale: 10, motivation: 5, synergy: 5 })).toBe(40);
    expect(founderFit({ skills: 99, access: 0, timeToSale: 0, motivation: 0, synergy: 0 })).toBe(10);
    const a = makeIdea('a', { founderFit: { skills: 10, access: 10, timeToSale: 10, motivation: 5, synergy: 5 } });
    const b = makeIdea('b', { founderFit: { skills: 0, access: 0, timeToSale: 0, motivation: 0, synergy: 0 } });
    expect(scoreIdea(a).score).toBe(scoreIdea(b).score);
  });
});

describe('ranking', () => {
  it('sorts by score, then confidence, then first-payment feasibility, then id', () => {
    const hi = makeIdea('z-hi', {}, scores(4));
    const lo = makeIdea('a-lo', {}, scores(2));
    expect(rankIdeas([lo, hi]).map((s) => s.idea.id)).toEqual(['z-hi', 'a-lo']);

    // Equal score: higher speedToPilot wins (firstPayment) when confidence is equal.
    const s1 = scores(3);
    s1.speedToPilot = 4;
    s1.mvpFeasible = 2; // same total: +2 −2 on max-10 dimensions
    const fast = makeIdea('b-fast', {}, s1);
    const slow = makeIdea('a-slow', {}, scores(3));
    expect(scoreIdea(fast).score).toBe(scoreIdea(slow).score);
    expect(rankIdeas([slow, fast]).map((s) => s.idea.id)).toEqual(['b-fast', 'a-slow']);

    // Full tie → stable id order.
    const x = makeIdea('b', {}, scores(3));
    const y = makeIdea('a', {}, scores(3));
    expect([scoreIdea(x), scoreIdea(y)].sort(compareRank).map((s) => s.idea.id)).toEqual(['a', 'b']);
  });

  it('excludes rejected ideas and ideas not yet assessed at the snapshot date', () => {
    const rej = makeIdea('rej', { stage: 'rejected' }, scores(5));
    const later = makeIdea('later', {}, scores(5), '2026-12-01');
    const ok = makeIdea('ok');
    expect(rankIdeas([rej, later, ok], '2026-11-12').map((s) => s.idea.id)).toEqual(['ok']);
  });

  it('derives movement only against a stored previous snapshot', () => {
    const a = makeIdea('a', {}, scores(4));
    a.assessments = [
      { ...a.assessments[0]!, assessedAt: '2026-11-01', scores: scores(2) },
      { ...a.assessments[0]!, assessedAt: '2026-11-10', scores: scores(4) },
    ];
    const b = makeIdea('b', {}, scores(3), '2026-11-01');
    const c = makeIdea('c', {}, scores(5), '2026-11-08');
    const r = rankWithMovement([a, b, c], '2026-11-12', '2026-11-05');
    expect(r.map((e) => e.idea.id)).toEqual(['c', 'a', 'b']);
    expect(r[0]!.movement).toEqual({ kind: 'new' });
    expect(r[1]!.movement).toEqual({ kind: 'same', previousRank: 2 });
    expect(r[1]!.scoreDelta).toBe(40);
    expect(r[2]!.movement).toEqual({ kind: 'down', by: 2, previousRank: 1 });

    const up = rankWithMovement([a, b], '2026-11-12', '2026-11-05');
    expect(up[0]!.movement).toEqual({ kind: 'up', by: 1, previousRank: 2 });
    // No previous snapshot → no movement is claimed.
    expect(rankWithMovement([a, b], '2026-11-12', null).every((e) => e.movement.kind === 'new')).toBe(true);
  });
});

describe('demo dataset', () => {
  it('is flagged as demo with an asOf date and ≥ 12 distinct ideas', () => {
    expect(demoData.isDemo).toBe(true);
    expect(demoData.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(demoData.ideas.length).toBeGreaterThanOrEqual(12);
    expect(new Set(demoData.ideas.map((i) => i.id)).size).toBe(demoData.ideas.length);
    expect(new Set(demoData.ideas.map((i) => i.slug)).size).toBe(demoData.ideas.length);
    expect(demoData.ideas.every((i) => i.demo === true)).toBe(true);
  });

  it('keeps assessments append-only (chronological) for every idea', () => {
    for (const idea of demoData.ideas) {
      const dates = idea.assessments.map((a) => a.assessedAt);
      expect([...dates].sort()).toEqual(dates);
    }
  });

  it('derives top-10 from the complete ranked list, in non-increasing score order', () => {
    const full = fullRanking(demoData);
    const top = topN(demoData, 10);
    expect(top).toHaveLength(10);
    expect(top.map((e) => e.idea.id)).toEqual(full.slice(0, 10).map((e) => e.idea.id));
    for (let i = 1; i < full.length; i++) expect(full[i - 1]!.score).toBeGreaterThanOrEqual(full[i]!.score);
    expect(top.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Rejected idea is never ranked.
    expect(full.some((e) => e.idea.stage === 'rejected')).toBe(false);
  });

  it('reports no verified payments unless experiments record them', () => {
    const k = computeKpis(demoData);
    expect(k.verifiedPaidSignals).toBe(0);
    expect(k.totalIdeas).toBe(demoData.ideas.length);
  });

  it('never picks an idea with a critical risk as strongest find when an alternative exists', () => {
    const lead = strongestFind(demoData)!;
    expect(lead.idea.riskFlags).not.toContain('legal');
    expect(lead.idea.riskFlags).not.toContain('lockedApi');
  });

  it('filters and sorts radar rows', () => {
    const base = { q: '', category: 'all', stage: 'all', sort: 'score' } as const;
    const all = radarRows(demoData, base);
    expect(all).toHaveLength(demoData.ideas.length);
    const legal = radarRows(demoData, { ...base, category: 'LegalTech' });
    expect(legal.every((r) => r.idea.category === 'LegalTech')).toBe(true);
    const q = radarRows(demoData, { ...base, q: 'репетитор' });
    expect(q.map((r) => r.idea.id)).toEqual(['idea-03']);
    const conf = radarRows(demoData, { ...base, sort: 'confidence' });
    for (let i = 1; i < conf.length; i++) expect(conf[i - 1]!.confidence).toBeGreaterThanOrEqual(conf[i]!.confidence);
    const recent = radarRows(demoData, { ...base, sort: 'recent' });
    for (let i = 1; i < recent.length; i++) expect(recent[i - 1]!.idea.updatedAt >= recent[i]!.idea.updatedAt).toBe(true);
  });
});
