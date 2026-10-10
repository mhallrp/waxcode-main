import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSamples,
  onsetEnvelope,
  findBestIntegerLag,
  refineTempoViaPulseTrain,
  findBestPhase,
  findNearbyRealOnsetSamples,
  decimateForAnalysis,
} from '../src/beatgrid-autocorrelation.js';

/** A synthetic mono PCM track: silence, with a short percussive "click" (a decaying burst of broadband noise, roughly kick-shaped) at every beat of a given bpm/phase - built directly, no ffmpeg involved, so these tests never shell out and the ground truth is exact by construction. */
function syntheticClickTrack({ bpm, firstBeatSeconds, durationSeconds, sampleRate = 8000, amplitude = 20000, clickMs = 15 }) {
  const totalSamples = Math.floor(durationSeconds * sampleRate);
  const samples = new Int16Array(totalSamples);
  const interval = 60 / bpm;
  const clickSamples = Math.round((clickMs / 1000) * sampleRate);

  let seed = 12345; // deterministic PRNG (mulberry32) - no real randomness needed, just a broadband-ish transient
  function rand() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  for (let beatTime = firstBeatSeconds; beatTime < durationSeconds; beatTime += interval) {
    const startSample = Math.round(beatTime * sampleRate);
    for (let i = 0; i < clickSamples; i++) {
      const idx = startSample + i;
      if (idx < 0 || idx >= totalSamples) continue;
      const decay = 1 - i / clickSamples;
      const noise = (rand() * 2 - 1) * amplitude * decay;
      samples[idx] = Math.max(-32768, Math.min(32767, samples[idx] + noise));
    }
  }
  return samples;
}

test('onsetEnvelope produces near-zero energy during silence and a clear spike at a transient', async () => {
  const sampleRate = 8000;
  const samples = syntheticClickTrack({ bpm: 120, firstBeatSeconds: 1.0, durationSeconds: 3, sampleRate });
  const envelope = await onsetEnvelope(samples, sampleRate, 0.01);

  // Well before the first click (eg. 0.5s in) should be silent/flat.
  const quietFrame = Math.round(0.5 / 0.01);
  assert.ok(envelope[quietFrame] < 1, `expected near-zero onset energy during silence, got ${envelope[quietFrame]}`);

  // Right around the first click (1.0s) should show a real spike.
  const clickFrame = Math.round(1.0 / 0.01);
  const nearClick = Math.max(...envelope.slice(clickFrame - 2, clickFrame + 3));
  assert.ok(nearClick > 50, `expected a clear onset spike near the click, got ${nearClick}`);
});

test('findBestIntegerLag recovers the true period on a synthetic, perfectly periodic envelope', async () => {
  // A hand-built envelope: a triangular pulse every 48 samples (480ms
  // at a 100Hz envelope rate = 125bpm), nothing else - bypasses audio
  // decoding/filtering entirely to isolate just the lag-finding math.
  const period = 48;
  const length = 2000;
  const envelope = new Float64Array(length);
  for (let center = 10; center < length; center += period) {
    for (let d = -3; d <= 3; d++) {
      const i = center + d;
      if (i >= 0 && i < length) envelope[i] = Math.max(envelope[i], 1 - Math.abs(d) / 4);
    }
  }

  const lag = await findBestIntegerLag(envelope, 30, 90);
  assert.equal(lag, period);
});

test('refineTempoViaPulseTrain recovers a true period that falls roughly HALFWAY between two integer envelope hops', async () => {
  // True period 47.6 samples (matches 126.05bpm at a 100Hz envelope
  // rate) - deliberately close to the midpoint between integer lags 47
  // and 48, the exact real-hardware failure case (2026-08-02, "2 Be
  // (Original Mix)": true tempo 126bpm, whole-track self-autocorrelation
  // confidently but wrongly converged on the neighbouring integer lag's
  // own 125.0bpm/127.66bpm bins instead - see this module's git history
  // for the cross-check against Traktor/Beatport that confirmed it).
  // Triangular pulses (not 2-sample-wide point spikes) - a real,
  // lowpassed onset envelope is always this kind of smooth shape, never
  // a bare impulse.
  const truePeriod = 47.6;
  const length = 3000;
  const envelope = new Float64Array(length);
  for (let center = 10; center < length; center += truePeriod) {
    for (let d = -3; d <= 3; d++) {
      const i = Math.round(center) + d;
      if (i >= 0 && i < length) envelope[i] = Math.max(envelope[i], 1 - Math.abs(center - i) / 4);
    }
  }

  const coarseLag = await findBestIntegerLag(envelope, 30, 90);
  const preciseLag = refineTempoViaPulseTrain(envelope, coarseLag);
  // Tight on purpose, unlike the old self-autocorrelation refinement
  // this replaced (which needed a loose 0.5-sample tolerance and could
  // legitimately collapse back onto the plain integer answer) - cross-
  // correlating against a synthetic pulse train at each candidate
  // period is a fundamentally different question from self-similarity,
  // and this tighter tolerance is the whole point of the rewrite: it
  // must NOT converge back onto 47 or 48.
  assert.ok(Math.abs(preciseLag - truePeriod) < 0.15, `expected ~${truePeriod}, got ${preciseLag}`);
});

