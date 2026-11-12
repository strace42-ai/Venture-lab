/**
 * DEMO research journal & snapshot history — derived from the VL-001 fixture only.
 * The fixture has no import provenance (files, checksums, approvals, per-source reviews), so those
 * fields are null and the journal says so. Snapshots are RECONSTRUCTED from append-only fixture
 * history at the fixture's snapshot dates (labelled «восстановлен»), never presented as stored.
 */
import { emptyStatusCounts, type FrozenSnapshot, type JournalIdeaChange, type JournalRun, type JournalView } from '../domain/research-ops';
import { marketScore, rankIdeas } from '../domain/scoring';
import { effectiveEvidenceStatus } from '../domain/selectors';
import type { Dataset, DemoDataset } from '../domain/types';

export function buildDemoJournal(data: Dataset): JournalView {
  const runs: JournalRun[] = [...data.researchRuns]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((r) => {
      const ideas: JournalIdeaChange[] = [];
      for (const idea of data.ideas) {
        const created = idea.createdAt === r.date;
        const a = idea.assessments.find((x) => x.assessedAt === r.date);
        const stIdx = idea.stageHistory.findIndex((x) => x.at === r.date);
        if (!created && !a && stIdx < 0) continue;
        const st = stIdx >= 0 ? idea.stageHistory[stIdx]! : null;
        ideas.push({
          ideaId: idea.id,
          slug: idea.slug,
          title: idea.title,
          created,
          updatedFields: [],
          assessmentAdded: !!a,
          assessmentScore: a ? marketScore(a.scores) : null,
          stage: st ? { from: stIdx > 0 ? idea.stageHistory[stIdx - 1]!.stage : null, to: st.stage, reason: st.reason ?? null } : null,
          evidenceAdded: 0,
          competitorsAdded: 0,
          statusChanges: 0,
        });
      }
      return {
        id: r.id,
        date: r.date,
        title: r.conclusion,
        synthetic: true,
        origin: 'demo',
        reviewedBy: 'демо-фикстура',
        coverage: null,
        limitations: null,
        markets: r.marketsExamined,
        sourceRefs: [],
        importedAt: null,
        importedBy: null,
        fileName: null,
        checksum: null,
        approval: null,
        counts: {
          ideasCreated: ideas.filter((i) => i.created).length,
          ideasUpdated: 0,
          assessmentsAdded: ideas.filter((i) => i.assessmentAdded).length,
          stageChanges: ideas.filter((i) => i.stage && i.stage.from !== null).length,
          rejected: ideas.filter((i) => i.stage?.to === 'rejected').length,
          evidenceAdded: 0,
          competitorsAdded: 0,
          statusChanges: 0,
        },
        evidenceStatus: emptyStatusCounts(),
        ideas,
      };
    });
  const allStatus = emptyStatusCounts();
  for (const i of data.ideas) for (const e of i.evidence) allStatus[effectiveEvidenceStatus(e)]++;
  return {
    mode: data.mode,
    asOf: data.asOf,
    runs,
    manualReviews: [],
    notes: [
      'Демо-журнал восстановлен из фикстуры VL-001: у демо-прогонов нет файлов импорта, контрольных сумм, одобрений и ревью источников.',
      `Все ${allStatus.unattributed + allStatus.unreviewed} демо-утверждений без привязанных источников.`,
    ],
  };
}

/** Reconstructed DEMO snapshots at the fixture snapshot dates (newest first). */
export function demoFrozenSnapshots(data: Dataset): FrozenSnapshot[] {
  const dates = (data as Partial<DemoDataset>).snapshotDates ?? [];
  return [...dates]
    .reverse()
    .map((d) => {
      const ranked = rankIdeas(data.ideas, d);
      return {
        id: `demo-${d}`,
        asOf: d,
        entryCount: ranked.length,
        kind: 'reconstructed' as const,
        entries: ranked.map((s, i) => ({ ideaId: s.idea.id, rank: i + 1, score: s.score, confidence: s.confidence, title: s.idea.title, slug: s.idea.slug })),
      };
    })
    .filter((s) => s.entryCount > 0);
}
