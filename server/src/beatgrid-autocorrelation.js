import { spawn } from 'node:child_process';
import { decodeSharedPair, BEATGRID_SAMPLE_RATE } from './shared-decode.js';
import { readTaggedBpm, correctMetricLevel } from './beatgrid-tag.js';
import { prioritizedSpawn } from './process-priority.js';

// Matches waveform.js's own DECODE_SAMPLE_RATE - plenty of resolution for onset detection.
const DECODE_SAMPLE_RATE = BEATGRID_SAMPLE_RATE;

// 10ms hop: fine enough for real beat timing once refined below, coarse enough to keep the envelope array small.
const ENVELOPE_HOP_SECONDS = 0.01;

// Tighter than waveform.js's 250Hz split - isolates the kick fundamental away from hats/snares/vocals.
const LOW_CROSSOVER_HZ = 150;
const CASCADE_STAGES = 4;

// Covers DJ-relevant tempos with margin; a track outside this should fail to find a peak, not get forced in.
const MIN_BPM = 70;
const MAX_BPM = 190;

// Below this many envelope samples, not enough signal to trust a global fit.
const MIN_ENVELOPE_SAMPLES = 200; // 2 seconds at the hop above

// Small on purpose - just separates "one real transient exists" from noise floor, not a loudness judgement.
const MIN_PEAK_ONSET_ENERGY = 50;

// Same reasoning as waveform.js's own MAX_ANALYSIS_SAMPLES (see its doc comment for the real OOM crash this class of fix addresses)
const MAX_ANALYSIS_SAMPLES = 20 * 60 * DECODE_SAMPLE_RATE; // 20 minutes at DECODE_SAMPLE_RATE