test('findBestPhase recovers the true phase on a synthetic periodic envelope', () => {
  const period = 48;
  const truePhase = 17; // arbitrary offset within one period
  const length = 2000;
  const envelope = new Float64Array(length);
  for (let center = truePhase; center < length; center += period) {
    for (let d = -3; d <= 3; d++) {
      const i = center + d;
      if (i >= 0 && i < length) envelope[i] = Math.max(envelope[i], 1 - Math.abs(d) / 4);
    }
  }

  const phase = findBestPhase(envelope, period);
  assert.ok(Math.abs(phase - truePhase) < 1, `expected ~${truePhase}, got ${phase}`);
});

test('findNearbyRealOnsetSamples anchors to a transient cluster\'s true START, not its loudest spike - a kick\'s sub-bass body swells louder several hops after its real attack', () => {
  // A realistic kick shape, confirmed on real hardware (owner,
  // 2026-08-02, "2 Be (Original Mix)"): a modest click at the real
  // attack (index 100), a short (3-hop) internal gap as the filtered
  // signal's own low-frequency oscillation dips, then a much LOUDER
  // sub-bass swell (index 104). Naive argmax-picking lands on the
  // louder swell instead of the true, quieter attack - exactly the
  // real-hardware-confirmed failure this function was rewritten to
  // fix (owner: "your algorithm was...a little way into the kick").
  //
  // A single onset at 140 (one period later) is included so this
  // candidate clears the sustained-confirmation gate (see
  // REQUIRED_CONSECUTIVE_CONFIRMATIONS's own doc comment) - the array
  // then ends shortly after, so the remaining required confirmations
  // are satisfied by "ran off the end, trust what's there," not by
  // building out a long, fully-populated track. This test is about
  // clusterLeadingEdge's own attack-vs-swell behaviour, not the
  // sustained-run requirement (see the dedicated test below for that).
  const length = 160;
  const envelope = new Float64Array(length);
  envelope[100] = 300; // the real attack - modest
  // 101-103 near-zero: a short internal gap, bridged (CLUSTER_GAP_SAMPLES)
  envelope[104] = 1000; // the swelled sub-bass body - much louder, but later
  envelope[140] = 1000; // one period later - satisfies the sustained-run check

  const anchor = findNearbyRealOnsetSamples(envelope, 98, 40, 15, 250);
  assert.ok(Math.abs(anchor - 100) < 1, `expected the cluster's true start near 100, got ${anchor}`);
});

test('findNearbyRealOnsetSamples does not bridge past REAL silence into an unrelated earlier blip', () => {
  // See the previous test's own doc comment for why envelope[140] is
  // here (satisfies the sustained-confirmation gate via the "ran off
  // the end" grace, not the specific property under test here).
  const length = 160;
  const envelope = new Float64Array(length);
  envelope[95] = 10; // an earlier, unrelated blip - well under the 5% cluster floor
  envelope[100] = 1000; // the real attack, with a clean gap (96-99) before it
  envelope[140] = 1000; // one period later - satisfies the sustained-run check

  const anchor = findNearbyRealOnsetSamples(envelope, 98, 40, 15, 250);
  assert.ok(Math.abs(anchor - 100) < 1, `expected the real attack at 100, not the unrelated blip at 95, got ${anchor}`);
});

test('findNearbyRealOnsetSamples walks past a silent phase residual to the first real beat, not the empty spot the phase folds into', () => {
  // Phase residual is 10 (well before any real signal); period 40; the
  // actual first real onset is two periods later, at 90 - should walk
  // 10 -> 50 -> 90, not get stuck reporting nothing or anchoring to
  // noise near 10. envelope[130] (one more period on) satisfies the
  // sustained-confirmation gate the same way the tests above do.
  const length = 145;
  const envelope = new Float64Array(length);
  envelope[90] = 1000;
  envelope[130] = 1000;

  const anchor = findNearbyRealOnsetSamples(envelope, 10, 40, 6, 250);
  assert.ok(Math.abs(anchor - 90) < 0.5, `expected the anchor at/just before 90, got ${anchor}`);
});

