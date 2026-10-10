import { useCallback, useEffect, useRef, useState } from 'react';

interface State<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Reads something from the box, and optionally keeps reading it. */
export function useBoxData<T>(
  read: () => Promise<T>,
  options: { everyMs?: number; pause?: boolean } = {},
) {
  const { everyMs, pause = false } = options;
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: true });

  // Kept in a ref so changing it does not restart the poll on every render.
  const readRef = useRef(read);
  readRef.current = read;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await readRef.current();
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (err) {
      if (alive.current) {
        setState((prev) => ({ ...prev, error: (err as Error).message, loading: false }));
      }
    }
  }, []);

  useEffect(() => {
    if (pause) return;
    void refresh();
    if (!everyMs) return;
    const timer = setInterval(() => { void refresh(); }, everyMs);
    return () => clearInterval(timer);
  }, [refresh, everyMs, pause]);

  return { ...state, refresh };
}
