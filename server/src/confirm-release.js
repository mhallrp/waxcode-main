import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASES_DIR } from './box-paths.js';
import { serverVersion } from './box-version.js';

/**
 * A running release confirming itself.
 *
 * The updater writes `last-known-good` only after its own health check passes - but the check sits
 * behind a restart of this very service, which kills the process waiting on it. So the file was
 * never written, and recover-boot reverted every update on the next boot (a real box, v0.12.0,
 * 2026-10-15). self-update.js now runs the activation in its own cgroup, which fixes that from the
 * NEXT update onwards - this fixes the one arriving now, because the box performing an update is
 * always running the OLD version's code.
 *
 * Health, to the updater, is `systemctl is-active` returning active. A server far enough through
 * startup to be serving requests already satisfies that, so confirming here means the same thing it
 * did before, decided by the version it is actually about.
 *
 * A release that cannot start never reaches this, stays unconfirmed, and is still reverted - which
 * is the case the whole mechanism exists for.
 */

/** Long enough that a release which starts and immediately dies does not get to confirm itself. */
export const CONFIRM_AFTER_MS = 90_000;

export function createReleaseConfirmer({
  releasesDir = RELEASES_DIR,
  runningVersion = () => serverVersion({ releasesDir }),
  log = console.log,
  setTimeoutFn = setTimeout,
  delayMs = CONFIRM_AFTER_MS,
} = {}) {
  const lastKnownGoodPath = join(releasesDir, 'last-known-good');

  function readLastKnownGood() {
    try {
      return readFileSync(lastKnownGoodPath, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  /** Bare, the way the updater stores it - `current` is a v-prefixed directory name. */
  function bareVersion(version) {
    return typeof version === 'string' ? version.replace(/^v/, '') : null;
  }

  function confirmNow() {
    /* Nothing here is worth failing a startup over - a box that cannot work out its own version
     * should carry on serving audio, unconfirmed. */
    let running;
    try {
      running = bareVersion(runningVersion());
    } catch (err) {
      log(`[release] could not read the running version: ${err.message}`);
      return { confirmed: false, reason: `unreadable: ${err.message}` };
    }
    if (running === null) return { confirmed: false, reason: 'no-current' };

    /*
     * Never write a baseline this box has never had. A box provisioned before the file existed has
     * no baseline on purpose - recover-boot reads that as "nothing to compare against" and leaves
     * the box alone. Inventing one here would switch reverting ON for a box that never had it.
     */
    const baseline = readLastKnownGood();
    if (baseline === null) return { confirmed: false, reason: 'no-baseline' };
    if (baseline === running) return { confirmed: false, reason: 'already-confirmed' };

    try {
      // Write-and-rename, matching release-manager.js - a torn file reads back as no baseline at all.
      const temporary = `${lastKnownGoodPath}.tmp`;
      writeFileSync(temporary, running);
      renameSync(temporary, lastKnownGoodPath);
    } catch (err) {
      log(`[release] could not confirm v${running}: ${err.message}`);
      return { confirmed: false, reason: `write-failed: ${err.message}` };
    }

    log(`[release] v${running} confirmed healthy, replacing baseline v${baseline}`);
    return { confirmed: true, version: running, previous: baseline };
  }

  return {
    confirmNow,

    /** Armed once the server is actually serving; never blocks startup. */
    schedule() {
      if (!existsSync(releasesDir)) return null;
      const timer = setTimeoutFn(() => { try { confirmNow(); } catch { /* never an unhandled throw on a timer */ } }, delayMs);
      timer?.unref?.();
      return timer;
    },
  };
}
