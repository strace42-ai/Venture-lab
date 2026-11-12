import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { DataProvider } from '../data/DataContext';
import { demoData } from '../data/demo';
import { fullRanking, radarRows } from '../domain/selectors';
import type { DemoDataset, Experiment } from '../domain/types';
import { verifiedPaymentsPhrase } from '../lib/format';

function withVerifiedPayments(n: number): DemoDataset {
  const exp = demoData.experiments[0]!;
  const paid: Experiment = { ...exp, funnel: { ...exp.funnel, paymentsVerified: n } };
  return { ...demoData, experiments: [paid, ...demoData.experiments.slice(1)] };
}

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="loc">{loc.pathname + loc.search}</output>;
}

function renderAt(path: string, data: DemoDataset = demoData) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <DataProvider data={data}>
        <AppRoutes />
        <LocationProbe />
      </DataProvider>
    </MemoryRouter>,
  );
  return user;
}

const ranking = fullRanking(demoData);

describe('Overview', () => {
  it('shows the computed top-10 in rank order with demo labels', async () => {
    renderAt('/');
    const list = await screen.findByRole('list', { name: 'Топ возможностей по рейтингу' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(10);
    ranking.slice(0, 10).forEach((e, i) => {
      expect(within(rows[i]!).getByRole('link', { name: e.idea.title })).toBeInTheDocument();
    });
    expect(screen.getAllByText(/демо/i).length).toBeGreaterThan(5);
    expect(screen.getByText(/Демо-журнал\. Это не live-статусы агентов/)).toBeInTheDocument();
  });

  it('filters the top-10 by segment and re-sorts by confidence', async () => {
    const user = renderAt('/');
    const list = await screen.findByRole('list', { name: 'Топ возможностей по рейтингу' });
    await user.click(screen.getByRole('radio', { name: 'B2C' }));
    const b2c = ranking.slice(0, 10).filter((e) => e.idea.segment === 'B2C');
    expect(within(list).getAllByRole('listitem')).toHaveLength(b2c.length);

    await user.click(screen.getByRole('radio', { name: 'Все' }));
    await user.click(screen.getByRole('radio', { name: 'Уверенность' }));
    const titles = within(screen.getByRole('list', { name: 'Топ возможностей по рейтингу' }))
      .getAllByRole('link')
      .map((a) => a.textContent);
    const expected = [...ranking.slice(0, 10)].sort((a, b) => b.confidence - a.confidence || a.rank - b.rank).map((e) => e.idea.title);
    expect(titles).toEqual(expected);
  });

  it('supports arrow-key navigation in segmented controls', async () => {
    const user = renderAt('/');
    await screen.findByRole('list', { name: 'Топ возможностей по рейтингу' });
    const rankRadio = screen.getByRole('radio', { name: 'Рейтинг' });
    rankRadio.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Уверенность' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Уверенность' })).toHaveFocus();
  });

  it('opens the idea dossier from the leaderboard', async () => {
    const user = renderAt('/');
    const lead = ranking[0]!;
    const list = await screen.findByRole('list', { name: 'Топ возможностей по рейтингу' });
    await user.click(within(list).getByRole('link', { name: lead.idea.title }));
    expect(await screen.findByRole('heading', { level: 1, name: lead.idea.title })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(`/ideas/${lead.idea.slug}`);
  });
});

describe('Overview headline (regression: paid count is derived, not hardcoded)', () => {
  it('formats zero / singular / few / many correctly', () => {
    expect(verifiedPaymentsPhrase(0)).toBe('ни одной подтверждённой оплаты');
    expect(verifiedPaymentsPhrase(1)).toBe('1 подтверждённая оплата');
    expect(verifiedPaymentsPhrase(3)).toBe('3 подтверждённые оплаты');
    expect(verifiedPaymentsPhrase(5)).toBe('5 подтверждённых оплат');
    expect(verifiedPaymentsPhrase(21)).toBe('21 подтверждённая оплата');
  });

  it('says «ни одной» with the demo data (0 verified)', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('ни одной подтверждённой оплаты');
  });

  it('reflects a positive verified-payment count in the headline and KPI', async () => {
    renderAt('/', withVerifiedPayments(2));
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('2 подтверждённые оплаты');
    expect(h1).not.toHaveTextContent('ни одной');
    const kpis = screen.getByRole('region', { name: 'Ключевые показатели (демо)' });
    expect(within(kpis).getByText('Подтверждённые оплаты').closest('.kpi')).toHaveTextContent('2');
  });
});

