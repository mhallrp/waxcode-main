import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecorder, defaultName, RECORD_DEVICE } from '../src/recorder.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'pidvs-rec-'));

function fakeSpawn() {
  const calls = [];
  const children = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = (signal) => { child.killedWith = signal; };
    child.stderr = new EventEmitter();
    children.push(child);
    return child;
  };
  return { spawnFn, calls, children };
}

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('start records MP3 from the record input', () => {
  const { spawnFn, calls } = fakeSpawn();
  const recorder = createRecorder({ spawnFn, recordingsDir: tempDir() });

  recorder.start('a-set');

  assert.equal(argAfter(calls[0].args, '-i'), RECORD_DEVICE);
  assert.equal(argAfter(calls[0].args, '-c:a'), 'libmp3lame');
  assert.equal(argAfter(calls[0].args, '-ar'), '48000');
  assert.ok(calls[0].args[calls[0].args.length - 1].endsWith('a-set.mp3'));
});

test('the size limit is handed to ffmpeg, not policed by polling', () => {
  const { spawnFn, calls } = fakeSpawn();
  const recorder = createRecorder({ spawnFn, recordingsDir: tempDir() });

  recorder.start();

  // A poll can overshoot between ticks; -fs cannot. The whole point of a fixed-size volume is
  // that going over is impossible rather than merely unlikely.
  const limit = Number(argAfter(calls[0].args, '-fs'));
  assert.ok(Number.isFinite(limit) && limit > 0, `expected a byte limit, got ${limit}`);
});

test('starting again while recording is refused rather than silently ignored', () => {
  const { spawnFn, calls } = fakeSpawn();
  const recorder = createRecorder({ spawnFn, recordingsDir: tempDir() });

  recorder.start();
  assert.throws(() => recorder.start(), /already recording/i);
  assert.equal(calls.length, 1);
});

test('starting replaces the existing recording - one file at a time, by design', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'old-set.mp3'), 'previous audio');
  const { spawnFn } = fakeSpawn();
  const recorder = createRecorder({ spawnFn, recordingsDir: dir });

  recorder.start('new-set');

  assert.equal(existsSync(join(dir, 'old-set.mp3')), false, 'the old recording must be gone');
});

test('stop finalises with SIGINT so the file is not left truncated', () => {
  const { spawnFn, children } = fakeSpawn();
  const recorder = createRecorder({ spawnFn, recordingsDir: tempDir() });

  recorder.start('a-set');
  assert.equal(recorder.stop(), 'a-set.mp3');

  assert.equal(children[0].killedWith, 'SIGINT');
  assert.equal(recorder.status().recording, false);
});

test('stopping when nothing is recording is a no-op, not an error', () => {
  const { spawnFn } = fakeSpawn();
  const recorder = createRecorder({ spawnFn, recordingsDir: tempDir() });
  assert.equal(recorder.stop(), null);
});

test('existing() finds a recording left behind by a power cut', () => {
  const dir = tempDir();
  writeFileSync(join(dir, '2026-08-24 09-15.mp3'), 'audio');
  const recorder = createRecorder({ spawnFn: fakeSpawn().spawnFn, recordingsDir: dir });

  // Scanned rather than remembered, so a recording survives the process that made it.
  assert.equal(recorder.existing().name, '2026-08-24 09-15.mp3');
  assert.equal(recorder.status().hasRecording, true);
});

test('status reports nothing when the volume is empty', () => {
  const recorder = createRecorder({ spawnFn: fakeSpawn().spawnFn, recordingsDir: tempDir() });
  const status = recorder.status();

  assert.equal(status.recording, false);
  assert.equal(status.hasRecording, false);
  assert.equal(status.name, null);
  assert.ok(status.remainingSeconds > 0, 'an empty volume has time available');
});

test('remove deletes the recording, and refuses while one is being written', () => {
  const dir = tempDir();
  const { spawnFn } = fakeSpawn();
  const recorder = createRecorder({ spawnFn, recordingsDir: dir });

  writeFileSync(join(dir, 'a-set.mp3'), 'audio');
  recorder.start('live');
  assert.throws(() => recorder.remove(), /stop the recording/i);

  recorder.stop();
  writeFileSync(join(dir, 'live.mp3'), 'audio');
  assert.equal(recorder.remove(), true);
  assert.equal(recorder.existing(), null);
});

