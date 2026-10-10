import { spawn } from 'node:child_process';
import { prioritizedSpawn } from './process-priority.js';

/** One decode of a track, shared by the waveform and the beat grid. */
export const WAVEFORM_SAMPLE_RATE = 16000;
export const BEATGRID_SAMPLE_RATE = 8000;

const inFlight = new Map();


export function decodeSharedPair(path, { spawnFn = spawn, priority, signal } = {}) {
  let entry = inFlight.get(path);

  if (!entry) {
    const controller = new AbortController();
    entry = { controller, consumers: 0, promise: null };
    entry.promise = runDecode(path, spawnFn, priority, controller.signal)
      .finally(() => { if (inFlight.get(path) === entry) inFlight.delete(path); });
    inFlight.set(path, entry);
  }

  // Refcounted: one consumer giving up (a deck load superseded by a newer one) must not kill a decode the other is still waiting on.
  entry.consumers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.consumers -= 1;
    if (entry.consumers <= 0) entry.controller.abort();
  };
  if (signal) {
    if (signal.aborted) release();
    else signal.addEventListener('abort', release, { once: true });
  }
  const settle = () => {
    if (signal) signal.removeEventListener('abort', release);
    if (!released) { released = true; entry.consumers -= 1; }
  };

  return entry.promise.then(
    (pair) => { settle(); if (signal?.aborted) throw new Error(`decode of ${path} was aborted`); return pair; },
    (err) => { settle(); throw err; },
  );
}

function runDecode(path, spawnFn, priority, signal) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-v', 'error', '-i', path,
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(WAVEFORM_SAMPLE_RATE), '-ac', '1', 'pipe:1',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(BEATGRID_SAMPLE_RATE), '-ac', '1', 'pipe:3',
    ];
    // fd 3 is inherited straight through the nice/ionice/taskset wrappers prioritizedSpawn may add.
    const ffmpeg = prioritizedSpawn(spawnFn, 'ffmpeg', ffmpegArgs, priority, {
      signal,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });

    const wide = [];
    const narrow = [];
    let stderr = '';

    ffmpeg.stdout.on('data', (chunk) => wide.push(chunk));
    ffmpeg.stdio?.[3]?.on('data', (chunk) => narrow.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    ffmpeg.once('error', (err) => reject(err));
    ffmpeg.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code} decoding ${path}: ${stderr.trim()}`));
        return;
      }
      resolve({ pcm16: Buffer.concat(wide), pcm8: Buffer.concat(narrow) });
    });
  });
}


/** In-flight segment decodes, shared by exact slice. */
const segmentsInFlight = new Map();

/** Decodes ONE slice of a track, for building a waveform progressively. */
export function decodeSegmentMono(path, startSeconds, durationSeconds, { spawnFn = spawn, priority, signal } = {}) {
  /** Keyed on the exact arguments, so only genuinely identical work is shared. */
  const key = `${path}\u0000${startSeconds}\u0000${durationSeconds}`;
  const existing = segmentsInFlight.get(key);
  if (existing !== undefined) return existing;

  const promise = decodeSegmentUncached(path, startSeconds, durationSeconds, { spawnFn, priority, signal });
  segmentsInFlight.set(key, promise);
  /* Removed on settle either way - a failure must not be remembered as the answer. */
  promise.then(() => segmentsInFlight.delete(key), () => segmentsInFlight.delete(key));
  return promise;
}

function decodeSegmentUncached(path, startSeconds, durationSeconds, { spawnFn, priority, signal }) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-v', 'error',
      '-ss', String(startSeconds),
      '-t', String(durationSeconds),
      '-i', path,
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(WAVEFORM_SAMPLE_RATE), '-ac', '1', '-',
    ];
    const ffmpeg = prioritizedSpawn(spawnFn, 'ffmpeg', ffmpegArgs, priority, { signal });

    const chunks = [];
    let stderr = '';
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    ffmpeg.once('error', (err) => reject(err));
    ffmpeg.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code} decoding ${startSeconds}s+${durationSeconds}s of ${path}: ${stderr.trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
