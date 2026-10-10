/** Tracks whether any load-triggered on-demand waveform/beat grid/key computation is currently active */
let activeCount = 0;
let waiters = [];

/** Call once when an on-demand job starts. Must be paired with a later endPriorityWork call. */
export function beginPriorityWork() {
  activeCount += 1;
}

/** Call once when that same on-demand job finishes - success, failure, or abort, doesn't matter. */
export function endPriorityWork() {
  activeCount -= 1;
  if (activeCount <= 0) {
    activeCount = 0;
    const toResolve = waiters;
    waiters = [];
    for (const resolve of toResolve) resolve();
  }
}

export function isPriorityActive() {
  return activeCount > 0;
}

/** Resolves immediately if nothing's active right now, otherwise once the last active job ends. */
export function waitUntilIdle() {
  if (activeCount === 0) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}

/** Test-only - resets module state between test files sharing this singleton. */
export function _resetForTests() {
  activeCount = 0;
  waiters = [];
}
