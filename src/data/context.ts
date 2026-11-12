import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DataMode } from '../domain/types';
import { demoData } from './demo';
import { createDemoSource, type DataSource, type Loadable } from './source';

export interface DataContextValue {
  mode: DataMode;
  source: DataSource;
  /** Switch modes explicitly (persists the choice); undefined when the mode is fixed (tests). */
  setMode?: (m: DataMode) => void;
}

export const DataContext = createContext<DataContextValue>({ mode: 'demo', source: createDemoSource(demoData) });

export function useDataSource(): DataContextValue {
  return useContext(DataContext);
}

export function useMode(): DataMode {
  return useContext(DataContext).mode;
}

export type LoadState<T> =
  | { status: 'loading'; retry: () => void }
  | { status: 'ready'; data: T; retry: () => void }
  | { status: 'error'; error: Error; retry: () => void };

function isPromise<T>(v: Loadable<T>): v is Promise<T> {
  return typeof (v as Promise<T>)?.then === 'function';
}

/**
 * Load a value from the active source. Synchronous DEMO values render immediately (no flicker);
 * REAL promises go through explicit loading → ready | error states.
 */
type Settled<T> = { ok: true; data: T } | { ok: false; error: Error };

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export function useLoad<T>(key: string, fn: () => Loadable<T>): LoadState<T> {
  const [tick, setTick] = useState(0);
  const retry = useRef(() => setTick((t) => t + 1)).current;
  const fullKey = `${key}#${tick}`;
  const result = useMemo((): { sync: Settled<T> } | { pending: Promise<Settled<T>> } => {
    try {
      const v = fn();
      // A promise is converted into a never-rejecting «settled» promise at the moment it is
      // created, so a fast failure can never surface as an unhandled rejection before the effect
      // below subscribes to it.
      if (isPromise(v)) return { pending: v.then((data): Settled<T> => ({ ok: true, data }), (e): Settled<T> => ({ ok: false, error: toError(e) })) };
      return { sync: { ok: true, data: v } };
    } catch (e) {
      return { sync: { ok: false, error: toError(e) } };
    }
    // `fn` is intentionally keyed by `key` (callers pass inline closures).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKey]);
  const [asyncState, setAsyncState] = useState<{ key: string; settled: Settled<T> } | null>(null);

  useEffect(() => {
    if (!('pending' in result)) return;
    let alive = true;
    void result.pending.then((settled) => {
      if (alive) setAsyncState({ key: fullKey, settled });
    });
    return () => {
      alive = false;
    };
  }, [result, fullKey]);

  const settled = 'sync' in result ? result.sync : asyncState?.key === fullKey ? asyncState.settled : null;
  if (!settled) return { status: 'loading', retry };
  return settled.ok ? { status: 'ready', data: settled.data, retry } : { status: 'error', error: settled.error, retry };
}
