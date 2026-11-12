import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { DataMode, Dataset } from '../domain/types';
import { DataContext } from './context';
import { demoData } from './demo';
import { MODE_KEY, resolveInitialMode } from './mode';
import { createApiSource, createDemoSource, type DataSource } from './source';

/**
 * - `data` (tests / fixed DEMO): DEMO source over that dataset, mode fixed.
 * - `source` (tests): a given source, mode fixed.
 * - neither: app mode — resolved from URL/storage/env and switchable.
 */
export function DataProvider({ data, source, children }: { data?: Dataset; source?: DataSource; children: ReactNode }) {
  const fixed = data ? createDemoSource(data) : source;
  const [mode, setModeState] = useState<DataMode>(() => (fixed ? fixed.mode : resolveInitialMode()));
  const setMode = useCallback((m: DataMode) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage unavailable — mode is kept for this tab only */
    }
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('mode', m);
      window.history.replaceState(window.history.state, '', url);
    }
    setModeState(m);
  }, []);

  const value = useMemo(() => {
    if (fixed) return { mode: fixed.mode, source: fixed };
    const s = mode === 'demo' ? createDemoSource(demoData) : createApiSource();
    return { mode, source: s, setMode };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, data, source]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
