import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePhaseAtTempo } from '../src/beatgrid-autocorrelation.js';

/**
 * A click track: a sharp transient every `bpm` beats, at signed-16-bit scale.
 * Phase analysis uses absolute onset thresholds, so the scale matters - see analyzePhaseAtTempo.
 */
function clickTrack(bpm, sampleRate, seconds, firstBeatSeconds = 0) {
  const samples = new Int16Array(Math.round(sampleRate * seconds));
  const period = (60 / bpm) * sampleRate;
  for (let beat = 0; ; beat++) {
    const at = Math.round(firstBeatSeconds * sampleRate + beat * period);
    if (at + 400 >= samples.length) break;
    // A short decaying thud - low frequency, so it survives the lowpass the phase analysis uses.
    for (let i = 0; i < 400; i++) {
      samples[at + i] = Math.round(20000 * Math.exp(-i / 60) * Math.sin((2 * Math.PI * 60 * i) / sampleRate));
    }
  }
  return samples;
}

test('analyzePhaseAtTempo finds the first beat of a click track', async () => {
  const sampleRate = 8000;
  const samples = clickTrack(120, sampleRate, 30, 0.25);

  const phase = await analyzePhaseAtTempo(samples, sampleRate, 120);

  assert.notEqual(phase, null);
  // Whole-beat equivalence: the grid is what matters, not which beat is called first.
  const period = 60 / 120;
  const offBy = Math.abs(phase - 0.25) % period;
  const distance = Math.min(offBy, period - offBy);
  assert.ok(distance < 0.03, `phase ${phase} should sit on the 0.25s grid, was ${distance.toFixed(3)}s off`);
});

test('analyzePhaseAtTempo returns null for silence rather than inventing a beat', async () => {
  const phase = await analyzePhaseAtTempo(new Int16Array(8000 * 20), 8000, 120);
  assert.equal(phase, null);
});

test('analyzePhaseAtTempo refuses a nonsense tempo instead of dividing by zero', async () => {
  const samples = clickTrack(120, 8000, 20);
  assert.equal(await analyzePhaseAtTempo(samples, 8000, 0), null);
  assert.equal(await analyzePhaseAtTempo(samples, 8000, -5), null);
});

test('analyzePhaseAtTempo is unaffected by which beat the tempo implies, only the grid', async () => {
  // Same click track read at half tempo: every other predicted beat still lands on a real onset,
  // so a valid phase must still come back rather than the analysis giving up.
  const samples = clickTrack(120, 8000, 30, 0.1);
  const phase = await analyzePhaseAtTempo(samples, 8000, 60);
  assert.notEqual(phase, null);
  const period = 1.0;
  const offBy = Math.abs(phase - 0.1) % period;
  assert.ok(Math.min(offBy, period - offBy) < 0.05);
});
