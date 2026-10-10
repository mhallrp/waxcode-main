import { useEffect, useState } from 'react';
import { api } from './api';
import { useResume } from './useResume';

/** Whether the box is answering at all. */

const EVERY_MS = 5000;
/** Two, not one. */
const MISSES_BEFORE_OFFLINE = 2;

export function useReachable(): boolean {
  const [reachable, setReachable] = useState(true);
  /** Misses counted while the app was away mean nothing: the heartbeat was not running. */
  const resume = useResume();

  useEffect(() => {
    let misses = 0;
    let stopped = false;

    const beat = async () => {
      try {
        await api.version();
        misses = 0;
        if (!stopped) setReachable(true);
      } catch {
        misses += 1;
        if (!stopped && misses >= MISSES_BEFORE_OFFLINE) setReachable(false);
      }
    };

    void beat();
    const timer = setInterval(() => { void beat(); }, EVERY_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [resume]);

  return reachable;
}
