import { getOrComputeEncodedWaveform, isWaveformCached } from './waveform-cache.js';
import { getOrComputeBeatGrid, isBeatGridCached } from './beatgrid-cache.js';
import { getOrComputeKey, isKeyCached } from './key-cache.js';
import { isPriorityActive, waitUntilIdle } from './on-demand-priority.js';
import { getAvailableMemoryMB } from './system-memory.js';
import { cachingDisabled } from './cache-mode.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './box-paths.js';

// Below this much real available RAM (see system-memory.js's MemAvailable), don't start the NEXT prefetch track
const MIN_AVAILABLE_MEMORY_MB = 250;
const MEMORY_CHECK_RETRY_MS = 3000;

/** Queues background waveform decodes so the whole library ends up cached without a live request ever needing to wait on ffmpeg */
// Touch this file under DATA_DIR to turn background prefetch ON; absent (the default) is off.
export const ENABLE_PREFETCH_FLAG = 'enable-prefetch';

export function createWaveformPrefetcher({
  cacheDir,
  getOrComputeEncodedWaveformFn = getOrComputeEncodedWaveform,
  isWaveformCachedFn = isWaveformCached,
  getOrComputeBeatGridFn = getOrComputeBeatGrid,
  isBeatGridCachedFn = isBeatGridCached,
  getOrComputeKeyFn = getOrComputeKey,
  isKeyCachedFn = isKeyCached,
  getAvailableMemoryMBFn = getAvailableMemoryMB,
  minAvailableMemoryMB = MIN_AVAILABLE_MEMORY_MB,
  memoryCheckRetryMs = MEMORY_CHECK_RETRY_MS,
  // Defaults OFF (2026-08-04) - two real, repeatable box crashes/reboots on real hardware both correlated with key detection running during
  keyPrefetchEnabled = false,
  // Fired with {completed, total} after every enqueue call and after every track finishes (success or failure
  onProgress,
  // Injectable so tests can exercise the queue without touching the environment or DATA_DIR
  enabled = process.env.PIDVS_ENABLE_PREFETCH === '1' || existsSync(join(DATA_DIR, ENABLE_PREFETCH_FLAG)),
} = {}) {
  // Off unless explicitly asked for - see ENABLE_PREFETCH_FLAG.
  if (!enabled || cachingDisabled()) {
    console.log('[waveform-prefetch] background prefetch off - every track analysed on demand, and cached when it is');
    onProgress?.({ completed: 0, total: 0 });
    return { enqueue() {}, stop() {} };
  }

  const queue = [];
  const queued = new Set();
  let running = false;
  let totalEnqueued = 0;
  let totalCompleted = 0;

  function reportProgress() {
    onProgress?.({ completed: totalCompleted, total: totalEnqueued });
  }

  /** Queues every given track that isn't already fully cached (both waveform AND beat grid*/
  function enqueue(tracks) {
    for (const track of tracks) {
      if (queued.has(track.path)) continue;
      const opts = { cacheDir, volumeId: track.volumeId, relativePath: track.relativePath };
      const keyDone = !keyPrefetchEnabled || isKeyCachedFn(track.path, opts);
      if (isWaveformCachedFn(track.path, opts) && isBeatGridCachedFn(track.path, opts) && keyDone) continue;
      queued.add(track.path);
      queue.push(track);
      totalEnqueued += 1;
    }
    reportProgress();
    if (!running) void processQueue();
  }

  async function processQueue() {
    running = true;
    while (queue.length > 0) {
      // Soft preemption: never START a new prefetch track while a load-triggered on-demand fetch
      if (isPriorityActive()) {
        await waitUntilIdle();
        continue;
      }
      // Same idea as the priority check above, but for real system memory rather than deck-load priority
      const availableMB = getAvailableMemoryMBFn();
      if (availableMB !== null && availableMB < minAvailableMemoryMB) {
        await new Promise((resolve) => setTimeout(resolve, memoryCheckRetryMs));
        continue;
      }
      const track = queue.shift();
      // `queued` stays marked for the WHOLE time this job is in flight, not just while it sits in `queue`
      const opts = { cacheDir, volumeId: track.volumeId, relativePath: track.relativePath, priority: 'background' };
      try {
        const start = Date.now();
        await getOrComputeEncodedWaveformFn(track.path, opts);
        console.log(`[waveform-prefetch] cached ${track.path} in ${Date.now() - start}ms`);
      } catch (err) {
        console.log(`[waveform-prefetch] failed to prefetch ${track.path}: ${err.message}`);
      }
      // Own try/catch, separate from the waveform's above
      try {
        const start = Date.now();
        const grid = await getOrComputeBeatGridFn(track.path, opts);
        console.log(`[waveform-prefetch] beat grid for ${track.path} in ${Date.now() - start}ms: ${grid ? `${grid.bpm.toFixed(1)}bpm` : 'no grid'}`);
      } catch (err) {
        console.log(`[waveform-prefetch] failed to compute beat grid for ${track.path}: ${err.message}`);
      }
      // Own try/catch, same independence reasoning as the beat grid step above.
      if (keyPrefetchEnabled) {
        try {
          const start = Date.now();
          const key = await getOrComputeKeyFn(track.path, opts);
          console.log(`[waveform-prefetch] key for ${track.path} in ${Date.now() - start}ms: ${key ?? 'no key'}`);
        } catch (err) {
          console.log(`[waveform-prefetch] failed to compute key for ${track.path}: ${err.message}`);
        }
      }
      queued.delete(track.path);
      totalCompleted += 1;
      reportProgress();
      // Extra safety margin on top of computeWaveformPeaks' own internal yielding (see waveform.js)
      await new Promise((resolve) => setImmediate(resolve));
    }
    running = false;
  }

  return {
    enqueue,
    // Clears whatever's still queued so a shutdown doesn't keep picking up new jobs
    stop() {
      totalEnqueued -= queue.length;
      queue.length = 0;
      queued.clear();
      reportProgress();
    },
  };
}
