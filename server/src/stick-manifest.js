import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MANIFEST_PATH = '.waxcode/library.json';

// Bumped only when a change would make this misread a newer tool's file rather than merely miss a field.
const SUPPORTED_FORMAT_VERSION = 1;

// exFAT stores modification times coarsely, so an exact comparison would spuriously miss on files nobody has touched.
const MTIME_TOLERANCE_MS = 2000;

/** Reads the library manifest a stick may carry (see MANIFEST.md, which is the contract both sides work from). */
export function readStickManifest(rootDir) {
  const path = join(rootDir, MANIFEST_PATH);
  if (!existsSync(path)) return null;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.log(`[stick-manifest] ${path} is unreadable, scanning normally: ${err.message}`);
    return null;
  }

  if (parsed?.formatVersion > SUPPORTED_FORMAT_VERSION) {
    console.log(`[stick-manifest] ${path} is format v${parsed.formatVersion}, newer than this box understands (v${SUPPORTED_FORMAT_VERSION}) - scanning normally`);
    return null;
  }
  if (!Array.isArray(parsed?.tracks)) return null;

  const byPath = new Map();
  for (const track of parsed.tracks) {
    if (typeof track?.path === 'string') byPath.set(track.path, track);
  }

  console.log(`[stick-manifest] ${byPath.size} tracks described by ${MANIFEST_PATH} (written by ${parsed.generatedBy ?? 'unknown'})`);

  // Playlists reference tracks by the manifest's own ids; browsing needs paths.
  const pathById = new Map();
  for (const track of parsed.tracks) {
    if (typeof track?.id === 'string' && typeof track?.path === 'string') pathById.set(track.id, track.path);
  }

  const playlists = (Array.isArray(parsed.playlists) ? parsed.playlists : [])
    .map((playlist) => ({
      id: playlist?.id ?? null,
      name: typeof playlist?.name === 'string' ? playlist.name : null,
      parentId: playlist?.parentId ?? null,
      // Order is the whole point of a playlist, and the only thing a folder can't express
      paths: (Array.isArray(playlist?.trackIds) ? playlist.trackIds : [])
        .map((id) => pathById.get(id))
        .filter((path) => typeof path === 'string'),
    }))
    .filter((playlist) => playlist.name && playlist.paths.length > 0);

  if (playlists.length > 0) {
    console.log(`[stick-manifest] ${playlists.length} playlists described by ${MANIFEST_PATH}`);
  }

  return {
    generatedBy: parsed.generatedBy ?? null,
    playlists,

    /** The manifest's entry for an absolute path, but only if the file on disk still matches the size and modification time it was recorded with */
    lookup(absolutePath, relativePath) {
      const entry = byPath.get(relativePath);
      if (!entry) return null;

      let stat;
      try {
        stat = statSync(absolutePath);
      } catch {
        return null;
      }
      if (entry.size !== stat.size) return null;
      // Whole seconds: exFAT stores modification times at coarser resolution than the writer's clock
      if (Math.abs(new Date(entry.mtime).getTime() - stat.mtimeMs) > MTIME_TOLERANCE_MS) return null;

      return {
        path: absolutePath,
        artist: entry.artist ?? '',
        title: entry.title ?? '',
        duration: typeof entry.durationMs === 'number' ? entry.durationMs / 1000 : 0,
        bpm: typeof entry.bpm === 'number' ? entry.bpm : null,
        key: typeof entry.key === 'string' ? entry.key : null,
      };
    },
  };
}

/** Writes what the box learned back to the stick, so the next insert - on this box or any other */
export function buildStickManifest(rootDir, tracks, { playlists, generatedBy = 'waxcode-box' } = {}) {
  const path = join(rootDir, MANIFEST_PATH);
  const temporary = `${path}.tmp`;

  let existing = {};
  try {
    if (existsSync(path)) existing = JSON.parse(readFileSync(path, 'utf8')) ?? {};
  } catch {
    // An unreadable manifest is replaced rather than merged - it was doing nothing for us anyway.
  }

  const existingByPath = new Map();
  for (const entry of Array.isArray(existing.tracks) ? existing.tracks : []) {
    if (typeof entry?.path === 'string') existingByPath.set(entry.path, entry);
  }

  const entries = [];
  for (const track of tracks) {
    const relativePath = track.relativePath;
    if (!relativePath) continue;
    let stat;
    try {
      stat = statSync(track.path);
    } catch {
      continue; // vanished between the scan and now
    }
    // What the manifest already said about this file, but only while the file itself is unchanged
    const previous = existingByPath.get(relativePath);
    const unchangedFile = previous
      && previous.size === stat.size
      && Math.abs(new Date(previous.mtime).getTime() - stat.mtimeMs) <= MTIME_TOLERANCE_MS;
    const carried = unchangedFile ? previous : {};

    entries.push({
      // Stable across rewrites so playlists keep resolving; derived from the path so two boxes scanning the same stick independently agree.
      id: previous?.id ?? createHash('sha1').update(relativePath).digest('hex').slice(0, 16),
      path: relativePath,
      size: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      artist: track.artist || carried.artist || '',
      title: track.title || carried.title || '',
      durationMs: Math.round((track.duration ?? 0) * 1000) || carried.durationMs || 0,
      // The box reads bpm and key from TAGS ONLY.
      bpm: typeof track.bpm === 'number' ? track.bpm : (typeof carried.bpm === 'number' ? carried.bpm : null),
      key: typeof track.key === 'string' && track.key ? track.key : (typeof carried.key === 'string' ? carried.key : null),
    });
  }

  if (entries.length === 0) return { changed: false };

  const next = {
    ...existing,
    formatVersion: SUPPORTED_FORMAT_VERSION,
    generatedBy,
    generatedAt: new Date().toISOString(),
    tracks: entries,
    playlists: playlists ?? existing.playlists ?? [],
  };

  // Nothing to gain from rewriting an identical file, and every write is wear on someone's stick.
  if (JSON.stringify(existing.tracks ?? []) === JSON.stringify(entries)) return { changed: false };

  return {
    changed: true,
    /** Call with the stick writable - see stick-writable.js. */
    commit() {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temporary, JSON.stringify(next));
        renameSync(temporary, path);
        console.log(`[stick-manifest] wrote ${entries.length} tracks to ${MANIFEST_PATH}`);
        return true;
      } catch (err) {
        console.log(`[stick-manifest] could not write ${MANIFEST_PATH} (${err.message}) - the next insert will scan`);
        try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort */ }
        return false;
      }
    },
  };
}
