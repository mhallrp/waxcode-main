import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kickOnsets, refineBpmAgainstOnsets } from '../src/beatgrid-refine.js';

const SR = 8000;

/** A kick every beat: a low sine burst with a sharp attack, at signed-16-bit scale. */
function kickTrack(bpm, seconds, { startAt = 0.5 } = {}) {
  const samples = new Int16Array(Math.round(SR * seconds));
  const period = (60 / bpm) * SR;
  for (let beat = 0; ; beat++) {
    const at = Math.round(startAt * SR + beat * period);
    if (at + 600 >= samples.length) break;
    for (let i = 0; i < 600; i++) {
      samples[at + i] = Math.round(22000 * Math.exp(-i / 90) * Math.sin((2 * Math.PI * 55 * i) / SR));
    }
  }
  return samples;
}

test('recovers the true tempo from a starting estimate that is slightly wrong', () => {
  const samples = kickTrack(128, 180);
  // 0.25% high - the size of error measured coming out of QM on a real track (Moff & Tarkin).
  const refined = refineBpmAgainstOnsets(samples, SR, 128 * 1.0025);
  assert.ok(Math.abs(refined - 128) < 0.02, `expected ~128, got ${refined}`);
});

test('a correct estimate is left essentially alone rather than nudged around', () => {
  const samples = kickTrack(124, 180);
  const refined = refineBpmAgainstOnsets(samples, SR, 124);
  assert.ok(Math.abs(refined - 124) < 0.01, `expected ~124, got ${refined}`);
});

test('never moves the tempo by more than a polish, whatever it is given', () => {
  // This is a refiner, not a tempo chooser. Handed a number 20% out - a different pulse, not a
  // mis-measured one - it must not wander off hunting for the right answer, because the estimate
  // it would land on is unconstrained. Leaving a wrong tempo wrong is the safe failure; replacing
  // it with a confidently different wrong one is not.
  const samples = kickTrack(128, 180);
  for (const wild of [128 * 1.2, 128 * 0.75, 128 * 2]) {
    const refined = refineBpmAgainstOnsets(samples, SR, wild);
    const moved = Math.abs(refined - wild) / wild;
    assert.ok(moved <= 0.02, `moved ${(moved * 100).toFixed(2)}% from ${wild.toFixed(2)}, past the cap`);
  }
});

test('returns the original when there is nothing to refine against', () => {
  assert.equal(refineBpmAgainstOnsets(new Int16Array(SR * 30), SR, 128), 128, 'silence');
  assert.equal(refineBpmAgainstOnsets(kickTrack(128, 5), SR, 128), 128, 'too few kicks');
});

test('rejects a nonsense tempo instead of dividing by it', () => {
  const samples = kickTrack(128, 60);
  assert.equal(refineBpmAgainstOnsets(samples, SR, 0), 0);
  assert.equal(refineBpmAgainstOnsets(samples, SR, -5), -5);
  assert.equal(refineBpmAgainstOnsets(null, SR, 128), 128);
});

test('kickOnsets finds one onset per beat and times them to better than a frame', () => {
  const onsets = kickOnsets(kickTrack(120, 30), SR);
  assert.ok(onsets.length > 50 && onsets.length < 70, `expected ~59 kicks, got ${onsets.length}`);
  const gaps = [];
  for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i] - onsets[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  // 0.5s at 120bpm. Sub-frame interpolation should beat the 8ms frame it was measured in.
  assert.ok(Math.abs(mean - 0.5) < 0.004, `expected ~0.5s spacing, got ${mean}`);
});

test('is not fooled by high-frequency percussion between the kicks', () => {
  // Hats on the offbeat: a full-band peak picker would call these onsets and halve the tempo.
  const samples = kickTrack(126, 180);
  const period = (60 / 126) * SR;
  for (let beat = 0; ; beat++) {
    const at = Math.round(0.5 * SR + (beat + 0.5) * period);
    if (at + 200 >= samples.length) break;
    for (let i = 0; i < 200; i++) {
      samples[at + i] = Math.max(-32000, Math.min(32000,
        samples[at + i] + Math.round(18000 * Math.exp(-i / 25) * Math.sin((2 * Math.PI * 3200 * i) / SR))));
    }
  }
  const refined = refineBpmAgainstOnsets(samples, SR, 126 * 1.002);
  assert.ok(Math.abs(refined - 126) < 0.05, `expected ~126 despite hats, got ${refined}`);
});
