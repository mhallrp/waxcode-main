import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './box-paths.js';

/** Per-track nudges to the beat grid, in seconds. */
const DEFAULT_STORAGE_PATH = join(DATA_DIR, 'grid-offsets.json');

/** As far as a grid can be pushed either way. */
const LIMIT_SECONDS = 0.5;

export function createGridOffsets({ storagePath = DEFAULT_STORAGE_PATH } = {}) {
  const key = (volumeId, relativePath) => `${volumeId}\u0000${relativePath}`;

  function read() {
    try {
      const parsed = JSON.parse(readFileSync(storagePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function write(all) {
    mkdirSync(dirname(storagePath), { recursive: true });
    const temporary = `${storagePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(temporary, storagePath);
  }

  return {
    /** The nudge for one track, or 0 - never null, because every caller would treat null as 0. */
    get(volumeId, relativePath) {
      const value = read()[key(volumeId, relativePath)];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    },

    /** Sets a nudge, clamped, and returns what was actually stored. */
    set(volumeId, relativePath, seconds) {
      const clamped = Math.max(-LIMIT_SECONDS, Math.min(LIMIT_SECONDS, Number(seconds) || 0));
      const all = read();
      const at = key(volumeId, relativePath);
      if (clamped === 0) delete all[at];
      else all[at] = clamped;
      write(all);
      return clamped;
    },

    /** Everything stored, for a diagnostics bundle - not a route. */
    all: read,
  };
}

export { LIMIT_SECONDS as GRID_OFFSET_LIMIT_SECONDS };
