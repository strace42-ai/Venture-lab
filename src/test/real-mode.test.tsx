import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { DataProvider } from '../data/DataContext';
import { demoData } from '../data/demo';
import { resolveInitialMode } from '../data/mode';
import { ApiError, createApiSource, type DataSource } from '../data/source';
import { buildIdeaDetail, buildOverview, buildRadarView } from '../domain/selectors';
import { buildEvidenceQueue } from '../domain/research-ops';
import type { Dataset, Evidence, Idea } from '../domain/types';

function realDataset(ideas: Idea[]): Dataset {
  return { ...demoData, mode: 'real', baseline: null, ideas, researchRuns: [], experiments: [], builds: [], activity: [] };
}

function asyncSource(ds: Dataset): DataSource & { calls: number } {
  const s = {
    mode: 'real' as const,
    calls: 0,
    overview: () => {
      s.calls++;
      return Promise.resolve(buildOverview(ds));
    },
    radar: (q: Parameters<DataSource['radar']>[0]) => Promise.resolve(buildRadarView(ds, q)),
    idea: (slug: string) => Promise.resolve(buildIdeaDetail(ds, slug)),
    ...opsFor(ds),
  };
  return s;
}

/** VL-003 methods of an API-like (async) source over an in-memory dataset. */
function opsFor(ds: Dataset): Pick<DataSource, 'journal' | 'evidence' | 'snapshots' | 'compare'> {
  return {
    journal: () => Promise.resolve({ mode: ds.mode, asOf: ds.asOf, runs: [], manualReviews: [], notes: [] }),
    evidence: (q) => Promise.resolve(buildEvidenceQueue(ds, q)),
    snapshots: () => Promise.resolve([]),
    compare: () => Promise.reject(new ApiError('Срез не найден', 'http', 404)),
  };
}

function failingSource(err: Error): DataSource & { calls: number } {
  const s = {
    mode: 'real' as const,
    calls: 0,
    overview: () => {
      s.calls++;
      return Promise.reject(err);
    },
    radar: () => Promise.reject(err),
    idea: () => Promise.reject(err),
    journal: () => Promise.reject(err),
    evidence: () => Promise.reject(err),
    snapshots: () => Promise.reject(err),
    compare: () => Promise.reject(err),
  };
  return s;
}

function renderWith(path: string, source: DataSource) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <DataProvider source={source}>
        <AppRoutes />
      </DataProvider>
    </MemoryRouter>,
  );
  return user;
}

const ev = (over: Partial<Evidence>): Evidence => ({
  id: 'e1',
  market: 'west',
  claim: 'Реальное утверждение с источником',
  dimensions: ['westernNeed'],
  url: 'https://example.org/report',
  title: 'Отчёт о рынке',
  publisher: 'Example Research',
  sourceType: 'independent',
  language: 'en',
  publishedAt: null,
  observedAt: '2026-11-01',
  retrievedAt: null,
  verificationStatus: 'checked',
  supportNote: null,
  ...over,
});

const base = demoData.ideas[0]!;
const scored: Idea = {
  ...base,
  synthetic: false,
  founderFit: null,
  validationPlan: null,
  evidence: [ev({}), ev({ id: 'e2', claim: 'Помечено checked, но без издателя', publisher: null, title: 'Блог без издателя' }), ev({ id: 'e3', market: 'ru', claim: 'Ещё не проверено', verificationStatus: 'unreviewed', title: 'Российский обзор' })],
  competitors: [{ id: 'c1', name: 'Real Competitor Inc', market: 'ru', url: 'https://example.com/c', kind: 'direct', coverage: 'partial', gap: 'нет интеграции', observedAt: '2026-11-01', evidenceIds: ['e1'] }],
};
const unscored: Idea = { ...demoData.ideas[1]!, id: 'unscored-1', slug: 'unscored-idea', title: 'Неоценённая реальная идея', assessments: [], synthetic: false, founderFit: null, validationPlan: null };

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  window.history.replaceState(null, '', '/');
});

