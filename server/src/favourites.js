import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STORAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'favourites.json');

/** Persisted list of favourited folders - a direct shortcut into one folder on one USB stick */
/** Favourites now live ON the stick they describe (`.waxcode/favourites.json`), not on the box - see stick-storage.js for the reasoning. */
export function createFavourites({
  storagePath = DEFAULT_STORAGE_PATH,
  stickStorage = null,
  resolveMounted = () => [],
} = {}) {
  let state = load(storagePath) ?? [];
  const FILENAME = 'favourites.json';

  function stickEntries(volumeId, root) {
    const stored = stickStorage?.read(root, FILENAME);
    if (!Array.isArray(stored)) return null;
    return stored
      .filter((entry) => typeof entry?.path === 'string')
      .map((entry) => ({ volumeId, path: entry.path }));
  }

  /** Only what's attached right now, preferring each stick's own file and falling back to whatever this box still holds for it. */
  function list() {
    const mounted = resolveMounted();
    if (!stickStorage || mounted.length === 0) return state;

    return mounted.flatMap(({ volumeId, root }) =>
      stickEntries(volumeId, root) ?? state.filter((f) => f.volumeId === volumeId)
    );
  }

  /** Everything this box holds, attached or not - for migration and for tests. */
  function localList() {
    return state;
  }

  function isFavourite(volumeId, path) {
    return list().some((f) => f.volumeId === volumeId && f.path === path);
  }

  function rootFor(volumeId) {
    return resolveMounted().find((device) => device.volumeId === volumeId)?.root ?? null;
  }

  /** Writes to the stick when it's here and will take it, and to this box when it won't. */
  async function persist(volumeId, entries) {
    const root = rootFor(volumeId);
    if (stickStorage && root) {
      const wrote = await stickStorage.write(root, FILENAME, entries.map(({ path }) => ({ path })));
      if (wrote) {
        // It lives on the stick now, so this box has no business keeping a copy that could later disagree with it.
        state = state.filter((f) => f.volumeId !== volumeId);
        save(storagePath, state);
        return;
      }
    }
    state = [...state.filter((f) => f.volumeId !== volumeId), ...entries];
    save(storagePath, state);
  }

  /** A no-op, not an error, if (volumeId, path) is already favourited. */
  async function add(volumeId, path) {
    if (isFavourite(volumeId, path)) return;
    const forVolume = [...list().filter((f) => f.volumeId === volumeId), { volumeId, path }];
    await persist(volumeId, forVolume);
  }

  /** A no-op, not an error, if (volumeId, path) wasn't favourited. */
  async function remove(volumeId, path) {
    if (!isFavourite(volumeId, path)) return;
    const forVolume = list().filter((f) => f.volumeId === volumeId && f.path !== path);
    await persist(volumeId, forVolume);
  }

  /** Moves this box's leftover favourites for a stick onto the stick itself, the first time that stick is seen after this change. */
  async function migrateToStick(volumeId, root) {
    if (!stickStorage) return;
    const mine = state.filter((f) => f.volumeId === volumeId);
    if (mine.length === 0) return;
    if (stickStorage.read(root, FILENAME) !== null) return;
    await persist(volumeId, mine);
  }

  return { list, localList, isFavourite, add, remove, migrateToStick };
}

function load(storagePath) {
  if (!existsSync(storagePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(storagePath, 'utf8'));
    if (!Array.isArray(raw)) return null;
    return raw.filter((f) => typeof f?.volumeId === 'string' && typeof f?.path === 'string');
  } catch (err) {
    // A corrupt store shouldn't take library browsing down over what's ultimately a convenience feature
    console.error(`Couldn't read favourites store at ${storagePath}, starting empty: ${err.message}`);
    return null;
  }
}

function save(storagePath, state) {
  mkdirSync(dirname(storagePath), { recursive: true });
  const tmpPath = `${storagePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state));
  renameSync(tmpPath, storagePath);
}
