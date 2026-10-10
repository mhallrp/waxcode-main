import { useEffect, useRef, useState } from 'react';

/** Keeps an overlay mounted long enough to animate both ways. */
export function usePresented(open: boolean, durationMs: number) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    if (open) {
      setMounted(true);
      /** Two frames, not one. */
      const outer = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(outer);
    }
    setShown(false);
    timer.current = setTimeout(() => setMounted(false), durationMs);
    return () => clearTimeout(timer.current);
  }, [open, durationMs]);

  return { mounted, shown };
}
