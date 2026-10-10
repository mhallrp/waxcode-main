import { spawn } from 'node:child_process';
import { decodeSharedPair, decodeSegmentMono, WAVEFORM_SAMPLE_RATE } from './shared-decode.js';
import { prioritizedSpawn } from './process-priority.js';

// A low mono rate is plenty for a visual amplitude envelope, unlike xwax's full-quality decode for actual playback.
const DECODE_SAMPLE_RATE = WAVEFORM_SAMPLE_RATE;

// Default resolution when no explicit bucket count is given - scaled to track length.
const TARGET_BUCKET_SECONDS = 0.04;

// bucketsForDuration counts in DECODE_SAMPLE_RATE frames; segments work in seconds.
const DECODE_SAMPLE_RATE_FOR_BUCKETS = 16000;

// Bucket count is a uint16 on the wire (see waveform-binary.js) - 65535 is a hard ceiling regardless of anything below.
const MAX_BUCKETS = 65000;

// A real, reproducible OOM crash: cascadeLowpass/cascadeHighpass each hold a FULL-length copy of the decoded samples alongside the original
const MAX_ANALYSIS_SAMPLES = 20 * 60 * DECODE_SAMPLE_RATE; // 20 minutes at DECODE_SAMPLE_RATE

// Tri-band crossover points.
const LOW_CROSSOVER_HZ = 250;
const HIGH_CROSSOVER_HZ = 4000;

/** Decodes `path` via ffmpeg once, then derives the drawn SHAPE from the raw broadband signal (`overall`) plus three frequency bands */
export async function computeWaveformPeaks(path, { buckets, spawnFn = spawn, priority, signal } = {}) {
  const { pcm16: pcm } = await decodeSharedPair(path, { spawnFn, priority, signal });
  const samples = pcmToInt16Array(pcm);
  await yieldToEventLoop();

  // Clamped to MAX_BUCKETS regardless of source
  const resolvedBuckets = Math.min(buckets ?? bucketsForDuration(samples.length), MAX_BUCKETS);

  // Filtering works off a decimated copy for unusually long tracks (see decimateForAnalysis)
  const { samples: analysisSamples, sampleRate: analysisSampleRate } = decimateForAnalysis(samples, MAX_ANALYSIS_SAMPLES);

  // Everything below is plain synchronous JS on this process's own event loop
  const lowSamples = await cascadeLowpass(analysisSamples, analysisSampleRate, LOW_CROSSOVER_HZ);
  const midSamples = await cascadeLowpass(await cascadeHighpass(analysisSamples, analysisSampleRate, LOW_CROSSOVER_HZ), analysisSampleRate, HIGH_CROSSOVER_HZ);
  const highSamples = await cascadeHighpass(analysisSamples, analysisSampleRate, HIGH_CROSSOVER_HZ);

  // `overall` comes from the RAW, unfiltered samples, at full resolution.
  const rawOverall = rawPeaksFromSamples(samples, resolvedBuckets);
  await yieldToEventLoop();
  const rawLow = rawMagnitudeFromSamples(lowSamples, resolvedBuckets);
  await yieldToEventLoop();
  const rawMid = rawMagnitudeFromSamples(midSamples, resolvedBuckets);
  await yieldToEventLoop();
  const rawHigh = rawMagnitudeFromSamples(highSamples, resolvedBuckets);
  await yieldToEventLoop();
  const { overall, colorWeights } = normalizeToInt8({ overall: rawOverall, low: rawLow, mid: rawMid, high: rawHigh });

  return overall.map((envelope, i) => ({ envelope, color: colorWeights[i] }));
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}


// Direct typed-array view over the same bytes, not a manual per-sample readInt16LE loop
function pcmToInt16Array(pcm) {
  const aligned = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length);
  return new Int16Array(aligned);
}

/** Simple stride decimation (take every Nth sample) down to at most `maxSamples` */
export function decimateForAnalysis(samples, maxSamples) {
  if (samples.length <= maxSamples) return { samples, sampleRate: DECODE_SAMPLE_RATE };
  const factor = Math.ceil(samples.length / maxSamples);
  const decimated = new Int16Array(Math.ceil(samples.length / factor));
  for (let i = 0, j = 0; i < samples.length; i += factor, j++) {
    decimated[j] = samples[i];
  }
  return { samples: decimated, sampleRate: DECODE_SAMPLE_RATE / factor };
}

// N cascaded one-pole stages = an N-pole filter, ~6*N dB/octave - steeper rolloff than a single stage, for real band separation.
const CASCADE_STAGES = 4;

