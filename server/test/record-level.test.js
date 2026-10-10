import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { peakFromPcm, createRecordLevel } from '../src/record-level.js';

/** Interleaved stereo S16_LE, the format arecord is asked for. */
function pcm(frames) {
  const buffer = Buffer.alloc(frames.length * 4);
  frames.forEach(([left, right], index) => {
    buffer.writeInt16LE(left, index * 4);
    buffer.writeInt16LE(right, index * 4 + 2);
  });
  return buffer;
}

test('the peak is per channel, and full scale reads as one', () => {
  assert.deepEqual(peakFromPcm(pcm([[0, 0]])), { left: 0, right: 0 });
  assert.deepEqual(peakFromPcm(pcm([[32768 / 2, 0]])), { left: 0.5, right: 0 });
  // Negative peaks count: a waveform is not louder for being the right way up.
  assert.deepEqual(peakFromPcm(pcm([[-32768, 0]])), { left: 1, right: 0 });
  // The loudest frame in the buffer wins, not the last.
  assert.deepEqual(peakFromPcm(pcm([[0, 32768 / 4], [0, 0]])), { left: 0, right: 0.25 });
});

/* A chunk boundary does not respect frames, and half a sample read as a whole one is a spike the
 * input never carried. */
test('a trailing partial frame is ignored rather than read across', () => {
  const whole = pcm([[100, 200]]);
  assert.deepEqual(peakFromPcm(Buffer.concat([whole, Buffer.from([0xff])])), peakFromPcm(whole));
  assert.deepEqual(peakFromPcm(Buffer.from([0xff, 0xff])), { left: 0, right: 0 });
});

function fakeSpawn() {
  const calls = [];
  const spawnFn = (command, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    calls.push({ command, args, proc });
    return proc;
  };
  return { spawnFn, calls };
}

test('capture starts on the first subscriber and stops on the last', () => {
  const { spawnFn, calls } = fakeSpawn();
  const level = createRecordLevel({ spawnFn, publishMs: 10_000 });

  assert.equal(calls.length, 0, 'nothing captures while nobody is looking');

  const stopA = level.subscribe(() => {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'arecord');
  assert.ok(calls[0].args.includes('dvs_record_capture'), 'the same device the recorder uses');

  const stopB = level.subscribe(() => {});
  assert.equal(calls.length, 1, 'a second watcher shares the one capture');

  stopA();
  assert.equal(calls[0].proc.killed, false, 'still one watcher left');
  stopB();
  assert.equal(calls[0].proc.killed, true, 'the last one out turns it off');
});

/* At 10Hz a peak that lived in only one buffer would be missed entirely, and a meter that misses
 * transients is worse than no meter. */
test('the peak is held between publishes, not taken from the last chunk', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const readings = [];
  const level = createRecordLevel({ spawnFn, publishMs: 20 });
  const stop = level.subscribe((reading) => readings.push(reading));

  calls[0].proc.stdout.emit('data', pcm([[32768 / 2, 0]]));  // loud
  calls[0].proc.stdout.emit('data', pcm([[0, 0]]));          // then silent

  // Waited for explicitly rather than by a fixed sleep, so a slow machine does not fail this.
  const until = Date.now() + 2000;
  while (readings.length < 2 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  stop();

  assert.ok(readings.length >= 2, `expected at least two readings, got ${readings.length}`);
  assert.equal(readings[0].left, 0.5, 'the loud chunk survived the quiet one after it');
  // And it resets, so a peak does not stick forever once the sound stops.
  assert.equal(readings[1].left, 0, 'silence afterwards reads as silence');
});
