import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaveformPrefetcher } from '../src/waveform-prefetch.js';
import { beginPriorityWork, endPriorityWork, _resetForTests } from '../src/on-demand-priority.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function track(path, volumeId = 'VOL-1', relativePath) {
  return { path, volumeId, relativePath: relativePath ?? path.replace(/^\//, '') };
}

test('prefetches every track in a folder that is not already cached', async () => {
  const computed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => { computed.push(path); return Buffer.alloc(0); },
  });

  prefetcher.enqueue([track('/a.mp3'), track('/b.mp3'), track('/c.mp3')]);
  await wait(20);

  assert.deepEqual(computed.sort(), ['/a.mp3', '/b.mp3', '/c.mp3']);
});

test('skips tracks that are already fully cached (waveform, beat grid, AND key), without computing any', async () => {
  const computed = [];
  const cached = new Set(['/already-cached.mp3']);
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: (path) => cached.has(path),
    getOrComputeEncodedWaveformFn: async (path) => { computed.push(path); return Buffer.alloc(0); },
    isBeatGridCachedFn: (path) => cached.has(path),
    getOrComputeBeatGridFn: async (path) => {
      if (cached.has(path)) throw new Error('should not be called for an already-cached track');
      return { bpm: 128, firstBeatSeconds: 1.2 };
    },
    keyPrefetchEnabled: true,
    isKeyCachedFn: (path) => cached.has(path),
    getOrComputeKeyFn: async (path) => {
      if (cached.has(path)) throw new Error('should not be called for an already-cached track');
      return '10A';
    },
  });

  prefetcher.enqueue([track('/already-cached.mp3'), track('/needs-it.mp3')]);
  await wait(20);

  assert.deepEqual(computed, ['/needs-it.mp3']);
});

test('passes volumeId/relativePath through to both the cache check and the compute call', async () => {
  const cacheCheckArgs = [];
  const computeArgs = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: (path, options) => { cacheCheckArgs.push(options); return false; },
    getOrComputeEncodedWaveformFn: async (path, options) => { computeArgs.push(options); return Buffer.alloc(0); },
  });

  prefetcher.enqueue([track('/media/pidvs/port-1/Techno/a.mp3', 'ABCD-1234', 'Techno/a.mp3')]);
  await wait(20);

  assert.equal(cacheCheckArgs[0].volumeId, 'ABCD-1234');
  assert.equal(cacheCheckArgs[0].relativePath, 'Techno/a.mp3');
  assert.equal(computeArgs[0].volumeId, 'ABCD-1234');
  assert.equal(computeArgs[0].relativePath, 'Techno/a.mp3');
});

test('processes one track at a time, not concurrently', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await wait(15);
      concurrent -= 1;
      return Buffer.alloc(0);
    },
  });

  prefetcher.enqueue([track('/a.mp3'), track('/b.mp3'), track('/c.mp3')]);
  await wait(80);

  assert.equal(maxConcurrent, 1);
});

test('every prefetch job runs at background priority, never on-demand/full', async () => {
  const calls = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path, options) => { calls.push(options); return Buffer.alloc(0); },
  });

  prefetcher.enqueue([track('/a.mp3')]);
  await wait(20);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].priority, 'background');
});

test('runs even while enqueued repeatedly - does not queue the same not-yet-processed path twice', async () => {
  const computed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => {
      await wait(15);
      computed.push(path);
      return Buffer.alloc(0);
    },
  });

  prefetcher.enqueue([track('/a.mp3')]);
  prefetcher.enqueue([track('/a.mp3')]); // re-browsing the same folder before the first pass finishes
  await wait(40);

  assert.deepEqual(computed, ['/a.mp3']);
});

test('a failure prefetching one track does not stop the others from being tried', async () => {
  const computed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => {
      if (path === '/bad.mp3') throw new Error('ffmpeg exited 1');
      computed.push(path);
      return Buffer.alloc(0);
    },
  });

  prefetcher.enqueue([track('/good1.mp3'), track('/bad.mp3'), track('/good2.mp3')]);
  await wait(30);

  assert.deepEqual(computed.sort(), ['/good1.mp3', '/good2.mp3']);
});

test('stop() prevents already-queued-but-not-yet-started jobs from running', async () => {
  const computed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => {
      await wait(15);
      computed.push(path);
      return Buffer.alloc(0);
    },
  });

  prefetcher.enqueue([track('/a.mp3'), track('/b.mp3'), track('/c.mp3')]);
  await wait(5); // let the first job start, before it or the rest finish
  prefetcher.stop();
  await wait(40);

  assert.ok(computed.length < 3, 'stop() should have prevented at least some queued jobs from ever starting');
});

