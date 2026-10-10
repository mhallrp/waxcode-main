import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeWaveformPeaks, computeWaveformInSegments, SEGMENT_FRACTIONS, normalizeToInt8, decimateForAnalysis } from '../src/waveform.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

function fakeSpawnReturning(pcm) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // fd 3 is the beat grid's 8kHz half of the same decode - see shared-decode.js.
    proc.stdio = [null, proc.stdout, proc.stderr, new EventEmitter()];
    queueMicrotask(() => {
      proc.stdout.emit('data', pcm);
      proc.stdio[3].emit('data', pcm);
      proc.emit('close', 0);
    });
    return proc;
  };
}

/** A pure sine tone, 16-bit mono PCM at the box's 16kHz decode rate - used to verify the in-process band filters actually separate frequencies. */
function sineTonePCM(frequencyHz, { sampleRate = 16000, durationSeconds = 0.5, amplitude = 20000 } = {}) {
  const totalFrames = Math.round(sampleRate * durationSeconds);
  const pcm = Buffer.alloc(totalFrames * 2);
  for (let i = 0; i < totalFrames; i++) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate));
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

test('computes the requested number of buckets, each a broadband envelope plus a low/mid/high colour blend', async () => {
  const peaks = await computeWaveformPeaks(join(FIXTURES, 'sample.mp3'), { buckets: 10 });

  assert.equal(peaks.length, 10);
  for (const bucket of peaks) {
    const { min, max } = bucket.envelope;
    assert.ok(Number.isInteger(min) && Number.isInteger(max), 'envelope peaks should be integers');
    assert.ok(min <= max, `envelope bucket min (${min}) should never exceed its max (${max})`);
    assert.ok(min >= -128 && min <= 127, `envelope min ${min} out of int8 range`);
    assert.ok(max >= -128 && max <= 127, `envelope max ${max} out of int8 range`);

    for (const band of ['low', 'mid', 'high']) {
      const weight = bucket.color[band];
      assert.ok(Number.isInteger(weight), `colour weight ${band} should be an integer`);
      assert.ok(weight >= 0 && weight <= 255, `colour weight ${band} (${weight}) out of byte range`);
    }
  }
});

test('defaults to a duration-scaled bucket count when none is specified', async () => {
  // sample.wav is exactly 1 second; at the 40ms/bucket target that's
  // exactly 25 buckets.
  const peaks = await computeWaveformPeaks(join(FIXTURES, 'sample.wav'));
  assert.equal(peaks.length, 25);
});

test('duration-scaled default resolves against the decoded track length, not a fixed count', async () => {
  // 2 seconds of silence at the 16kHz decode rate = 32000 frames =
  // 64000 bytes; at the 40ms/bucket target that's exactly 50 buckets,
  // chosen to land on a whole number so this test doesn't also have to
  // reason about rounding.
  const peaks = await computeWaveformPeaks('/fake/two-seconds.wav', {
    spawnFn: fakeSpawnReturning(Buffer.alloc(64000)),
  });
  assert.equal(peaks.length, 50);
});

test('works across every supported format, not just mp3', async () => {
  for (const file of ['sample.flac', 'sample.aiff', 'sample.ogg', 'sample.m4a']) {
    const peaks = await computeWaveformPeaks(join(FIXTURES, file), { buckets: 5 });
    assert.equal(peaks.length, 5, `${file} should still produce 5 buckets`);
  }
});

test('rejects when ffmpeg fails to decode the file (eg. a non-audio path)', async () => {
  await assert.rejects(
    computeWaveformPeaks(join(FIXTURES, 'readme.txt'), { buckets: 5 }),
    /ffmpeg exited/,
  );
});

test('priority: background wraps the ffmpeg call with nice/ionice/taskset instead of running it directly', async () => {
  let capturedCommand;
  let capturedArgs;
  const spawnFn = (cmd, args) => {
    capturedCommand = cmd;
    capturedArgs = args;
    return fakeSpawnReturning(Buffer.alloc(0))(cmd, args);
  };

  await computeWaveformPeaks('/fake/track.mp3', { buckets: 1, spawnFn, priority: 'background' });

  assert.equal(capturedCommand, 'nice');
  assert.deepEqual(
    capturedArgs.slice(0, 7),
    ['-n', '19', 'ionice', '-c', '3', 'taskset', '-c'],
  );
  assert.equal(capturedArgs[7], '3');
  assert.equal(capturedArgs[8], 'ffmpeg');
  assert.ok(capturedArgs.includes('/fake/track.mp3'), 'the real ffmpeg args should still be present, just appended');
});