describe('REAL mode — empty database', () => {
  it('overview says no research has been imported and shows no demo labels', async () => {
    renderWith('/', asyncSource(realDataset([])));
    expect(await screen.findByRole('heading', { level: 1, name: /Исследования ещё не импортированы/ })).toBeInTheDocument();
    expect(screen.getAllByText(/research:import/, { selector: 'code' }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Демо$/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('Реальные данные').length).toBeGreaterThan(0);
  });

  it('radar shows the same honest empty state', async () => {
    renderWith('/radar', asyncSource(realDataset([])));
    expect(await screen.findByText('Исследования ещё не импортированы')).toBeInTheDocument();
  });
});

describe('REAL mode — API unavailable', () => {
  it('shows an explicit error with retry and never falls back to demo data', async () => {
    const src = failingSource(new ApiError('Локальный API недоступен.', 'unavailable'));
    const user = renderWith('/', src);
    expect(await screen.findByRole('heading', { name: 'Локальная база исследований недоступна' })).toBeInTheDocument();
    expect(screen.queryByText(demoData.ideas[0]!.title)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Повторить/ }));
    await waitFor(() => expect(src.calls).toBe(2));
  });

  it('dossier load errors are shown as errors, not as «not found»', async () => {
    renderWith('/ideas/x', failingSource(new ApiError('Ошибка API (500)', 'http', 500)));
    expect(await screen.findByRole('heading', { name: 'Не удалось загрузить данные' })).toBeInTheDocument();
  });
});

describe('REAL mode — imported data', () => {
  const ds = realDataset([scored, unscored]);

  it('overview ranks only scored ideas, labels the unscored one and claims no movement without a snapshot', async () => {
    renderWith('/', asyncSource(ds));
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('1 идея в рейтинге, 1 не оценена');
    const list = screen.getByRole('list', { name: 'Топ возможностей по рейтингу' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText(/Сохранённых срезов ещё нет/)).toBeInTheDocument();
    expect(screen.getByText('Экспериментов нет')).toBeInTheDocument();
    expect(screen.queryByText(/^Демо$/)).not.toBeInTheDocument();
  });

  it('radar marks unscored ideas «не оценено» instead of a zero score', async () => {
    renderWith('/radar', asyncSource(ds));
    const table = await screen.findByRole('table', { name: 'Идеи на радаре' });
    const row = within(table).getByText('Неоценённая реальная идея').closest('tr')!;
    expect(within(row).getByText('не оценено')).toBeInTheDocument();
    expect(row).not.toHaveTextContent(/\b0\b/);
  });

  it('dossier shows source links with provenance and honest verification states', async () => {
    renderWith(`/ideas/${scored.slug}`, asyncSource(ds));
    await screen.findByRole('heading', { level: 1, name: scored.title });
    const link = screen.getByRole('link', { name: /Отчёт о рынке/ });
    expect(link).toHaveAttribute('href', 'https://example.org/report');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('Проверено')).toBeInTheDocument();
    expect(screen.getByText('Источник требует проверки')).toBeInTheDocument(); // checked but no publisher
    expect(screen.getByText('Не проверено')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Real Competitor Inc/ })).toHaveAttribute('href', 'https://example.com/c');
  });

  it('unscored dossier says the assessment is missing (no fabricated score)', async () => {
    renderWith('/ideas/unscored-idea', asyncSource(ds));
    expect(await screen.findByText('Оценка не импортирована')).toBeInTheDocument();
    expect(screen.getByText('Не оценено')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Разбивка балла по критериям' })).not.toBeInTheDocument();
  });

  it('never renders a non-http source URL as a link', async () => {
    const evil: Idea = { ...scored, evidence: [ev({ url: 'javascript:alert(1)', title: 'Подозрительная ссылка' })] };
    renderWith(`/ideas/${scored.slug}`, asyncSource(realDataset([evil])));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('link', { name: /Подозрительная ссылка/ })).not.toBeInTheDocument();
  });
});

