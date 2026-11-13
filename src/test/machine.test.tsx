import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { DataProvider } from '../data/DataContext';
import { demoData } from '../data/demo';
import { MachineClientContext, type MachineClient } from '../data/machine';
import { ApiError } from '../data/source';
import type { MachineCandidateDetail, MachineOverview } from '../domain/machine';
import { DIMENSION_KEYS } from '../domain/scoring';

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="loc">{loc.pathname + loc.search}</output>;
}

const run = { id: 3, jobKey: 'daily:fixture:2026-11-12', feed: 'fixture' as const, asOf: '2026-11-12', status: 'succeeded' as const, attempts: 1, maxAttempts: 3, spent: 659, budgetLimit: 2000, error: null, partialReason: null, startedAt: '2026-11-12T03:00:00Z', finishedAt: '2026-11-12T03:00:02Z', pipelineVersion: 'vl-004a-pipeline-1' };

function overview(over: Partial<MachineOverview> = {}): MachineOverview {
  return {
    feed: 'fixture',
    timezone: 'Asia/Novokuznetsk',
    today: '2026-11-12',
    latestRun: run,
    lastSuccess: run,
    stale: false,
    snapshot: {
      asOf: '2026-11-12',
      jobId: 3,
      eligibleCount: 2,
      holdCount: 1,
      publishedAt: '2026-11-12T03:00:02Z',
      entries: [
        { rank: 1, externalId: 'invoice-reminders-smb', title: 'Пример: напоминания об оплате', category: 'Finance', segment: 'B2B', marketScore: 72, confidence: 74, founderFit: 27, evidenceGrade: 'B', prevRank: 1, scoreDelta: 0, isNew: false, assessedAsOf: '2026-11-12', carried: false },
        { rank: 2, externalId: 'focus-coworking-1on1', title: 'Фокус-коворкинг 1-на-1', category: 'Productivity', segment: 'B2C', marketScore: 64, confidence: 65, founderFit: 24, evidenceGrade: 'B', prevRank: 1, scoreDelta: -4, isNew: false, assessedAsOf: '2026-11-12', carried: false },
      ],
    },
    previousSnapshot: { asOf: '2026-11-11', jobId: 2, eligibleCount: 2, holdCount: 1, publishedAt: '2026-11-11T03:00:00Z' },
    newToday: [],
    watchlist: [{ externalId: 'str-guest-guide', title: 'Цифровой гид гостя', state: 'RESEARCH_HOLD', marketScore: 50, confidence: 56, evidenceGrade: 'C', holdReasons: ['Пробел опровергнут: в РФ уже есть RYNTO Guest Portal, GuestCom'], isNew: false }],
    changes: [{ kind: 'competitor', externalId: 'focus-coworking-1on1', title: 'Фокус-коворкинг 1-на-1', competitor: 'Пример: ФокусПара', market: 'ru', competitorKind: 'direct', url: null }],
    costs: { lastRun: 659, month: 1754, budgetPerRun: 2000, monthlyBudget: 40000, priceVersion: 'fixture-prices-2026-11' },
    totals: { candidates: 3, passed: 2, held: 1, discovered: 0 },
    diagnostics: null,
    ...over,
  };
}

