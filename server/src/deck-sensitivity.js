import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

/** Matches TIMECODER_MAX_SENSITIVITY in xwax's timecoder.h. */
export const MAX_SENSITIVITY = 3;
export const DEFAULT_SENSITIVITY = 0;

/** How much rumble the timecoder is told to ignore, per deck, remembered across restarts. */
export function createDeckSensitivity({ dataDir = DEFAULT_DATA_DIR, deckCount = 2 } = {}) {
  const path = join(dataDir, 'deck-sensitivity.json');
  let levels = read();

  function read() {
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      // The default is the calibrated threshold, so a lost file costs responsiveness to nothing
      console.log(`[deck-sensitivity] unreadable ${path}, defaulting to ${DEFAULT_SENSITIVITY}: ${err.message}`);
      return {};
    }
  }

  function clamp(level) {
    const value = Number(level);
    if (!Number.isFinite(value)) return DEFAULT_SENSITIVITY;
    return Math.min(MAX_SENSITIVITY, Math.max(0, Math.round(value)));
  }

  return {
    get(deckNumber) {
      return clamp(levels[deckNumber] ?? DEFAULT_SENSITIVITY);
    },

    /** Returns the clamped value actually stored, so a caller can report what it settled on. */
    set(deckNumber, level) {
      const value = clamp(level);
      levels = { ...levels, [deckNumber]: value };
      try {
        mkdirSync(dirname(path), { recursive: true });
        // Write-and-rename: a torn file here would be read back as "unreadable" on next boot.
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, JSON.stringify(levels));
        renameSync(temporary, path);
      } catch (err) {
        console.log(`[deck-sensitivity] could not persist: ${err.message}`);
      }
      return value;
    },

    all() {
      const result = {};
      for (let deckNumber = 1; deckNumber <= deckCount; deckNumber++) {
        result[deckNumber] = this.get(deckNumber);
      }
      return result;
    },
  };
}
