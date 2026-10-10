/** Polishes a tempo estimate against the track's own kick onsets. */

/** Frames of this many samples; at the beat grid's 8kHz that is 8ms, finer than QM's 11.5ms hop. */
const FRAME = 64;
/** Kick band. */
const LOW_CROSSOVER_HZ = 120;
const CASCADE_STAGES = 4;

/** Cascaded one-pole lowpass - same shape as beatgrid-autocorrelation's, kept local so this module stands alone. */
function lowpass(samples, sampleRate, cutoffHz) {
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const out = Float64Array.from(samples);
  for (let stage = 0; stage < CASCADE_STAGES; stage++) {
    let value = 0;
    for (let i = 0; i < out.length; i++) {
      value += alpha * (out[i] - value);
      out[i] = value;
    }
  }
  return out;
}
/** Kicks closer together than this are the same hit, or a sub-beat we do not want. */
const MIN_GAP_SECONDS = 0.25;
/** An onset must sit this close to a predicted beat to count as on-grid, in beats. */
const ON_GRID_TOLERANCE = 0.08;
/** Below this many beats of baseline there is nothing to gain, and rounding gets risky. */
const MIN_BASELINE_BEATS = 8;
/** Refuse a correction larger than this. */
const MAX_CORRECTION = 0.02;

/** Kick onset times in seconds, timed to sub-frame accuracy. */
export function kickOnsets(rawSamples, sampleRate) {
  const frameSeconds = FRAME / sampleRate;
  const count = Math.floor(rawSamples.length / FRAME);
  if (count < 16) return [];

  const samples = lowpass(rawSamples, sampleRate, LOW_CROSSOVER_HZ);

  const energy = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = 0; j < FRAME; j++) sum += Math.abs(samples[i * FRAME + j]);
    energy[i] = sum / FRAME;
  }

  const sorted = Float64Array.from(energy).sort();
  const threshold = sorted[Math.floor(sorted.length * 0.93)];

  const times = [];
  for (let i = 1; i < count - 1; i++) {
    if (energy[i] <= threshold || energy[i] < energy[i - 1] || energy[i] <= energy[i + 1]) continue;
    // Parabolic vertex through the three points
    const denom = energy[i - 1] - 2 * energy[i] + energy[i + 1];
    const shift = denom === 0 ? 0 : (energy[i - 1] - energy[i + 1]) / (2 * denom);
    const time = (i + Math.max(-0.5, Math.min(0.5, shift))) * frameSeconds;
    if (!times.length || time - times[times.length - 1] > MIN_GAP_SECONDS) times.push(time);
  }
  return times;
}

/** One pass: the longest on-grid span within `limitSeconds`, divided by the beats across it. */
function spanPeriod(times, period, limitSeconds) {
  const within = times.filter((t) => t - times[0] <= limitSeconds);
  if (within.length < MIN_BASELINE_BEATS) return null;

  let firstTime = null, firstBeat = 0, lastTime = 0, lastBeat = 0;
  for (const time of within) {
    const beats = (time - within[0]) / period;
    const nearest = Math.round(beats);
    // Skipped, not absorbed: an onset off this grid is a snare or a stray
    if (Math.abs(beats - nearest) > ON_GRID_TOLERANCE) continue;
    if (firstTime === null) { firstTime = time; firstBeat = nearest; }
    lastTime = time;
    lastBeat = nearest;
  }
  if (firstTime === null || lastBeat - firstBeat < MIN_BASELINE_BEATS) return null;
  return (lastTime - firstTime) / (lastBeat - firstBeat);
}

/** Refined BPM, or the original when there is nothing trustworthy to refine against. */
export function refineBpmAgainstOnsets(samples, sampleRate, bpm) {
  if (!(bpm > 0) || !samples?.length) return bpm;

  const times = kickOnsets(samples, sampleRate);
  if (times.length < 40) return bpm;

  const original = 60 / bpm;
  let period = original;
  for (const limit of [30, 120, Infinity]) {
    const better = spanPeriod(times, period, limit);
    if (better > 0) period = better;
  }

  if (Math.abs(period - original) / original > MAX_CORRECTION) return bpm;
  return 60 / period;
}
