import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');


export const LINE = 'line';
export const PHONO = 'phono';

/** Whether the turntables feeding this box run at LINE or PHONO level. */
export function createDeckInputMode({ dataDir = DEFAULT_DATA_DIR, deckCount = 2 } = {}) {

  function envPath(deckNumber) {
    return join(dataDir, `deck${deckNumber}.env`);
  }

  function readDeck(deckNumber) {
    const path = envPath(deckNumber);
    if (!existsSync(path)) return LINE;
    try {
      return /^PIDVS_PHONO_IN=--phono\s*$/m.test(readFileSync(path, 'utf8')) ? PHONO : LINE;
    } catch (err) {
      // Line is the safe default: a phono-level signal into a line-level threshold merely tracks marginally
      console.log(`[deck-input-mode] unreadable ${path}, assuming line: ${err.message}`);
      return LINE;
    }
  }

  /** Deck 1's file is canonical. */
  function get() {
    return readDeck(1);
  }

  /** Only the INPUT half is set from this any more. */
  function contentsFor(mode) {
    return mode === PHONO
      ? 'PIDVS_PHONO_IN=--phono\nPIDVS_PHONO_OUT=\n'
      : 'PIDVS_PHONO_IN=\nPIDVS_PHONO_OUT=\n';
  }

  /** Write-then-rename, so a torn write can't leave systemd a half-written EnvironmentFile. */
  function writeDeck(deckNumber, mode) {
    const path = envPath(deckNumber);
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, contentsFor(mode));
    renameSync(tmpPath, path);
  }

  /** Applies to every deck at once - see the note above on why this is not per-deck. */
  function set(mode) {
    const normalised = mode === PHONO ? PHONO : LINE;
    for (let deckNumber = 1; deckNumber <= deckCount; deckNumber++) writeDeck(deckNumber, normalised);
    return normalised;
  }

  /** Rewrites any deck's file that isn't exactly what this version would write, at startup. */
  function reconcile() {
    const canonical = get();
    const expected = contentsFor(canonical);
    for (let deckNumber = 1; deckNumber <= deckCount; deckNumber++) {
      const path = envPath(deckNumber);
      let actual = null;
      try {
        actual = existsSync(path) ? readFileSync(path, 'utf8') : null;
      } catch { /* unreadable counts as needing a rewrite */ }
      if (actual === expected) continue;
      writeDeck(deckNumber, canonical);
      console.log(`[deck-input-mode] deck ${deckNumber} env rewritten to match the box setting (${canonical})`);
    }
  }

  reconcile();

  return { get, set };
}
