/**
 * Client for the VL-004A machine-research API (read-only). Independent of the DEMO/REAL/TEST data
 * modes: the machine dataset is its own feed ('fixture' emulation or 'live' worker).
 */
import { createContext, useContext } from 'react';
import type { MachineCandidateDetail, MachineFeed, MachineOverview, MachineRun } from '../domain/machine';
import { ApiError } from './source';

export interface MachineClient {
  overview(feed: MachineFeed): Promise<MachineOverview>;
  runs(feed: MachineFeed): Promise<MachineRun[]>;
  candidate(feed: MachineFeed, id: string): Promise<MachineCandidateDetail | null>;
}

type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function createMachineApiClient(base = '/api', fetchImpl: FetchLike = (u, i) => fetch(u, i), timeoutMs = 10_000): MachineClient {
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
    if (res.status === 502 || res.status === 503 || res.status === 504) throw new ApiError('Локальный API или база недоступны.', 'unavailable', res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ApiError(`Некорректный ответ API (${res.status}).`, 'invalid', res.status);
    }
    if (!res.ok) throw new ApiError((body as { error?: { message?: string } })?.error?.message ?? `Ошибка API (${res.status})`, 'http', res.status);
    return body as T;
  }
  return {
    overview: async (feed) => {
      const v = await get<MachineOverview>(`/machine/overview?feed=${feed}`);
      if (!v || !Array.isArray(v.watchlist) || !Array.isArray(v.changes)) throw new ApiError('Ответ /api/machine/overview не соответствует контракту.', 'invalid');
      return v;
    },
    runs: async (feed) => (await get<{ runs: MachineRun[] }>(`/machine/runs?feed=${feed}`))?.runs ?? [],
    candidate: (feed, id) => get<MachineCandidateDetail>(`/machine/candidates/${encodeURIComponent(id)}?feed=${feed}`, true),
  };
}

export const MachineClientContext = createContext<MachineClient>(createMachineApiClient());

export function useMachineClient(): MachineClient {
  return useContext(MachineClientContext);
}