describe('API data source', () => {
  const ok = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

  it('maps network failure and 503 to «unavailable», 404 detail to null, bad payload to «invalid»', async () => {
    await expect(createApiSource('real', '/api', () => Promise.reject(new Error('ECONNREFUSED'))).overview()).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(createApiSource('real', '/api', () => ok({ error: { message: 'db down' } }, 503)).overview()).rejects.toMatchObject({ kind: 'unavailable', message: 'db down' });
    expect(await createApiSource('real', '/api', () => ok({}, 404)).idea('x')).toBeNull();
    await expect(createApiSource('real', '/api', () => ok({ nope: true })).overview()).rejects.toMatchObject({ kind: 'invalid' });
    const notJson = () => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) });
    await expect(createApiSource('real', '/api', notJson).overview()).rejects.toMatchObject({ kind: 'unavailable', status: 502 });
  });

  it('builds a validated query string for the radar', async () => {
    const calls: string[] = [];
    const src = createApiSource('real', '/api', (u: string) => {
      calls.push(u);
      return ok({ rows: [], total: 0, totalAll: 0, page: 2, pageSize: 50, categories: [], stages: [] });
    });
    await src.radar({ q: 'кофе', category: 'HoReCa', stage: 'scored', sort: 'confidence' }, 2);
    expect(calls[0]).toBe('/api/ideas?dataset=real&sort=confidence&page=2&pageSize=50&q=%D0%BA%D0%BE%D1%84%D0%B5&category=HoReCa&stage=scored');
  });

  it('every request of a TEST source is scoped to dataset=test (no cross-dataset reads)', async () => {
    const calls: string[] = [];
    const src = createApiSource('test', '/api', (u: string) => {
      calls.push(u);
      return ok(u.includes('/ideas?') ? { rows: [], total: 0, totalAll: 0, page: 1, pageSize: 50, categories: [], stages: [] } : { ranking: [], kpis: {} });
    });
    expect(src.mode).toBe('test');
    await src.overview();
    await src.radar({ q: '', category: 'all', stage: 'all', sort: 'score' }, 1);
    await src.idea('x');
    expect(calls).toEqual(['/api/overview?dataset=test', '/api/ideas?dataset=test&sort=score&page=1&pageSize=50', '/api/ideas/x?dataset=test']);
  });
});

describe('mode selection (DEMO / REAL never mixed)', () => {
  it('resolves ?mode=, then the saved choice, then defaults to REAL', () => {
    expect(resolveInitialMode('?mode=demo')).toBe('demo');
    expect(resolveInitialMode('?mode=real')).toBe('real');
    expect(resolveInitialMode('')).toBe('real');
    localStorage.setItem('vl.mode', 'demo');
    expect(resolveInitialMode('')).toBe('demo');
    expect(resolveInitialMode('?mode=real')).toBe('real');
  });

  it('switching from DEMO to REAL replaces all data (no demo ideas leak into REAL)', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no server in tests')));
    window.history.replaceState(null, '', '/?mode=demo');
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <DataProvider>
          <AppRoutes />
        </DataProvider>
      </MemoryRouter>,
    );
    expect((await screen.findAllByText(demoData.ideas[0]!.title)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Демо-режим').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'К реальным данным' }));
    expect(await screen.findByRole('heading', { name: 'Локальная база исследований недоступна' })).toBeInTheDocument();
    expect(screen.queryByText(demoData.ideas[0]!.title)).not.toBeInTheDocument();
    expect(localStorage.getItem('vl.mode')).toBe('real');
    expect(window.location.search).toContain('mode=real');
  });
});

describe('labels follow the mode', () => {
  it('DEMO never shows the REAL «Тестовые данные» marker; REAL never shows «Демо»', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/']}>
        <DataProvider data={demoData}>
          <AppRoutes />
        </DataProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('list', { name: 'Топ возможностей по рейтингу' });
    expect(screen.queryByText('Тестовые данные')).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Демо$/i).length).toBeGreaterThan(0);
    unmount();

    renderWith('/', asyncSource(realDataset([{ ...scored, synthetic: true }])));
    await screen.findByRole('list', { name: 'Топ возможностей по рейтингу' });
    expect(screen.getAllByText('Тестовые данные').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Демо$/i)).not.toBeInTheDocument();
  });
});


