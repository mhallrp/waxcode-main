import { test, assert } from 'vitest';
import { viewportAgreesWithOrientation } from './appHeight';

/*
 * The whole fix rests on this check. iOS reports a PORTRAIT-shaped viewport for a moment when a
 * home-screen app is launched already in landscape, and the app lays out against it and never
 * re-resolves. Timing the re-read did not work - on a cold launch the wrong value outlives any
 * delay worth waiting, which is why the bug only showed on the first open (2026-10-18).
 */
test('a landscape device reporting a portrait viewport is not believed', () => {
  assert.equal(viewportAgreesWithOrientation({ width: 390, height: 844 }, true), false);
});

test('a landscape device reporting a landscape viewport is believed', () => {
  assert.equal(viewportAgreesWithOrientation({ width: 844, height: 390 }, true), true);
});

test('portrait is the same test the other way round', () => {
  assert.equal(viewportAgreesWithOrientation({ width: 844, height: 390 }, false), false);
  assert.equal(viewportAgreesWithOrientation({ width: 390, height: 844 }, false), true);
});

/* Square contradicts nothing, so it must not stall the poll forever. */
test('a square viewport is accepted either way', () => {
  assert.equal(viewportAgreesWithOrientation({ width: 500, height: 500 }, true), true);
  assert.equal(viewportAgreesWithOrientation({ width: 500, height: 500 }, false), true);
});

/* A zero reading is not a measurement. */
test('zero or negative is never believed', () => {
  assert.equal(viewportAgreesWithOrientation({ width: 0, height: 844 }, false), false);
  assert.equal(viewportAgreesWithOrientation({ width: 390, height: 0 }, false), false);
});
