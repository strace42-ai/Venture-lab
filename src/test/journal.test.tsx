import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { DataProvider } from '../data/DataContext';
import { demoData } from '../data/demo';
import { buildDemoJournal } from '../data/demo-journal';
import { ApiError, type DataSource } from '../data/source';
import { buildEvidenceQueue, compareSnapshots, snapshotMeta, type FrozenSnapshot, type JournalView } from '../domain/research-ops';
import { buildIdeaDetail, buildOverview, buildRadarView } from '../domain/selectors';
import type { Dataset, Evidence, Idea } from '../domain/types';

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="loc">{loc.pathname + loc.search}</output>;
}

function renderWith(path: string, props: { data?: Dataset; source?: DataSource }) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <DataProvider {...props}>
        <AppRoutes />
        <LocationProbe />
      </DataProvider>
    </MemoryRouter>,
  );
  return user;
}

// ------------------------------------------------------------------ API-like source

const ev = (over: Partial<Evidence>): Evidence => ({
  id: 's1',
  market: 'west',
  claim: 'Утверждение из реального источника',
  dimensions: ['westernNeed'],
  url: 'https://example.org/a',
  title: 'Страница',
  publisher: 'Example',
  sourceType: 'independent',
  language: 'ru',
  publishedAt: null,
  observedAt: '2026-11-01',
  retrievedAt: null,
  verificationStatus: 'unreviewed',
  supportNote: null,
  ...over,
});

function realData(evidence: Evidence[]): Dataset {
  const base = demoData.ideas[0]!;
  const idea: Idea = { ...base, id: 'real-a', slug: 'real-a', title: 'Реальная идея A', evidence, assessments: [] };
  return { ...demoData, mode: 'test', baseline: null, ideas: [idea], researchRuns: [], experiments: [], builds: [], activity: [] };
}

function frozen(id: string, asOf: string, rows: [string, number, string][]): FrozenSnapshot {
  return { id, asOf, kind: 'stored', entryCount: rows.length, entries: rows.map(([ideaId, score, title], i) => ({ ideaId, rank: i + 1, score, confidence: 40, title, slug: ideaId })) };
}

function apiSource(ds: Dataset, opts: { journal?: JournalView; snaps?: FrozenSnapshot[] } = {}): DataSource {
  const snaps = opts.snaps ?? [];
  return {
    mode: 'test',
    overview: () => Promise.resolve(buildOverview(ds)),
    radar: (q) => Promise.resolve(buildRadarView(ds, q)),
    idea: (slug) => Promise.resolve(buildIdeaDetail(ds, slug)),
    journal: () => Promise.resolve(opts.journal ?? { mode: 'test', asOf: ds.asOf, runs: [], manualReviews: [], notes: [] }),
    evidence: (q, page) => Promise.resolve(buildEvidenceQueue(ds, q, { page, pageSize: 50 })),
    snapshots: () => Promise.resolve(snaps.map(snapshotMeta)),
    compare: (a, b) => {
      const x = snaps.find((s) => s.id === a);
      const y = snaps.find((s) => s.id === b);
      return x && y ? Promise.resolve(compareSnapshots(x, y)) : Promise.reject(new ApiError('Срез не найден', 'http', 404));
    },
  };
}

// ------------------------------------------------------------------ DEMO

