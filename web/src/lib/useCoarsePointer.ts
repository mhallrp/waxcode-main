import { useEffect, useState } from 'react';

/** Whether this is being used with a FINGER rather than a mouse or trackpad. */
const QUERY = '(pointer: coarse)';

export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => {
    try {
      return window.matchMedia?.(QUERY).matches ?? false;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const media = window.matchMedia?.(QUERY);
    if (!media) return undefined;
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  return coarse;
}
