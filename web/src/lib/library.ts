import type { Device, Track } from '../types';

/** The folder tree, built from the track paths themselves. */
export function childrenOf(device: Device, segments: string[]) {
  const prefix = segments.length ? `${device.root}/${segments.join('/')}/` : `${device.root}/`;
  const folders = new Set<string>();
  const tracks: Track[] = [];

  for (const track of device.tracks ?? []) {
    if (!track.path.startsWith(prefix)) continue;
    const rest = track.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) tracks.push(track);
    else folders.add(rest.slice(0, slash));
  }

  /** The box's own list as well as what the tracks imply. */
  const here = segments.join('/');
  for (const folder of device.folders ?? []) {
    if (here && !folder.startsWith(`${here}/`)) continue;
    const rest = here ? folder.slice(here.length + 1) : folder;
    if (!rest) continue;
    const slash = rest.indexOf('/');
    folders.add(slash === -1 ? rest : rest.slice(0, slash));
  }

  return {
    // Numeric collation, so "Track 2" sorts before "Track 10".
    folders: [...folders].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    tracks,
  };
}

/** Only real comparisons. */
export type SortField = 'title' | 'artist' | 'bpm';

const COMPARE: Record<SortField, (a: Track, b: Track) => number> = {
  title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
  artist: (a, b) => (a.artist || '').localeCompare(b.artist || '', undefined, { sensitivity: 'base' }),
  bpm: (a, b) => (a.bpm ?? 0) - (b.bpm ?? 0),
};

export function sortTracks(tracks: Track[], field: SortField, ascending: boolean): Track[] {
  const sorted = [...tracks].sort(COMPARE[field]);
  return ascending ? sorted : sorted.reverse();
}

/** A track's bare filename, which is what an order names - see the server's track-order.js. */
export const fileNameOf = (track: Track) => track.path.split('/').pop() ?? track.path;

/** Puts the tracks somebody placed first, in the order they placed them; everything else follows. */
export function applyTrackOrder(tracks: Track[], names: string[]): Track[] {
  if (names.length === 0) return tracks;

  const byName = new Map<string, Track[]>();
  for (const track of tracks) {
    const key = fileNameOf(track);
    const list = byName.get(key);
    if (list) list.push(track); else byName.set(key, [track]);
  }

  const placed: Track[] = [];
  const seen = new Set<Track>();
  for (const name of names) {
    for (const track of byName.get(name) ?? []) {
      placed.push(track);
      seen.add(track);
    }
  }
  return [...placed, ...tracks.filter((track) => !seen.has(track))];
}

/** Search, scoped to the device AND folder in view. */
export function searchTracks(device: Device, segments: string[], query: string): Track[] {
  const prefix = segments.length ? `${device.root}/${segments.join('/')}/` : `${device.root}/`;
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return (device.tracks ?? [])
    .filter((t) => t.path.startsWith(prefix))
    .filter((t) => t.title.toLowerCase().includes(needle) || (t.artist ?? '').toLowerCase().includes(needle))
    .slice(0, 300);
}
