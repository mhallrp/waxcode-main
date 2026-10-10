import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanLibrary } from '../src/library-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

// One fixture generated per format actually in the owner's collection
// (see test/fixtures). .aif is the same code path as .aiff, no separate fixture needed.
const GENERATED_EXTENSIONS = ['.mp3', '.wav', '.flac', '.aiff', '.ogg', '.m4a'];

test('finds every supported format, recursively, ignoring non-audio files', async () => {
  const tracks = await scanLibrary(FIXTURES);

  // 6 top-level samples + 1 nested = 7. readme.txt must not appear.
  assert.equal(tracks.length, 7);

  const extsFound = new Set(tracks.map((t) => t.path.slice(t.path.lastIndexOf('.'))));
  for (const ext of GENERATED_EXTENSIONS) {
    assert.ok(extsFound.has(ext), `expected a track with extension ${ext}`);
  }
});

test('reads artist/title tags correctly', async () => {
  const tracks = await scanLibrary(FIXTURES);
  const mp3 = tracks.find((t) => t.path.endsWith('sample.mp3'));

  assert.equal(mp3.artist, 'Test Artist');
  assert.equal(mp3.title, 'Test Title mp3');
});

test('reads duration from the format header, not just tags', async () => {
  const tracks = await scanLibrary(FIXTURES);
  const mp3 = tracks.find((t) => t.path.endsWith('sample.mp3'));

  // Exact value depends on the fixture's own real length - just
  // confirm it's a real, positive duration, not the 0-when-unknown
  // fallback.
  assert.ok(mp3.duration > 0, `expected a positive duration, got ${mp3.duration}`);
});

test('reads bpm from the tag when present, null when not', async () => {
  const tracks = await scanLibrary(FIXTURES);
  const mp3 = tracks.find((t) => t.path.endsWith('sample.mp3'));
  const flac = tracks.find((t) => t.path.endsWith('sample.flac'));

  assert.equal(mp3.bpm, 128, 'sample.mp3 fixture is tagged TBPM=128');
  assert.equal(flac.bpm, null, 'sample.flac has no bpm tag');
});

test('reads key from the tag when present, null when not - neither fixture is tagged', async () => {
  const tracks = await scanLibrary(FIXTURES);
  const mp3 = tracks.find((t) => t.path.endsWith('sample.mp3'));

  assert.equal(mp3.key, null, 'sample.mp3 fixture has no key tag');
});

test('finds tagged files in nested subfolders', async () => {
  const tracks = await scanLibrary(FIXTURES);
  const nested = tracks.find((t) => t.path.endsWith('nested.flac'));

  assert.ok(nested, 'nested.flac should be found');
  assert.equal(nested.artist, 'Nested Artist');
});

test('onTrack fires once per track, as each one is found', async () => {
  const seen = [];
  const tracks = await scanLibrary(FIXTURES, { onTrack: (track) => seen.push(track) });

  assert.equal(seen.length, tracks.length);
  assert.deepEqual(seen, tracks);
});

test('onFilesFound fires once with the full path list, before any onTrack call', async () => {
  const events = [];
  const tracks = await scanLibrary(FIXTURES, {
    onFilesFound: (paths) => events.push({ type: 'found', paths }),
    onTrack: (track) => events.push({ type: 'track', track }),
  });

  assert.equal(events[0].type, 'found');
  assert.equal(events[0].paths.length, tracks.length);
  assert.deepEqual(new Set(events[0].paths), new Set(tracks.map((t) => t.path)));
  assert.ok(events.slice(1).every((e) => e.type === 'track'), 'every event after onFilesFound should be a track event');
});

test('defers to active on-demand work before reading each file\'s tags', async () => {
  let waitCalls = 0;
  const tracks = await scanLibrary(FIXTURES, {
    // "Active" for every check - the real singleton only ever reports this transiently, but the
    // scan loop must call waitUntilIdleFn every time it sees it, not just once.
    isPriorityActiveFn: () => true,
    waitUntilIdleFn: async () => {
      waitCalls += 1;
    },
  });

  assert.equal(waitCalls, tracks.length, 'should defer once per file while priority work is reported active');
});

test('never calls waitUntilIdleFn when nothing else is active', async () => {
  let waitCalls = 0;
  await scanLibrary(FIXTURES, {
    isPriorityActiveFn: () => false,
    waitUntilIdleFn: async () => {
      waitCalls += 1;
    },
  });

  assert.equal(waitCalls, 0, 'should never defer when isPriorityActiveFn reports idle');
});

test('pauses the tag-reading loop while memory is tight, rather than allocating through it', async () => {
  // A cold scan of 3,115 tracks took the server from 86MB to ~200MB RSS and pushed 306MB into zram
  // on a 1GB box (2026-09-20). Nothing was killed, but a swapping server shares a BLE link with
  // 50ms status ticks and waveform transfers, and the app became unusable. Slower is the right
  // trade here: nobody waits on a background scan the way they wait on a track.
  let reported = 100; // below the threshold to begin with
  const memoryChecks = [];
  const retries = [];

  const tracks = await scanLibrary(FIXTURES, {
    getAvailableMemoryMBFn: () => {
      memoryChecks.push(reported);
      // Free up after the first couple of checks, so the scan proceeds rather than hanging.
      if (memoryChecks.length >= 2) reported = 900;
      return reported;
    },
    minAvailableMemoryMB: 250,
    memoryCheckRetryMs: 1,
    isPriorityActiveFn: () => false,
    waitUntilIdleFn: async () => { retries.push('idle'); },
  });

  assert.ok(memoryChecks.length >= 2, 'it must re-check rather than deciding once and carrying on');
  assert.ok(memoryChecks[0] < 250, 'the first check saw a box under pressure');
  assert.ok(tracks.length > 0, 'and the scan still completes once memory frees up');
});

test('a null memory reading is not treated as low memory', async () => {
  // getAvailableMemoryMB returns null when /proc/meminfo cannot be read at all. Treating "unknown"
  // as "tight" would stall the scan forever on any platform without it.
  const tracks = await scanLibrary(FIXTURES, {
    getAvailableMemoryMBFn: () => null,
    minAvailableMemoryMB: 250,
    memoryCheckRetryMs: 1,
    isPriorityActiveFn: () => false,
    waitUntilIdleFn: async () => {},
  });
  assert.ok(tracks.length > 0, 'an unreadable /proc/meminfo must not block the scan');
});
