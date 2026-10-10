import { test, assert } from 'vitest';
import {
  decodePeaks, downsample, blended, runInStart, barPhaseSeconds, nearestBeat, waveformPlayhead,
} from './waveform';

/** The wire format: a uint16 count, then min, max, low, mid, high per bucket. */
function encode(peaks: Array<[number, number, number, number, number]>): ArrayBuffer {
  const bytes = new Uint8Array(2 + peaks.length * 5);
  new DataView(bytes.buffer).setUint16(0, peaks.length, true);
  peaks.forEach(([min, max, low, mid, high], i) => {
    const view = new DataView(bytes.buffer);
    view.setInt8(2 + i * 5, min);
    view.setInt8(2 + i * 5 + 1, max);
    bytes[2 + i * 5 + 2] = low;
    bytes[2 + i * 5 + 3] = mid;
    bytes[2 + i * 5 + 4] = high;
  });
  return bytes.buffer;
}

/* min and max are SIGNED. Reading them as unsigned turns every trough into a peak, which still draws
 * a plausible-looking waveform - the failure is silent, which is why it is pinned here. */
test('decodePeaks reads min and max as signed bytes', () => {
  const peaks = decodePeaks(encode([[-120, 100, 200, 30, 25]]));
  assert.equal(peaks.length, 1);
  assert.deepEqual(peaks[0], { min: -120, max: 100, low: 200, mid: 30, high: 25 });
});

test('decodePeaks reads the count from the first two bytes, little-endian', () => {
  assert.equal(decodePeaks(encode(Array(300).fill([-1, 1, 0, 0, 0]))).length, 300);
});

/*
 * The overview AVERAGES each group rather than taking its envelope. A strict min/max makes one
 * transient render an entire window at full height even in a quiet section - which is exactly how a
 * blown-out solid block happens.
 */
test('downsample averages a group rather than taking its loudest member', () => {
  const peaks = [
    { min: -10, max: 10, low: 0, mid: 0, high: 0 },
    { min: -100, max: 100, low: 0, mid: 0, high: 0 },
  ];
  const [only] = downsample(peaks, 1);
  assert.equal(only!.max, 55, 'the average, not the peak');
  assert.equal(only!.min, -55);
});

/* Swift does integer division here, so the two surfaces must truncate toward zero identically or
 * the same track draws a pixel differently in each. */
test('downsample truncates toward zero, matching Swift integer division', () => {
  const peaks = [
    { min: -1, max: 1, low: 0, mid: 0, high: 0 },
    { min: -2, max: 2, low: 0, mid: 0, high: 0 },
  ];
  const [only] = downsample(peaks, 1);
  assert.equal(only!.max, 1, '3/2 truncates to 1');
  assert.equal(only!.min, -1, '-3/2 truncates toward zero, not down to -2');
});

test('downsample leaves a track alone when it is already short enough', () => {
  const peaks = [{ min: -1, max: 1, low: 0, mid: 0, high: 0 }];
  assert.equal(downsample(peaks, 150), peaks);
});

test('blended mixes the three band weights into one colour', () => {
  // Pure low is the low band's colour: 0.85, 0.18, 0.18 of full scale.
  assert.equal(blended({ min: 0, max: 0, low: 255, mid: 0, high: 0 }), 'rgb(217,46,46)');
  assert.equal(blended({ min: 0, max: 0, low: 0, mid: 0, high: 0 }), 'rgb(0,0,0)');
});

/*
 * The run-in is one bar before the DOWNBEAT NEAREST ZERO, not one bar before zero. Bar lines are
 * phased to the grid while zero is wherever the file begins, so using zero parks the marker at an
 * arbitrary phase inside the run-in - visibly off the line it is drawn against.
 */
test('the run-in is a real bar line, not simply four beats before zero', () => {
  // 120bpm: half-second beats. First detected beat at 0.3s, so the nearest beat to zero is 0.3 - 0.5 = -0.2.
  const grid = { bpm: 120, firstBeatSeconds: 0.3 };
  assert.equal(barPhaseSeconds(grid), -0.2);
  assert.equal(runInStart(grid), -0.2 - 2, 'four beats, which at 120bpm is two seconds');
});

test('no grid means no run-in, so the playhead parks at zero', () => {
  assert.equal(runInStart(null), 0);
  assert.equal(runInStart({ bpm: 0 }), 0);
});

/* The playhead may sit in the run-in, but a cue point or loop dropped there would play silence. */
test('a snapped beat is never before the track', () => {
  const grid = { bpm: 120, firstBeatSeconds: -0.2 };
  assert.equal(nearestBeat(-3.1, grid), 0, 'snapped forward to the start, not to a silent position');
  assert.equal(nearestBeat(-3.1, null), 0, 'and with no grid at all');
  assert.equal(nearestBeat(10.3, grid), 10.3, 'an ordinary position is untouched');
});

/*
 * The focused waveform is centred on this, and the playhead feeding it is PREDICTED forward from
 * the last status by the deck's own pitch. Nothing stopped that prediction at the end of the track,
 * so a finished track scrolled on into empty space for ever.
 */
test('the waveform playhead stops at the end of the track', () => {
  const grid = null;
  assert.equal(waveformPlayhead(100, grid, 240), 100, 'mid-track, left alone');
  assert.equal(waveformPlayhead(240, grid, 240), 240, 'exactly the end');
  assert.equal(waveformPlayhead(999, grid, 240), 240, 'and no further, however long it predicts');
});

/* The two bounds are NOT symmetric, on purpose. Before zero there is real audio to aim at while
 * back-cueing; past the end there is nothing. */
test('it still allows the run-in, which is real', () => {
  const grid = { bpm: 120, firstBeatSeconds: 4 };
  const before = waveformPlayhead(-10, grid, 240);
  assert.ok(before < 0, `the run-in is kept, not floored at zero: ${before}`);
  assert.equal(waveformPlayhead(-10, null, 240), 0, 'without a grid there is no run-in to keep');
});

test('an unknown length caps nothing, because there is nothing to cap at', () => {
  assert.equal(waveformPlayhead(999, null, null), 999);
});
