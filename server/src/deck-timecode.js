import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// xwax's own built-in definitions (see xwax/timecoder.c)
export const SERATO_SIDE_A = 'serato_2a';
export const SERATO_SIDE_B = 'serato_2b';
export const VALID_SIDES = [SERATO_SIDE_A, SERATO_SIDE_B];

const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

function envPath(dataDir, deckNumber) {
  return join(dataDir, `deck${deckNumber}-timecode.env`);
}

/** Persists each deck's selected Serato timecode side as the SAME file xwax@.service's EnvironmentFile= reads at process start */
export function createDeckTimecode({ dataDir = DEFAULT_DATA_DIR } = {}) {
  function get(deckNumber) {
    const path = envPath(dataDir, deckNumber);
    if (!existsSync(path)) return SERATO_SIDE_A;
    const match = /^PIDVS_TIMECODE=(\S+)/m.exec(readFileSync(path, 'utf8'));
    return match && VALID_SIDES.includes(match[1]) ? match[1] : SERATO_SIDE_A;
  }

  function set(deckNumber, side) {
    if (!VALID_SIDES.includes(side)) {
      throw new Error(`Unknown Serato timecode side: ${side}`);
    }
    const path = envPath(dataDir, deckNumber);
    mkdirSync(dataDir, { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, `PIDVS_TIMECODE=${side}\n`);
    renameSync(tmpPath, path);
  }

  return { get, set };
}