/** Global/offline autocorrelation-based beat tracker, vs aubio/BTrack's causal event tracking. */
export function computeBeatGridViaAutocorrelation(path, { spawnFn = spawn, priority, signal, readTaggedBpmFn = readTaggedBpm } = {}) {
  // Same decode the waveform uses - ffmpeg emits this 8kHz stream alongside its 16kHz one
  const decoded = decodeSharedPair(path, { spawnFn, priority, signal }).then(({ pcm8: pcm }) => pcmToInt16Array(pcm));
  const tagged = readTaggedBpmFn(path).catch(() => null);

  return Promise.all([decoded, tagged]).then(([samples, tagBpm]) =>
    analyzeSamples(samples, DECODE_SAMPLE_RATE, { tagBpm }));
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Split from computeBeatGridViaAutocorrelation so tests can feed real or synthetic sample arrays directly, without shelling out to ffmpeg. */
export async function analyzeSamples(samples, sampleRate, { tagBpm = null } = {}) {
  // Decimating (if needed) before anything else, and using the correspondingly reduced rate for everything downstream
  ({ samples, sampleRate } = decimateForAnalysis(samples, sampleRate, MAX_ANALYSIS_SAMPLES));

  const low = await cascadeLowpass(samples, sampleRate, LOW_CROSSOVER_HZ);
  const envelope = await onsetEnvelope(low, sampleRate, ENVELOPE_HOP_SECONDS);
  if (envelope.length < MIN_ENVELOPE_SAMPLES) return null;

  // Peak (not average) onset energy - catches near-silent tracks that would otherwise score every lag/phase equally.
  const peakEnergy = envelope.reduce((max, v) => Math.max(max, v), 0);
  if (peakEnergy < MIN_PEAK_ONSET_ENERGY) return null;

  const envelopeRate = 1 / ENVELOPE_HOP_SECONDS;
  const minLag = Math.floor((envelopeRate * 60) / MAX_BPM);
  const maxLag = Math.ceil((envelopeRate * 60) / MIN_BPM);
  if (maxLag >= envelope.length) return null;

  // Tempo comes from the WIDEBAND envelope, not the lowpassed one - isolating to the kick can lock onto the wrong pulse.
  const wideEnvelope = await onsetEnvelope(samples, sampleRate, ENVELOPE_HOP_SECONDS);

  const coarseLag = await findBestIntegerLag(wideEnvelope, minLag, maxLag);
  if (coarseLag === null) return null;
  await yieldToEventLoop();

  const preciseLag = refineTempoViaPulseTrain(wideEnvelope, coarseLag);
  if (!(preciseLag > 0)) return null;

  // Phase/attack precision still uses the LOWPASSED envelope - wideband's loudest nearby transient is often a hat, not the kick.
  const phaseSamples = findBestPhase(envelope, preciseLag);

  // Raw phase is a whole-track average and can fall in silence before the real first beat - walk forward to a real onset before refining.
  const windowSamples = preciseLag * SNAP_WINDOW_FRACTION;
  const onsetAnchor = findNearbyRealOnsetSamples(envelope, phaseSamples, preciseLag, windowSamples, peakEnergy * ONSET_ANCHOR_MIN_RATIO);
  const snappedPhaseSamples = onsetAnchor === null ? phaseSamples : onsetAnchor;

  // The grid search above lands near the true tempo but not on it, which walks most of a beat by the end of a long track.
  const fit = await refineTempoViaOnsetAlignment(envelope, preciseLag, snappedPhaseSamples, peakEnergy);
  // One long-baseline pass over whatever tempo the stages above settled on.
  const driftedLag = refineTempoViaDrift(envelope, fit ? fit.period : preciseLag);

  // A tag can settle which metric level we locked onto - see beatgrid-tag.js.
  const metric = correctMetricLevel(60 / (driftedLag * ENVELOPE_HOP_SECONDS), tagBpm);
  const finalLag = metric.corrected ? 60 / (metric.bpm * ENVELOPE_HOP_SECONDS) : driftedLag;

  /** Re-fit the phase at the final tempo, rather than keeping the one the alignment search arrived at. */
  const finalPhase = findBestPhase(envelope, finalLag);
  const finalWindow = finalLag * SNAP_WINDOW_FRACTION;
  const finalAnchor = findNearbyRealOnsetSamples(envelope, finalPhase, finalLag, finalWindow, peakEnergy * ONSET_ANCHOR_MIN_RATIO);

  /** The anchor may move by WHOLE BEATS only. */
  const anchoredPhase = finalAnchor === null
    ? finalPhase
    : finalPhase + Math.round((finalAnchor - finalPhase) / finalLag) * finalLag;

  return {
    bpm: 60 / (finalLag * ENVELOPE_HOP_SECONDS),
    firstBeatSeconds: anchoredPhase * ENVELOPE_HOP_SECONDS,
  };
}

/** Phase only, at a tempo somebody else already decided. */
export async function analyzePhaseAtTempo(samples, sampleRate, bpm) {
  if (!(bpm > 0)) return null;
  ({ samples, sampleRate } = decimateForAnalysis(samples, sampleRate, MAX_ANALYSIS_SAMPLES));

  // The LOWPASSED envelope, as analyzeSamples uses for phase - wideband's loudest nearby transient is often a hat rather than the kick.
  const low = await cascadeLowpass(samples, sampleRate, LOW_CROSSOVER_HZ);
  const envelope = await onsetEnvelope(low, sampleRate, ENVELOPE_HOP_SECONDS);
  if (envelope.length < MIN_ENVELOPE_SAMPLES) return null;

  const peakEnergy = envelope.reduce((max, v) => Math.max(max, v), 0);
  if (peakEnergy < MIN_PEAK_ONSET_ENERGY) return null;

  const lag = 60 / (bpm * ENVELOPE_HOP_SECONDS);
  if (!(lag > 0) || lag >= envelope.length) return null;

  const phase = findBestPhase(envelope, lag);
  const anchor = findNearbyRealOnsetSamples(envelope, phase, lag, lag * SNAP_WINDOW_FRACTION,
                                            peakEnergy * ONSET_ANCHOR_MIN_RATIO);

  // Whole beats only - see analyzeSamples' own note on why the sub-beat nudge is discarded.
  const anchored = anchor === null ? phase : phase + Math.round((anchor - phase) / lag) * lag;
  return anchored * ENVELOPE_HOP_SECONDS;
}

// How many outer frames run between yields - called twice per analysis (once on the lowpassed signal, once on the raw one)
const ENVELOPE_YIELD_INTERVAL = 200;

/** Half-wave-rectified derivative of short-time energy - a standard onset-strength envelope: rising energy is a positive spike, flat/falling is zero. */
export async function onsetEnvelope(samples, sampleRate, hopSeconds) {
  const hopSamples = Math.max(1, Math.round(sampleRate * hopSeconds));
  const frameCount = Math.floor(samples.length / hopSamples);
  const energy = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    if (f % ENVELOPE_YIELD_INTERVAL === 0) await yieldToEventLoop();
    let sum = 0;
    const start = f * hopSamples;
    const end = start + hopSamples;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      sum += s * s;
    }
    energy[f] = Math.sqrt(sum / hopSamples);
  }

  const envelope = new Float64Array(frameCount);
  for (let f = 1; f < frameCount; f++) {
    envelope[f] = Math.max(0, energy[f] - energy[f - 1]);
  }
  return envelope;
}

