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
export function useLoad<T>(key: string, fn: () => Loadable<T>): LoadState<T> {
  const [tick, setTick] = useState(0);
  const retry = useRef(() => setTick((t) => t + 1)).current;
  const fullKey = `${key}#${tick}`;
  const result = useMemo(() => {
    try {
      return { value: fn() };
    } catch (e) {
      return { error: e instanceof Error ? e : new Error(String(e)) };
    }
    // `fn` is intentionally keyed by `key` (callers pass inline closures).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKey]);
  const [asyncState, setAsyncState] = useState<{ key: string; data?: T; error?: Error } | null>(null);

  useEffect(() => {
    if (!('value' in result) || !isPromise(result.value)) return;
    let alive = true;
    result.value.then(
      (data) => alive && setAsyncState({ key: fullKey, data }),
      (error: unknown) => alive && setAsyncState({ key: fullKey, error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      alive = false;
    };
  }, [result, fullKey]);

  if ('error' in result && result.error) return { status: 'error', error: result.error, retry };
  const v = (result as { value: Loadable<T> }).value;
  if (!isPromise(v)) return { status: 'ready', data: v, retry };
  if (!asyncState || asyncState.key !== fullKey) return { status: 'loading', retry };
  if (asyncState.error) return { status: 'error', error: asyncState.error, retry };
  return { status: 'ready', data: asyncState.data as T, retry };
}