// ---------------------------------------------------------------- P2: stale Radar rows (review fix)
describe('Radar never shows rows of another source or stale rows on error', () => {
  function renderApp(path: string) {
    window.history.replaceState(null, '', path);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[path.split('?')[0]!]}>
        <DataProvider>
          <AppRoutes />
        </DataProvider>
      </MemoryRouter>,
    );
    return user;
  }
  const demoTitle = demoData.ideas[0]!.title;

  it('DEMO → REAL on /radar with the API down: explicit error, no demo rows under the REAL banner', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('API down')));
    const user = renderApp('/radar?mode=demo');
    expect((await screen.findAllByText(demoTitle)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'К реальным данным' }));
    expect(await screen.findByRole('heading', { name: 'Локальная база исследований недоступна' })).toBeInTheDocument();
    expect(screen.queryByText(demoTitle)).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Идеи на радаре' })).not.toBeInTheDocument();
  });

  it('DEMO → REAL on /radar while REAL is still loading: loading state, not demo rows', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => {})); // never resolves
    const user = renderApp('/radar?mode=demo');
    expect((await screen.findAllByText(demoTitle)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'К реальным данным' }));
    await waitFor(() => expect(screen.queryByText(demoTitle)).not.toBeInTheDocument());
    expect(screen.getByText('Загрузка…')).toBeInTheDocument();
    expect(screen.getAllByText('Реальные данные').length).toBeGreaterThan(0);
  });

  it('REAL → DEMO → REAL on /radar does not leak REAL rows into DEMO either', async () => {
    const realTitle = 'Только реальная идея';
    const realView = buildRadarView(realDataset([{ ...scored, title: realTitle }]), { q: '', category: 'all', stage: 'all', sort: 'score' });
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(realView) }));
    const user = renderApp('/radar?mode=real');
    expect((await screen.findAllByText(realTitle)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Открыть демо' }));
    expect((await screen.findAllByText(demoTitle)).length).toBeGreaterThan(0);
    expect(screen.queryByText(realTitle)).not.toBeInTheDocument();
  });

  it('within one source, a failed refresh shows the error instead of the previous rows', async () => {
    let fail = false;
    const ds = realDataset([scored, unscored]);
    const src: DataSource = {
      mode: 'real',
      overview: () => Promise.resolve(buildOverview(ds)),
      radar: (q) => (fail ? Promise.reject(new ApiError('Ошибка API (500)', 'http', 500)) : Promise.resolve(buildRadarView(ds, q))),
      idea: (slug) => Promise.resolve(buildIdeaDetail(ds, slug)),
      ...opsFor(ds),
    };
    const user = renderWith('/radar', src);
    expect(await screen.findByRole('table', { name: 'Идеи на радаре' })).toBeInTheDocument();
    fail = true;
    await user.click(screen.getByRole('radio', { name: 'Свежие' }));
    expect(await screen.findByRole('heading', { name: 'Не удалось загрузить данные' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Идеи на радаре' })).not.toBeInTheDocument();
  });

  it('TEST mode is its own explicitly labelled dataset', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (u: string) => {
      calls.push(u);
      return Promise.reject(new Error('API down'));
    });
    renderApp('/?mode=test');
    expect(await screen.findByRole('heading', { name: 'Локальная база исследований недоступна' })).toBeInTheDocument();
    expect(screen.getAllByText('Тестовые импорты').length).toBeGreaterThan(0);
    expect(calls.every((u) => u.includes('dataset=test'))).toBe(true);
    expect(resolveInitialMode('?mode=test')).toBe('test');
  });
});

describe('useLoad never leaks unhandled promise rejections (CI regression)', () => {
  it('an immediately rejected source request is handled before React subscribes', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    // Vitest runs jsdom tests in Node; the app tsconfig has no Node types, hence the local type.
    const proc = (globalThis as unknown as { process: { on(e: string, f: (r: unknown) => void): void; off(e: string, f: (r: unknown) => void): void } }).process;
    proc.on('unhandledRejection', onUnhandled);
    try {
      renderWith('/ideas/x', failingSource(new ApiError('Ошибка API (500)', 'http', 500)));
      expect(await screen.findByRole('heading', { name: 'Не удалось загрузить данные' })).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([]);
    } finally {
      proc.off('unhandledRejection', onUnhandled);
    }
  });
});