test('priority: ondemand wraps the ffmpeg call with a lighter nice/ionice, no taskset', async () => {
  let capturedCommand;
  let capturedArgs;
  const spawnFn = (cmd, args) => {
    capturedCommand = cmd;
    capturedArgs = args;
    return fakeSpawnReturning(Buffer.alloc(0))(cmd, args);
  };

  await computeWaveformPeaks('/fake/track.mp3', { buckets: 1, spawnFn, priority: 'ondemand' });

  assert.equal(capturedCommand, 'nice');
  assert.deepEqual(capturedArgs.slice(0, 6), ['-n', '15', 'ionice', '-c', '2', '-n']);
  assert.equal(capturedArgs[6], '0');
  assert.equal(capturedArgs[7], 'ffmpeg');
  assert.ok(capturedArgs.includes('/fake/track.mp3'), 'the real ffmpeg args should still be present, just appended');
  assert.ok(!capturedArgs.includes('taskset'), 'ondemand should not be pinned to a single core');
});

test('without lowPriority, ffmpeg is invoked directly with no wrapper', async () => {
  let capturedCommand;
  const spawnFn = (cmd, args) => {
    capturedCommand = cmd;
    return fakeSpawnReturning(Buffer.alloc(0))(cmd, args);
  };

  await computeWaveformPeaks('/fake/track.mp3', { buckets: 1, spawnFn });
  assert.equal(capturedCommand, 'ffmpeg');
});

test('threads an abort signal through to spawnFn, so a caller can kill the ffmpeg process outright', async () => {
  const controller = new AbortController();
  let capturedOptions;
  const spawnFn = (cmd, args, options) => {
    capturedOptions = options;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdio = [null, proc.stdout, proc.stderr, new EventEmitter()];
    // Mirrors a real aborted spawn: Node emits 'error' with an AbortError rather than closing.
    options.signal.addEventListener('abort', () => {
      proc.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    }, { once: true });
    return proc;
  };

  // Deliberately not awaited - the abort has to happen while the decode is still in flight. Once it
  // has finished there is nothing left to kill, and the signal is released.
  const pending = computeWaveformPeaks('/fake/abort-track.mp3', { buckets: 1, spawnFn, signal: controller.signal });
  pending.catch(() => {});

  // Not the caller's own signal object: the decode is shared with the beat grid and refcounted, so
  // ffmpeg gets the shared controller's signal (see shared-decode.js). What must still hold is that
  // the caller aborting aborts the spawn - the last consumer out kills the process.
  assert.ok(capturedOptions.signal, 'an abort signal is threaded to spawnFn');
  assert.equal(capturedOptions.signal.aborted, false);
  controller.abort();
  assert.equal(capturedOptions.signal.aborted, true, 'the caller aborting aborts the shared decode');

  await assert.rejects(pending);
});

