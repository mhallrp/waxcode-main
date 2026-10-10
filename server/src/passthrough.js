import { spawn } from 'node:child_process';
import { PHONO } from './deck-input-mode.js';

/** Logs a child process's stdout/stderr line by line - previously piped but never read, so every real failure was silently discarded. */
function logEngineOutput(deckNumber, engine, streamName, stream) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) console.log(`[passthrough] deck ${deckNumber} ${engine} (${streamName}): ${line}`);
    }
  });
}

/** Per-deck ALSA device names for passthrough (pi/asound.conf) - route through the same dmix/dsnoop layers xwax sits on, multi-client-safe. */
export function passthroughDeviceNames(deckNumber, { phono = false } = {}) {
  return {
    capture: `dvs_deck${deckNumber}_capture`,
    playback: `dvs_deck${deckNumber}_${phono ? 'phono' : 'line'}`,
  };
}

// alsaloop can crash outright on simultaneous ALSA overrun events on both decks - a real bug in its own xrun-recovery code.

// Delay before auto-restarting a crashed alsaloop - gives the ALSA/DMA layer real recovery time rather than hammering straight back in.
const UNEXPECTED_EXIT_RESTART_DELAY_MS = 1500;

// Give up after this many crashes in a row without a stable run - surfaces as isActive going false, not an infinite crash loop.
const MAX_CONSECUTIVE_RESTARTS = 3;

// A restart running this long counts as "stable" and resets the consecutive-crash counter.
const STABLE_RUN_MS = 5000;

/** Four peaking biquads that undo what this box does to a phono-level signal, applied only on a deck set to phono. */
const PHONO_CORRECTION = [
  'equalizer', '5250', '0.497q', '-1.85',
  'equalizer', '5710', '3.363q', '7.85',
  'equalizer', '9147', '1.005q', '11.61',
  'equalizer', '12461', '1.228q', '13.39',
];

/** sox rather than ffmpeg for the corrected path, despite ffmpeg already being a dependency here: sox takes an explicit buffer size */
const SOX_BUFFER_BYTES = 2048 * 2 * 4;

/** The unfiltered path is left exactly as it was - a line-level deck is already correct, and this is the path in daily use. */
function passthroughCommand({ capture, playback, phono }) {
  if (!phono) {
    // -l is alsaloop's requested latency IN FRAMES, not -t/--tlatency (microseconds).
    return ['alsaloop', ['-C', capture, '-P', playback, '-l', '2048']];
  }
  return ['sox', [
    '-q', '--buffer', String(SOX_BUFFER_BYTES),
    '-t', 'alsa', capture,
    '-t', 'alsa', playback,
    ...PHONO_CORRECTION,
  ]];
}

/** Manages one alsaloop child process per deck, forwarding a deck's ALSA capture route to its playback route for real-vinyl passthrough. */
export class PassthroughManager {
  #processes = new Map();
  #spawnFn;
  #deckInputMode;
  #restartDelayMs;
  #maxConsecutiveRestarts;
  #stableRunMs;
  #consecutiveRestarts = new Map();
  #restartTimers = new Map();

  constructor({
    spawnFn = spawn,
    deckInputMode = null,
    restartDelayMs = UNEXPECTED_EXIT_RESTART_DELAY_MS,
    maxConsecutiveRestarts = MAX_CONSECUTIVE_RESTARTS,
    stableRunMs = STABLE_RUN_MS,
    /** Called with a deck number whenever its passthrough state changes, including when alsaloop exits on its own. */
    onChange = null,
  } = {}) {
    this.#onChange = onChange;
    this.#spawnFn = spawnFn;
    this.#deckInputMode = deckInputMode;
    this.#restartDelayMs = restartDelayMs;
    this.#maxConsecutiveRestarts = maxConsecutiveRestarts;
    this.#stableRunMs = stableRunMs;
  }

  #onChange;
  /** Decks the DJ deliberately put into passthrough, as opposed to ones where alsaloop is simply idling because nothing is loaded. */
  #requested = new Set();

  /** True only where passthrough is both running AND asked for - what the app's toggle reflects. */
  isRequested(deckNumber) {
    return this.#requested.has(deckNumber) && this.#processes.has(deckNumber);
  }

