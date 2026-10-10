import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './box-paths.js';

/** Whether key lock is available at all. */

const STORE = 'key-lock-feature.json';

/** Off. Somebody has to choose this, having read what it costs. */
export const DEFAULT_ENABLED = false;

export function createKeyLockFeature({ dataDir = DATA_DIR, log = console.log } = {}) {
  const path = join(dataDir, STORE);

  function enabled() {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      return raw?.enabled === true;
    } catch {
      /** Absent or unreadable is OFF, which is also the default */
      return DEFAULT_ENABLED;
    }
  }

  /** Turns the experiment on or off. */
  function setEnabled(on) {
    const value = on === true;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ enabled: value })}\n`);
      renameSync(temporary, path);
    } catch (err) {
      log(`[key-lock] could not persist: ${err.message}`);
      return { ok: false, reason: 'not-saved', detail: err.message };
    }
    log(`[key-lock] experiment ${value ? 'enabled' : 'disabled'}`);
    return { ok: true, enabled: value };
  }

  return { enabled, setEnabled };
}