test('rejects when the given signal aborts mid-decode', async () => {
  const controller = new AbortController();
  const spawnFn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // Never emits 'close' on its own - only the abort should settle this promise, same as a real
    // killed ffmpeg process where Node's spawn() emits 'error' with an AbortError.
    queueMicrotask(() => proc.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    return proc;
  };

  const promise = computeWaveformPeaks('/fake/track.mp3', { buckets: 1, spawnFn, signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, /aborted/i);
});

test('decodes the source file only once, not once per band', async () => {
  // The whole point of the in-process filtering rewrite (2026-07-27,
  // after a real 7-minute track's three-way ffmpeg decode measured
  // ~4s on real hardware) - a regression back to one spawn per band
  // would silently reintroduce that cost without any test catching it.
  let spawnCount = 0;
  const spawnFn = (...args) => {
    spawnCount += 1;
    return fakeSpawnReturning(Buffer.alloc(0))(...args);
  };
  await computeWaveformPeaks('/fake/track.mp3', { buckets: 1, spawnFn });
  assert.equal(spawnCount, 1);
});

test('low-frequency content colours mainly low, not high', async () => {
  const pcm = sineTonePCM(60); // well below the 250Hz crossover
  const peaks = await computeWaveformPeaks('/fake/low-tone.wav', { buckets: 1, spawnFn: fakeSpawnReturning(pcm) });
  const { color } = peaks[0];
  assert.ok(color.low > color.high, `expected low colour weight (${color.low}) to dominate high (${color.high}) for a 60Hz tone`);
});

test('high-frequency content colours mainly high, not low', async () => {
  // 6000Hz - comfortably above the 4000Hz crossover AND comfortably
  // under the 16kHz decode rate's own 8000Hz Nyquist limit (confirmed a
  // real, foundational bug 2026-08-02: at the OLD 8kHz decode rate,
  // Nyquist was exactly 4000Hz, so there was no valid frequency to even
  // write this test with, let alone for real hi-hat/cymbal content to
  // survive decoding at all). Unlike the OLD two-band design, colour
  // weight is a per-bucket PROPORTION (see normalizeToInt8's own doc
  // comment) rather than something whose scale depends on what else is
  // in the rest of the track, so a single pure-tone bucket is a valid
  // fixture here - no coupling to worry about any more.
  const pcm = sineTonePCM(6000);
  const peaks = await computeWaveformPeaks('/fake/high-tone.wav', { buckets: 1, spawnFn: fakeSpawnReturning(pcm) });
  const { color } = peaks[0];
  assert.ok(color.high > color.low, `expected high colour weight (${color.high}) to dominate low (${color.low}) for a 6000Hz tone`);
});

test('a hi-hat sitting on top of a kick renders TALLER than either alone - the whole point of deriving shape from the broadband signal', async () => {
  // This is the actual regression test for the architectural fix
  // (2026-08-02): under the OLD design (filter into bands FIRST, then
  // peak each independently), a hat on top of a kick could never
  // combine into a taller spike, because the low and high bands were
  // separated before either was measured. Deriving the envelope from
  // the RAW, unfiltered signal instead means |kick_sample + hat_sample|
  // is what actually gets measured, same as a real waveform.
  //
  // All three variants are placed as three buckets of ONE decode/
  // normalize pass (not three separate calls) deliberately - the
  // int8 scale is set by the track's own single loudest moment (see
  // normalizeToInt8), so comparing across separately-normalized calls
  // would be meaningless (a lone bucket always scales itself to fill
  // the range). Within one pass, the combined bucket should legitimately
  // define (or tie for) the scale, and the other two should render
  // shorter than it.
  const kickOnly = sineTonePCM(60, { amplitude: 12000, durationSeconds: 0.2 });
  const hatOnly = sineTonePCM(6000, { amplitude: 12000, durationSeconds: 0.2 });
  const kickPlusHat = Buffer.alloc(kickOnly.length);
  for (let i = 0; i < kickOnly.length / 2; i++) {
    const combined = kickOnly.readInt16LE(i * 2) + hatOnly.readInt16LE(i * 2);
    kickPlusHat.writeInt16LE(Math.max(-32768, Math.min(32767, combined)), i * 2);
  }
  const pcm = Buffer.concat([kickOnly, hatOnly, kickPlusHat]);

  const peaks = await computeWaveformPeaks('/fake/kick-hat-combined.wav', { buckets: 3, spawnFn: fakeSpawnReturning(pcm) });
  const kickHeight = peaks[0].envelope.max;
  const hatHeight = peaks[1].envelope.max;
  const combinedHeight = peaks[2].envelope.max;
  assert.ok(
    combinedHeight > kickHeight && combinedHeight > hatHeight,
    `expected combined envelope (${combinedHeight}) to exceed both kick-only (${kickHeight}) and hat-only (${hatHeight})`,
  );
});

test('a silent track normalizes to zero throughout, not divide-by-zero noise', async () => {
  const peaks = await computeWaveformPeaks('/fake/silent.mp3', {
    buckets: 1,
    spawnFn: fakeSpawnReturning(Buffer.alloc(8)), // all-zero PCM
  });
  assert.equal(peaks[0].envelope.min, 0);
  assert.equal(peaks[0].envelope.max, 0);
  for (const band of ['low', 'mid', 'high']) {
    assert.equal(peaks[0].color[band], 0);
  }
});

test('rejects when the spawned process itself fails to start', async () => {
  const fakeSpawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => proc.emit('error', new Error('spawn ffmpeg ENOENT')));
    return proc;
  };

  await assert.rejects(
    computeWaveformPeaks('/does/not/matter.mp3', { spawnFn: fakeSpawn }),
    /ENOENT/,
  );
});

