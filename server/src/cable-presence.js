import { existsSync, statSync } from 'node:fs';

const DEFAULT_FLAG_PATH = '/run/pidvs/cable-present';

// How long a cable insert stays RECENT. A different question from whether one is plugged in now.
const WINDOW_MS = 60_000;

/** The flag file's mtime if the insert is still recent, or null. */
export function cablePresentSince(flagPath = DEFAULT_FLAG_PATH) {
  if (!existsSync(flagPath)) return null;
  const { mtimeMs } = statSync(flagPath);
  return Date.now() - mtimeMs < WINDOW_MS ? mtimeMs : null;
}

/** Whether a cable is plugged in RIGHT NOW, regardless of when it went in. */
export function isCableCurrentlyPresent(flagPath = DEFAULT_FLAG_PATH) {
  return existsSync(flagPath);
}