describe('Overview strongest find (regression: no critical-risk fallback)', () => {
  it('shows an explicit review state when no idea is eligible', async () => {
    const allCritical: DemoDataset = {
      ...demoData,
      ideas: demoData.ideas.map((i) => ({ ...i, riskFlags: [...i.riskFlags, 'legal'] })),
    };
    renderAt('/', allCritical);
    expect(await screen.findByRole('heading', { name: 'Нет находки без критических рисков' })).toBeInTheDocument();
    expect(screen.getByText('Требует ревью')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Открыть досье/ })).not.toBeInTheDocument();
  });
});

describe('Radar', () => {
  async function tableRows() {
    const table = await screen.findByRole('table', { name: /Идеи на радаре/ });
    return within(table).getAllByRole('row').slice(1);
  }

  it('lists every idea, then narrows by search query', async () => {
    const user = renderAt('/radar');
    expect(await tableRows()).toHaveLength(demoData.ideas.length);
    await user.type(screen.getByLabelText('Поиск'), 'кофе');
    const rows = await tableRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Инвентаризация для кофеен по фото');
    expect(screen.getByTestId('loc')).toHaveTextContent('q=%D0%BA%D0%BE%D1%84%D0%B5');
  });

  it('filters by category and stage, shows an empty state and resets', async () => {
    const user = renderAt('/radar');
    await user.selectOptions(await screen.findByLabelText('Категория'), 'LegalTech');
    let rows = await tableRows();
    const legal = demoData.ideas.filter((i) => i.category === 'LegalTech');
    expect(rows).toHaveLength(legal.length);

    await user.selectOptions(screen.getByLabelText('Стадия'), 'validating');
    expect(await screen.findByText('Ничего не найдено')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /Сбросить фильтры/ })[0]!);
    rows = await tableRows();
    expect(rows).toHaveLength(demoData.ideas.length);
  });

  it('sorts by most recently updated', async () => {
    const user = renderAt('/radar');
    await tableRows();
    await user.click(screen.getByRole('radio', { name: 'Свежие' }));
    const rows = await tableRows();
    const expected = radarRows(demoData, { q: '', category: 'all', stage: 'all', sort: 'recent' });
    rows.forEach((row, i) => expect(row).toHaveTextContent(expected[i]!.idea.title));
    expect(screen.getByTestId('loc')).toHaveTextContent('sort=recent');
  });

  it('reads the query from the URL (global search entry point)', async () => {
    renderAt('/radar?q=%D1%82%D0%B5%D0%BD%D0%B4%D0%B5%D1%80');
    const rows = await tableRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('госзакупок');
  });
});

describe('Dossier', () => {
  it('renders all 12 dimensions, separate confidence, risks and validation plan', async () => {
    renderAt('/ideas/legal-meeting-minutes');
    await screen.findByRole('heading', { level: 1 });
    const dims = screen.getByRole('list', { name: 'Разбивка балла по критериям' });
    expect(within(dims).getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByText('Уверенность в доказательствах')).toBeInTheDocument();
    expect(screen.getByText('Соответствие основателю')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'План первой валидации' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Риски' })).toBeInTheDocument();
    // Unknown component is surfaced explicitly.
    expect(screen.getByLabelText('Оценка неизвестна')).toBeInTheDocument();
    expect(screen.getAllByText('источник не привязан').length).toBeGreaterThan(0);
  });

  it('shows a not-found state for unknown ideas', async () => {
    renderAt('/ideas/does-not-exist');
    expect(await screen.findByText('Досье не найдено')).toBeInTheDocument();
  });
});

describe('Navigation', () => {
  it('renders intentional placeholders for secondary routes', async () => {
    renderAt('/portfolio');
    expect(await screen.findByText(/Раздел ещё не реализован/)).toBeInTheDocument();
    expect(screen.getByText(/без выдуманной выручки/)).toBeInTheDocument();
  });

  it('opens the mobile drawer and closes it with Escape', async () => {
    const user = renderAt('/');
    await screen.findByRole('list', { name: 'Топ возможностей по рейтингу' });
    await user.click(screen.getByRole('button', { name: 'Открыть меню' }));
    const dialog = screen.getByRole('dialog', { name: 'Навигация' });
    expect(within(dialog).getByRole('link', { name: /Радар/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('navigates via the sidebar', async () => {
    const user = renderAt('/');
    await screen.findByRole('list', { name: 'Топ возможностей по рейтингу' });
    const sidebar = screen.getByRole('complementary', { name: 'Боковая панель' });
    await user.click(within(sidebar).getByRole('link', { name: /Журнал исследований/ }));
    expect(await screen.findByText(/Каждый прогон исследования/)).toBeInTheDocument();
  });

  it('global search submits to the radar', async () => {
    const user = renderAt('/');
    await screen.findByRole('list', { name: 'Топ возможностей по рейтингу' });
    await user.type(screen.getByRole('searchbox', { name: 'Поиск идей на радаре' }), 'стомат{Enter}');
    const table = await screen.findByRole('table', { name: /Идеи на радаре/ });
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(1);
  });
});