test('also computes and caches each track\'s beat grid, alongside its waveform', async () => {
  const gridComputed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async () => Buffer.alloc(0),
    isBeatGridCachedFn: () => false,
    getOrComputeBeatGridFn: async (path) => { gridComputed.push(path); return { bpm: 128, firstBeatSeconds: 1.2 }; },
    getOrComputeKeyFn: async () => null, // not under test here - avoid a real keyfinder-cli fallback attempt
  });

  prefetcher.enqueue([track('/a.mp3'), track('/b.mp3')]);
  await wait(20);

  assert.deepEqual(gridComputed.sort(), ['/a.mp3', '/b.mp3']);
});

test('a track is skipped entirely only once its waveform, beat grid, AND key are all already cached', async () => {
  const waveformComputed = [];
  const gridComputed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: (path) => path === '/both-cached.mp3' || path === '/waveform-only.mp3',
    getOrComputeEncodedWaveformFn: async (path) => { waveformComputed.push(path); return Buffer.alloc(0); },
    isBeatGridCachedFn: (path) => path === '/both-cached.mp3',
    getOrComputeBeatGridFn: async (path) => { gridComputed.push(path); return { bpm: 128, firstBeatSeconds: 1.2 }; },
    keyPrefetchEnabled: true,
    isKeyCachedFn: (path) => path === '/both-cached.mp3',
    getOrComputeKeyFn: async () => '10A',
  });

  prefetcher.enqueue([track('/both-cached.mp3'), track('/waveform-only.mp3')]);
  await wait(20);

  // both-cached.mp3 is skipped outright (never queued); waveform-only.mp3
  // still gets queued to backfill just its missing beat grid/key - its
  // waveform compute runs too (a cheap cache hit in real code, not
  // something this fake distinguishes), but the point being tested is
  // that the beat grid gets computed for it.
  assert.ok(!waveformComputed.includes('/both-cached.mp3'));
  assert.deepEqual(gridComputed, ['/waveform-only.mp3']);
});

test('a beat grid failure does not prevent the waveform from being counted as done, and vice versa', async () => {
  const waveformComputed = [];
  const gridComputed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => { waveformComputed.push(path); return Buffer.alloc(0); },
    isBeatGridCachedFn: () => false,
    getOrComputeBeatGridFn: async (path) => {
      if (path === '/no-grid.mp3') throw new Error('aubio exited 1');
      gridComputed.push(path);
      return { bpm: 128, firstBeatSeconds: 1.2 };
    },
    getOrComputeKeyFn: async () => null, // not under test here - avoid a real keyfinder-cli fallback attempt
  });

  prefetcher.enqueue([track('/no-grid.mp3'), track('/fine.mp3')]);
  await wait(20);

  assert.deepEqual(waveformComputed.sort(), ['/fine.mp3', '/no-grid.mp3']);
  assert.deepEqual(gridComputed, ['/fine.mp3']);
});

test('beat grid computation also runs at background priority', async () => {
  const calls = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async () => Buffer.alloc(0),
    isBeatGridCachedFn: () => false,
    getOrComputeBeatGridFn: async (path, options) => { calls.push(options); return null; },
    getOrComputeKeyFn: async () => null, // not under test here - avoid a real keyfinder-cli fallback attempt
  });

  prefetcher.enqueue([track('/a.mp3')]);
  await wait(20);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].priority, 'background');
});

test('key prefetch is OFF by default - not called even if a track is otherwise fully cached', async () => {
  const keyComputed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async () => Buffer.alloc(0),
    isBeatGridCachedFn: () => false,
    getOrComputeBeatGridFn: async () => ({ bpm: 128, firstBeatSeconds: 1.2 }),
    getOrComputeKeyFn: async (path) => { keyComputed.push(path); return '10A'; },
  });

  prefetcher.enqueue([track('/a.mp3')]);
  await wait(20);

  assert.deepEqual(keyComputed, [], 'key prefetch must stay off unless explicitly enabled - see DEVLOG.md 2026-08-04');
});