const detail: MachineCandidateDetail = {
  feed: 'fixture',
  externalId: 'str-guest-guide',
  firstSeen: '2026-11-10',
  primaryJob: 'guest-guide',
  westernProduct: 'Touch Stay',
  rank: null,
  current: {
    id: 1, jobId: 3, asOf: '2026-11-12', title: 'Цифровой гид гостя', pitch: 'Гид квартиры', segment: 'B2B', category: 'Hospitality',
    scores: Object.fromEntries(DIMENSION_KEYS.map((k) => [k, k === 'westernPay' ? null : 1])) as MachineCandidateDetail['current']['scores'],
    confidenceComponents: { completeness: 80, corroboration: 30, recency: 90, reliability: 0, russiaValidation: 100 },
    founderFitComponents: null, marketScore: 50, confidence: 56, founderFit: null, evidenceGrade: 'C', state: 'RESEARCH_HOLD',
    holdReasons: ['Пробел опровергнут: в РФ уже есть RYNTO Guest Portal, GuestCom'], rationale: 'r', dimensionNotes: ['ruWeakness: 5 → 1'], models: ['a', 'b'], pipelineVersion: 'vl-004a-pipeline-1',
  },
  history: [],
  sources: [{ key: 's1', url: 'https://gcom.host/', publisher: 'GuestCom', region: 'ru', sourceType: 'company_self_report', fetchStatus: 'ok', httpStatus: 200, excerpt: 'Инструкции заселения', agent: 'skeptic' }],
  claims: [{ key: 'ru-gap', dimension: 'ruUnmetJob', text: 'В РФ нет отдельного сервиса гида гостя.', quote: 'Гиды не упоминаются', sourceKeys: ['s1'], status: 'contradicted', reason: 'опровергнуто: прямые конкуренты (РФ) — GuestCom', highImpact: true, supportingKeys: [], skepticVerdict: 'refuted', skepticReason: 'найдены прямые конкуренты: GuestCom' }],
  searches: [{ agent: 'skeptic', purpose: 'ru_competitors', region: 'ru', query: 'гостевой портал апартаменты', resultCount: 1, status: 'ok' }],
  competitors: [{ name: 'GuestCom', url: 'https://gcom.host/', market: 'ru', kind: 'direct', foundBy: 'skeptic', note: 'цена: Free 0 ₽', reason: 'на странице заявлен тот же сценарий (guest-guide)' }],
  reviews: [{ reviewer: 'skeptic', model: 'fixture-skeptic-v1', decision: 'challenge', summary: 'Независимые контр-запросы', findings: ['ru-gap: опровергнуто'] }],
};
detail.history = [detail.current];

function client(over: Partial<MachineClient> = {}): MachineClient {
  return {
    overview: async (feed) => (feed === 'live' ? overview({ feed: 'live', latestRun: null, lastSuccess: null, snapshot: null, watchlist: [], changes: [], stale: true }) : overview()),
    runs: async () => [run],
    candidate: async (_f, id) => (id === 'str-guest-guide' ? detail : null),
    ...over,
  };
}

function renderAt(path: string, c: MachineClient = client()) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <DataProvider data={demoData}>
        <MachineClientContext.Provider value={c}>
          <AppRoutes />
          <LocationProbe />
        </MachineClientContext.Provider>
      </DataProvider>
    </MemoryRouter>,
  );
  return user;
}