  /** Marks a deck as deliberately in passthrough, or not. Does not start or stop anything. */
  setRequested(deckNumber, requested) {
    if (requested) this.#requested.add(deckNumber);
    else this.#requested.delete(deckNumber);
    this.#onChange?.(deckNumber);
  }

  /** Whether alsaloop is actually running - the raw fact, used for lifecycle decisions. */
  isActive(deckNumber) {
    return this.#processes.has(deckNumber);
  }

  /** Starts passthrough for a deck; no-op if already running. Always resets the consecutive-crash counter and cancels any pending auto-restart. */
  start(deckNumber) {
    if (this.#processes.has(deckNumber)) return;
    this.#cancelPendingRestart(deckNumber);
    this.#consecutiveRestarts.delete(deckNumber);
    this.#spawnEngine(deckNumber);
  }

  #spawnEngine(deckNumber) {
    // Read at spawn time, not cached: a deck stopped by an input-mode change picks up the new engine on its next start
    const phono = this.#deckInputMode?.get() === PHONO;
    const { capture, playback } = passthroughDeviceNames(deckNumber, { phono });
    const [command, args] = passthroughCommand({ capture, playback, phono });
    const child = this.#spawnFn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logEngineOutput(deckNumber, command, 'stdout', child.stdout);
    logEngineOutput(deckNumber, command, 'stderr', child.stderr);
    const startedAt = Date.now();
    const onGone = (logLine) => {
      console.log(logLine);
      // stop removes the map entry before killing the child, so a still-matching entry here means an unexpected exit, not a deliberate stop.
      if (this.#processes.get(deckNumber) !== child) return;
      this.#processes.delete(deckNumber);
      this.#onChange?.(deckNumber);
      this.#handleUnexpectedExit(deckNumber, startedAt);
    };
    child.on('exit', (code, signal) => {
      onGone(`[passthrough] deck ${deckNumber} ${command} exited (code=${code}, signal=${signal})`);
    });
    child.on('error', (err) => {
      onGone(`[passthrough] deck ${deckNumber} ${command} failed to start: ${err.message}`);
    });
    this.#processes.set(deckNumber, child);
    this.#onChange?.(deckNumber);
    console.log(`[passthrough] deck ${deckNumber} started via ${command} (${capture} -> ${playback}${phono ? ', phono correction applied' : ''})`);
  }

  #handleUnexpectedExit(deckNumber, startedAt) {
    const ranFor = Date.now() - startedAt;
    const priorCount = this.#consecutiveRestarts.get(deckNumber) ?? 0;
    const count = ranFor >= this.#stableRunMs ? 1 : priorCount + 1;

    if (count > this.#maxConsecutiveRestarts) {
      console.log(`[passthrough] deck ${deckNumber} passthrough crashed ${count} times in a row without a stable run - giving up, staying stopped`);
      this.#consecutiveRestarts.delete(deckNumber);
      return;
    }

    this.#consecutiveRestarts.set(deckNumber, count);
    console.log(`[passthrough] deck ${deckNumber} passthrough exited unexpectedly after ${ranFor}ms - restarting in ${this.#restartDelayMs}ms (attempt ${count}/${this.#maxConsecutiveRestarts})`);
    const timer = setTimeout(() => {
      this.#restartTimers.delete(deckNumber);
      this.#spawnEngine(deckNumber);
    }, this.#restartDelayMs);
    this.#restartTimers.set(deckNumber, timer);
  }

  #cancelPendingRestart(deckNumber) {
    const timer = this.#restartTimers.get(deckNumber);
    if (!timer) return;
    clearTimeout(timer);
    this.#restartTimers.delete(deckNumber);
  }

  /** Stops passthrough for a deck; no-op if nothing running or pending. Also cancels any auto-restart scheduled after a crash. */
  stop(deckNumber) {
    this.#cancelPendingRestart(deckNumber);
    this.#consecutiveRestarts.delete(deckNumber);
    const child = this.#processes.get(deckNumber);
    if (!child) return;
    this.#processes.delete(deckNumber);
    this.#onChange?.(deckNumber);
    child.kill('SIGTERM');
    console.log(`[passthrough] deck ${deckNumber} stopped`);
  }

  /** Stops every running passthrough loop - used on server shutdown. */
  stopAll() {
    for (const deckNumber of Array.from(this.#processes.keys())) this.stop(deckNumber);
    for (const deckNumber of Array.from(this.#restartTimers.keys())) this.stop(deckNumber);
  }
}