test('also computes and caches each track\'s key, alongside its waveform and beat grid', async () => {
  const keyComputed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async () => Buffer.alloc(0),
    isBeatGridCachedFn: () => false,
    getOrComputeBeatGridFn: async () => ({ bpm: 128, firstBeatSeconds: 1.2 }),
    keyPrefetchEnabled: true,
    isKeyCachedFn: () => false,
    getOrComputeKeyFn: async (path) => { keyComputed.push(path); return '10A'; },
  });

  prefetcher.enqueue([track('/a.mp3'), track('/b.mp3')]);
  await wait(20);

  assert.deepEqual(keyComputed.sort(), ['/a.mp3', '/b.mp3']);
});

test('a key failure does not prevent the waveform/grid from being counted as done, and vice versa', async () => {
  const waveformComputed = [];
  const keyComputed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => { waveformComputed.push(path); return Buffer.alloc(0); },
    isBeatGridCachedFn: () => false,
    getOrComputeBeatGridFn: async () => ({ bpm: 128, firstBeatSeconds: 1.2 }),
    keyPrefetchEnabled: true,
    isKeyCachedFn: () => false,
    getOrComputeKeyFn: async (path) => {
      if (path === '/no-key.mp3') throw new Error('keyfinder-cli exited 1');
      keyComputed.push(path);
      return '10A';
    },
  });

  prefetcher.enqueue([track('/no-key.mp3'), track('/fine.mp3')]);
  await wait(20);

  assert.deepEqual(waveformComputed.sort(), ['/fine.mp3', '/no-key.mp3']);
  assert.deepEqual(keyComputed, ['/fine.mp3']);
});

test('key computation also runs at background priority', async () => {
  const calls = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async () => Buffer.alloc(0),
    isBeatGridCachedFn: () => false,
    getOrComputeBeatGridFn: async () => null,
    keyPrefetchEnabled: true,
    isKeyCachedFn: () => false,
    getOrComputeKeyFn: async (path, options) => { calls.push(options); return null; },
  });

  prefetcher.enqueue([track('/a.mp3')]);
  await wait(20);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].priority, 'background');
});

test('onProgress reports {completed, total} as tracks are enqueued and finish', async () => {
  const progressUpdates = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async () => Buffer.alloc(0),
    isBeatGridCachedFn: () => false,
    getOrComputeBeatGridFn: async () => null,
    onProgress: (p) => progressUpdates.push({ ...p }),
  });

  prefetcher.enqueue([track('/a.mp3'), track('/b.mp3')]);
  await wait(20);

  // First update is right after enqueue (0 done, 2 total); the rest trickle in as each track finishes.
  assert.deepEqual(progressUpdates[0], { completed: 0, total: 2 });
  assert.deepEqual(progressUpdates.at(-1), { completed: 2, total: 2 });
});

test('onProgress counts a track as done (for progress purposes) even if it failed, not just on success', async () => {
  const progressUpdates = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => { if (path === '/bad.mp3') throw new Error('nope'); return Buffer.alloc(0); },
    isBeatGridCachedFn: () => false,
    getOrComputeBeatGridFn: async () => null,
    onProgress: (p) => progressUpdates.push({ ...p }),
  });

  prefetcher.enqueue([track('/bad.mp3')]);
  await wait(20);

  assert.deepEqual(progressUpdates.at(-1), { completed: 1, total: 1 });
});

test('onProgress never fires a "newly queued" bump for a track that was already fully cached - it\'s never queued at all', async () => {
  const progressUpdates = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => true,
    isBeatGridCachedFn: () => true,
    getOrComputeEncodedWaveformFn: async () => Buffer.alloc(0),
    getOrComputeBeatGridFn: async () => null,
    onProgress: (p) => progressUpdates.push({ ...p }),
  });

  prefetcher.enqueue([track('/already-cached.mp3')]);
  await wait(20);

  assert.deepEqual(progressUpdates, [{ completed: 0, total: 0 }]);
});

test('stop() un-counts abandoned (never-started) tracks from total, so completed can still reach total afterwards', async () => {
  const progressUpdates = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async () => { await wait(15); return Buffer.alloc(0); },
    isBeatGridCachedFn: () => false,
    getOrComputeBeatGridFn: async () => null,
    onProgress: (p) => progressUpdates.push({ ...p }),
  });

  prefetcher.enqueue([track('/a.mp3'), track('/b.mp3'), track('/c.mp3')]);
  await wait(5); // let the first job start, before any finish
  prefetcher.stop();
  await wait(30);

  const last = progressUpdates.at(-1);
  assert.equal(last.completed, last.total, 'completed should have caught up to total after stop() discounted the abandoned tracks');
});

