import { useSearchParams } from 'react-router-dom';
import type { MachineFeed } from '../domain/machine';

/** Machine feed from the URL (`?feed=fixture|live`). Default: fixture emulation (live worker = VL-004B). */
export function useFeed(): [MachineFeed, (f: MachineFeed) => void] {
  const [params, setParams] = useSearchParams();
  const feed: MachineFeed = params.get('feed') === 'live' ? 'live' : 'fixture';
  return [
    feed,
    (f) => {
      const next = new URLSearchParams(params);
      next.set('feed', f);
      setParams(next, { replace: true });
    },
  ];
}
