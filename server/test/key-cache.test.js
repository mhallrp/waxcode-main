import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, copyFileSync, utimesSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrComputeKey, isKeyCached } from '../src/key-cache.js';
import { cachePathFor } from '../src/waveform-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_MP3 = join(__dirname, 'fixtures', 'sample.mp3');

function tempCacheDir() {
  return mkdtempSync(join(tmpdir(), 'pidvs-key-cache-test-'));
}

function tempTrack() {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-key-track-test-'));
  const trackPath = join(dir, 'track.mp3');
  copyFileSync(FIXTURE_MP3, trackPath);
  return trackPath;
}

function fakeKeyfinderSpawn(stdout) {
  const calls = { count: 0 };
  const spawnFn = () => {
    calls.count += 1;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      proc.stdout.emit('data', stdout);
      proc.emit('close', 0);
    });
    return proc;
  };
  return { spawnFn, calls };
}

test('getOrComputeKey computes and caches a key on a miss', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn, calls } = fakeKeyfinderSpawn('10A\n');

  const key = await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });
  assert.equal(key, '10A');
  assert.equal(calls.count, 1);
});

test('getOrComputeKey serves from cache on a second call, without re-running keyfinder-cli', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn, calls } = fakeKeyfinderSpawn('5B\n');

  const first = await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });
  const second = await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });

  assert.equal(second, first);
  assert.equal(calls.count, 1, 'second call should be a cache hit, not a second keyfinder-cli run');
});

test('a null key (no key detected) is itself cached, not recomputed on the next call', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn, calls } = fakeKeyfinderSpawn('');

  const first = await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });
  const second = await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });

  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(calls.count, 1, 'a cached null result should still short-circuit the second call');
});

test('a changed source file (different mtime) invalidates the cache and recomputes', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn, calls } = fakeKeyfinderSpawn('10A\n');

  await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });
  const future = new Date(Date.now() + 60_000);
  utimesSync(trackPath, future, future);
  await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });

  assert.equal(calls.count, 2, 'a changed mtime should force a fresh keyfinder-cli run');
});

test('isKeyCached is false before computing, true after', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn } = fakeKeyfinderSpawn('10A\n');

  assert.equal(isKeyCached(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir }), false);
  await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });
  assert.equal(isKeyCached(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir }), true);
});

test('isKeyCached is true for a cached null key too - a checked-and-found-nothing track should not be re-queued', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn } = fakeKeyfinderSpawn('');

  await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });
  assert.equal(isKeyCached(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir }), true);
});

test('is stored right alongside the waveform cache entry - same directory, same key, sibling file', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn } = fakeKeyfinderSpawn('10A\n');

  await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });

  const waveformPath = cachePathFor('VOL1', 'track.mp3', cacheDir);
  const keyPath = waveformPath.replace(/\.bin$/, '.key.json');
  assert.equal(dirname(keyPath), dirname(waveformPath));
  assert.ok(existsSync(keyPath));
});

test('a corrupt cache file falls back to recomputing rather than crashing', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn, calls } = fakeKeyfinderSpawn('10A\n');

  const waveformPath = cachePathFor('VOL1', 'track.mp3', cacheDir);
  const keyPath = waveformPath.replace(/\.bin$/, '.key.json');
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, 'not valid json');

  const key = await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });
  assert.equal(key, '10A');
  assert.equal(calls.count, 1);
});

test('a saved cache entry never leaves a stray .tmp file behind', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn } = fakeKeyfinderSpawn('10A\n');

  await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });

  const waveformPath = cachePathFor('VOL1', 'track.mp3', cacheDir);
  const keyPath = waveformPath.replace(/\.bin$/, '.key.json');
  assert.equal(existsSync(`${keyPath}.tmp`), false);
});

test('the cache file stores plain JSON with the key string', async () => {
  const cacheDir = tempCacheDir();
  const trackPath = tempTrack();
  const { spawnFn } = fakeKeyfinderSpawn('7B\n');

  await getOrComputeKey(trackPath, { volumeId: 'VOL1', relativePath: 'track.mp3', cacheDir, spawnFn });

  const waveformPath = cachePathFor('VOL1', 'track.mp3', cacheDir);
  const keyPath = waveformPath.replace(/\.bin$/, '.key.json');
  const stored = JSON.parse(readFileSync(keyPath, 'utf8'));
  assert.equal(stored.key, '7B');
});