test('never starts a new track while on-demand priority work (a deck load) is active', async () => {
  _resetForTests();
  const computed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => { computed.push(path); return Buffer.alloc(0); },
    isBeatGridCachedFn: () => true,
    getOrComputeBeatGridFn: async () => null,
  });

  beginPriorityWork();
  prefetcher.enqueue([track('/a.mp3'), track('/b.mp3')]);
  await wait(20);
  assert.deepEqual(computed, [], 'nothing should start while priority work is active');

  endPriorityWork();
  await wait(20);
  assert.deepEqual(computed.sort(), ['/a.mp3', '/b.mp3'], 'queued tracks should process once priority work clears');
});

test('a track already in flight when priority work begins is left to finish naturally (soft, not hard, preemption)', async () => {
  _resetForTests();
  const computed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => { await wait(15); computed.push(path); return Buffer.alloc(0); },
    isBeatGridCachedFn: () => true,
    getOrComputeBeatGridFn: async () => null,
  });

  prefetcher.enqueue([track('/a.mp3')]);
  await wait(5); // let the in-flight job start before priority work begins
  beginPriorityWork();
  await wait(20);

  assert.deepEqual(computed, ['/a.mp3'], 'the already-running job should finish rather than being killed');
  endPriorityWork();
});

test('never starts a new track while available memory is below the safe floor', async () => {
  const computed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => { computed.push(path); return Buffer.alloc(0); },
    isBeatGridCachedFn: () => true,
    getOrComputeBeatGridFn: async () => null,
    getAvailableMemoryMBFn: () => 50, // well below any real threshold
    minAvailableMemoryMB: 250,
    memoryCheckRetryMs: 5,
  });

  prefetcher.enqueue([track('/a.mp3')]);
  await wait(30);

  assert.deepEqual(computed, [], 'nothing should start while memory is below the safe floor');
  prefetcher.stop(); // otherwise the retry loop's setTimeout keeps the process alive forever
});

test('resumes once available memory recovers above the safe floor', async () => {
  const computed = [];
  let availableMB = 50;
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => { computed.push(path); return Buffer.alloc(0); },
    isBeatGridCachedFn: () => true,
    getOrComputeBeatGridFn: async () => null,
    getAvailableMemoryMBFn: () => availableMB,
    minAvailableMemoryMB: 250,
    memoryCheckRetryMs: 5,
  });

  prefetcher.enqueue([track('/a.mp3')]);
  await wait(20);
  assert.deepEqual(computed, [], 'still paused while memory is low');

  availableMB = 500;
  await wait(30);
  assert.deepEqual(computed, ['/a.mp3'], 'should resume once memory recovers');
});

test('a null return from getAvailableMemoryMBFn (eg. unreadable /proc/meminfo) never blocks - unknown is not treated as zero', async () => {
  const computed = [];
  const prefetcher = createWaveformPrefetcher({
    enabled: true,
    isWaveformCachedFn: () => false,
    getOrComputeEncodedWaveformFn: async (path) => { computed.push(path); return Buffer.alloc(0); },
    isBeatGridCachedFn: () => true,
    getOrComputeBeatGridFn: async () => null,
    getAvailableMemoryMBFn: () => null,
    minAvailableMemoryMB: 250,
  });

  prefetcher.enqueue([track('/a.mp3')]);
  await wait(20);

  assert.deepEqual(computed, ['/a.mp3'], 'null (unknown) memory reading must not be treated as "out of memory"');
});

test('is inert unless explicitly enabled - the default since 2026-09-15, so a new box never chews through the whole drive', async () => {
  const analysed = [];
  // No `enabled`, exactly as index.js constructs it on a real box with no opt-in flag.
  const prefetcher = createWaveformPrefetcher({
    cacheDir: '/tmp/cache',
    getOrComputeEncodedWaveformFn: async (path) => { analysed.push(path); return Buffer.alloc(0); },
    isWaveformCachedFn: () => false,
  });

  prefetcher.enqueue('/a.mp3');
  prefetcher.enqueue('/b.mp3');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(analysed, [], 'nothing should be analysed ahead of being asked for');
});

test('reports itself caught up when disabled, so the app shows no phantom scan progress', () => {
  const progress = [];
  createWaveformPrefetcher({ cacheDir: '/tmp/cache', onProgress: (p) => progress.push(p) });
  assert.deepEqual(progress, [{ completed: 0, total: 0 }]);
});
