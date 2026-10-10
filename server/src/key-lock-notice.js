import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './box-paths.js';

/*
 * Whether the owner has been told, once, what key lock costs.
 *
 * This replaced a box-wide on/off switch in Settings (2026-10-11). Key lock is a normal control on
 * the deck now, so there is nothing left to enable - but it does soften transients, and somebody
 * reaching for it deserves to hear that before the first time rather than wonder why their kicks
 * went soft. Once is enough; a warning on every press is noise, and noise is what gets ignored.
 *
 * Kept on the BOX, not in a browser, so it is the person who is told rather than the device. The
 * owner who read it on their phone does not get it again on a laptop.
 */

const STORE = 'key-lock-notice.json';

export function createKeyLockNotice({ dataDir = DATA_DIR, log = console.log } = {}) {
  const path = join(dataDir, STORE);

  function acknowledged() {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))?.acknowledged === true;
    } catch {
      /** Absent or unreadable means it has not been shown, so show it. Costs one dialog. */
      return false;
    }
  }

  function acknowledge() {
    try {
      mkdirSync(dirname(path), { recursive: true });
      // Write-and-rename, like every other store here - a torn file reads back as unreadable.
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ acknowledged: true })}\n`);
      renameSync(temporary, path);
    } catch (err) {
      log(`[key-lock] could not persist the notice: ${err.message}`);
      return { ok: false, reason: 'not-saved', detail: err.message };
    }
    return { ok: true, acknowledged: true };
  }

  return { acknowledged, acknowledge };
}
