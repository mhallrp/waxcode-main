import { cachingDisabled } from './cache-mode.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { computeKey } from './key-detection.js';
import { cachePathFor } from './waveform-cache.js';

// Bump if computeKey's algorithm/tool changes, so stale cache entries stop passing their mtime+size fingerprint check.
const FORMAT_VERSION = 1;

/** Reuses waveform-cache.js's cachePathFor, same as beatgrid-cache.js. */
function keyCachePathFor(volumeId, relativePath, cacheDir) {
  return cachePathFor(volumeId, relativePath, cacheDir).replace(/\.bin$/, '.key.json');
}

/** Same shape as getOrComputeBeatGrid - a "no key detected" (null) result is itself cached. */
export async function getOrComputeKey(path, { volumeId, relativePath, cacheDir, spawnFn, priority, signal, computeKeyFn = computeKey } = {}) {
  const cacheFilePath = keyCachePathFor(volumeId, relativePath, cacheDir);
  const stat = statSync(path);

  const noCache = cachingDisabled();
  const cached = noCache ? undefined : readCache(cacheFilePath, stat);
  if (cached !== undefined) return cached;

  const key = await computeKeyFn(path, { spawnFn, priority, signal });

  try {
    if (!noCache) writeCache(cacheFilePath, stat, key);
  } catch (err) {
    console.log(`[key-cache] failed to write cache for ${path}: ${err.message}`);
  }

  return key;
}

/** Cheap "would getOrComputeKey need to run keyfinder-cli right now" check, without doing the analysis. */
export function isKeyCached(path, { volumeId, relativePath, cacheDir } = {}) {
  if (cachingDisabled()) return false;
  try {
    return readCache(keyCachePathFor(volumeId, relativePath, cacheDir), statSync(path)) !== undefined;
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
    return undefined;
  }
  if (parsed.formatVersion !== FORMAT_VERSION || parsed.mtimeMs !== realStat.mtimeMs || parsed.size !== realStat.size) {
    return undefined;
  }
  return parsed.key;
}

function writeCache(cacheFilePath, realStat, key) {
  mkdirSync(dirname(cacheFilePath), { recursive: true });
  const tmpPath = `${cacheFilePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({
    formatVersion: FORMAT_VERSION,
    mtimeMs: realStat.mtimeMs,
    size: realStat.size,
    key,
  }));
  renameSync(tmpPath, cacheFilePath);
}