describe('Research Journal — DEMO', () => {
  it('shows runs with demo labelling and switches tabs via the URL', async () => {
    const user = renderWith('/journal', { data: demoData });
    expect(await screen.findByRole('heading', { level: 1, name: /Что исследовано, что проверено/ })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Прогоны исследований' })).toBeInTheDocument();
    expect(screen.getAllByText(/демо/i).length).toBeGreaterThan(0);
    const j = buildDemoJournal(demoData);
    expect(screen.getByRole('heading', { level: 2, name: new RegExp(j.runs[0]!.title!.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Проверка источников/ }));
    expect(screen.getByTestId('loc')).toHaveTextContent('tab=evidence');
    expect(await screen.findByText(/Открытие ссылки — не доказательство/)).toBeInTheDocument();
    // DEMO never offers review commands (no database to write to).
    expect(screen.queryByText(/research:review -- --dataset/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /История ТОП-10/ }));
    expect(await screen.findByText(/Демо: срезы восстановлены из фикстуры/)).toBeInTheDocument();
  });

  it('evidence filters write to the URL and narrow the queue', async () => {
    const user = renderWith('/journal?tab=evidence', { data: demoData });
    const before = (await screen.findByRole('list', { name: 'Очередь проверки источников' })).children.length;
    await user.selectOptions(screen.getByLabelText('Статус'), 'all');
    await user.selectOptions(screen.getByLabelText('Рынок'), 'ru');
    expect(screen.getByTestId('loc')).toHaveTextContent('market=ru');
    const expected = buildEvidenceQueue(demoData, { status: 'all', market: 'ru', sourceType: 'all', idea: 'all', minAgeDays: null, missingUrl: false, dimension: 'all', risk: 'all' }).total;
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(50);
    await waitFor(() => expect(screen.getByRole('list', { name: 'Очередь проверки источников' }).children.length).toBe(expected));
    expect(before).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ API-backed (TEST)

describe('Research Journal — API-backed', () => {
  it('honest empty states: no runs, no snapshots', async () => {
    const user = renderWith('/journal', { source: apiSource(realData([])) });
    expect(await screen.findByText('Тестовых прогонов нет')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Проверка источников/ }));
    expect(await screen.findByText('Источников пока нет')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /История ТОП-10/ }));
    expect(await screen.findByText('Сохранённых срезов ещё нет')).toBeInTheDocument();
    expect(screen.getByText(/research:snapshot -- --dataset test --apply/)).toBeInTheDocument();
  });

  it('one snapshot: asks for a second one instead of comparing', async () => {
    renderWith('/journal?tab=history', { source: apiSource(realData([]), { snaps: [frozen('s1', '2026-11-02', [['a', 50, 'A']])] }) });
    expect(await screen.findByText('Нужен ещё один срез для сравнения')).toBeInTheDocument();
  });

  it('compares two stored snapshots with frozen titles and N/10 note', async () => {
    const snaps = [frozen('s2', '2026-11-06', [['d', 80, 'Новая D'], ['b', 30, 'Новое имя B']]), frozen('s1', '2026-11-02', [['b', 60, 'Старое имя B'], ['c', 40, 'C']])];
    renderWith('/journal?tab=history', { source: apiSource(realData([]), { snaps }) });
    const summary = await screen.findByRole('region', { name: 'Итог сравнения' });
    expect(summary).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Сравнение срезов ТОП-10' });
    expect(within(table).getByText('Новое имя B')).toBeInTheDocument();
    expect(within(table).getByText(/Старое имя B/)).toBeInTheDocument();
    expect(within(table).getByText('Новая D')).toBeInTheDocument();
    expect(screen.getByText(/только 2 оценённых идей — ТОП не дополняется искусственно/)).toBeInTheDocument();
  });

  it('evidence card offers copyable review commands only for live datasets; unattributed can only be rejected', async () => {
    const data = realData([ev({ id: 's1' }), ev({ id: 's2', url: null, publisher: null })]);
    renderWith('/journal?tab=evidence', { source: apiSource(data) });
    const list = await screen.findByRole('list', { name: 'Очередь проверки источников' });
    expect(within(list).getAllByText(/research:review -- --dataset test --idea real-a --evidence s1 --status checked/).length).toBe(1);
    expect(within(list).queryByText(/--evidence s2 --status checked/)).not.toBeInTheDocument();
    expect(within(list).getByText(/--evidence s2 --status rejected/)).toBeInTheDocument();
  });

  it('shows the last review decision (who, how, why) in the queue history', async () => {
    const data = realData([
      ev({
        id: 's1',
        verificationStatus: 'rejected',
        reviews: [
          { status: 'unreviewed', at: '2026-11-01T10:00:00Z', origin: 'import', actor: 'researcher', reason: null, runId: 'r1' },
          { status: 'rejected', at: '2026-11-02T10:00:00Z', origin: 'manual', actor: 'Основатель', reason: 'Утверждения нет на странице', runId: null },
        ],
      }),
    ]);
    const user = renderWith('/journal?tab=evidence', { source: apiSource(data) });
    expect(await screen.findByText('Под фильтр ничего не подходит')).toBeInTheDocument(); // nothing needs review
    // Regression: choosing «Все» must not snap back to the needs-review default.
    await user.selectOptions(screen.getByLabelText('Статус'), 'all');
    expect(screen.getByTestId('loc')).toHaveTextContent('status=all');
    expect(screen.getByLabelText('Статус')).toHaveValue('all');
    expect(await screen.findAllByText(/Утверждения нет на странице/)).not.toHaveLength(0);
  });

  it('load errors render a retryable error state', async () => {
    const err = new ApiError('База исследований недоступна', 'unavailable');
    const src = { ...apiSource(realData([])), journal: () => Promise.reject(err) };
    renderWith('/journal', { source: src });
    expect(await screen.findByRole('alert')).toHaveTextContent(/недоступна/);
  });
});
