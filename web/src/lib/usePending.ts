import { useEffect, useState } from 'react';

/** Shows the result of a control the moment it is pressed, without waiting for the box to agree. */
export function usePending<T>(
  actual: T,
  holdMs = 1200,
  /** How "the box agrees" is decided. */
  isEqual: (pending: T, real: T) => boolean = Object.is,
): [T, (value: T) => void, () => void] {
  const [pending, setPending] = useState<{ value: T; at: number } | null>(null);

  useEffect(() => {
    if (!pending) return undefined;
    // The box agrees - nothing left to be optimistic about.
    if (isEqual(pending.value, actual)) {
      setPending(null);
      return undefined;
    }
    const remaining = holdMs - (Date.now() - pending.at);
    if (remaining <= 0) {
      setPending(null);
      return undefined;
    }
    const timer = setTimeout(() => setPending(null), remaining);
    return () => clearTimeout(timer);
  }, [pending, actual, holdMs, isEqual]);

  return [
    pending ? pending.value : actual,
    (value: T) => setPending({ value, at: Date.now() }),
    () => setPending(null),
  ];
}