// Yields between each of the 4 stages, not just before/after the whole cascade (2026-08-19)
async function cascadeLowpass(samples, sampleRate, cutoffHz) {
  let result = samples;
  for (let i = 0; i < CASCADE_STAGES; i++) {
    result = lowpass(result, sampleRate, cutoffHz);
    await yieldToEventLoop();
  }
  return result;
}

async function cascadeHighpass(samples, sampleRate, cutoffHz) {
  let result = samples;
  for (let i = 0; i < CASCADE_STAGES; i++) {
    result = highpass(result, sampleRate, cutoffHz);
    await yieldToEventLoop();
  }
  return result;
}

/** One-pole (6dB/octave) IIR low-pass - see computeWaveformPeaks' doc comment for why this, not ffmpeg's own filter. Cascaded (see cascadeLowpass) rather than used alone. */
function lowpass(samples, sampleRate, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  const out = new Int16Array(samples.length);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    prev = prev + alpha * (samples[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** One-pole (6dB/octave) IIR high-pass - same reasoning as lowpass above. */
function highpass(samples, sampleRate, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = rc / (rc + dt);
  const out = new Int16Array(samples.length);
  let prevIn = samples.length > 0 ? samples[0] : 0;
  let prevOut = 0;
  for (let i = 0; i < samples.length; i++) {
    const input = samples[i];
    const output = alpha * (prevOut + input - prevIn);
    out[i] = output;
    prevOut = output;
    prevIn = input;
  }
  return out;
}

/** Every band shares one frame count (derived from the same decoded buffer), so any one is enough to derive the bucket count. */
function bucketsForDuration(totalFrames) {
  const durationSeconds = totalFrames / DECODE_SAMPLE_RATE;
  return Math.max(1, Math.round(durationSeconds / TARGET_BUCKET_SECONDS));
}

/** Reduces raw 16-bit samples to a real signed (min, max) envelope per bucket - the actual drawn shape (see `overall` in computeWaveformPeaks). Scaling to int8 is normalizeToInt8's job, not this function's. */
function rawPeaksFromSamples(samples, buckets) {
  const totalFrames = samples.length;
  const peaks = [];

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b / buckets) * totalFrames);
    const end = Math.max(start + 1, Math.floor(((b + 1) / buckets) * totalFrames));

    let min = 0;
    let max = 0;
    for (let i = start; i < end && i < totalFrames; i++) {
      const sample = samples[i];
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    peaks.push({ min, max });
  }

  return peaks;
}

/** Same bucket reduction as rawPeaksFromSamples, but a single peak magnitude (max absolute value) per bucket, not a (min, max) pair */
function rawMagnitudeFromSamples(samples, buckets) {
  const totalFrames = samples.length;
  const magnitudes = [];

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b / buckets) * totalFrames);
    const end = Math.max(start + 1, Math.floor(((b + 1) / buckets) * totalFrames));

    let magnitude = 0;
    for (let i = start; i < end && i < totalFrames; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > magnitude) magnitude = abs;
    }
    magnitudes.push(magnitude);
  }

  return magnitudes;
}

// Per-band weights that balance the COLOUR blend only, never the drawn shape - a mistake here can shift hue, never loudness.
const LOW_COLOR_WEIGHT = 1.0;
const MID_COLOR_WEIGHT = 0.5;
const HIGH_COLOR_WEIGHT = 10.0;

/** Scales the raw broadband envelope (`overall`) to int8 off its own peak alone - the only thing that determines drawn height. */
/** `peak` overrides the track's own peak, for drawing a partial waveform against a fixed scale while later segments are still decoding */
export function normalizeToInt8({ overall, low, mid, high }, { peak } = {}) {
  let overallPeak = peak ?? 0;
  if (peak === undefined) for (const { min, max } of overall) overallPeak = Math.max(overallPeak, Math.abs(min), Math.abs(max));
  const scale = overallPeak > 0 ? 127 / overallPeak : 0;

  const clampInt8 = (v) => Math.max(-127, Math.min(127, Math.round(v)));
  const overallScaled = overall.map(({ min, max }) => ({ min: clampInt8(min * scale), max: clampInt8(max * scale) }));

  const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const colorWeights = low.map((lowMag, i) => {
    const midMag = mid[i];
    const highMag = high[i];
    const weightedLow = lowMag * LOW_COLOR_WEIGHT;
    const weightedMid = midMag * MID_COLOR_WEIGHT;
    const weightedHigh = highMag * HIGH_COLOR_WEIGHT;
    const total = weightedLow + weightedMid + weightedHigh;
    if (total <= 0) return { low: 0, mid: 0, high: 0 };
    return {
      low: clampByte((weightedLow / total) * 255),
      mid: clampByte((weightedMid / total) * 255),
      high: clampByte((weightedHigh / total) * 255),
    };
  });

  return { overall: overallScaled, colorWeights };
}


