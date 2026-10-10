import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, copyFileSync, utimesSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrComputeBeatGrid, isBeatGridCached } from '../src/beatgrid-cache.js';
import { cachePathFor } from '../src/waveform-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_MP3 = join(__dirname, 'fixtures', 'sample.mp3');

function tempCacheDir() {
  return mkdtempSync(join(tmpdir(), 'pidvs-beatgrid-cache-test-'));
}

/** A copy of the fixture at a fresh temp path, so tests can freely mutate its mtime without touching the shared fixture file. */
function tempTrack() {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-beatgrid-track-test-'));
  const trackPath = join(dir, 'track.mp3');
  copyFileSync(FIXTURE_MP3, trackPath);
  return trackPath;
}

/**
 * A stand-in beat tracker, injected as `computeBeatGridFn`.
 *
 * These tests are about the CACHE - hit, miss, invalidation, the on-disk shape - not about whichever
 * tracker sits behind it. They used to fake `aubio beat`'s stdout through the spawn function, which
 * tied them to one tracker's process and output format; when the aubio path was deleted (2026-09-02)
 * they all hung, waiting on a spawn that no longer happened. Injecting the function itself is what
 * they always meant to do.
 */
function fakeTracker(grid) {
  const calls = { count: 0 };
  const computeBeatGridFn = async () => {
    calls.count += 1;
    return grid;
  };
  return { computeBeatGridFn, calls };
}

function steadyGrid({ bpm = 120, firstBeatSeconds = 1.0 } = {}) {
  return { bpm, firstBeatSeconds };
}

test('getOrComputeBeatGrid computes and caches a grid on a miss', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { computeBeatGridFn, calls } = fakeTracker(steadyGrid({ bpm: 128 }));

  const grid = await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });
  assert.ok(Math.abs(grid.bpm - 128) < 0.01);
  assert.equal(calls.count, 1);
});

test('getOrComputeBeatGrid serves from cache on a second call, without re-running the tracker', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { computeBeatGridFn, calls } = fakeTracker(steadyGrid({ bpm: 140 }));

  const first = await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });
  const second = await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });

  assert.deepEqual(second, first);
  assert.equal(calls.count, 1, 'second call should be a cache hit, not a second tracker run');
});

test('a null grid (the tracker found no usable beats) is itself cached, not recomputed on the next call', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { computeBeatGridFn, calls } = fakeTracker(null); // no beats detected at all

  const first = await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });
  const second = await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });

  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(calls.count, 1, 'a cached null result should still short-circuit the second call');
});

test('a changed source file (different mtime) invalidates the cache and recomputes', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { computeBeatGridFn, calls } = fakeTracker(steadyGrid({ bpm: 120 }));

  await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });
  const future = new Date(Date.now() + 60_000);
  utimesSync(trackPath, future, future);
  await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });

  assert.equal(calls.count, 2, 'a changed mtime should force a fresh tracker run');
});

test('isBeatGridCached is false before computing, true after', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { computeBeatGridFn } = fakeTracker(steadyGrid());

  assert.equal(isBeatGridCached(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir }), false);
  await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });
  assert.equal(isBeatGridCached(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir }), true);
});

test('isBeatGridCached is true for a cached null grid too - a checked-and-found-nothing track should not be re-queued', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { computeBeatGridFn } = fakeTracker(null);

  await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });
  assert.equal(isBeatGridCached(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir }), true);
});

test('is stored right alongside the waveform cache entry - same directory, same key, sibling file', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { computeBeatGridFn } = fakeTracker(steadyGrid());

  await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });

  const waveformPath = cachePathFor('VOL1', 'track.mp3', cacheDir);
  const beatGridPath = waveformPath.replace(/\.bin$/, '.beatgrid.json');
  assert.equal(dirname(beatGridPath), dirname(waveformPath));
  assert.ok(existsSync(beatGridPath));
});

test('a corrupt cache file falls back to recomputing rather than crashing', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { computeBeatGridFn, calls } = fakeTracker(steadyGrid({ bpm: 128 }));

  const waveformPath = cachePathFor('VOL1', 'track.mp3', cacheDir);
  const beatGridPath = waveformPath.replace(/\.bin$/, '.beatgrid.json');
  mkdirSync(dirname(beatGridPath), { recursive: true });
  writeFileSync(beatGridPath, 'not valid json');

  const grid = await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });
  assert.ok(Math.abs(grid.bpm - 128) < 0.01);
  assert.equal(calls.count, 1);
});

test('a saved cache entry never leaves a stray .tmp file behind', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { computeBeatGridFn } = fakeTracker(steadyGrid());

  await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });

  const waveformPath = cachePathFor('VOL1', 'track.mp3', cacheDir);
  const beatGridPath = waveformPath.replace(/\.bin$/, '.beatgrid.json');
  assert.equal(existsSync(`${beatGridPath}.tmp`), false);
});

test('the cache file stores plain JSON with bpm/firstBeatSeconds', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { computeBeatGridFn } = fakeTracker(steadyGrid({ bpm: 150, firstBeatSeconds: 0.42 }));

  await getOrComputeBeatGrid(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, computeBeatGridFn });

  const waveformPath = cachePathFor('VOL1', 'track.mp3', cacheDir);
  const beatGridPath = waveformPath.replace(/\.bin$/, '.beatgrid.json');
  const stored = JSON.parse(readFileSync(beatGridPath, 'utf8'));
  assert.ok(Math.abs(stored.grid.bpm - 150) < 0.01);
  assert.ok(Math.abs(stored.grid.firstBeatSeconds - 0.42) < 0.001);
});
