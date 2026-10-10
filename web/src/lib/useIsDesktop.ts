import { useEffect, useState } from 'react';

/** Whether to lay the app out for a desktop rather than a phone. */
const DESKTOP_QUERY = '(min-width: 1024px) and (pointer: fine)';

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => matches());

  useEffect(() => {
    const query = window.matchMedia?.(DESKTOP_QUERY);
    if (!query) return undefined;
    const onChange = () => setIsDesktop(query.matches);
    /** Live, because a desktop window gets dragged narrower and a laptop gets an external display plugged in. */
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}

/** Separate so the initial state can be computed without a render, and a test can call it directly. */
export function matches(): boolean {
  try {
    return window.matchMedia?.(DESKTOP_QUERY).matches === true;
  } catch {
    /** jsdom without matchMedia, and any browser old enough to lack it: the phone layout is the safe answer, since it works at every width. */
    return false;
  }
}
