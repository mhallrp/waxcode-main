/** Watching an update happen, from a page that is about to be restarted underneath it. */

const KEY = 'waxcode.update';

/** Past this, something has gone wrong and saying nothing is worse than guessing. */
export const STALL_MS = 8 * 60_000;

export interface UpdateWatch {
  /** The version being installed, as the box reported it when accepting the request. */
  target: string;
  startedAt: number;
}

export type Stage =
  /** Reachable, still the old version: downloading, staging, compiling xwax. */
  | 'preparing'
  /** Not answering. The restart itself, which is brief. */
  | 'restarting'
  /** Reachable and reporting the target. */
  | 'done'
  /** Reachable, still old, and far too long about it. */
  | 'stalled';

export function startWatching(target: string, now = Date.now()): UpdateWatch {
  const watch = { target, startedAt: now };
  try {
    localStorage.setItem(KEY, JSON.stringify(watch));
  } catch {
    /** Private browsing, or storage disabled. */
  }
  return watch;
}

export function stopWatching(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* nothing to do, and nothing worth saying */ }
}

export function resumeWatching(now = Date.now()): UpdateWatch | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (typeof raw?.target !== 'string' || typeof raw?.startedAt !== 'number') return null;
    /** An abandoned watch must not trap somebody on this screen forever */
    if (now - raw.startedAt > STALL_MS * 3) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Versions arrive as "v0.10.15" or "0.10.15" depending on where they came from. */
const bare = (v: string) => v.replace(/^v/, '');

/** What is happening, from the only evidence there is: whether the box answers, and what it says. */
export function stageOf(watch: UpdateWatch, reported: string | null, now = Date.now()): Stage {
  if (reported !== null && bare(reported) === bare(watch.target)) return 'done';
  if (reported === null) return 'restarting';
  return now - watch.startedAt > STALL_MS ? 'stalled' : 'preparing';
}

/** 0..1, for a bar. Deliberately not derived from anything the box reports, because it reports nothing. */
export function fractionOf(stage: Stage, watch: UpdateWatch, now = Date.now()): number {
  if (stage === 'done') return 1;
  /** An honest guess, and it only ever moves forwards. */
  const elapsed = Math.max(0, now - watch.startedAt);
  const crept = Math.min(0.85, elapsed / 120_000 * 0.85);
  return stage === 'restarting' ? Math.max(crept, 0.9) : crept;
}