test('findNearbyRealOnsetSamples skips a sparse, on-grid intro for the first SUSTAINED run - a single early on-grid hit is not enough evidence on its own', () => {
  // Real-hardware regression test (owner, 2026-08-02, "...Anymore
  // (Christopher Rau Remix)"): the track's actual intro has a genuine,
  // ON-GRID bassline hitting 3 of every 4 beats (never more than 3 in
  // a row) for about 7 bars, before the real groove (kick on every
  // beat) begins - the OLD single-candidate-confirmation logic walked
  // straight onto the very first bassline hit and anchored the whole
  // grid several bars early. Modelled here at a period of 40: 3 real
  // onsets then 1 gap, repeated for 3 groups (12 beats, comfortably
  // more than one 8-beat confirmation window's worth), then a fully
  // dense run from beat 12 onward.
  const period = 40;
  const length = period * 26 + 10;
  const envelope = new Float64Array(length);
  for (let k = 0; k < 12; k++) {
    if (k % 4 === 3) continue; // the recurring gap - 3 hits, 1 skip
    envelope[k * period] = 1000;
  }
  for (let k = 12; k < 25; k++) {
    envelope[k * period] = 1000; // the real, unbroken groove
  }

  const anchor = findNearbyRealOnsetSamples(envelope, 0, period, 6, 250);
  // Every sampled beat in the confirmed dense run (12 onward) is an
  // identical, isolated single-sample spike here, so the median across
  // them lands right back on the run's own first beat's own refined
  // position, same as before ANCHOR_SAMPLE_BEATS existed - this test
  // is about skipping the sparse intro entirely, not about the median's
  // own robustness (see the dedicated test below for that).
  const expected = 12 * period;
  assert.ok(Math.abs(anchor - expected) < 1, `expected the anchor at the dense groove's start (${expected}), not the sparse intro's first hit (0), got ${anchor}`);
});

test('findNearbyRealOnsetSamples\'s median resists a single outlier beat, even the confirmed run\'s own first one', () => {
  // Owner's hypothesis (2026-08-02, "...Anymore (Christopher Rau
  // Remix)"): a sustained run's own first beat can still be a
  // transitional/ambiguous one (eg. a bass note that was already
  // playing blurs into the kick's actual attack right as the kick
  // enters). Modelled here: beat 0's own transient has extra bridgeable
  // energy before its peak (envelope[45]=60, above the 5% cluster
  // floor of a 1000 peak) that pulls its OWN refined leading edge
  // noticeably earlier than its true nominal position - the other 7
  // confirmed beats (1-7) are clean, isolated, IDENTICAL single-sample
  // spikes with nothing to bridge, refining consistently among
  // themselves. The median across all 8 must follow that clean
  // majority, not get pulled towards beat 0's own outlying position -
  // this is the actual property that replaced a simpler "always skip
  // N beats" approach, which was tried and rejected after it
  // introduced a ~0.38-beat error on "2 Be (Original Mix)" (this
  // project's most rigorously validated track - see
  // ANCHOR_SAMPLE_BEATS's own doc comment).
  const period = 40;
  const phaseSamples = 50;
  const envelope = new Float64Array(period * 9);
  envelope[45] = 60; // bridgeable pre-energy - pulls beat 0's OWN edge earlier
  envelope[50] = 1000; // beat 0's own peak
  for (let k = 1; k <= 7; k++) envelope[phaseSamples + k * period] = 1000; // clean majority

  const anchor = findNearbyRealOnsetSamples(envelope, phaseSamples, period, 6, 250);
  // The clean majority's own consistent refined position (see the
  // isolated-spike interpolation math in the other tests in this
  // file) - NOT beat 0's own, pulled-earlier position.
  const cleanBeatOwnPosition = phaseSamples - 0.05;
  assert.ok(Math.abs(anchor - cleanBeatOwnPosition) < 0.5, `expected the median to follow the clean majority (~${cleanBeatOwnPosition}), not beat 0's own outlying edge, got ${anchor}`);
});

test('findNearbyRealOnsetSamples still returns a real answer, not garbage, when the track ends shortly after confirming a run as sustained', () => {
  // Just enough real signal (beats 0 and 1) for the "ran off the end,
  // trust what's there" grace to confirm this run as sustained (see
  // findNearbyRealOnsetSamples's own doc comment) - short enough that
  // most of ANCHOR_SAMPLE_BEATS's own sampling window falls past the
  // end of the envelope entirely. The median must still resolve from
  // whatever real samples ARE available (here, just 2), not return
  // null or throw.
  const period = 40;
  const envelope = new Float64Array(45);
  envelope[0] = 1000;
  envelope[40] = 1000;

  const anchor = findNearbyRealOnsetSamples(envelope, 0, period, 6, 250);
  assert.ok(Math.abs(anchor) < 1, `expected a real answer near the run's own first beat (0) from the available samples, got ${anchor}`);
});

