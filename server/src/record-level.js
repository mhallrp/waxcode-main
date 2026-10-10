import { spawn } from 'node:child_process';
import { RECORD_DEVICE } from './recorder.js';

/** Live level of the record input, so somebody can see a signal arriving before they commit to a take. */

/** 16-bit signed, so this is what a sample of 1.0 would be. */
const FULL_SCALE = 32768;

/** Interleaved stereo S16_LE, matching the arecord invocation below. */
const BYTES_PER_FRAME = 4;

/** Peak of each channel in a raw buffer, 0..1. */
export function peakFromPcm(buffer) {
  let left = 0;
  let right = 0;
  const frames = Math.floor(buffer.length / BYTES_PER_FRAME);
  for (let frame = 0; frame < frames; frame++) {
    const at = frame * BYTES_PER_FRAME;
    const l = Math.abs(buffer.readInt16LE(at));
    const r = Math.abs(buffer.readInt16LE(at + 2));
    if (l > left) left = l;
    if (r > right) right = r;
  }
  return { left: left / FULL_SCALE, right: right / FULL_SCALE };
}

/** How often a reading is published. Fast enough to read as live, slow enough to be nothing. */
const PUBLISH_MS = 100;

/** Starts capturing on the first subscriber and stops on the last. */
export function createRecordLevel({
  device = RECORD_DEVICE,
  spawnFn = spawn,
  publishMs = PUBLISH_MS,
  log = (message) => console.log(`[record-level] ${message}`),
} = {}) {
  const listeners = new Set();
  let proc = null;
  let timer = null;
  /** Held BETWEEN publishes, not per chunk: a peak that only survived one buffer would be missed entirely at 10Hz */
  let pending = { left: 0, right: 0 };

  function start() {
    if (proc) return;
    proc = spawnFn('arecord', [
      '-D', device, '-f', 'S16_LE', '-r', '48000', '-c', '2', '-t', 'raw', '-q',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout?.on('data', (chunk) => {
      const peak = peakFromPcm(chunk);
      if (peak.left > pending.left) pending.left = peak.left;
      if (peak.right > pending.right) pending.right = peak.right;
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.once('error', (err) => { log(`could not start: ${err.message}`); proc = null; });
    proc.once('close', (code) => {
      // Only worth saying when it was not us closing it - a stop kills this deliberately.
      if (proc !== null && code !== 0) log(`arecord exited ${code}: ${stderr.trim().slice(0, 200)}`);
      proc = null;
    });

    timer = setInterval(() => {
      const reading = pending;
      pending = { left: 0, right: 0 };
      for (const listener of listeners) listener(reading);
    }, publishMs);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    const running = proc;
    proc = null;
    running?.kill('SIGTERM');
    pending = { left: 0, right: 0 };
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    get listenerCount() { return listeners.size; },
  };
}
