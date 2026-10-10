import { createHash } from 'node:crypto';
import { cachingDisabled } from './cache-mode.js';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWaveformPeaks, computeWaveformInSegments } from './waveform.js';
import { encodeWaveformPeaks } from './waveform-binary.js';
import { openStickWaveforms } from './stick-waveforms.js';

// The box's own storage (server/data/), not the USB stick - sticks mount read-only (usb-mount.sh's `-o ro`), so the cache can't live there.
const DEFAULT_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'waveform-cache');

// [formatVersion: uint8][mtimeMs: float64 LE][size: uint32 LE], then the exact bytes encodeWaveformPeaks would produce.
const HEADER_SIZE = 13;

// Bump whenever computeWaveformPeaks's algorithm changes - a stale entry would otherwise still pass its mtime+size fingerprint forever.
const FORMAT_VERSION = 7;

const LAST_SEEN_FILENAME = '.last-seen';

// 30 days - a stick that hasn't reappeared in that long gets a fully fresh cache rebuild next time, rather than reconciling months of drift.
const DEFAULT_MAX_VOLUME_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// One index per volume, kept because building it walks every entry header in a file that can be hundreds of megabytes.
const stickWaveformIndexes = new Map();

function stickWaveformsFor(volumeId, stickRoot) {
  if (!volumeId || !stickRoot) return null;
  if (!stickWaveformIndexes.has(volumeId)) {
    stickWaveformIndexes.set(volumeId, openStickWaveforms(stickRoot, { formatVersion: FORMAT_VERSION }));
  }
  return stickWaveformIndexes.get(volumeId);
}

/** Called when a stick is (re)scanned - its packed file may have been rewritten since we indexed it. */
export function clearStickWaveforms(volumeId) {
  stickWaveformIndexes.delete(volumeId);
}

/** The stick's mount root, derived rather than passed. */
function stickRootFor(path, relativePath) {
  if (!relativePath || !path.endsWith(relativePath)) return null;
  return path.slice(0, path.length - relativePath.length);
}

/** A track's encoded waveform, served from the on-box cache while mtime+size still match. */
export async function getOrComputeEncodedWaveform(path, { volumeId, relativePath, cacheDir = DEFAULT_CACHE_DIR, spawnFn, buckets, priority, signal, onPartial } = {}) {
  const cacheFilePath = cachePathFor(volumeId, relativePath, cacheDir);
  const stat = statSync(path);

  const noCache = cachingDisabled();
  const cached = noCache ? null : readCache(cacheFilePath, stat);
  if (cached) return cached;

  // Precomputed on a laptop and carried on the stick.
  const precomputed = noCache ? null : stickWaveformsFor(volumeId, stickRootFor(path, relativePath))?.read(relativePath);
  if (precomputed && precomputed.length > HEADER_SIZE && fingerprintMatches(precomputed, stat)) {
    try {
      writeCache(cacheFilePath, stat, precomputed.subarray(HEADER_SIZE));
    } catch (err) {
      console.log(`[waveform-cache] couldn't adopt the precomputed waveform for ${path}: ${err.message}`);
    }
    return precomputed.subarray(HEADER_SIZE);
  }

  // With an onPartial the track is built slice by slice so the caller can show it filling in
  let peaks;
  let alreadyDelivered = false;
  if (onPartial) {
    ({ peaks, alreadyDelivered } = await computeWaveformInSegments(path, { spawnFn, priority, signal, onPartial }));
  } else {
    peaks = await computeWaveformPeaks(path, { buckets, spawnFn, priority, signal });
  }
  const encoded = encodeWaveformPeaks(peaks);

  try {
    if (!noCache) writeCache(cacheFilePath, stat, encoded);
  } catch (err) {
    // A cache write failure should never fail the waveform request - it only affects whether the NEXT request gets to skip the decode.
    console.log(`[waveform-cache] failed to write cache for ${path}: ${err.message}`);
  }

  // Accepted and ignored: partial delivery is tracked by the caller now.
  void alreadyDelivered;
  return encoded;
}

/** Cheap "would getOrComputeEncodedWaveform need to decode anything right now" check */
export function isWaveformCached(path, { volumeId, relativePath, cacheDir = DEFAULT_CACHE_DIR } = {}) {
  if (cachingDisabled()) return false;
  try {
    return readCacheHeader(cachePathFor(volumeId, relativePath, cacheDir), statSync(path));
  } catch {
    return false;
  }
}

