/** Follows a value that arrives in jumps, so a reveal reads as one movement rather than a series of steps. */

/** How much of the remaining gap is closed per second. Higher is snappier, not shorter. */
const RATE = 5;

/** Below this the remaining distance is under a pixel on any waveform anybody is looking at. */
const SETTLED = 0.001;

export function createFractionEase(initial = 0) {
  let current = initial;
  let last: number | null = null;

  return (target: number, now: number): number => {
    /** The first frame has no interval to ease over, and a track whose waveform was already cached arrives complete */
    if (last === null) {
      last = now;
      current = target;
      return current;
    }

    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    /** Backwards means a DIFFERENT track, not a waveform un-loading. */
    if (target < current) {
      current = target;
      return current;
    }

    current += (target - current) * (1 - Math.exp(-RATE * dt));
    // Snapped, so a finished waveform is exactly 1 rather than 0.9994 - which never finishes.
    if (Math.abs(target - current) < SETTLED) current = target;
    return current;
  };
}