// How many outer `lag` values run between yields
const LAG_YIELD_INTERVAL = 8;

/** Autocorrelation restricted to the MIN_BPM/MAX_BPM lag range, normalized by overlap count so longer lags aren't unfairly penalised. */
export async function findBestIntegerLag(envelope, minLag, maxLag) {
  let bestLag = null;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if ((lag - minLag) % LAG_YIELD_INTERVAL === 0) await yieldToEventLoop();
    let score = 0;
    const count = envelope.length - lag;
    for (let i = 0; i < count; i++) {
      score += envelope[i] * envelope[i + lag];
    }
    score /= count;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag;
}

/** Linear interpolation between the two nearest whole-sample envelope values - what lets bestPhaseAndScore/refineTempoViaPulseTrain evaluate the envelope at arbitrary, non-integer offsets. */
function interpolatedValue(envelope, position) {
  const i0 = Math.floor(position);
  const i1 = i0 + 1;
  if (i0 < 0 || i1 >= envelope.length) return 0;
  const frac = position - i0;
  return envelope[i0] * (1 - frac) + envelope[i1] * frac;
}

const PHASE_SEARCH_STEPS = 400;

/** Finds the phase within [0, period) that maximises onset energy at predicted beat positions, and that score. */
function bestPhaseAndScore(envelope, period, steps) {
  let bestPhase = 0;
  let bestScore = -Infinity;
  const step = period / steps;
  for (let i = 0; i < steps; i++) {
    const phase = i * step;
    let score = 0;
    let count = 0;
    for (let position = phase; position < envelope.length; position += period) {
      score += interpolatedValue(envelope, position);
      count++;
    }
    if (count === 0) continue;
    score /= count;
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  return { phase: bestPhase, score: bestScore };
}

export function findBestPhase(envelope, period) {
  return bestPhaseAndScore(envelope, period, PHASE_SEARCH_STEPS).phase;
}

// Search range either side of the coarse lag - the true period can sit near the midpoint between adjacent integer-lag bins.
const TEMPO_REFINEMENT_RANGE_SAMPLES = 2;
const TEMPO_REFINEMENT_STEPS = 300;

// Coarser than PHASE_SEARCH_STEPS - only needs to rank candidates against each other, not full precision.
const TEMPO_SWEEP_PHASE_STEPS = 50;

/** Refines the coarse tempo via continuous pulse-train cross-correlation (Percival & Tzanetakis 2014) rather than self-autocorrelation, which converges on the wrong period near a lag-bin boundary. */
export function refineTempoViaPulseTrain(envelope, coarseLag) {
  let bestLag = coarseLag;
  let bestScore = -Infinity;
  const step = (2 * TEMPO_REFINEMENT_RANGE_SAMPLES) / TEMPO_REFINEMENT_STEPS;
  for (let i = 0; i <= TEMPO_REFINEMENT_STEPS; i++) {
    const lag = coarseLag - TEMPO_REFINEMENT_RANGE_SAMPLES + i * step;
    if (lag <= 0) continue;
    const { score } = bestPhaseAndScore(envelope, lag, TEMPO_SWEEP_PHASE_STEPS);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag;
}

/** Long-baseline tempo refinement, from discrete onsets. */
const DRIFT_WINDOWS = 8;
const DRIFT_MIN_ONSETS_PER_WINDOW = 6;
const DRIFT_ITERATIONS = 3;

/* Peaks below this fraction of the strongest onset are texture, not beats. */
const DRIFT_ONSET_MIN_RATIO = 0.30;

/* A correction beyond this is a different tempo, not a refinement - refuse rather than chase it. */
const DRIFT_MAX_CORRECTION = 0.01;

/** Discrete onset peaks: local maxima above a floor, thinned to one per half-period. */
function onsetPeaks(envelope, period) {
  let peak = 0;
  for (let i = 0; i < envelope.length; i++) if (envelope[i] > peak) peak = envelope[i];
  if (!(peak > 0)) return [];

  const floor = peak * DRIFT_ONSET_MIN_RATIO;
  const minSep = Math.max(1, Math.floor(period / 2));
  const peaks = [];
  for (let i = 1; i < envelope.length - 1; i++) {
    if (envelope[i] < floor || envelope[i] < envelope[i - 1] || envelope[i] < envelope[i + 1]) continue;
    const last = peaks.length - 1;
    if (last >= 0 && i - peaks[last] < minSep) {
      if (envelope[i] > envelope[peaks[last]]) peaks[last] = i;
    } else {
      peaks.push(i);
    }
  }
  return peaks;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** One drift measurement: fractional tempo error, or null when the track cannot support it. */
export function measureDrift(envelope, period, peaks) {
  if (!(period > 0) || peaks.length < DRIFT_WINDOWS * DRIFT_MIN_ONSETS_PER_WINDOW) return null;

  const first = peaks[0];
  const last = peaks[peaks.length - 1];
  const span = (last - first) / DRIFT_WINDOWS;
  if (!(span > period * DRIFT_MIN_ONSETS_PER_WINDOW)) return null;

  const centres = [];
  const offsets = [];
  for (let w = 0; w < DRIFT_WINDOWS; w++) {
    const lo = first + w * span;
    const hi = lo + span;
    const inWindow = [];
    for (const p of peaks) {
      if (p < lo || p >= hi) continue;
      let d = ((p % period) + period) % period;
      if (d > period / 2) d -= period;
      inWindow.push(d);
    }
    if (inWindow.length < DRIFT_MIN_ONSETS_PER_WINDOW) continue;
    centres.push(lo + span / 2);
    offsets.push(median(inWindow));
  }
  if (offsets.length < 4) return null;

  // Unwrap, so a phase that walks past half a period keeps going rather than folding back.
  const unwrapped = [offsets[0]];
  for (let i = 1; i < offsets.length; i++) {
    let d = offsets[i] - offsets[i - 1];
    while (d > period / 2) d -= period;
    while (d < -period / 2) d += period;
    unwrapped.push(unwrapped[i - 1] + d);
  }

  const n = unwrapped.length;
  const meanX = centres.reduce((a, b) => a + b, 0) / n;
  const meanY = unwrapped.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (centres[i] - meanX) * (unwrapped[i] - meanY);
    den += (centres[i] - meanX) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

/** Iterates measureDrift to convergence. Returns the seed unchanged if it cannot improve on it. */
export function refineTempoViaDrift(envelope, period) {
  let current = period;
  for (let i = 0; i < DRIFT_ITERATIONS; i++) {
    const drift = measureDrift(envelope, current, onsetPeaks(envelope, current));
    if (drift === null) return period;
    const next = current * (1 + drift);
    if (!(next > 0) || Math.abs(next - period) / period > DRIFT_MAX_CORRECTION) return period;
    current = next;
  }
  return current;
}

// Scales with beat period rather than a fixed ms value - a fixed window was too narrow on busy multi-hit intros.
const SNAP_WINDOW_FRACTION = 0.35;

// Relative to the track's own peak onset energy, not an absolute value - kick loudness varies a lot track to track.
const ONSET_ANCHOR_MIN_RATIO = 0.25;

// Lower than a "loudest point" threshold - once a real kick is confirmed nearby
const CLUSTER_FLOOR_RATIO = 0.05;

// Bridges a kick's own internal decay spikes while walking back to its true attack, without crossing into real silence.
const CLUSTER_GAP_SAMPLES = 5;

/** Walks backward from a confirmed transient's peak to where its energy cluster genuinely begins, not just its loudest point - see CLUSTER_GAP_SAMPLES. Bounded to half a beat period back. */
function clusterLeadingEdge(envelope, peakIndex, floor, maxBackSamples) {
  const bound = Math.max(0, peakIndex - maxBackSamples);
  let earliest = peakIndex;
  let gapRun = 0;
  for (let i = peakIndex - 1; i >= bound; i--) {
    if (envelope[i] >= floor) {
      earliest = i;
      gapRun = 0;
    } else {
      gapRun++;
      if (gapRun > CLUSTER_GAP_SAMPLES) break;
    }
  }
  if (earliest === 0) return 0;
  const prevValue = envelope[earliest - 1];
  if (envelope[earliest] === prevValue) return earliest;
  const frac = Math.max(0, Math.min(1, (floor - prevValue) / (envelope[earliest] - prevValue)));
  return earliest - frac;
}

// Requires a SUSTAINED run before trusting an anchor, not one isolated hit.
const REQUIRED_CONSECUTIVE_CONFIRMATIONS = 8;

// Median across this many confirmed beats, not just the run's first.
const ANCHOR_SAMPLE_BEATS = REQUIRED_CONSECUTIVE_CONFIRMATIONS;

/** Walks forward through period-spaced candidates for the first SUSTAINED run of real onset energy (see REQUIRED_CONSECUTIVE_CONFIRMATIONS) */
export function findNearbyRealOnsetSamples(envelope, phaseSamples, period, windowSamples, minPeakValue) {
  const maxCandidates = Math.ceil((envelope.length - phaseSamples) / period) + 1;

  function peakNear(center) {
    const lo = Math.max(0, center - Math.round(windowSamples));
    const hi = Math.min(envelope.length - 1, center + Math.round(windowSamples));
    let peak = 0;
    let peakIndex = center;
    for (let i = lo; i <= hi; i++) {
      if (envelope[i] > peak) {
        peak = envelope[i];
        peakIndex = i;
      }
    }
    return { peak, peakIndex };
  }

  for (let k = 0; k < maxCandidates; k++) {
    const center = Math.round(phaseSamples + k * period);
    if (center >= envelope.length) break;
    const { peak, peakIndex } = peakNear(center);
    if (peak < minPeakValue) continue;

    // Confirm this is a sustained run, not a lone coincidence; running off the end of the envelope counts as "trust what's there."
    let sustained = true;
    for (let j = 1; j < REQUIRED_CONSECUTIVE_CONFIRMATIONS; j++) {
      const nextCenter = Math.round(phaseSamples + (k + j) * period);
      if (nextCenter >= envelope.length) break;
      if (peakNear(nextCenter).peak < minPeakValue) {
        sustained = false;
        break;
      }
    }
    if (!sustained) continue;

    // Median of several refined beats in this run, expressed as a beat-0 offset - not just the run's own first instance.
    const refinedOffsets = [];
    for (let m = 0; m < ANCHOR_SAMPLE_BEATS; m++) {
      const sampleCenter = Math.round(phaseSamples + (k + m) * period);
      if (sampleCenter >= envelope.length) break;
      const sample = m === 0 ? { peak, peakIndex } : peakNear(sampleCenter);
      if (sample.peak < minPeakValue) continue;
      const refined = clusterLeadingEdge(envelope, sample.peakIndex, sample.peak * CLUSTER_FLOOR_RATIO, Math.floor(period / 2));
      refinedOffsets.push(refined - m * period);
    }

    refinedOffsets.sort((a, b) => a - b);
    return refinedOffsets[Math.floor(refinedOffsets.length / 2)];
  }
  return null;
}


// Direct typed-array view, not a manual per-sample readInt16LE loop
export function pcmToInt16Array(pcm) {
  const aligned = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length);
  return new Int16Array(aligned);
}

/** Same idea as waveform.js's own decimateForAnalysis */
export function decimateForAnalysis(samples, sampleRate, maxSamples) {
  if (samples.length <= maxSamples) return { samples, sampleRate };
  const factor = Math.ceil(samples.length / maxSamples);
  const decimated = new Int16Array(Math.ceil(samples.length / factor));
  for (let i = 0, j = 0; i < samples.length; i += factor, j++) {
    decimated[j] = samples[i];
  }
  return { samples: decimated, sampleRate: sampleRate / factor };
}

// Same cascaded one-pole IIR as waveform.js's lowpass, reimplemented locally since tuning needs differ.
async function cascadeLowpass(samples, sampleRate, cutoffHz) {
  let result = samples;
  for (let i = 0; i < CASCADE_STAGES; i++) {
    result = lowpass(result, sampleRate, cutoffHz);
    await yieldToEventLoop();
  }
  return result;
}

function lowpass(samples, sampleRate, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  const out = new Float64Array(samples.length);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    prev = prev + alpha * (samples[i] - prev);
    out[i] = prev;
  }
  return out;
}

// An onset must clear this fraction of peak energy to count as a real beat.
const ALIGN_ONSET_MIN_RATIO = 0.15;

// How far either side of a predicted beat to look for its onset, as a fraction of a period.
const ALIGN_MATCH_FRACTION = 0.25;

// Distances are capped at this fraction of a period before averaging
const ALIGN_CAP_FRACTION = 0.15;

// Tempo search range either side of the seed, and its resolution.
const ALIGN_RANGE_RATIO = 0.004;
const ALIGN_STEPS = 400;

// Phase re-centring passes per candidate - the median converges immediately, this is belt and braces.
const ALIGN_PHASE_PASSES = 2;

// Candidates between yields.
const ALIGN_YIELD_INTERVAL = 20;

// Below this many matched beats a candidate is not evidence of anything.
const MIN_ALIGN_BEATS = 24;

/** Final tempo polish: picks the period whose beats land closest to real onsets across the track. */
export async function refineTempoViaOnsetAlignment(envelope, period, phaseSamples, peakEnergy) {
  const minPeak = peakEnergy * ALIGN_ONSET_MIN_RATIO;

  let best = null;
  let bestCost = Infinity;

  for (let i = 0; i <= ALIGN_STEPS; i += 1) {
    if (i % ALIGN_YIELD_INTERVAL === 0) await yieldToEventLoop();

    const candidate = period * (1 - ALIGN_RANGE_RATIO + (2 * ALIGN_RANGE_RATIO * i) / ALIGN_STEPS);
    if (candidate <= 0) continue;

    const scored = alignmentCost(envelope, candidate, phaseSamples, minPeak);
    if (!scored) continue;

    if (scored.cost < bestCost) {
      bestCost = scored.cost;
      best = { period: candidate, phaseSamples: scored.phaseSamples };
    }
  }

  if (!best) return null;

  // The seed judged on the same objective - anything that cannot beat it is not an improvement.
  const seed = alignmentCost(envelope, period, phaseSamples, minPeak);
  if (!seed || bestCost >= seed.cost) return null;

  return best;
}

/** Mean capped distance from each predicted beat to its nearest real onset */
function alignmentCost(envelope, period, phaseSamples, minPeak) {
  const window = Math.max(1, Math.round(period * ALIGN_MATCH_FRACTION));
  const cap = period * ALIGN_CAP_FRACTION;
  let phase = phaseSamples;
  let matched = [];

  for (let pass = 0; pass < ALIGN_PHASE_PASSES; pass += 1) {
    matched = [];
    for (let k = 0; ; k += 1) {
      const beat = phase + k * period;
      const center = Math.round(beat);
      if (center >= envelope.length) break;

      const lo = Math.max(0, center - window);
      const hi = Math.min(envelope.length - 1, center + window);
      let peak = 0;
      let peakIndex = -1;
      for (let i = lo; i <= hi; i += 1) {
        if (envelope[i] > peak) {
          peak = envelope[i];
          peakIndex = i;
        }
      }
      if (peakIndex < 0 || peak < minPeak) continue;

      matched.push(clusterLeadingEdge(envelope, peakIndex, peak * CLUSTER_FLOOR_RATIO, Math.floor(period / 2)) - beat);
    }

    if (matched.length < MIN_ALIGN_BEATS) return null;

    // Median, not mean - a few beats matched to the wrong transient must not drag the phase.
    const sorted = [...matched].sort((a, b) => a - b);
    phase += sorted[Math.floor(sorted.length / 2)];
  }

  let total = 0;
  for (const offset of matched) total += Math.min(Math.abs(offset), cap);

  return { cost: total / matched.length, phaseSamples: phase };
}
