import { cachingDisabled } from './cache-mode.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { computeBeatGridViaAutocorrelation } from './beatgrid-autocorrelation.js';
import { cachePathFor } from './waveform-cache.js';

// Bump whenever the beat tracker's algorithm changes, so stale cache entries stop passing their mtime+size fingerprint check.
const FORMAT_VERSION = 17;  // 17: tempo refined against kick onsets after QM

/** Reuses waveform-cache.js's cachePathFor so a track's beat grid lives next to its waveform entry - same key, different extension, small JSON not the binary format. */
function beatGridCachePathFor(volumeId, relativePath, cacheDir) {
  return cachePathFor(volumeId, relativePath, cacheDir).replace(/\.bin$/, '.beatgrid.json');
}

/** Same shape as waveform-cache.js's getOrComputeEncodedWaveform. Unlike the waveform cache, a "no grid" (null) result is itself cached - a beatless track won't find one next time either. */
export async function getOrComputeBeatGrid(path, { volumeId, relativePath, cacheDir, spawnFn, priority, signal, computeBeatGridFn = computeBeatGridViaAutocorrelation } = {}) {
  const cacheFilePath = beatGridCachePathFor(volumeId, relativePath, cacheDir);
  const stat = statSync(path);

  const noCache = cachingDisabled();
  const cached = noCache ? undefined : readCache(cacheFilePath, stat);
  if (cached !== undefined) return cached;

  // computeBeatGridFn is injectable like getOrComputeEncodedWaveform's spawnFn
  const grid = await computeBeatGridFn(path, { spawnFn, priority, signal });

  try {
    if (!noCache) writeCache(cacheFilePath, stat, grid);
  } catch (err) {
    // A cache write failure should never fail the request - same reasoning as waveform-cache.js.
    console.log(`[beatgrid-cache] failed to write cache for ${path}: ${err.message}`);
  }

  return grid;
}

/** Cheap "would getOrComputeBeatGrid need to analyse right now" check, without doing the analysis - same as waveform-cache.js's isWaveformCached. */
export function isBeatGridCached(path, { volumeId, relativePath, cacheDir } = {}) {
  if (cachingDisabled()) return false;
  try {
    return readCache(beatGridCachePathFor(volumeId, relativePath, cacheDir), statSync(path)) !== undefined;
  } catch {
    return false;
  }
}

// undefined = genuine cache miss; null is itself a valid cached value, so the two must stay distinguishable.
function readCache(cacheFilePath, realStat) {
  if (!existsSync(cacheFilePath)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  } catch {
    return undefined; // corrupt/partial file - treat as a miss, not an error
  }
  if (parsed.formatVersion !== FORMAT_VERSION || parsed.mtimeMs !== realStat.mtimeMs || parsed.size !== realStat.size) {
    return undefined;
  }
  return parsed.grid;
}

function writeCache(cacheFilePath, realStat, grid) {
  mkdirSync(dirname(cacheFilePath), { recursive: true });
  // Write-then-rename, not a direct write - an appliance with no UPS can lose power mid-write at any time.
  const tmpPath = `${cacheFilePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({
    formatVersion: FORMAT_VERSION,
    mtimeMs: realStat.mtimeMs,
    size: realStat.size,
    grid,
  }));
  renameSync(tmpPath, cacheFilePath);
}