test('remove on an empty volume reports that there was nothing to do', () => {
  const recorder = createRecorder({ spawnFn: fakeSpawn().spawnFn, recordingsDir: tempDir() });
  assert.equal(recorder.remove(), false);
});

test('exportTo copies the recording to the stick and puts it back read-only', async () => {
  const dir = tempDir();
  const stick = tempDir();
  writeFileSync(join(dir, 'a-set.mp3'), 'the mix');
  const recorder = createRecorder({ spawnFn: fakeSpawn().spawnFn, recordingsDir: dir });

  let wrapped = false;
  const stickStorage = {
    withWritableStick: async (mountPath, body) => { wrapped = true; return body(); },
  };

  const result = await recorder.exportTo({ mountPath: stick, stickStorage, freeBytesOnStick: 1e9 });

  assert.ok(wrapped, 'the copy must go through the remount wrapper, not write to a read-only stick');
  assert.equal(readFileSync(join(stick, 'Recordings', 'a-set.mp3'), 'utf8'), 'the mix');
  assert.equal(result.name, 'a-set.mp3');
});

test('exportTo refuses rather than half-copying when the stick is too full', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'a-set.mp3'), 'the mix');
  const recorder = createRecorder({ spawnFn: fakeSpawn().spawnFn, recordingsDir: dir });

  await assert.rejects(
    () => recorder.exportTo({
      mountPath: tempDir(),
      stickStorage: { withWritableStick: async (_, body) => body() },
      freeBytesOnStick: 1,
    }),
    /not enough room/i,
  );
});

test('exportTo refuses while recording, and when there is nothing to copy', async () => {
  const dir = tempDir();
  const { spawnFn } = fakeSpawn();
  const recorder = createRecorder({ spawnFn, recordingsDir: dir });
  const stickStorage = { withWritableStick: async (_, body) => body() };

  await assert.rejects(
    () => recorder.exportTo({ mountPath: tempDir(), stickStorage, freeBytesOnStick: 1e9 }),
    /no recording/i,
  );

  recorder.start();
  await assert.rejects(
    () => recorder.exportTo({ mountPath: tempDir(), stickStorage, freeBytesOnStick: 1e9 }),
    /stop the recording/i,
  );
});

test('defaultName is sortable and safe on the exFAT stick it may be copied to', () => {
  const name = defaultName(new Date(2026, 7, 24, 9, 5));
  assert.equal(name, '2026-08-24 09-05');
  assert.ok(!name.includes(':'), 'colons are illegal on exFAT');
});

test('a recording that ends on its own says so, rather than leaving the app showing "recording"', () => {
  const { spawnFn, children } = fakeSpawn();
  let ended = 0;
  const recorder = createRecorder({
    spawnFn,
    recordingsDir: tempDir(),
    onEndedByItself: () => { ended += 1 },
  });

  recorder.start();
  // ffmpeg exiting by itself - hitting -fs, or dying. Every other transition is published by
  // whoever asked for it; this one has nobody to report it.
  children[0].emit('close', 0);

  assert.equal(ended, 1);
  assert.equal(recorder.status().recording, false);
});

test('a deliberate stop does not fire the ended-by-itself callback twice', () => {
  const { spawnFn, children } = fakeSpawn();
  let ended = 0;
  const recorder = createRecorder({
    spawnFn,
    recordingsDir: tempDir(),
    onEndedByItself: () => { ended += 1 },
  });

  recorder.start();
  recorder.stop();
  children[0].emit('close', 255);   // SIGINT makes ffmpeg exit non-zero; that is normal here

  assert.equal(ended, 0, 'the app already knows - it asked for the stop');
});

/*
 * The copy used to be copyFileSync, which blocked Node's event loop for the whole transfer - on a
 * cheap stick a 300MB set is tens of seconds during which the box answers nothing at all. It also
 * meant there was no progress to report, because nothing could run to report it.
 */
