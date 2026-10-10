import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const DEFAULT_KEY_LOCK = false;

/** Whether key lock (master tempo) is on, per deck, remembered across restarts. */
export function createDeckKeyLock({ dataDir = DEFAULT_DATA_DIR, deckCount = 2 } = {}) {
  const path = join(dataDir, 'deck-key-lock.json');
  let states = read();

  function read() {
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      // Defaulting to off costs nothing but a re-toggle, and matches what xwax itself starts as.
      console.log(`[deck-key-lock] unreadable ${path}, defaulting to off: ${err.message}`);
      return {};
    }
  }

  return {
    get(deckNumber) {
      return states[deckNumber] === true;
    },

    set(deckNumber, on) {
      const value = on === true;
      states = { ...states, [deckNumber]: value };
      try {
        mkdirSync(dirname(path), { recursive: true });
        // Write-and-rename, like every other store here - a torn file reads back as unreadable.
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, JSON.stringify(states));
        renameSync(temporary, path);
      } catch (err) {
        console.log(`[deck-key-lock] could not persist: ${err.message}`);
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