// Two quick slices to get something on screen, then even eighths.
export const SEGMENT_FRACTIONS = [1 / 16, 1 / 16, ...Array(7).fill(1 / 8)];

// Partials are drawn against absolute full scale.
const PARTIAL_SCALE_PEAK = 32767;

// How close a track's true peak must be to full scale before the partials are treated as already carrying the final answer.
const PARTIAL_SCALE_TOLERANCE = 0.95;

/** Builds a track's waveform slice by slice, reporting the track-so-far as each lands. */
export async function computeWaveformInSegments(path, { spawnFn = spawn, priority, signal, onPartial } = {}) {
  const duration = await probeDurationSeconds(path, spawnFn, signal);
  if (!(duration > 0)) return computeWaveformPeaks(path, { spawnFn, priority, signal });

  const raw = { overall: [], low: [], mid: [], high: [] };
  let start = 0;

  // Bucket boundaries come from the WHOLE track, not from each slice independently.
  const totalBuckets = Math.min(bucketsForDuration(duration * DECODE_SAMPLE_RATE_FOR_BUCKETS), MAX_BUCKETS);
  let bucketsSoFar = 0;

  for (const fraction of SEGMENT_FRACTIONS) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    const length = fraction * duration;
    const pcm = await decodeSegmentMono(path, start, length, { spawnFn, priority, signal });
    const samples = pcmToInt16Array(pcm);
    start += length;
    if (samples.length === 0) continue;

    // This slice's share of the whole-track total
    const bucketsThroughEnd = Math.round(start / duration * totalBuckets);
    const buckets = Math.max(1, Math.min(bucketsThroughEnd, totalBuckets) - bucketsSoFar);
    bucketsSoFar += buckets;
    const lowSamples = await cascadeLowpass(samples, WAVEFORM_SAMPLE_RATE, LOW_CROSSOVER_HZ);
    const midSamples = await cascadeLowpass(await cascadeHighpass(samples, WAVEFORM_SAMPLE_RATE, LOW_CROSSOVER_HZ), WAVEFORM_SAMPLE_RATE, HIGH_CROSSOVER_HZ);
    const highSamples = await cascadeHighpass(samples, WAVEFORM_SAMPLE_RATE, HIGH_CROSSOVER_HZ);
    await yieldToEventLoop();

    const segment = {
      overall: rawPeaksFromSamples(samples, buckets),
      low: rawMagnitudeFromSamples(lowSamples, buckets),
      mid: rawMagnitudeFromSamples(midSamples, buckets),
      high: rawMagnitudeFromSamples(highSamples, buckets),
    };
    const startBucket = raw.overall.length;
    raw.overall.push(...segment.overall);
    raw.low.push(...segment.low);
    raw.mid.push(...segment.mid);
    raw.high.push(...segment.high);
    await yieldToEventLoop();

    // Only this slice's buckets, not the track so far - see encodeWaveformDelta for what sending the accumulated waveform each time cost.
    if (onPartial) onPartial({ startBucket, peaks: toPeaks(normalizeToInt8(segment, { peak: PARTIAL_SCALE_PEAK })) });
  }

  const finalPeaks = toPeaks(normalizeToInt8(raw));

  // If the track peaks at (near) full scale, the partials were already normalised against the same number
  let peak = 0;
  for (const { min, max } of raw.overall) peak = Math.max(peak, Math.abs(min), Math.abs(max));
  const alreadyDelivered = peak >= PARTIAL_SCALE_PEAK * PARTIAL_SCALE_TOLERANCE;

  return { peaks: finalPeaks, alreadyDelivered };
}

function toPeaks({ overall, colorWeights }) {
  return overall.map((envelope, i) => ({ envelope, color: colorWeights[i] }));
}

function probeDurationSeconds(path, spawnFn, signal) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path];
    const probe = spawnFn('ffprobe', args, { signal });
    let out = '';
    probe.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    probe.once('error', () => resolve(0));
    // A duration we cannot read is not fatal - the caller falls back to a whole-track decode.
    probe.once('close', () => resolve(Number.parseFloat(out.trim()) || 0));
  });
}
