/** Translates the box's clock into this browser's */

/** How far back the minimum is taken. At ~20 statuses a second that is ~300 samples. */
export const CLOCK_WINDOW_MS = 15_000;

export interface BoxClock {
  /** The local time at which the box took a reading stamped `sentAt`. */
  localTimeOf(sentAt: number | null | undefined, now: number): number;
  /** The current estimate, for tests and diagnostics. Null until a stamped status has been seen. */
  readonly offset: number | null;
}

export function createBoxClock({ windowMs = CLOCK_WINDOW_MS } = {}): BoxClock {
  /** Monotonic deque - `observed` strictly increasing front to back */
  const samples: { at: number; observed: number }[] = [];

  return {
    localTimeOf(sentAt, now) {
      /** An unstamped status is from a box too old to send one. */
      if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return now;

      const observed = now - sentAt;

      // Anything no smaller than this sample can never be the minimum again - it is both older and larger.
      for (let last = samples.at(-1); last && last.observed >= observed; last = samples.at(-1)) samples.pop();
      samples.push({ at: now, observed });
      // Never emptied: with nothing in the window the last known estimate still beats no estimate.
      for (let first = samples[0]; samples.length > 1 && first && first.at <= now - windowMs; first = samples[0]) samples.shift();

      return sentAt + (samples[0]?.observed ?? observed);
    },
    get offset() {
      return samples[0]?.observed ?? null;
    },
  };
}