/** The same question for a WHOLE library listing, in one directory read instead of two syscalls a track. */
export function cachedPathChecker({ volumeId, cacheDir = DEFAULT_CACHE_DIR } = {}) {
  if (cachingDisabled()) return () => false;
  let names;
  try {
    names = new Set(readdirSync(volumeDirFor(volumeId, cacheDir)));
  } catch {
    return () => false; // no cache directory for this volume yet
  }
  return (relativePath) => names.has(`${createHash('sha1').update(relativePath ?? '').digest('hex')}.bin`);
}

/** (volumeId, relativePath) -> cache file, keyed by sha1 of each, nested under a per-volume directory so cleanupStaleVolumes can delete a whole stick's cache at once. */
export function cachePathFor(volumeId, relativePath, cacheDir = DEFAULT_CACHE_DIR) {
  const key = createHash('sha1').update(relativePath ?? '').digest('hex');
  return join(volumeDirFor(volumeId, cacheDir), `${key}.bin`);
}

/** Deletes one track's cached analysis - its waveform and its beat grid. */
export function forgetCachedAnalysis(volumeId, relativePath, cacheDir = DEFAULT_CACHE_DIR) {
  const bin = cachePathFor(volumeId, relativePath, cacheDir);
  for (const file of [bin, bin.replace(/\.bin$/, '.beatgrid.json')]) {
    try { rmSync(file, { force: true }); } catch { /* nothing to do about it, and nothing depends on it */ }
  }
}

function volumeDirFor(volumeId, cacheDir = DEFAULT_CACHE_DIR) {
  const key = createHash('sha1').update(volumeId ?? '').digest('hex');
  return join(cacheDir, key);
}

/** Marks `volumeId` as seen right now, so cleanupStaleVolumes knows this stick is still in circulation. The marker file's mtime is the timestamp. */
export function touchVolumeLastSeen(volumeId, cacheDir = DEFAULT_CACHE_DIR) {
  const volumeDir = volumeDirFor(volumeId, cacheDir);
  mkdirSync(volumeDir, { recursive: true });
  writeFileSync(join(volumeDir, LAST_SEEN_FILENAME), '');
}

/** Deletes every volume's entire cache directory once its.last-seen marker is older than `maxAgeMs`. Returns the removed volume directory names. */
export function cleanupStaleVolumes(cacheDir = DEFAULT_CACHE_DIR, maxAgeMs = DEFAULT_MAX_VOLUME_AGE_MS) {
  let entries;
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const now = Date.now();
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const volumeDir = join(cacheDir, entry.name);
    let lastSeenMs;
    try {
      lastSeenMs = statSync(join(volumeDir, LAST_SEEN_FILENAME)).mtimeMs;
    } catch {
      lastSeenMs = 0;
    }
    if (now - lastSeenMs > maxAgeMs) {
      rmSync(volumeDir, { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

function readCache(cacheFilePath, realStat) {
  let buf;
  try {
    buf = readFileSync(cacheFilePath);
  } catch {
    return null; // no cache yet, or unreadable - treat as a miss, not an error
  }
  if (buf.length < HEADER_SIZE || !fingerprintMatches(buf, realStat)) return null;
  return buf.subarray(HEADER_SIZE);
}

/** Reads only HEADER_SIZE bytes via a raw file descriptor, not the whole (potentially large) cache file. */
function readCacheHeader(cacheFilePath, realStat) {
  let fd;
  try {
    fd = openSync(cacheFilePath, 'r');
  } catch {
    return false; // no cache yet, or unreadable - treat as a miss, not an error
  }
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    const bytesRead = readSync(fd, header, 0, HEADER_SIZE, 0);
    return bytesRead === HEADER_SIZE && fingerprintMatches(header, realStat);
  } finally {
    closeSync(fd);
  }
}

// Source file changed, or the algorithm that produced this changed (FORMAT_VERSION) - either way, a mismatch means "treat as a miss."
function fingerprintMatches(buf, realStat) {
  return buf.readUInt8(0) === FORMAT_VERSION
    && buf.readDoubleLE(1) === realStat.mtimeMs
    && buf.readUInt32LE(9) === realStat.size;
}

function writeCache(cacheFilePath, realStat, encoded) {
  mkdirSync(dirname(cacheFilePath), { recursive: true });
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(FORMAT_VERSION, 0);
  header.writeDoubleLE(realStat.mtimeMs, 1);
  header.writeUInt32LE(realStat.size, 9);
  // Write-then-rename, not a direct write - rename is atomic, so a power cut mid-write can't leave a half-written cache file.
  const tmpPath = `${cacheFilePath}.tmp`;
  writeFileSync(tmpPath, Buffer.concat([header, encoded]));
  renameSync(tmpPath, cacheFilePath);
}