test('normalizeToInt8 scales the broadband envelope to fill the range off its own peak alone', () => {
  const overall = [{ min: -8000, max: 8000 }];
  // Deliberately huge low/mid/high magnitudes relative to overall - if
  // these leaked into the envelope scale at all, this would clip/
  // distort it. They must not: colour and shape are fully decoupled
  // (2026-08-02 redesign - see normalizeToInt8's own doc comment).
  const low = [50000];
  const mid = [50000];
  const high = [50000];

  const result = normalizeToInt8({ overall, low, mid, high });

  assert.equal(result.overall[0].max, 127);
  assert.equal(result.overall[0].min, -127);
});

test('normalizeToInt8 blends low/mid/high into weighted colour fractions summing to ~255, independent of the envelope', () => {
  // Equal raw magnitudes across all three bands - any imbalance in the
  // resulting fractions comes purely from the *_COLOR_WEIGHT constants,
  // not from the input data, since all three inputs are identical here.
  const overall = [{ min: -1, max: 1 }]; // irrelevant to this test - see the decoupling test above
  const low = [1000];
  const mid = [1000];
  const high = [1000];

  const result = normalizeToInt8({ overall, low, mid, high });
  const { low: colorLow, mid: colorMid, high: colorHigh } = result.colorWeights[0];

  // Ordering follows the *_COLOR_WEIGHT constants directly, not a
  // fixed low>mid>high or high>mid>low assumption - MID_COLOR_WEIGHT
  // is deliberately the smallest of the three (measured against real
  // tracks: mid's raw magnitude alone nearly matched low's, so a
  // moderate weight there would have let it dominate almost
  // everywhere - see normalizeToInt8's own doc comment), so with equal
  // raw inputs the real expected order is high > low > mid.
  assert.ok(colorHigh > colorLow && colorLow > colorMid, `expected high (${colorHigh}) > low (${colorLow}) > mid (${colorMid}) given equal raw magnitudes and HIGH_COLOR_WEIGHT > LOW_COLOR_WEIGHT > MID_COLOR_WEIGHT`);
  const total = colorLow + colorMid + colorHigh;
  assert.ok(total >= 250 && total <= 255, `expected fractions to sum close to 255, got ${total}`);
});

test('normalizeToInt8 gives an all-low bucket a pure low colour, not diluted by absent bands', () => {
  const overall = [{ min: -1, max: 1 }];
  const result = normalizeToInt8({ overall, low: [1000], mid: [0], high: [0] });
  assert.deepEqual(result.colorWeights[0], { low: 255, mid: 0, high: 0 });
});

test('normalizeToInt8 on an all-silent signal returns zero throughout, not divide-by-zero noise', () => {
  const overall = [{ min: 0, max: 0 }];
  const result = normalizeToInt8({ overall, low: [0], mid: [0], high: [0] });
  assert.equal(result.overall[0].min, 0);
  assert.equal(result.overall[0].max, 0);
  assert.deepEqual(result.colorWeights[0], { low: 0, mid: 0, high: 0 });
});

test('decimateForAnalysis is a no-op (same array, same rate) when already under the cap', () => {
  const samples = new Int16Array([1, 2, 3, 4, 5]);
  const result = decimateForAnalysis(samples, 10);
  assert.equal(result.samples, samples, 'should return the exact same array, not a copy, when no decimation is needed');
  assert.equal(result.sampleRate, 16000);
});

test('decimateForAnalysis reduces to at most maxSamples and scales the sample rate down by the same factor', () => {
  const samples = new Int16Array(1000);
  for (let i = 0; i < samples.length; i++) samples[i] = i;
  const result = decimateForAnalysis(samples, 100);

  assert.ok(result.samples.length <= 100, `expected at most 100 samples, got ${result.samples.length}`);
  assert.ok(result.samples.length >= 90, `expected close to 100 samples, got ${result.samples.length}`);
  // factor = ceil(1000/100) = 10, so the effective rate should drop by the same factor.
  assert.equal(result.sampleRate, 1600);
  // Stride decimation - every 10th original sample, in order.
  assert.equal(result.samples[0], 0);
  assert.equal(result.samples[1], 10);
  assert.equal(result.samples[2], 20);
});

