import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, utimesSync, existsSync, statSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getOrComputeEncodedWaveform,
  isWaveformCached,
  cachePathFor,
  touchVolumeLastSeen,
  cleanupStaleVolumes,
} from '../src/waveform-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_MP3 = join(__dirname, 'fixtures', 'sample.mp3');

function tempCacheDir() {
  return mkdtempSync(join(tmpdir(), 'pidvs-waveform-cache-test-'));
}

/** A copy of the fixture at a fresh temp path, so tests can freely mutate its mtime without touching the shared fixture file. */
function tempTrack() {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-waveform-track-test-'));
  const trackPath = join(dir, 'track.mp3');
  copyFileSync(FIXTURE_MP3, trackPath);
  return trackPath;
}

function countingSpawn() {
  const calls = { count: 0 };
  const spawnFn = (...args) => {
    calls.count += 1;
    return spawn(...args);
  };
  return { spawnFn, calls };
}

test('cachePathFor derives a stable, deterministic key from volumeId+relativePath', () => {
  const cacheDir = '/some/cache/dir';
  const path = cachePathFor('ABCD-1234', 'House Deeper/track.mp3', cacheDir);
  assert.ok(path.startsWith('/some/cache/dir/'));
  assert.ok(path.endsWith('.bin'));
  assert.equal(path, cachePathFor('ABCD-1234', 'House Deeper/track.mp3', cacheDir));
});

test('cachePathFor gives different relativePaths different keys', () => {
  const cacheDir = '/some/cache/dir';
  const a = cachePathFor('ABCD-1234', 'a.mp3', cacheDir);
  const b = cachePathFor('ABCD-1234', 'b.mp3', cacheDir);
  assert.notEqual(a, b);
});

test('cachePathFor gives the same relativePath on different volumeIds different keys', () => {
  const cacheDir = '/some/cache/dir';
  const a = cachePathFor('ABCD-1234', 'track.mp3', cacheDir);
  const b = cachePathFor('WXYZ-5678', 'track.mp3', cacheDir);
  assert.notEqual(a, b);
});

test('the same volumeId+relativePath resolves to the same cache key regardless of which port/mount path the file is currently under', () => {
  // This is the whole point of the 2026-07-30 rework: cachePathFor
  // never sees the actual port/mount path at all, only volumeId and a
  // path already relative to the stick's own root - so a stick moved
  // from port-1 to port-3 (an ordinary, frequent real workflow) still
  // resolves to the exact same cache entry.
  const cacheDir = '/some/cache/dir';
  const key = cachePathFor('ABCD-1234', 'Techno/track.mp3', cacheDir);
  assert.equal(key, cachePathFor('ABCD-1234', 'Techno/track.mp3', cacheDir));
});

test('a first request decodes and caches; a second request for the same file skips decoding entirely', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn, calls } = countingSpawn();
  const opts = { cacheDir, spawnFn, buckets: 5, volumeId: 'ABCD-1234', relativePath: 'track.mp3' };

  const first = await getOrComputeEncodedWaveform(trackPath, opts);
  assert.equal(calls.count, 1);

  const cacheFilePath = cachePathFor('ABCD-1234', 'track.mp3', cacheDir);
  assert.ok(existsSync(cacheFilePath), 'expected a cache file to have been written to the box\'s own cache dir');

  const second = await getOrComputeEncodedWaveform(trackPath, opts);
  assert.equal(calls.count, 1, 'a cache hit should not spawn ffmpeg again');
  assert.deepEqual(second, first, 'a cache hit should return byte-identical data to the fresh decode');
});

test('isWaveformCached reflects whether a real cache entry exists for the current file', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn } = countingSpawn();
  const opts = { cacheDir, spawnFn, buckets: 5, volumeId: 'ABCD-1234', relativePath: 'track.mp3' };

  assert.equal(isWaveformCached(trackPath, opts), false);
  await getOrComputeEncodedWaveform(trackPath, opts);
  assert.equal(isWaveformCached(trackPath, opts), true);
});

test('a changed source file (different mtime) invalidates the cache rather than serving stale data', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn, calls } = countingSpawn();
  const opts = { cacheDir, spawnFn, buckets: 5, volumeId: 'ABCD-1234', relativePath: 'track.mp3' };

  await getOrComputeEncodedWaveform(trackPath, opts);
  assert.equal(calls.count, 1);

  // Simulate the file having been replaced/re-ripped - same path, new
  // content, so its mtime moves forward.
  const future = new Date(Date.now() + 60_000);
  utimesSync(trackPath, future, future);

  await getOrComputeEncodedWaveform(trackPath, opts);
  assert.equal(calls.count, 2, 'a changed mtime should force a fresh decode, not serve the stale cache');
});

