import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './box-paths.js';
import { compareVersions } from './version-compare.js';

/** Telling somebody an update is waiting, and letting THEM pick the moment. */

/** How long a dismissed version stays quiet. Long enough not to nag, short enough to be news. */
export const SNOOZE_MS = 48 * 60 * 60 * 1000;

/** The background backstop, for a box nobody opens. */
export const REFRESH_MS = 2 * 60 * 60 * 1000;

/** How stale a cached answer may be before SOMEBODY ASKING counts as a reason to look again. */
export const STALE_MS = 10 * 60_000;

const STORE = 'update-dismissed.json';

export function createUpdateNotice({
  selfUpdate,
  dataDir = DATA_DIR,
  snoozeMs = SNOOZE_MS,
  refreshMs = REFRESH_MS,
  staleMs = STALE_MS,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = console.log,
} = {}) {
  /** The last answer from the feed. Null until the first check finishes. */
  let latest = null;
  let checkedAt = null;

  function storePath() {
    return join(dataDir, STORE);
  }

  function readDismissal() {
    try {
      const raw = JSON.parse(readFileSync(storePath(), 'utf8'));
      if (typeof raw?.version !== 'string' || typeof raw?.at !== 'number') return null;
      return raw;
    } catch {
      /** A corrupt or absent file means nothing has been dismissed, which is the safe reading: the failure mode is showing a banner one extra time */
      return null;
    }
  }

  /** Records that this version was dismissed. Returns what the banner should do next. */
  function dismiss(version) {
    if (typeof version !== 'string' || version === '') return { ok: false, reason: 'no-version' };
    try {
      writeFileSync(storePath(), `${JSON.stringify({ version, at: now() }, null, 2)}\n`, { mode: 0o644 });
      return { ok: true, version, showAgainAt: now() + snoozeMs };
    } catch (err) {
      /** Unwritable means the banner comes back on the next page load, which is annoying but honest */
      log(`[update-notice] could not record the dismissal: ${err.message}`);
      return { ok: false, reason: 'not-saved', detail: err.message };
    }
  }

  /** What the UI should show, answered from the cached check so a page load costs nothing. */
  function notice() {
    /* Somebody is looking. If what we hold is old, start a fresh check - without waiting for it. */
    if (checkedAt === null || now() - checkedAt > staleMs) void refresh();

    if (latest === null) return { waiting: false, checked: false, version: null, running: null };
    if (!latest.ok || !latest.newer) {
      return { waiting: false, checked: true, version: null, running: latest.running ?? null };
    }

    const dismissal = readDismissal();
    const sameVersion = dismissal !== null && compareVersions(dismissal.version, latest.latest) >= 0;
    const stillQuiet = dismissal !== null && now() - dismissal.at < snoozeMs;
    /** Dismissing v0.10.11 hides v0.10.11, not whatever comes after it */
    const hidden = sameVersion && stillQuiet;

    return {
      waiting: !hidden,
      checked: true,
      version: latest.latest,
      running: latest.running ?? null,
      dismissed: hidden,
      showAgainAt: hidden ? dismissal.at + snoozeMs : null,
      checkedAt,
    };
  }

  /** Asks the feed and remembers the answer. Safe to call often; it is the caller's timer that paces it. */
  async function refresh() {
    try {
      latest = await selfUpdate.check();
      checkedAt = now();
      if (latest.ok && latest.newer) log(`[update-notice] ${latest.latest} is available`);
    } catch (err) {
      /** Left as whatever it was rather than cleared: a momentary network failure should not make a banner that was correctly showing disappear. */
      log(`[update-notice] could not check: ${err.message}`);
    }
    return latest;
  }

  function start() {
    void refresh();
    const timer = setIntervalFn(() => { void refresh(); }, refreshMs);
    timer?.unref?.();
    return () => clearIntervalFn(timer);
  }

  return { start, refresh, notice, dismiss };
}
