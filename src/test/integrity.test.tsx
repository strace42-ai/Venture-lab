import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { DataProvider } from '../data/DataContext';
import { demoData } from '../data/demo';
import { assessmentIntegrity } from '../domain/integrity';
import { computeKpis, fullRanking, strongestFind } from '../domain/selectors';
import { rankIdeas } from '../domain/scoring';
import type { DemoDataset, Evidence, Idea } from '../domain/types';

const ev = (over: Partial<Evidence>): Evidence => ({
  id: 'e1',
  market: 'west',
  claim: 'Ключевое утверждение оценки',
  dimensions: ['westernNeed'],
  url: 'https://example.org/a',
  title: 'Страница',
  publisher: 'Example',
  sourceType: 'independent',
  language: 'en',
  publishedAt: null,
  observedAt: '2026-11-01',
  retrievedAt: null,
  verificationStatus: 'checked',
  supportNote: null,
  ...over,
});

const leadIdea = fullRanking(demoData)[0]!.idea;

/** The DEMO dataset where the current leader's assessments cite evidence `e1` with the given status. */
function withLeadEvidence(status: Evidence['verificationStatus'], cite: string[] = ['e1']): DemoDataset {
  const lead: Idea = {
    ...leadIdea,
    evidence: [ev({ verificationStatus: status })],
    assessments: leadIdea.assessments.map((a) => ({ ...a, evidenceIds: cite })),
  };
  return {
    ...demoData,
    ideas: demoData.ideas.map((i) => (i.id === lead.id ? lead : i)),
  };
}

describe('assessmentIntegrity (domain)', () => {
  const idea = {
    evidence: [ev({ id: 'ok' }), ev({ id: 'rej', verificationStatus: 'rejected' }), ev({ id: 'new', verificationStatus: 'unreviewed' }), ev({ id: 'noattr', publisher: null })],
  };

  it('rejected or missing cited evidence → needs-review, with ids', () => {
    expect(assessmentIntegrity(idea, { evidenceIds: ['ok', 'rej'] })).toMatchObject({ status: 'needs-review', rejected: ['rej'], missing: [] });
    expect(assessmentIntegrity(idea, { evidenceIds: ['ok', 'gone'] })).toMatchObject({ status: 'needs-review', missing: ['gone'] });
  });

  it('unreviewed / unattributed → unverified (weak, not refuted); all checked → verified; none → unlinked', () => {
    expect(assessmentIntegrity(idea, { evidenceIds: ['ok', 'new', 'noattr'] })).toMatchObject({ status: 'unverified', unverified: ['new', 'noattr'] });
    expect(assessmentIntegrity(idea, { evidenceIds: ['ok'] })).toMatchObject({
      status: 'verified',
      cited: 1,
    });
    expect(assessmentIntegrity(idea, {})).toMatchObject({
      status: 'unlinked',
      cited: 0,
    });
  });

  it('a rejected source in an UNCITED position does not flag the assessment', () => {
    expect(assessmentIntegrity(idea, { evidenceIds: ['ok'] }).status).toBe('verified');
  });
});

describe('recommendations honour evidence integrity', () => {
  it('a rejected cited source removes the idea from strongest find and strong leads, but not from the ranking', () => {
    const ok = withLeadEvidence('checked');
    const bad = withLeadEvidence('rejected');
    expect(strongestFind(ok)!.idea.id).toBe(leadIdea.id);
    expect(strongestFind(bad)!.idea.id).not.toBe(leadIdea.id);

    const rOk = fullRanking(ok);
    const rBad = fullRanking(bad);
    // Same score and rank: the scoring rubric is not silently changed.
    expect(rBad[0]!.idea.id).toBe(leadIdea.id);
    expect(rBad[0]!.score).toBe(rOk[0]!.score);
    expect(rBad[0]!.integrity).toMatchObject({
      status: 'needs-review',
      rejected: ['e1'],
    });

    const kOk = computeKpis(ok);
    const kBad = computeKpis(bad);
    expect(kBad.assessmentsNeedingReview).toBe(1);
    expect(kOk.assessmentsNeedingReview).toBe(0);
    expect(kBad.highConfidenceLeads).toBeLessThanOrEqual(kOk.highConfidenceLeads);
  });

  it('unreviewed cited evidence does NOT exclude the idea', () => {
    expect(strongestFind(withLeadEvidence('unreviewed'))!.idea.id).toBe(leadIdea.id);
  });

  it('historical (as-of) ranking values are unchanged by a later rejection', () => {
    const date = demoData.snapshotDates[0]!;
    const before = rankIdeas(withLeadEvidence('checked').ideas, date).map((s) => [s.idea.id, s.score, s.confidence]);
    const after = rankIdeas(withLeadEvidence('rejected').ideas, date).map((s) => [s.idea.id, s.score, s.confidence]);
    expect(after).toEqual(before);
  });
});

describe('UI: integrity warning', () => {
  function renderAt(path: string, data: DemoDataset) {
    render(
      <MemoryRouter initialEntries={[path]}>
        <DataProvider data={data}>
          <AppRoutes />
        </DataProvider>
      </MemoryRouter>,
    );
  }

  it('overview: alert with ids, flagged leaderboard row, and a different strongest find', async () => {
    renderAt('/', withLeadEvidence('rejected'));
    const alert = await screen.findByRole('status', {
      name: 'Оценки требуют пересмотра',
    });
    expect(alert).toHaveTextContent(leadIdea.title);
    expect(alert).toHaveTextContent(/e1 отклонён/);
    const list = screen.getByRole('list', {
      name: 'Топ возможностей по рейтингу',
    });
    expect(within(list).getAllByText('Оценка требует пересмотра')).toHaveLength(1);
    const hero = document.getElementById('hero-title')!;
    expect(hero).toBeInTheDocument();
    expect(hero).not.toHaveTextContent(leadIdea.title);
  });

  it('overview: no alert when the cited source is checked', async () => {
    renderAt('/', withLeadEvidence('checked'));
    await screen.findByRole('list', { name: 'Топ возможностей по рейтингу' });
    expect(screen.queryByRole('status', { name: 'Оценки требуют пересмотра' })).not.toBeInTheDocument();
    expect(screen.queryByText('Оценка требует пересмотра')).not.toBeInTheDocument();
  });

  it('dossier: explains the warning, what it does not change, and how to lift it', async () => {
    renderAt(`/ideas/${leadIdea.slug}`, withLeadEvidence('rejected'));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('Оценка требует пересмотра: источник e1 отклонён');
    expect(notice).toHaveTextContent(/не рекомендуется/);
    expect(notice).toHaveTextContent(/сохранённые срезы не изменены/);
    expect(notice).toHaveTextContent(/новую ревизию оценки/);
  });

  it('radar: the flagged idea carries the warning', async () => {
    renderAt('/radar', withLeadEvidence('rejected'));
    const table = await screen.findByRole('table', { name: /Идеи на радаре/ });
    expect(within(table).getAllByText('Оценка требует пересмотра')).toHaveLength(1);
  });
});
