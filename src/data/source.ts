/**
 * Data sources: the single seam between the UI and its data.
 *
 * - DEMO: the typed VL-001 fixture, computed synchronously in the browser.
 * - REAL: the local read-only API (server/), which runs the SAME src/domain selectors
 *   over records loaded from PostgreSQL. The UI never mixes the two.
 */
import { buildIdeaDetail, buildOverview, buildRadarView, type IdeaDetailView, type OverviewView, type RadarQuery, type RadarView } from '../domain/selectors';
import type { DataMode, Dataset } from '../domain/types';

export type Loadable<T> = T | Promise<T>;

export interface DataSource {
  mode: DataMode;
  overview(): Loadable<OverviewView>;
  radar(query: RadarQuery, page: number): Loadable<RadarView>;
  idea(idOrSlug: string): Loadable<IdeaDetailView | null>;
}

export function createDemoSource(data: Dataset): DataSource {
  return {
    mode: 'demo',
    overview: () => buildOverview(data),
    radar: (query) => buildRadarView(data, query),
    idea: (slug) => buildIdeaDetail(data, slug),
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'unavailable' | 'http' | 'invalid',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const RADAR_PAGE_SIZE = 50;

type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export function createApiSource(base = '/api', fetchImpl: FetchLike = (u, i) => fetch(u, i), timeoutMs = 10_000): DataSource {
  async function get<T>(path: string, allow404 = false): Promise<T | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`${base}${path}`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    } catch {
      throw new ApiError('Локальный API недоступен. Запустите `npm run api` (и базу данных).', 'unavailable');
    } finally {
      clearTimeout(timer);
    }
    if (allow404 && res.status === 404) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ApiError(`Некорректный ответ API (${res.status}).`, 'invalid', res.status);
    }
    if (!res.ok) {
      const msg = (body as { error?: { message?: string } })?.error?.message ?? `Ошибка API (${res.status})`;
      throw new ApiError(msg, res.status === 503 ? 'unavailable' : 'http', res.status);
    }
    return body as T;
  }

  return {
    mode: 'real',
    overview: async () => {
      const v = await get<OverviewView>('/overview');
      if (!v || !Array.isArray(v.ranking) || !v.kpis) throw new ApiError('Ответ /api/overview не соответствует контракту.', 'invalid');
      return v;
    },
    radar: async (query, page) => {
      const p = new URLSearchParams({ sort: query.sort, page: String(page), pageSize: String(RADAR_PAGE_SIZE) });
      if (query.q) p.set('q', query.q);
      if (query.category !== 'all') p.set('category', query.category);
      if (query.stage !== 'all') p.set('stage', query.stage);
      const v = await get<RadarView>(`/ideas?${p.toString()}`);
      if (!v || !Array.isArray(v.rows)) throw new ApiError('Ответ /api/ideas не соответствует контракту.', 'invalid');
      return v;
    },
    idea: (slug) => get<IdeaDetailView>(`/ideas/${encodeURIComponent(slug)}`, true),
  };
}
