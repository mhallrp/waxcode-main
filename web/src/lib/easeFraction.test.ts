import { test, assert } from 'vitest';
import { createFractionEase } from './easeFraction';

/* The waveform arrives in segments, so the revealed edge used to jump. This is what turns that into
 * one movement - and the properties below are what make it read as motion rather than as steps. */

test('the first value is taken as-is, so a cached waveform does not animate in', () => {
  const ease = createFractionEase();
  assert.equal(ease(1, 0), 1, 'already complete, and it should look it');

  const partial = createFractionEase();
  assert.equal(partial(0.2, 0), 0.2);
});

test('it closes the gap, decelerating as it arrives', () => {
  const ease = createFractionEase();
  ease(0, 0);

  const first = ease(1, 100);
  const second = ease(1, 200);
  const third = ease(1, 300);

  assert.ok(first > 0 && first < 1, `moved but did not jump: ${first}`);
  assert.ok(second > first && third > second, 'still closing');
  // The shape: each equal step covers LESS ground than the one before it.
  assert.ok(second - first < first, 'decelerating');
  assert.ok(third - second < second - first, 'still decelerating');
});

/*
 * The one that is easy to get wrong and invisible when you do. A per-frame multiplier runs at double
 * speed on a 120Hz screen; this samples the same curve whatever the frame rate.
 */
test('the same elapsed time gives the same result at any frame rate', () => {
  const slow = createFractionEase();
  slow(0, 0);
  slow(1, 100);

  const fast = createFractionEase();
  fast(0, 0);
  for (let t = 10; t <= 100; t += 10) fast(1, t);

  assert.ok(Math.abs(slow(1, 100) - fast(1, 100)) < 0.01, 'one 100ms step matches ten 10ms steps');
});

test('a smaller gap moves more slowly than a large one', () => {
  const big = createFractionEase();
  big(0, 0);
  const bigStep = big(1, 100) - 0;

  const small = createFractionEase();
  small(0.9, 0);
  const smallStep = small(1, 100) - 0.9;

  assert.ok(smallStep < bigStep, 'the motion takes its speed from the distance left');
});

test('going backwards snaps, because that is a different track', () => {
  const ease = createFractionEase();
  ease(0, 0);
  ease(1, 500);
  // A new track resets decoded to 0; easing that would draw the old waveform retreating.
  assert.equal(ease(0, 600), 0);
});

test('it finishes exactly, rather than approaching 1 forever', () => {
  const ease = createFractionEase();
  ease(0, 0);
  let value = 0;
  for (let t = 100; t <= 4000; t += 100) value = ease(1, t);
  assert.equal(value, 1);
});
