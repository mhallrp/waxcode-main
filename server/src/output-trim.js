import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

/** 0dB is what every release before this one played at, and stays the default. */
export const DEFAULT_TRIM_DB = 0;
/** Down only, and far enough to meet a quiet passthrough. Up is not on offer - see xwax PROTOCOL.md's TRIM. */
export const MIN_TRIM_DB = -20;
export const MAX_TRIM_DB = 0;

/** What xwax wants: a plain multiplier, not decibels. */
export function trimMultiplier(db) {
  return 10 ** (db / 20);
}

/**
 * How far the digital output is turned down, box-wide.
 *
 * Box-wide rather than per-deck for the same reason the phono/line setting is: both decks run the
 * same engine off the same files, and the thing being matched - the vinyl passing through beside
 * them - is a property of the turntables and the mixer, not of one deck.
 */
export function createOutputTrim({ dataDir = DEFAULT_DATA_DIR } = {}) {
  const path = join(dataDir, 'output-trim.json');
  let db = read();

  function clamp(value) {
    if (!Number.isFinite(value)) return DEFAULT_TRIM_DB;
    if (value < MIN_TRIM_DB) return MIN_TRIM_DB;
    if (value > MAX_TRIM_DB) return MAX_TRIM_DB;
    // Half a decibel is finer than anyone can set a mixer by ear, and keeps the stored value tidy.
    return Math.round(value * 2) / 2;
  }

  function read() {
    if (!existsSync(path)) return DEFAULT_TRIM_DB;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return clamp(parsed?.db);
    } catch (err) {
      // 0dB is the safe default: it is what the box did before this setting existed.
      console.log(`[output-trim] unreadable ${path}, defaulting to 0dB: ${err.message}`);
      return DEFAULT_TRIM_DB;
    }
  }

  return {
    /** Decibels, always between MIN_TRIM_DB and 0. */
    get() {
      return db;
    },

    /** What to send xwax for the current setting. */
    multiplier() {
      return trimMultiplier(db);
    },

    set(value) {
      db = clamp(typeof value === 'number' ? value : Number(value));
      try {
        mkdirSync(dirname(path), { recursive: true });
        // Write-and-rename, like every other store here - a torn file reads back as unreadable.
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, JSON.stringify({ db }));
        renameSync(temporary, path);
      } catch (err) {
        console.log(`[output-trim] could not persist: ${err.message}`);
      }
      return db;
    },
  };
}
