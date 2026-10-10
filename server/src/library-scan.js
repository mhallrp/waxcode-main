import { readdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { parseFile } from 'music-metadata';
import { isPriorityActive, waitUntilIdle } from './on-demand-priority.js';
import { getAvailableMemoryMB } from './system-memory.js';

/** Pause the tag-reading loop when the box is this close to running out. */
const MIN_AVAILABLE_MEMORY_MB = 250;
const MEMORY_CHECK_RETRY_MS = 3000;
import { readStickManifest } from './stick-manifest.js';
import { relativeTrackPath } from './library-directory.js';

/** Not crates. Windows and chkdsk leave these on any removable volume. */
const HIDDEN_DIRECTORIES = new Set([
  'System Volume Information',
  '$RECYCLE.BIN',
  'RECYCLER',
  'found.000',
  'LOST.DIR',
]);

export const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.aiff', '.aif', '.ogg', '.m4a']);

/** Scan a directory tree for audio files and read their tags. */
export async function scanLibrary(rootDir, {
  onTrack,
  onFilesFound,
  onPlaylists,
  /** Every directory on the stick, reported once the walk is done. */
  onFolders,
  isPriorityActiveFn = isPriorityActive,
  waitUntilIdleFn = waitUntilIdle,
  getAvailableMemoryMBFn = getAvailableMemoryMB,
  minAvailableMemoryMB = MIN_AVAILABLE_MEMORY_MB,
  memoryCheckRetryMs = MEMORY_CHECK_RETRY_MS,
} = {}) {
  const folders = [];
  const paths = await findAudioFiles(rootDir, folders);
  onFilesFound?.(paths);
  onFolders?.(folders);
  const tracks = [];

  // Advisory only - the walk above is still the truth about what's here.
  const manifest = readStickManifest(rootDir);
  let fromManifest = 0;
  // Reported up front, before the slow part - the folder tree and the crates are both browsable as soon as the walk is done
  if (manifest?.playlists?.length) onPlaylists?.(manifest.playlists);

  for (const path of paths) {
    // Soft preemption, same pattern/reasoning as waveform-prefetch.js's own processQueue
    if (isPriorityActiveFn()) {
      await waitUntilIdleFn();
    }
    // Back off while memory is tight, giving the allocator room and GC a chance to catch up.
    for (;;) {
      const availableMB = getAvailableMemoryMBFn();
      if (availableMB === null || availableMB >= minAvailableMemoryMB) break;
      await new Promise((resolve) => setTimeout(resolve, memoryCheckRetryMs));
    }
    const known = manifest?.lookup(path, relativeTrackPath(path, rootDir));
    const track = known ?? await readTrack(path);
    if (known) fromManifest += 1;
    if (track) {
      tracks.push(track);
      onTrack?.(track);
    }
    // Explicit yield between files.
    await new Promise((resolve) => setImmediate(resolve));
  }

  if (manifest) {
    console.log(`[library-scan] ${fromManifest}/${paths.length} tracks came from the manifest - ${paths.length - fromManifest} needed reading`);
  }

  return tracks;
}

/** Every audio file under `dir`, and every directory passed on the way. */
async function findAudioFiles(dir, folders) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    // Skip dotfiles/dotdirs - confirmed on real hardware that a Mac-written exFAT/FAT32 stick is full of these: AppleDouble resource-fork
    if (entry.name.startsWith('.')) continue;

    // Housekeeping directories Windows and the filesystem itself leave on a removable volume.
    if (HIDDEN_DIRECTORIES.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      folders?.push(fullPath);
      files.push(...await findAudioFiles(fullPath, folders));
    } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readTrack(path) {
  try {
    // skipCovers - embedded artwork is often the slowest part of parsing a tag (decoding/copying an image per file), and isn't shown anywhere yet.
    const { common, format } = await parseFile(path, { skipCovers: true });

    return {
      path,
      artist: common.artist ?? '',
      title: common.title ?? basename(path, extname(path)),
      duration: format.duration ?? 0,
      // Tag-only, same reasoning as bpm above - no fallback here (the app fetches an analyzed key via the app on demand instead).
      bpm: common.bpm ?? null,
      key: common.key ?? null,
    };
  } catch (err) {
    console.error(`Skipping unreadable file ${path}: ${err.message}`);
    return null;
  }
}
