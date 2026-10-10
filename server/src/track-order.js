const FILENAME = 'order.json';

/** A chosen order for the tracks in a folder, kept on the stick that holds them. */
export function createTrackOrder({ stickStorage } = {}) {
  /** Nothing stored, a stick that cannot be read, or a file written by something else - all "no order". */
  function readAll(mountPath) {
    const stored = stickStorage?.read(mountPath, FILENAME);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return stored;
  }

  /** The chosen order for one folder, as bare filenames. Empty means "no opinion", not "empty folder". */
  function get(mountPath, folder) {
    const names = readAll(mountPath)[folder];
    return Array.isArray(names) ? names.filter((n) => typeof n === 'string') : [];
  }

  /** Replaces one folder's order, leaving every other folder alone. */
  async function set(mountPath, folder, names) {
    if (!stickStorage) return false;
    const all = readAll(mountPath);
    const clean = (names ?? []).filter((n) => typeof n === 'string' && !n.includes('/')).slice(0, 5000);

    // An empty order is a REMOVAL, not an empty list - it is how somebody goes back to sorting.
    if (clean.length === 0) delete all[folder];
    else all[folder] = clean;

    return stickStorage.write(mountPath, FILENAME, all);
  }

  return { get, set, readAll };
}

/** Applies a chosen order to the tracks actually present. */
export function applyOrder(tracks, names, nameOf) {
  if (!names || names.length === 0) return tracks;

  const byName = new Map();
  for (const track of tracks) {
    const key = nameOf(track);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(track);
  }

  const placed = [];
  const seen = new Set();
  for (const name of names) {
    for (const track of byName.get(name) ?? []) {
      placed.push(track);
      seen.add(track);
    }
  }

  return [...placed, ...tracks.filter((track) => !seen.has(track))];
}