describe('Автоматический TOP-10 (machine dashboard)', () => {
  it('shows the machine TOP (N/10, no padding), honest emulation banner and no human-verified wording', async () => {
    renderAt('/machine');
    expect(await screen.findByRole('heading', { level: 1, name: 'Автоматический TOP-10' })).toBeInTheDocument();
    expect(screen.getByText('Эмуляция на фикстурах')).toBeInTheDocument();
    expect(screen.getByText(/не живое исследование/)).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Автоматический TOP-10' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText(/TOP не дополняется до десяти/)).toBeInTheDocument();
    expect(screen.getAllByText(/Проверено системой/).length).toBeGreaterThan(0);
    // only disclaimers mention humans; no element is ever LABELLED as human-checked
    expect(screen.queryByText(/^\s*проверено человеком\s*$/i)).not.toBeInTheDocument();
    expect(document.body.textContent).toMatch(/≠ проверено человеком|а не проверку человеком/);
    // the legacy DEMO banner does not apply to the machine feed
    expect(screen.queryByText('Демо-режим')).not.toBeInTheDocument();
  });

  it('lists automatic holds with reasons and competitor changes', async () => {
    renderAt('/machine');
    expect(await screen.findByText(/Пробел опровергнут: в РФ уже есть RYNTO Guest Portal/)).toBeInTheDocument();
    expect(screen.getByText('Пример: ФокусПара')).toBeInTheDocument();
    expect(screen.getByText('Новый конкурент в РФ')).toBeInTheDocument();
  });

  it('switching to the live feed shows an honest «no live runs, paid calls disabled» state', async () => {
    const user = renderAt('/machine');
    await screen.findByRole('table', { name: 'Автоматический TOP-10' });
    await user.click(screen.getByRole('radio', { name: 'Живой воркер' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('feed=live');
    expect(await screen.findByText('Живых прогонов ещё не было')).toBeInTheDocument();
    expect(screen.getByText(/платные вызовы выключены до отдельного разрешения/)).toBeInTheDocument();
  });

  it('a failed latest run keeps showing the last successful TOP with a failure indicator', async () => {
    const failed = { ...run, id: 4, asOf: '2026-11-13', status: 'partial' as const, partialReason: 'бюджет задания исчерпан' };
    renderAt('/machine', client({ overview: async () => overview({ latestRun: failed }) }));
    expect(await screen.findByText(/бюджет задания исчерпан — показан последний успешный TOP-10/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Автоматический TOP-10' })).toBeInTheDocument();
  });

  it('live feed: run diagnostics, ₽ costs and carried-forward entries are shown honestly', async () => {
    const liveRun = { ...run, feed: 'live' as const, jobKey: 'daily:live:2026-11-13', asOf: '2026-11-13', spent: 1834, budgetLimit: 20000 };
    const snap = overview().snapshot!;
    const live = overview({
      feed: 'live',
      latestRun: liveRun,
      lastSuccess: liveRun,
      snapshot: { ...snap, asOf: '2026-11-13', entries: [snap.entries[0]!, { ...snap.entries[1]!, carried: true, assessedAsOf: '2026-11-12' }] },
      costs: { lastRun: 1834, month: 5523, budgetPerRun: 20000, monthlyBudget: 40000, priceVersion: 'yandex-2026-11-12' },
      diagnostics: {
        jobId: 9, asOf: '2026-11-13', status: 'succeeded', independence: 'independent',
        searches: { ru: 31, west: 2, world: 12, failed: 1 },
        pages: { ok: 22, failed: 3, byStatus: { ok: 22, robots_disallowed: 2, blocked: 1 } },
        competitors: { ruDirect: 5, ruAdjacent: 1, distinctRu: 6, marketUnverified: 2 },
        independenceUnverified: 1,
        contradictions: 2,
        cost: { estimated: 4120, charged: 1834, observed: 1834, unknownCalls: 1, anomalies: 0 },
        averageConfidence: 47, partialReason: null, error: null, carried: 1,
      },
    });
    renderAt('/machine?feed=live', client({ overview: async () => live }));
    expect(await screen.findByText('Диагностика последнего прогона')).toBeInTheDocument();
    expect(screen.getByText(/две независимые модели/)).toBeInTheDocument();
    expect(screen.getByText(/запрещено robots\.txt: 2/)).toBeInTheDocument();
    expect(screen.getByText(/прямых 5 · смежных 1/)).toBeInTheDocument();
    expect(screen.getByText(/рынок не подтверждён \(не учтены\): 2/)).toBeInTheDocument();
    expect(screen.getByText(/источников: 1 — учтены как «тип не установлен»/)).toBeInTheDocument();
    expect(screen.getByText(/41,20 ₽ → 18,34 ₽/)).toBeInTheDocument();
    expect(screen.getByText(/без подтверждённой стоимости: 1 \(учтён максимум\)/)).toBeInTheDocument();
    expect(screen.getAllByText(/оценка от 12 нояб.*не перепроверялась|оценка от .*не перепроверялась/).length).toBeGreaterThan(0);
    expect(screen.getByText(/только ручной разовый запуск/)).toBeInTheDocument();
  });

  it('API errors render a retryable error state', async () => {
    renderAt('/machine', client({ overview: () => Promise.reject(new ApiError('Локальный API недоступен.', 'unavailable')) }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/недоступн/);
  });

  it('candidate dossier: hold reasons, refuted claim, skeptic-found competitor, «Человек не проверял»', async () => {
    renderAt('/machine/str-guest-guide?feed=fixture');
    expect(await screen.findByRole('heading', { level: 1, name: 'Цифровой гид гостя' })).toBeInTheDocument();
    expect(screen.getByText('Человек не проверял')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Отложено автоматически/);
    expect(screen.getByText('Опровергнуто')).toBeInTheDocument();
    expect(screen.getByText('найден скептиком')).toBeInTheDocument();
    const dims = screen.getByRole('list', { name: 'Разбивка машинного балла' });
    expect(within(dims).getAllByRole('listitem')).toHaveLength(12);
    expect(within(dims).getByText('?')).toBeInTheDocument();
  });

  it('unknown candidate → not-found state', async () => {
    renderAt('/machine/nope-nope?feed=fixture');
    expect(await screen.findByText('Кандидат не найден')).toBeInTheDocument();
  });

  it('is the first item of the main navigation', async () => {
    renderAt('/machine');
    const nav = await screen.findByRole('navigation', { name: 'Основная навигация' });
    expect(within(nav).getAllByRole('link')[0]).toHaveTextContent('Автоматический TOP-10');
  });
});
