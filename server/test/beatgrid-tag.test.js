import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctMetricLevel } from '../src/beatgrid-tag.js';

test('a metric-level error is corrected by SCALING our own measurement, not by taking the tag', () => {
  // Vin 2 Win analysed at 84.666 against a tag of 127 - two thirds, so the grid met the beat only
  // every third one. The answer is our number at the right level (126.999), never the tag itself:
  // that is what keeps integer-rounding out of the result entirely.
  const r = correctMetricLevel(84.666, 127);
  assert.equal(r.corrected, true);
  assert.ok(Math.abs(r.bpm - 126.999) < 0.01, `expected ~126.999, got ${r.bpm}`);
  assert.notEqual(r.bpm, 127, 'must not adopt the tag value itself');
});

test('a 4/3 confusion is corrected the same way', () => {
  const r = correctMetricLevel(109.338, 82); // 01 Pathos
  assert.equal(r.corrected, true);
  assert.ok(Math.abs(r.bpm - 82.0) < 0.5, `expected ~82, got ${r.bpm}`);
});

test('a tempo already at the tagged level is left completely alone', () => {
  // The case that matters most: this must never fine-tune. Askell measured 116.1045 against a tag of
  // 116, and Epilion 131.87 against a tag of 132 whose true tempo is 131.868 - snapping either to
  // its tag is exactly the mistake this module refuses to make.
  assert.equal(correctMetricLevel(116.1045, 116).corrected, false);
  assert.equal(correctMetricLevel(116.1045, 116).bpm, 116.1045);
  assert.equal(correctMetricLevel(131.8664, 132).corrected, false);
  assert.equal(correctMetricLevel(131.8664, 132).bpm, 131.8664);
});

test('a doubled or halved tempo is left alone - it still lands on every kick', () => {
  assert.equal(correctMetricLevel(195.6361, 98).corrected, false);
  assert.equal(correctMetricLevel(60, 120).corrected, false);
});

test('a tag unrelated to the measurement is ignored', () => {
  // Plum Valley tags itself 61 while measuring 164; Joe Likes to Dance 63 against 167.
  assert.equal(correctMetricLevel(163.9974, 61).corrected, false);
  assert.equal(correctMetricLevel(166.6667, 63).corrected, false);
});

test('a missing or broken tag leaves the measurement untouched', () => {
  for (const tag of [null, undefined, 0, -5, NaN, 'abc']) {
    assert.equal(correctMetricLevel(128.04, tag).bpm, 128.04, `tag ${String(tag)}`);
  }
});
