import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STORAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'deck-relative-mode.json');

/** Persists each deck's last-set Relative mode choice (see xwax/player.h's own doc comment on the feature) across a Node restart */
export function createDeckRelativeMode({ storagePath = DEFAULT_STORAGE_PATH } = {}) {
  let state = load(storagePath) ?? {};

  function get(deckNumber) {
    return state[String(deckNumber)] === true;
  }

  function set(deckNumber, on) {
    state = { ...state, [String(deckNumber)]: on === true };
    save(storagePath, state);
  }

  return { get, set };
}

function load(storagePath) {
  if (!existsSync(storagePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(storagePath, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    return raw;
  } catch (err) {
    // A corrupt store shouldn't block every deck's LOAD over what's ultimately a UI convenience
    console.error(`Couldn't read relative-mode store at ${storagePath}, defaulting every deck to Absolute: ${err.message}`);
    return null;
  }
}

function save(storagePath, state) {
  mkdirSync(dirname(storagePath), { recursive: true });
  const tmpPath = `${storagePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state));
  renameSync(tmpPath, storagePath);
}
