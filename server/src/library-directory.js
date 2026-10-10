/** A track's path relative to its device's own mount root ("" for the root, "Artist/Album/track.mp3" for a nested one) */
export function relativeTrackPath(trackPath, root) {
  if (!root || !trackPath.startsWith(root)) return trackPath;
  return trackPath.slice(root.length).replace(/^\/+/, '');
}

/** The virtual folder playlists appear under. */
export const PLAYLISTS_FOLDER = 'Playlists';

/** Playlists browse as ordinary folders, which is why the app needed no changes to support them: it navigates by path and renders whatever */
function listPlaylists({ tracks, root, path, playlists }) {
  // "Playlists" itself - one entry per crate.
  if (path === PLAYLISTS_FOLDER) {
    const collator = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    return { subfolders: playlists.map((p) => p.name).sort(collator), tracks: [] };
  }

  // Everything after the prefix is the name, taken whole rather than split on "/"
  const name = path.slice(PLAYLISTS_FOLDER.length + 1);
  const playlist = playlists.find((p) => p.name === name);
  if (!playlist) return { subfolders: [], tracks: [] };

  // Resolved against the tracks the scan actually found
  const byRelative = new Map();
  for (const track of tracks) {
    byRelative.set(relativeTrackPath(track.path, root), track);
  }

  return {
    subfolders: [],
    tracks: playlist.paths.map((p) => byRelative.get(p)).filter(Boolean),
  };
}

/** One level of a device's folder tree: immediate subfolder names, plus tracks directly in `path`. */
export function listDirectory({ tracks, root, path, playlists = [] }) {
  const hasPlaylists = playlists.length > 0;
  if (hasPlaylists && (path === PLAYLISTS_FOLDER || path.startsWith(`${PLAYLISTS_FOLDER}/`))) {
    return listPlaylists({ tracks, root, path, playlists });
  }

  const requestedComponents = path === '' ? [] : path.split('/');
  const subfolderNames = new Set();
  const directTracks = [];

  for (const track of tracks) {
    let relative = track.path;
    if (root && relative.startsWith(root)) {
      relative = relative.slice(root.length);
    }
    const components = relative.split('/').filter((c) => c.length > 0);
    if (components.length <= requestedComponents.length) continue;

    // Only tracks whose path actually starts with the requested folder's components belong under it at any depth.
    const matchesPrefix = requestedComponents.every((component, i) => components[i] === component);
    if (!matchesPrefix) continue;

    if (components.length === requestedComponents.length + 1) {
      directTracks.push(track);
    } else {
      subfolderNames.add(components[requestedComponents.length]);
    }
  }

  const collator = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const subfolders = Array.from(subfolderNames).sort(collator);
  directTracks.sort((a, b) => collator(a.title, b.title));

  // Offered at the root only, and first - the real folder tree stays exactly where it was
  if (hasPlaylists && path === '') {
    return { subfolders: [PLAYLISTS_FOLDER, ...subfolders], tracks: directTracks };
  }

  return { subfolders, tracks: directTracks };
}
