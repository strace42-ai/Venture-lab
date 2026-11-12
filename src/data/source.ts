/**
 * Data sources: the single seam between the UI and its data.
 *
 * - DEMO: the typed VL-001 fixture, computed synchronously in the browser.
 * - REAL: the local read-only API (server/), which runs the SAME src/domain selectors
 *   over records loaded from PostgreSQL. The UI never mixes the two.
 */
import { buildIdeaDetail, buildOverview, buildRadarView, type IdeaDetailView, type OverviewView, type RadarQuery, type RadarView } from '../domain/selectors';
import type { DataMode, Dataset, LiveDataset } from '../domain/types';
import { buildDemoJournal, demoFrozenSnapshots } from './demo-journal';
import {
  buildEvidenceQueue,
  compareSnapshots,
  snapshotMeta,
  type EvidenceQuery,
  type EvidenceQueueView,
  type JournalView,
  type SnapshotComparison,
  type SnapshotMeta,
} from '../domain/research-ops';

export type Loadable<T> = T | Promise<T>;

export interface DataSource {
  mode: DataMode;
  overview(): Loadable<OverviewView>;
  radar(query: RadarQuery, page: number): Loadable<RadarView>;
  idea(idOrSlug: string): Loadable<IdeaDetailView | null>;
  /** VL-003 — research journal (runs + manual reviews). */
  journal(): Loadable<JournalView>;
  /** VL-003 — evidence review queue. */
  evidence(query: EvidenceQuery, page: number): Loadable<EvidenceQueueView>;
  /** VL-003 — stored (or, in DEMO, reconstructed) snapshots, newest first. */
  snapshots(): Loadable<SnapshotMeta[]>;
  /** VL-003 — compare two snapshots from their frozen entries. */
  compare(a: string, b: string): Loadable<SnapshotComparison>;
}

export function createDemoSource(data: Dataset): DataSource {
  return {
    mode: 'demo',
    overview: () => buildOverview(data),
    radar: (query) => buildRadarView(data, query),
    idea: (slug) => buildIdeaDetail(data, slug),
    journal: () => buildDemoJournal(data),
    evidence: (query) => buildEvidenceQueue(data, query),
    snapshots: () => demoFrozenSnapshots(data).map(snapshotMeta),
    compare: (a, b) => {
      const all = demoFrozenSnapshots(data);
      const x = all.find((s) => s.id === a);
      const y = all.find((s) => s.id === b);
      if (!x || !y) throw new Error('Срез не найден');
      return compareSnapshots(x, y);
    },
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
export const EVIDENCE_PAGE_SIZE = 50;

type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * API-backed source for ONE isolated dataset: `real` (human-reviewed) or `test` (synthetic imports).
 * The dataset is sent with every request, so a source can never read the other dataset.
 */
export function createApiSource(dataset: LiveDataset = 'real', base = '/api', fetchImpl: FetchLike = (u, i) => fetch(u, i), timeoutMs = 10_000): DataSource {
  const ds = `dataset=${dataset}`;
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
    // Gateway errors (e.g. the dev proxy with the API stopped) mean «unavailable», whatever the body.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      let msg: string | undefined;
      try {
        msg = ((await res.json()) as { error?: { message?: string } })?.error?.message;
      } catch {
        msg = undefined;
      }
      throw new ApiError(msg ?? 'Локальный API недоступен. Запустите `npm run api` (и базу данных).', 'unavailable', res.status);
    }
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
    mode: dataset,
    overview: async () => {
      const v = await get<OverviewView>(`/overview?${ds}`);
      if (!v || !Array.isArray(v.ranking) || !v.kpis) throw new ApiError('Ответ /api/overview не соответствует контракту.', 'invalid');
      return v;
    },
    radar: async (query, page) => {
      const p = new URLSearchParams({ dataset, sort: query.sort, page: String(page), pageSize: String(RADAR_PAGE_SIZE) });
      if (query.q) p.set('q', query.q);
      if (query.category !== 'all') p.set('category', query.category);
      if (query.stage !== 'all') p.set('stage', query.stage);
      const v = await get<RadarView>(`/ideas?${p.toString()}`);
      if (!v || !Array.isArray(v.rows)) throw new ApiError('Ответ /api/ideas не соответствует контракту.', 'invalid');
      return v;
    },
    idea: (slug) => get<IdeaDetailView>(`/ideas/${encodeURIComponent(slug)}?${ds}`, true),
    journal: async () => {
      const v = await get<JournalView>(`/journal?${ds}`);
      if (!v || !Array.isArray(v.runs)) throw new ApiError('Ответ /api/journal не соответствует контракту.', 'invalid');
      return v;
    },
    evidence: async (q, page) => {
      const p = new URLSearchParams({ dataset, status: q.status, market: q.market, sourceType: q.sourceType, idea: q.idea, dimension: q.dimension, risk: q.risk, page: String(page), pageSize: String(EVIDENCE_PAGE_SIZE) });
      if (q.minAgeDays !== null) p.set('minAgeDays', String(q.minAgeDays));
      if (q.missingUrl) p.set('missingUrl', 'true');
      const v = await get<EvidenceQueueView>(`/evidence?${p.toString()}`);
      if (!v || !Array.isArray(v.rows)) throw new ApiError('Ответ /api/evidence не соответствует контракту.', 'invalid');
      return v;
    },
    snapshots: async () => {
      const v = await get<{ snapshots: { id: string; asOf: string; entryCount: number }[] }>(`/snapshots?${ds}`);
      if (!v || !Array.isArray(v.snapshots)) throw new ApiError('Ответ /api/snapshots не соответствует контракту.', 'invalid');
      return v.snapshots.map((x) => ({ id: x.id, asOf: x.asOf, entryCount: x.entryCount, kind: 'stored' as const }));
    },
    compare: async (a, b) => {
      const p = new URLSearchParams({ dataset, a, b });
      const v = await get<SnapshotComparison>(`/snapshots/compare?${p.toString()}`);
      if (!v || !Array.isArray(v.rows)) throw new ApiError('Ответ /api/snapshots/compare не соответствует контракту.', 'invalid');
      return v;
    },
  };
}
