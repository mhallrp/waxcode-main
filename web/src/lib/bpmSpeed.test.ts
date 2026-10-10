import { test, assert } from 'vitest';
import { createBpmSpeedTracker } from './bpmSpeed';

/** Feeds a steady platter at `speed`, sampling every `stepMs` of the BOX's clock. */
function run(tracker: ReturnType<typeof createBpmSpeedTracker>, options: {
  speed: number; seconds: number; stepMs?: number; baseBPM?: number | null; wow?: number;
}) {
  const step = (options.stepMs ?? 50) / 1000;
  let elapsed = 0;
  for (let t = 0; t <= options.seconds; t += step) {
    /* Wow is a once-per-revolution modulation - the thing the window exists to cancel. 33 1/3 rpm
     * is 0.5556Hz, scaled by how fast the platter is actually going. */
    const wobble = options.wow
      ? options.wow * Math.sin(2 * Math.PI * 0.5556 * options.speed * t)
      : 0;
    elapsed += step * options.speed * (1 + wobble);
    tracker.observe({
      elapsed,
      boxTime: t,
      pitch: options.speed,
      timecodeValid: true,
      baseBPM: options.baseBPM ?? 124,
    });
  }
}

test('a steady platter settles on its real speed', () => {
  const tracker = createBpmSpeedTracker();
  run(tracker, { speed: 1.08, seconds: 6 });
  assert.ok(tracker.displaySpeed !== null);
  assert.ok(Math.abs(tracker.displaySpeed! - 1.08) < 0.002, `got ${tracker.displaySpeed}`);
});

/*
 * The whole reason this module exists. Wow is a once-per-revolution speed modulation of about 0.3%
 * on a PLX-500, and it is what made a decimal BPM unreadable. Averaging over a revolution cancels
 * it - so the readout must sit still even while the measurement underneath is wobbling.
 */
test('wow does not move the displayed number', () => {
  const tracker = createBpmSpeedTracker();
  run(tracker, { speed: 1.0, seconds: 4, wow: 0.003, baseBPM: 124 });
  const settled = tracker.displaySpeed;

  const seen = new Set<number>();
  for (let i = 0; i < 40; i += 1) {
    run(tracker, { speed: 1.0, seconds: 0.4, wow: 0.003, baseBPM: 124 });
    seen.add(Math.round((124 * (tracker.displaySpeed ?? 0)) * 100) / 100);
  }
  assert.equal(settled !== null, true);
  assert.ok(seen.size <= 2, `the readout moved across ${seen.size} values: ${[...seen].join(', ')}`);
});

/* A fader at zero must read the track's REAL tempo, whatever it is. The grid is anchored at nominal
 * rather than at zero precisely so an oddly-analysed tempo is not rounded to a value it does not
 * have - 123.47 would otherwise display as 123.45. */
test('a fader at nominal reads the track tempo exactly, even an odd one', () => {
  const tracker = createBpmSpeedTracker();
  run(tracker, { speed: 1.0, seconds: 6, baseBPM: 123.47 });
  assert.equal(123.47 * (tracker.displaySpeed ?? 0), 123.47);
});

/* Needle up means the platter says nothing about tempo. Fed the zeros either side of a lift, any
 * average crawls up from nothing and back down - wrong for longer than it is right. */
test('an invalid timecode holds the last reading rather than averaging toward zero', () => {
  const tracker = createBpmSpeedTracker();
  run(tracker, { speed: 1.05, seconds: 6 });
  const held = tracker.displaySpeed;

  for (let i = 0; i < 20; i += 1) {
    tracker.observe({ elapsed: 100, boxTime: 10 + i * 0.05, pitch: 0, timecodeValid: false, baseBPM: 124 });
  }
  assert.equal(tracker.displaySpeed, held, 'the readout did not drift while the needle was up');
});

test('a stationary platter is ignored, not read as a tempo', () => {
  const tracker = createBpmSpeedTracker();
  run(tracker, { speed: 1.0, seconds: 6 });
  const held = tracker.displaySpeed;
  tracker.observe({ elapsed: 50, boxTime: 99, pitch: 0.01, timecodeValid: true, baseBPM: 124 });
  assert.equal(tracker.displaySpeed, held);
});

/* A seek, cue or loop wrap is a jump, not speed. Fitting across one would read the jump as tempo. */
test('a position jump does not become a speed', () => {
  const tracker = createBpmSpeedTracker();
  run(tracker, { speed: 1.0, seconds: 6 });
  tracker.observe({ elapsed: 500, boxTime: 6.1, pitch: 1.0, timecodeValid: true, baseBPM: 124 });
  assert.ok(Math.abs((tracker.displaySpeed ?? 0) - 1.0) < 0.01, `got ${tracker.displaySpeed}`);
});

test('a new track starts from its own tempo', () => {
  const tracker = createBpmSpeedTracker();
  run(tracker, { speed: 1.08, seconds: 6 });
  tracker.reset();
  assert.equal(tracker.displaySpeed, null);
});

/* PLAY is a speed we already know: the audio is at full speed from the first buffer, so it is
 * pinned rather than averaged toward. */
test('a pinned speed is taken at once', () => {
  const tracker = createBpmSpeedTracker();
  run(tracker, { speed: 1.08, seconds: 6 });
  tracker.pin(1.0);
  assert.equal(tracker.displaySpeed, 1.0);
});

/*
 * The hysteresis, tested directly.
 *
 * The window cancels wow, but precision alone cannot stop a flicker: a value sitting near a grid
 * boundary re-rounds either way and the displayed number visibly flips. The hold is what stops it,
 * and it is separate from the averaging - the test above passes with the hysteresis disabled, so it
 * proves the window and nothing else.
 *
 * Driven through the no-clock path, where the measurement is the reported pitch smoothed - which is
 * enough to walk a value toward a boundary and see whether the display follows it.
 */
const STEP = 0.05 / 124; // the BPM grid, as a pitch fraction, at 124 BPM

function settleAtNominal() {
  const tracker = createBpmSpeedTracker();
  tracker.observe({ elapsed: null, boxTime: null, pitch: 1.0, timecodeValid: true, baseBPM: 124 });
  assert.equal(tracker.displaySpeed, 1.0, 'starts on the nominal grid point');
  return tracker;
}

test('a drift of one grid step never moves the readout', () => {
  const tracker = settleAtNominal();
  for (let i = 0; i < 200; i += 1) {
    tracker.observe({
      elapsed: null, boxTime: null, pitch: 1.0 + STEP, timecodeValid: true, baseBPM: 124,
    });
  }
  assert.equal(tracker.displaySpeed, 1.0, 'one step is inside the hold, however long it persists');
});

test('a real move past the hold is followed', () => {
  const tracker = settleAtNominal();
  for (let i = 0; i < 400; i += 1) {
    tracker.observe({
      elapsed: null, boxTime: null, pitch: 1.0 + 8 * STEP, timecodeValid: true, baseBPM: 124,
    });
  }
  /* It lands within the HOLD of the new value, not exactly on it - which is the contract: once the
   * display is inside the band it stops chasing. Being stricter than that would be asserting the
   * absence of the very thing this is for. */
  const moved = (tracker.displaySpeed ?? 0) - 1.0;
  assert.ok(moved >= 4 * STEP, `the readout followed: moved ${moved / STEP} steps`);
  assert.ok(
    Math.abs((tracker.displaySpeed ?? 0) - (1.0 + 8 * STEP)) <= 3 * STEP,
    `and settled inside the hold of the new value: ${tracker.displaySpeed}`,
  );
});