test('the export streams, reporting progress, and leaves nothing behind when it finishes', async () => {
  const recordingsDir = tempDir();
  const recorder = createRecorder({ spawnFn: fakeSpawn().spawnFn, recordingsDir });

  const payload = Buffer.alloc(256 * 1024, 7);
  writeFileSync(join(recordingsDir, 'a-set.mp3'), payload);

  const mountPath = tempDir();
  const seen = [];
  const stickStorage = {
    withWritableStick: async (_path, fn) => {
      // Sampled WHILE the copy runs - the whole point is that other work can still happen.
      const timer = setInterval(() => { seen.push(recorder.status().exporting); }, 1);
      try {
        return await fn();
      } finally {
        clearInterval(timer);
      }
    },
  };

  assert.equal(recorder.status().exporting, null, 'nothing in flight before it starts');

  const result = await recorder.exportTo({
    mountPath, stickStorage, freeBytesOnStick: payload.length * 4,
  });

  assert.equal(result.name, 'a-set.mp3');
  assert.deepEqual(
    readFileSync(join(mountPath, 'Recordings', 'a-set.mp3')),
    payload,
    'and every byte arrived',
  );

  const reported = seen.filter(Boolean);
  assert.ok(reported.length > 0, 'the event loop kept running during the copy');
  assert.ok(reported.every((one) => one.total === payload.length), 'the total is the file size');
  assert.ok(
    reported.every((one) => one.copied >= 0 && one.copied <= one.total),
    'progress stays within the file',
  );
  assert.equal(recorder.status().exporting, null, 'and it clears when the copy is done');
});

/** A failed copy must not leave a bar stuck on screen for the rest of the session. */
test('a failed export clears its progress', async () => {
  const recordingsDir = tempDir();
  const recorder = createRecorder({ spawnFn: fakeSpawn().spawnFn, recordingsDir });
  writeFileSync(join(recordingsDir, 'a-set.mp3'), Buffer.alloc(1024));

  const stickStorage = {
    withWritableStick: async (_path, fn) => fn(),
  };

  await assert.rejects(recorder.exportTo({
    // A directory that cannot be created, so the copy fails part way in rather than never starting.
    mountPath: '/proc/nonexistent-waxcode-test',
    stickStorage,
    freeBytesOnStick: 1024 * 4,
  }));
  assert.equal(recorder.status().exporting, null);
});

/*
 * Progress must reflect what reached the DEVICE, not what the kernel accepted into the page cache.
 * dirty_ratio on the box allows ~198MB of a 990MB machine to sit dirty, so a bar counting accepted
 * bytes races to that limit and then crawls - or on a smaller file reads 100% while the stick is
 * still catching up, at exactly the moment somebody decides whether to pull it out.
 */
test('export progress never runs ahead of what has been flushed', async () => {
  const { copyWithProgress } = await import('../src/recorder.js');
  const dir = tempDir();
  const payload = Buffer.alloc(40 * 1024, 3);
  writeFileSync(join(dir, 'in.bin'), payload);

  const reported = [];
  await copyWithProgress(join(dir, 'in.bin'), join(dir, 'out.bin'), (copied) => reported.push(copied), {
    chunkBytes: 4 * 1024,
    flushEveryBytes: 16 * 1024,
  });

  assert.deepEqual(readFileSync(join(dir, 'out.bin')), payload, 'every byte arrived');
  assert.ok(reported.length >= 2, `expected several updates, got ${reported.length}`);
  assert.deepEqual(
    [...reported].sort((a, b) => a - b), reported,
    'progress only ever moves forward',
  );
  assert.equal(reported[reported.length - 1], payload.length, 'and ends at the real total');
  assert.ok(
    reported.every((value) => value <= payload.length),
    'never claims more than the file holds',
  );
  // Flushed in 16KB steps, so the first report is a flush boundary rather than the first 4KB chunk.
  assert.equal(reported[0], 16 * 1024, 'reported at the flush, not at the write');
});