test('computeWaveformPeaks clamps an absurd explicit bucket count to MAX_BUCKETS - the wire format is a uint16', async () => {
  const peaks = await computeWaveformPeaks(join(FIXTURES, 'sample.wav'), { buckets: 100000 });
  assert.ok(peaks.length <= 65000, `expected at most 65000 buckets, got ${peaks.length}`);
});

test('computeWaveformPeaks stays bounded and doesn\'t throw for an unusually long track - the real OOM/uint16 crash this fixes', async () => {
  // ~21 minutes of silence at DECODE_SAMPLE_RATE (16kHz) - well past MAX_ANALYSIS_SAMPLES (20 min),
  // deliberately exercising both the decimation path and the bucket-count clamp together. Cheap to
  // allocate (silence, not real audio) but a real, meaningful size - see MAX_ANALYSIS_SAMPLES's own
  // doc comment for the real 47-minute track that crashed the box without this fix.
  const durationSeconds = 21 * 60;
  const pcmBytes = durationSeconds * 16000 * 2;
  const spawnFn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      proc.stdout.emit('data', Buffer.alloc(pcmBytes));
      proc.emit('close', 0);
    });
    return proc;
  };

  const peaks = await computeWaveformPeaks('/fake/long-track.wav', { spawnFn });
  assert.ok(peaks.length > 0 && peaks.length <= 65000, `expected a sane, bounded bucket count, got ${peaks.length}`);
});

test('segments claim buckets in proportion to the audio they cover', async () => {
  // The regression guard for the bug that made a 281s track draw a breakdown truly at 156s as
  // though it were at 192s (owner measured it against Traktor, 2026-09-01).
  //
  // `start` is advanced past a slice before the bucket boundary is computed, so it already IS that
  // slice's end. Adding the slice length to it again claimed buckets a whole segment beyond the
  // audio decoded - stretching everything from the second slice onward progressively later, and
  // leaving the final 12.5% of every track crammed into the one bucket the Math.max(1, ...) floor
  // allowed. The TOTAL still came to totalBuckets because of the Math.min clamp, which is why the
  // bucket count looked correct and nothing caught it.
  //
  // Asserted on the cumulative boundaries rather than per-segment counts: it is the boundary
  // between audio time and bucket index that has to hold, and that is what the canvas draws against.
  const partials = [];
  await computeWaveformInSegments(join(FIXTURES, 'sample.mp3'), {
    onPartial: ({ startBucket, peaks }) => partials.push({ startBucket, count: peaks.length }),
  });

  assert.equal(partials.length, SEGMENT_FRACTIONS.length, 'one partial per segment');

  const total = partials.at(-1).startBucket + partials.at(-1).count;
  let audioSoFar = 0;

  for (const [i, fraction] of SEGMENT_FRACTIONS.entries()) {
    audioSoFar += fraction;
    const bucketsThroughEnd = partials[i].startBucket + partials[i].count;
    // In BUCKETS, not percent: the fixture is ~1s, so one bucket is ~4% of it and a percentage
    // tolerance tight enough to be meaningful would fail on rounding alone. A boundary may sit at
    // most one bucket either side of its exact position; the bug moved boundaries by whole
    // segments, so this still catches it comfortably.
    assert.ok(
      Math.abs(bucketsThroughEnd - audioSoFar * total) <= 1.5,
      `segment ${i}: covers ${(audioSoFar * 100).toFixed(1)}% of the audio, so its boundary should be `
        + `~bucket ${(audioSoFar * total).toFixed(1)} of ${total}, but it is ${bucketsThroughEnd}`,
    );
  }

  // The last slice is the one the old bug starved: it must get its real share, not the floor of 1.
  // The clearest single signal: the bug starved this one to the Math.max(1, ...) floor on every
  // track, whatever its length, while its real share is an eighth.
  const lastShare = partials.at(-1).count / total;
  assert.ok(
    lastShare > 0.08,
    `final segment covers 12.5% of the audio but got ${partials.at(-1).count} of ${total} buckets `
      + `(${(lastShare * 100).toFixed(1)}%) - the old bug starved it to 1`,
  );
});
