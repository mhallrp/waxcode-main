#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

/**
 * Measures what the box's passthrough path does to a signal, by comparing two recordings of the
 * same passage: one with the turntable wired straight to the mixer, one with it going through the
 * box. The difference between their spectra IS the correction curve.
 *
 * Why measure rather than calculate: the high-frequency loss on a phono-level deck comes from the
 * ADC not presenting the ~47kOhm a moving-magnet cartridge is specified into, and the resulting
 * response depends on that specific cartridge's inductance and impedance. A formula derived from
 * two datasheets would be right for one cartridge and wrong for everyone else's - and would miss
 * anything else in the path nobody thought to model. This measures the whole difference, for the
 * cartridge actually plugged in.
 *
 * Usage:
 *   node tools/passthrough-response.js <direct.flac> <throughbox.flac>
 *
 * Recording both is easiest with the box's own record input (see server/src/recorder.js):
 *   1. Turntable -> mixer directly.        Play a passage. That capture is `direct`.
 *   2. Turntable -> box -> mixer.          Play the SAME passage. That capture is `throughbox`.
 *
 * The two takes will not align sample for sample, and do not need to - this compares long-term
 * average energy per band over the whole file, which is stable across takes of the same passage
 * provided it runs long enough. Thirty seconds or more of broadband material; a quiet intro or a
 * single sustained note will produce confident nonsense.
 */

const DECODE_RATE = 48000;

/** Third-octave centres from 25Hz up. Fine enough to see the shape of a rolloff, coarse enough to average well. */
const BANDS = [
  31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

/** Mono PCM at DECODE_RATE. Mono because a loading-induced rolloff is common to both channels. */
function decode(path) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-i', path, '-f', 's16le', '-acodec', 'pcm_s16le',
    '-ar', String(DECODE_RATE), '-ac', '1', '-',
  ], { maxBuffer: 1024 * 1024 * 1024 });

  if (result.status !== 0) {
    throw new Error(`ffmpeg failed on ${path}: ${result.stderr?.toString().trim()}`);
  }
  const buf = result.stdout;
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  if (samples.length < DECODE_RATE * 5) {
    throw new Error(`${path} is under 5 seconds - too short to average meaningfully.`);
  }
  return samples;
}

/**
 * Energy at one frequency, via Goertzel over successive blocks.
 *
 * Goertzel rather than a full FFT: we want ~29 known frequencies, not every bin, and this needs no
 * dependency and no power-of-two padding. Blocks are averaged so a loud passage in one take and a
 * quiet one in the other don't skew a single measurement.
 */
function bandEnergy(samples, freq, rate = DECODE_RATE) {
  const blockSize = 8192;
  const k = Math.round((blockSize * freq) / rate);
  const w = (2 * Math.PI * k) / blockSize;
  const coeff = 2 * Math.cos(w);

  let total = 0;
  let blocks = 0;
  for (let start = 0; start + blockSize <= samples.length; start += blockSize) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < blockSize; i++) {
      // Hann window, so energy from neighbouring frequencies doesn't leak into this bin.
      const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (blockSize - 1)));
      const s0 = samples[start + i] * window + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    total += s1 * s1 + s2 * s2 - coeff * s1 * s2;
    blocks++;
  }
  return blocks > 0 ? total / blocks : 0;
}

const [directPath, throughPath] = process.argv.slice(2);
if (!directPath || !throughPath) {
  console.error('Usage: node tools/passthrough-response.js <direct.flac> <throughbox.flac>');
  process.exit(1);
}

const direct = decode(directPath);
const through = decode(throughPath);

const rows = BANDS.map((freq) => {
  const a = bandEnergy(direct, freq);
  const b = bandEnergy(through, freq);
  return { freq, db: a > 0 && b > 0 ? 10 * Math.log10(b / a) : null };
});

// Normalised at 1kHz, so an overall level difference between the two takes - inevitable, since
// nobody re-plays a record at exactly the same gain - doesn't read as a response error.
const reference = rows.find((r) => r.freq === 1000)?.db ?? 0;

console.log(`direct:      ${directPath}`);
console.log(`through box: ${throughPath}`);
console.log(`\n(normalised at 1kHz; negative = the box is losing that band)\n`);
console.log('  freq      diff');
for (const { freq, db } of rows) {
  if (db === null) {
    console.log(`${String(freq).padStart(6)}  ${'no signal'.padStart(9)}`);
    continue;
  }
  const rel = db - reference;
  const bar = '#'.repeat(Math.min(40, Math.max(0, Math.round(20 + rel * 2))));
  console.log(`${String(freq).padStart(6)}  ${rel.toFixed(2).padStart(7)} dB  ${bar}`);
}

const top = rows.filter((r) => r.db !== null && r.freq >= 8000).map((r) => r.db - reference);
if (top.length > 0) {
  const worst = Math.min(...top);
  console.log(`\nWorst loss above 8kHz: ${worst.toFixed(2)} dB`);
  console.log(worst > -1
    ? 'Essentially flat - nothing here worth correcting.'
    : 'Invert this curve to build the correction filter.');
}