test('a cache entry written by an older format version is treated as a miss, even with a matching fingerprint', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn, calls } = countingSpawn();
  const opts = { cacheDir, spawnFn, buckets: 5, volumeId: 'ABCD-1234', relativePath: 'track.mp3' };

  // Hand-craft a cache file matching the real header LAYOUT
  // ([formatVersion: uint8][mtimeMs: float64 LE][size: uint32 LE]) but
  // with an obviously-stale version byte (0) and a genuinely correct
  // mtime+size fingerprint - simulates a cache entry left over from a
  // previous algorithm (see waveform-cache.js's own FORMAT_VERSION doc
  // comment for the real incident this covers: switching the
  // band-separation filters left every already-cached track showing
  // stale, muddier colour separation until this check was added).
  const stat = statSync(trackPath);
  const staleHeader = Buffer.alloc(13);
  staleHeader.writeUInt8(0, 0);
  staleHeader.writeDoubleLE(stat.mtimeMs, 1);
  staleHeader.writeUInt32LE(stat.size, 9);
  const cacheFilePath = cachePathFor('ABCD-1234', 'track.mp3', cacheDir);
  mkdirSync(dirname(cacheFilePath), { recursive: true });
  writeFileSync(cacheFilePath, Buffer.concat([staleHeader, Buffer.from('old-format-payload')]));

  assert.equal(isWaveformCached(trackPath, opts), false, 'a version mismatch should read as not cached');

  await getOrComputeEncodedWaveform(trackPath, opts);
  assert.equal(calls.count, 1, 'should have decoded fresh rather than trusting the stale-version entry');
});

test('two different tracks never share a cache entry, even with identical content', async () => {
  const cacheDir = tempCacheDir();
  const trackA = tempTrack();
  const trackB = tempTrack(); // a separate temp copy - same bytes, different path

  const { spawnFn, calls } = countingSpawn();
  await getOrComputeEncodedWaveform(trackA, { cacheDir, spawnFn, buckets: 5, volumeId: 'ABCD-1234', relativePath: 'a.mp3' });
  await getOrComputeEncodedWaveform(trackB, { cacheDir, spawnFn, buckets: 5, volumeId: 'ABCD-1234', relativePath: 'b.mp3' });

  assert.equal(calls.count, 2, 'two distinct relativePaths should each get their own real decode, not share a cache entry');
});

test('touchVolumeLastSeen creates the volume directory with a fresh marker', () => {
  const cacheDir = tempCacheDir();
  touchVolumeLastSeen('ABCD-1234', cacheDir);

  const entries = readdirSync(cacheDir);
  assert.equal(entries.length, 1, 'expected exactly one volume directory to have been created');
});

test('cleanupStaleVolumes leaves a recently-seen volume alone', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  await getOrComputeEncodedWaveform(trackPath, { cacheDir, spawnFn: countingSpawn().spawnFn, buckets: 5, volumeId: 'ABCD-1234', relativePath: 'track.mp3' });
  touchVolumeLastSeen('ABCD-1234', cacheDir);

  const removed = cleanupStaleVolumes(cacheDir, 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(removed, []);
  assert.equal(isWaveformCached(trackPath, { cacheDir, volumeId: 'ABCD-1234', relativePath: 'track.mp3' }), true);
});

test('cleanupStaleVolumes removes a volume\'s entire cache once its marker is older than maxAgeMs', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  await getOrComputeEncodedWaveform(trackPath, { cacheDir, spawnFn: countingSpawn().spawnFn, buckets: 5, volumeId: 'ABCD-1234', relativePath: 'track.mp3' });
  touchVolumeLastSeen('ABCD-1234', cacheDir);

  // A negative maxAgeMs - "stale unless last seen in the future" - is
  // always true for a marker written before this call runs, robustly
  // regardless of filesystem mtime resolution. maxAgeMs of exactly 0
  // flaked here in practice: `now - lastSeenMs` can legitimately come
  // out to 0 if both land in the same millisecond tick, and `0 > 0`
  // is false.
  const removed = cleanupStaleVolumes(cacheDir, -1);
  assert.equal(removed.length, 1);
  assert.equal(isWaveformCached(trackPath, { cacheDir, volumeId: 'ABCD-1234', relativePath: 'track.mp3' }), false, 'the whole volume directory, cache file included, should be gone');
});

test('cleanupStaleVolumes only removes the stale volume, not other volumes still in circulation', () => {
  const cacheDir = tempCacheDir();
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000;

  touchVolumeLastSeen('STALE-VOL', cacheDir);
  touchVolumeLastSeen('FRESH-VOL', cacheDir);

  // Backdate STALE-VOL's own marker past maxAgeMs, without needing
  // cleanupStaleVolumes to accept a fake "now" - simpler to move the
  // one marker into the past than the whole clock.
  const staleMarkerPath = join(cachePathForVolumeDir('STALE-VOL', cacheDir), '.last-seen');
  const past = new Date(Date.now() - maxAgeMs - 1000);
  utimesSync(staleMarkerPath, past, past);

  const removed = cleanupStaleVolumes(cacheDir, maxAgeMs);
  assert.deepEqual(removed, [cachePathForVolumeDirName('STALE-VOL', cacheDir)]);
});

// Test-only mirror of waveform-cache.js's internal volumeDirFor() - simpler to reimplement the sha1(volumeId) scheme than export it for one test.
function cachePathForVolumeDir(volumeId, cacheDir) {
  return dirname(cachePathFor(volumeId, '', cacheDir));
}
function cachePathForVolumeDirName(volumeId, cacheDir) {
  return cachePathForVolumeDir(volumeId, cacheDir).slice(cacheDir.length + 1);
}

test('cleanupStaleVolumes on an empty/nonexistent cache dir does nothing and does not throw', () => {
  const cacheDir = join(tempCacheDir(), 'does-not-exist-yet');
  assert.deepEqual(cleanupStaleVolumes(cacheDir, 0), []);
});