test('findNearbyRealOnsetSamples returns null when nothing anywhere clears the threshold', () => {
  const envelope = new Float64Array(300).fill(1); // signal everywhere, but all below the threshold
  const anchor = findNearbyRealOnsetSamples(envelope, 10, 40, 6, 250);
  assert.equal(anchor, null);
});

test('decimateForAnalysis is a no-op (same array, same rate) when already under the cap', () => {
  const samples = new Int16Array([1, 2, 3]);
  const result = decimateForAnalysis(samples, 8000, 10);
  assert.equal(result.samples, samples);
  assert.equal(result.sampleRate, 8000);
});

test('decimateForAnalysis reduces to at most maxSamples and scales the given rate down by the same factor', () => {
  const samples = new Int16Array(1000);
  const result = decimateForAnalysis(samples, 8000, 100);
  assert.ok(result.samples.length <= 100);
  assert.equal(result.sampleRate, 800); // factor = ceil(1000/100) = 10
});

test('analyzeSamples still recovers a correct bpm on an unusually long track - the real OOM crash class this fixes (see waveform.js)', async () => {
  const sampleRate = 8000;
  const trueBpm = 125;
  const trueFirstBeat = 1.234;
  // 21 minutes - just past MAX_ANALYSIS_SAMPLES (20 min), so decimation kicks in with a small,
  // detection-preserving factor (2x) rather than needing a huge, slow-to-generate fixture.
  const samples = syntheticClickTrack({ bpm: trueBpm, firstBeatSeconds: trueFirstBeat, durationSeconds: 21 * 60, sampleRate });

  const grid = await analyzeSamples(samples, sampleRate);
  assert.ok(grid);
  assert.ok(Math.abs(grid.bpm - trueBpm) < 0.5, `expected ~${trueBpm}bpm even after decimation, got ${grid.bpm}`);
});

test('analyzeSamples recovers bpm and firstBeatSeconds on a synthetic click track end to end', async () => {
  const sampleRate = 8000;
  const trueBpm = 125;
  const trueFirstBeat = 1.234;
  const samples = syntheticClickTrack({ bpm: trueBpm, firstBeatSeconds: trueFirstBeat, durationSeconds: 60, sampleRate });

  const grid = await analyzeSamples(samples, sampleRate);
  assert.ok(grid);
  assert.ok(Math.abs(grid.bpm - trueBpm) < 0.1, `expected ~${trueBpm}bpm, got ${grid.bpm}`);
  // firstBeatSeconds is only defined modulo the beat interval - check
  // the nearest true beat, not the literal first one.
  const interval = 60 / trueBpm;
  const nearestN = Math.round((grid.firstBeatSeconds - trueFirstBeat) / interval);
  const nearestTrueBeat = trueFirstBeat + nearestN * interval;
  assert.ok(Math.abs(grid.firstBeatSeconds - nearestTrueBeat) < 0.02, `expected phase near ${nearestTrueBeat}, got ${grid.firstBeatSeconds}`);
});

test('analyzeSamples stays accurate even through a simulated "quiet section" (a breakdown), unlike a causal tracker', async () => {
  const sampleRate = 8000;
  const trueBpm = 128;
  const trueFirstBeat = 0.8;
  const samples = syntheticClickTrack({ bpm: trueBpm, firstBeatSeconds: trueFirstBeat, durationSeconds: 90, sampleRate });

  // Silence out a whole 20-second stretch in the middle - the kick
  // drops out entirely, same as a real breakdown - while every beat
  // OUTSIDE that window keeps its full-strength click.
  const quietStart = Math.floor(35 * sampleRate);
  const quietEnd = Math.floor(55 * sampleRate);
  for (let i = quietStart; i < quietEnd; i++) samples[i] = 0;

  const grid = await analyzeSamples(samples, sampleRate);
  assert.ok(grid);
  // A wider tolerance than the clean end-to-end test above on purpose -
  // losing a real fifth of the track's onset evidence to silence is a
  // genuinely harder case, some real degradation is fair to expect.
  // The point being proven is "still close, no wrong lock" (aubio and
  // BTrack were both off by multiple bpm or more on real tracks with
  // no silent section at all), not perfection despite missing data.
  assert.ok(Math.abs(grid.bpm - trueBpm) < 0.5, `expected close to ${trueBpm}bpm despite the quiet section, got ${grid.bpm}`);
});

test('analyzeSamples returns null for near-silence (not enough signal to trust a grid)', async () => {
  const sampleRate = 8000;
  const samples = new Int16Array(Math.floor(5 * sampleRate)); // all zeros
  const grid = await analyzeSamples(samples, sampleRate);
  assert.equal(grid, null);
});
