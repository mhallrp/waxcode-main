import { test, assert } from 'vitest';
import {
  MAX_OVERSHOOT_SECONDS, momentumProgress, momentumTravelPx, rubberBanded, springBackProgress,
} from './scrubPhysics';

const DURATION = 300;

test('inside the track the position is untouched', () => {
  assert.equal(rubberBanded(0, DURATION), 0);
  assert.equal(rubberBanded(150, DURATION), 150);
  assert.equal(rubberBanded(DURATION, DURATION), DURATION);
});

/* It must never stop dead at the boundary - that feels like the finger slipping - but it must not
 * run away either. The give asymptotes at 1.5 SECONDS of track, however hard it is pulled. */
test('dragging before the start gives, but never past the asymptote', () => {
  assert.ok(rubberBanded(-1, DURATION) > -1, 'resisted, so it moves less than the finger');
  assert.ok(rubberBanded(-1, DURATION) < 0, 'but it does move');
  // >=, not >: past about 40s of pull the exponential underflows to zero and the asymptote is
  // reached exactly. What matters is that it is never EXCEEDED, however hard the drag.
  assert.ok(rubberBanded(-1000, DURATION) >= -MAX_OVERSHOOT_SECONDS, 'never past 1.5s');
  assert.ok(rubberBanded(-10, DURATION) < -1.49, 'and a hard pull gets close to it');
});

test('dragging past the end gives the same way', () => {
  assert.ok(rubberBanded(DURATION + 1, DURATION) < DURATION + 1);
  assert.ok(rubberBanded(DURATION + 1000, DURATION) <= DURATION + MAX_OVERSHOOT_SECONDS);
  assert.ok(rubberBanded(DURATION + 10, DURATION) > DURATION + 1.49);
});

test('resistance is symmetric at both ends', () => {
  const before = 0 - rubberBanded(-2, DURATION);
  const after = rubberBanded(DURATION + 2, DURATION) - DURATION;
  assert.ok(Math.abs(before - after) < 1e-9);
});

/* A flick keeps travelling. The decay curve's total remaining distance is v / -k, which is what
 * decides where the seek eventually lands. */
test('a faster flick travels further, proportionally', () => {
  assert.ok(momentumTravelPx(1000) > momentumTravelPx(500));
  assert.ok(Math.abs(momentumTravelPx(1000) / momentumTravelPx(500) - 2) < 1e-9);
  assert.equal(momentumTravelPx(0), 0);
});

test('a flick the other way travels the other way', () => {
  assert.ok(momentumTravelPx(-1000) < 0);
});

/* Asymptotic on purpose: the coast is stopped by CONVERGENCE, not by a timer, because any fixed
 * cutoff either lands early - a visible final jump - or needlessly late. */
/*
 * Asymptotic on purpose: the coast is stopped by CONVERGENCE, not by a timer, because any fixed
 * cutoff either lands early - a visible final jump - or needlessly late. (Far enough out the
 * exponential underflows and it does reach 1, which is why a convergence test and not a progress
 * test is what ends the animation.)
 */
test('the coast approaches its target asymptotically', () => {
  assert.equal(momentumProgress(0), 0);
  assert.ok(momentumProgress(1) > 0.8);
  assert.ok(momentumProgress(2) < 1, 'still short after two seconds');
  assert.ok(momentumProgress(2) > momentumProgress(1), 'and still closing');
});

/* The spring back is a different curve and DOES finish - it is clamping to a real boundary, not
 * coasting toward one. */
test('the spring back completes, unlike the coast', () => {
  assert.equal(springBackProgress(0), 0);
  assert.equal(springBackProgress(0.3), 1, 'done at 300ms');
  assert.equal(springBackProgress(5), 1, 'and stays done');
  assert.ok(springBackProgress(0.15) > 0.8, 'eased out, so most of it happens early');
});
