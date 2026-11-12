import type { DataMode } from '../domain/types';

export const MODE_KEY = 'vl.mode';

function readStoredMode(): DataMode | null {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'demo' || v === 'real' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Explicit mode resolution, highest priority first:
 * 1. `?mode=demo|real` in the URL, 2. the saved choice, 3. VITE_DATA_MODE, 4. `real`.
 * REAL is the default so a fresh project honestly shows an empty research database.
 */
export function resolveInitialMode(search: string = typeof window !== 'undefined' ? window.location.search : ''): DataMode {
  const q = new URLSearchParams(search).get('mode');
  if (q === 'demo' || q === 'real') return q;
  const stored = readStoredMode();
  if (stored) return stored;
  const env = import.meta.env.VITE_DATA_MODE;
  return env === 'demo' ? 'demo' : 'real';
}

