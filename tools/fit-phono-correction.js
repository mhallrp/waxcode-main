#!/usr/bin/env node
/**
 * Fits a cascade of peaking-EQ biquads to the phono passthrough correction curve.
 *
 * The correction itself was measured, not modelled (see tools/passthrough-response.js and DEVLOG
 * 2026-08-23): a phono-level cartridge working into the ADC's input impedance loses -14dB at 8k
 * and -25dB at 16k. This turns that measurement into something that can run live.
 *
 * Biquads rather than the FIR used for offline validation: an FFT equaliser wide enough to shape
 * this curve adds ~85ms, on top of alsaloop's existing ~43ms. That is felt immediately when
 * cueing a real record. Peaking biquads add no meaningful latency at all.
 *
 * The target tapers above 12.5kHz instead of chasing the full -25dB. Per-band SNR of the captured
 * signal is only 25dB at 16k, so fully correcting it buys hiss rather than air. Confirmed by ear
 * against the untapered version (2026-08-23).
 */

const RATE = 48000;

/** [frequency, dB of boost needed]. From the measured curve, tapered above 12.5k. */
const TARGET = [
  [1000, 0], [1250, 0], [1600, 0], [2000, 0], [2500, 0.5], [3150, 1], [4000, 2.3],
  [5000, 7.4], [6300, 11.8], [8000, 13.9], [10000, 18], [12500, 19],
  [14000, 14], [16000, 8], [18000, 4], [20000, 0],
];

/** Above 16k the content is near the noise floor, so a close fit there is not worth trading for one lower down. */
const weightFor = (freq) => (freq >= 16000 ? 0.35 : 1);

/** Magnitude response of one RBJ peaking filter, in dB. */
function peakingResponse(freq, { f0, q, gain }) {
  const A = Math.pow(10, gain / 40);
  const w0 = (2 * Math.PI * f0) / RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const cosW0 = Math.cos(w0);

  const b = [1 + alpha * A, -2 * cosW0, 1 - alpha * A];
  const a = [1 + alpha / A, -2 * cosW0, 1 - alpha / A];

  const w = (2 * Math.PI * freq) / RATE;
  const num = { re: b[0] + b[1] * Math.cos(w) + b[2] * Math.cos(2 * w), im: -(b[1] * Math.sin(w) + b[2] * Math.sin(2 * w)) };
  const den = { re: a[0] + a[1] * Math.cos(w) + a[2] * Math.cos(2 * w), im: -(a[1] * Math.sin(w) + a[2] * Math.sin(2 * w)) };
  const mag = Math.hypot(num.re, num.im) / Math.hypot(den.re, den.im);
  return 20 * Math.log10(mag);
}

const cascadeResponse = (freq, filters) => filters.reduce((sum, f) => sum + peakingResponse(freq, f), 0);

function error(filters) {
  let total = 0;
  for (const [freq, wanted] of TARGET) {
    const diff = cascadeResponse(freq, filters) - wanted;
    total += weightFor(freq) * diff * diff;
  }
  return total;
}

/**
 * Deterministic search - a seeded LCG rather than Math.random, so re-running this reproduces the
 * exact filter that shipped rather than a slightly different one.
 */
let seed = 20260823;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (lo, hi) => lo + random() * (hi - lo);

const FILTER_COUNT = 4;
const randomFilter = () => ({ f0: Math.exp(pick(Math.log(3000), Math.log(17000))), q: pick(0.4, 3), gain: pick(0, 22) });

let best = null;
let bestError = Infinity;

for (let restart = 0; restart < 400; restart++) {
  let filters = Array.from({ length: FILTER_COUNT }, randomFilter);
  let current = error(filters);
  let step = 1;

  // Coordinate descent with a shrinking step - enough for a smooth 4-parameter-per-filter surface.
  for (let iteration = 0; iteration < 3000; iteration++) {
    const index = Math.floor(random() * FILTER_COUNT);
    const candidate = filters.map((f) => ({ ...f }));
    const which = Math.floor(random() * 3);
    if (which === 0) candidate[index].f0 = Math.max(2000, Math.min(19000, candidate[index].f0 * (1 + pick(-0.15, 0.15) * step)));
    if (which === 1) candidate[index].q = Math.max(0.2, Math.min(4, candidate[index].q + pick(-0.4, 0.4) * step));
    if (which === 2) candidate[index].gain = Math.max(-6, Math.min(24, candidate[index].gain + pick(-3, 3) * step));

    const candidateError = error(candidate);
    if (candidateError < current) { filters = candidate; current = candidateError; }
    if (iteration % 300 === 299) step *= 0.75;
  }

  if (current < bestError) { bestError = current; best = filters; }
}

best.sort((x, y) => x.f0 - y.f0);

console.log(`RMS error: ${Math.sqrt(bestError / TARGET.length).toFixed(2)} dB\n`);
console.log('  freq    target    fitted     diff');
for (const [freq, wanted] of TARGET) {
  const got = cascadeResponse(freq, best);
  console.log(`${String(freq).padStart(6)}  ${wanted.toFixed(1).padStart(6)}  ${got.toFixed(2).padStart(8)}  ${(got - wanted).toFixed(2).padStart(7)}`);
}

const chain = best.map((f) => `equalizer=f=${Math.round(f.f0)}:t=q:w=${f.q.toFixed(3)}:g=${f.gain.toFixed(2)}`).join(',');
console.log(`\nffmpeg filter chain:\n${chain}`);
console.log(`\nPeak boost across the band: ${Math.max(...TARGET.map(([f]) => cascadeResponse(f, best))).toFixed(1)} dB`);
