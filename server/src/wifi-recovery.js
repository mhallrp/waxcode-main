import { readdir } from 'node:fs/promises';

/**
 * The way back in, asked for with a file.
 *
 * A box whose network has changed under it - a new router, a new flat, a password someone rotated -
 * can be perfectly healthy and still unreachable, with no screen to say so and no keyboard to fix
 * it on. It needs a way to be told "let go, start again" by somebody standing in front of it.
 *
 * That used to be an Apple device on a USB port, which is a strange thing to require of a DJ and
 * silently useless to anybody who owns neither an iPhone nor the right cable (owner, 2026-10-19).
 * A named file on any USB stick asks nothing of what you own.
 *
 * Deliberately physical. Nothing reachable over the network can trigger this, because it ends with
 * the box leaving the network the request arrived on.
 *
 * The flush is the whole action: a box with nothing saved has nowhere to be, and wifi-mode raises
 * the setup network for exactly that. The AP is not commanded up here - it follows.
 */

/** What the owner names the file. */
export const MARKER_BASE = 'waxcode_recovery';

/**
 * Whether a filename is the marker.
 *
 * `.txt` counts because Windows and macOS both hide known extensions, so somebody told to make a
 * text file called `waxcode_recovery` very often produces `waxcode_recovery.txt` and cannot see the
 * difference. Case is ignored because FAT and exFAT do not reliably preserve it.
 *
 * Failing to recognise the file is the expensive mistake here - the owner is already locked out,
 * and the fallback is a card reader - so this errs towards recognising it.
 */
export function isRecoveryMarker(name) {
  const lower = String(name).toLowerCase();
  return lower === MARKER_BASE || lower === `${MARKER_BASE}.txt`;
}

/** Whether a mounted medium carries the marker at its ROOT - not buried in a folder. */
export async function mediumAsksForRecovery(mountPath, readdirFn = readdir) {
  if (!mountPath) return false;
  try {
    return (await readdirFn(mountPath)).some(isRecoveryMarker);
  } catch {
    // Unreadable is not asking. A stick that cannot be listed is a stick, not a request.
    return false;
  }
}

export function createWifiRecovery({
  wifiProvisioning,
  readdirFn = readdir,
  log = (message) => console.log(`[wifi-recovery] ${message}`),
} = {}) {
  /** Mount paths already acted on, so one insert means one flush. */
  const handled = new Set();

  return {
    /**
     * Called for every medium the box mounts, with or without a volume id.
     *
     * Acting once per insert matters: a stick stays mounted, and a write to it triggers a rescan.
     * Without this the owner could join a network on the setup page, still have the stick in, and
     * have the next rescan throw that network away again.
     */
    async mediaMounted(mountPath) {
      if (!mountPath || handled.has(mountPath)) return { acted: false, reason: 'already-handled' };
      if (!(await mediumAsksForRecovery(mountPath, readdirFn))) {
        return { acted: false, reason: 'no-marker' };
      }

      // Marked before the work, not after: a flush that throws must not be retried on a loop.
      handled.add(mountPath);
      log(`${MARKER_BASE} found on ${mountPath} - letting go of every saved network`);

      let answer;
      try {
        answer = await wifiProvisioning.forgetAll();
      } catch (err) {
        log(`could not forget the saved networks: ${err.message}`);
        return { acted: true, ok: false, reason: 'threw' };
      }

      if (!answer?.ok) {
        log(`only partly done (${answer?.reason ?? 'unknown'}), ${answer?.remaining ?? '?'} left`
          + ' - this box may rejoin one of them instead of opening its setup network');
        return { acted: true, ok: false, reason: answer?.reason ?? 'unknown', remaining: answer?.remaining };
      }

      log('every saved network is gone - the setup network will come up shortly');
      return { acted: true, ok: true };
    },

    /** A stick taken out and put back in is a fresh request. */
    mediaRemoved(mountPath) {
      handled.delete(mountPath);
    },

    /** For diagnostics. */
    describe() {
      return { handled: [...handled] };
    },
  };
}
