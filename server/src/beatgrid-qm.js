import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeSharedPair, BEATGRID_SAMPLE_RATE } from './shared-decode.js';
import { readTaggedBpm, correctMetricLevel } from './beatgrid-tag.js';
import { prioritizedSpawn } from './process-priority.js';
import { analyzePhaseAtTempo, pcmToInt16Array } from './beatgrid-autocorrelation.js';
import { refineBpmAgainstOnsets } from './beatgrid-refine.js';

/** Tempo from Queen Mary's beat tracker, phase from this project's own onset alignment. */

/** Where to find the helper, in order of preference. */
const QMTEMPO_CANDIDATES = [
  process.env.PIDVS_QMTEMPO,
  fileURLToPath(new URL('../qmtempo/bin/qmtempo', import.meta.url)),
  '/usr/local/bin/qmtempo',
].filter(Boolean);

function qmtempoPath() {
  return QMTEMPO_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** Fed at the 8kHz rate the shared decode already produces, NOT at 44.1kHz. */
export function computeBeatGridViaQm(path, { spawnFn = spawn, priority, signal, readTaggedBpmFn = readTaggedBpm } = {}) {
  const decoded = decodeSharedPair(path, { spawnFn, priority, signal }).then(({ pcm8 }) => pcm8);
  const tagged = readTaggedBpmFn(path).catch(() => null);

  return Promise.all([decoded, tagged]).then(async ([pcm, tagBpm]) => {
    const int16 = pcmToInt16Array(pcm);
    if (int16.length < BEATGRID_SAMPLE_RATE * 10) return null;

    const tempo = await runQmtempo(int16ToFloat32(int16), BEATGRID_SAMPLE_RATE, { spawnFn, priority, signal });
    if (tempo === null) return null;

    /** Polish the tempo against the track's own kicks before anything else uses it. */
    const refined = refineBpmAgainstOnsets(int16, BEATGRID_SAMPLE_RATE, tempo.bpm);

    // A tag can still settle which metric level we landed on
    const metric = correctMetricLevel(refined, tagBpm);
    const bpm = metric.bpm;
    if (!(bpm > 0)) return null;

    const firstBeatSeconds = await analyzePhaseAtTempo(int16, BEATGRID_SAMPLE_RATE, bpm);
    // Phase analysis returning null means the track had no usable onsets
    return { bpm, firstBeatSeconds: firstBeatSeconds ?? tempo.firstBeatSeconds };
  });
}

/** The helper wants float32 in [-1, 1). */
function int16ToFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

/** Spawns the helper, writes the samples to it, and parses its one line of output. */
function runQmtempo(samples, sampleRate, { spawnFn, priority, signal }) {
  return new Promise((resolve) => {
    const bin = qmtempoPath();
    if (bin === null) return resolve(null);

    let child;
    try {
      child = prioritizedSpawn(spawnFn, bin, [String(sampleRate)], priority, signal ? { signal } : {});
    } catch {
      return resolve(null);
    }

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdout.on('error', () => {});
    // EPIPE if the helper exits early (too short, no beats) - it has already said why on stderr.
    child.stdin.on('error', () => {});
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const parts = out.trim().split(/\s+/);
      const bpm = Number(parts[1]);          // long-baseline fit, not the median of intervals
      const firstBeat = Number(parts[2]);
      if (!Number.isFinite(bpm) || bpm <= 0) return resolve(null);
      resolve({ bpm, firstBeatSeconds: Number.isFinite(firstBeat) ? firstBeat : 0 });
    });

    child.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  });
}
