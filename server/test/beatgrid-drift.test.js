import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureDrift, refineTempoViaDrift } from '../src/beatgrid-autocorrelation.js';

/** An envelope with an impulse every `period` samples, starting at `phase`, optionally drifting. */
function pulses({ period, phase = 0, length = 8000, drift = 0 }) {
  const env = new Float64Array(length);
  let t = phase;
  let p = period;
  while (t < length - 1) {
    env[Math.round(t)] = 1000;
    p *= 1 + drift;
    t += p;
  }
  return env;
}

test('a perfectly steady pulse train measures no drift', () => {
  const env = pulses({ period: 50 });
  const d = measureDrift(env, 50, [...env.keys()].filter((i) => env[i] > 0));
  assert.ok(d !== null, 'should be measurable');
  assert.ok(Math.abs(d) < 1e-3, `expected ~0, got ${d}`);
});

test('a period guessed too short shows positive drift, and refinement recovers the true one', () => {
  // The real failure this exists for: a tempo 0.1% out walks a quarter beat across a long track.
  const truePeriod = 50;
  const env = pulses({ period: truePeriod, length: 40000 });
  const guess = truePeriod * 0.999;
  const refined = refineTempoViaDrift(env, guess);
  assert.ok(Math.abs(refined - truePeriod) < Math.abs(guess - truePeriod) / 5,
    `refinement should close most of the gap: guess ${guess}, refined ${refined}, true ${truePeriod}`);
});

test('refinement is symmetric - a period guessed too long is pulled back down', () => {
  const truePeriod = 50;
  const env = pulses({ period: truePeriod, length: 40000 });
  const guess = truePeriod * 1.001;
  const refined = refineTempoViaDrift(env, guess);
  assert.ok(Math.abs(refined - truePeriod) < Math.abs(guess - truePeriod) / 5,
    `guess ${guess}, refined ${refined}, true ${truePeriod}`);
});

test('a wild seed is refused rather than chased', () => {
  // Beyond DRIFT_MAX_CORRECTION this is a different tempo, not a refinement, and silently walking to
  // it would turn a metric error into a plausible-looking wrong answer.
  const env = pulses({ period: 50, length: 40000 });
  assert.equal(refineTempoViaDrift(env, 75), 75, 'a 50% error must be left alone for another stage');
});

test('too few onsets to judge returns the seed untouched', () => {
  const env = pulses({ period: 50, length: 400 });
  assert.equal(refineTempoViaDrift(env, 50), 50);
});

test('silence returns the seed untouched', () => {
  assert.equal(refineTempoViaDrift(new Float64Array(8000), 50), 50);
});

import { findNearbyRealOnsetSamples } from '../src/beatgrid-autocorrelation.js';

test('the onset anchor is only ever used a whole beat at a time', () => {
  // Guards the fix that mattered most for phase accuracy: findNearbyRealOnsetSamples usefully walks
  // forward out of a silent intro, but its sub-beat nudge moves the whole GRID and was the single
  // largest source of phase error - 87.1ms mean against 8.8ms without it. analyzeSamples quantises
  // the anchor back onto the grid; this asserts the raw helper really can return an off-grid value,
  // so that quantisation is load-bearing rather than decorative.
  const period = 50;
  const env = new Float64Array(6000);
  // Silence for the first 20 beats, then beats deliberately offset from the grid by a third of a beat.
  for (let k = 20; k < 110; k++) {
    const at = Math.round(k * period + period / 3);
    if (at < env.length) env[at] = 1000;
  }
  const anchor = findNearbyRealOnsetSamples(env, 0, period, period * 0.35, 100);
  assert.ok(anchor !== null, 'should find the run of beats');
  const offGrid = Math.abs(anchor - Math.round(anchor / period) * period);
  assert.ok(offGrid > period * 0.1,
    `helper should return an off-grid anchor (got ${anchor}, off-grid by ${offGrid}) - if this ever ` +
    'stops being true the quantisation in analyzeSamples is no longer needed');
});
