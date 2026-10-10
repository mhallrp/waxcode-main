import { createConnection } from 'node:net';
import { deckSocketPath, isDeckServing } from './xwax-status.js';
import { ensureDeckRunning } from './xwax-lifecycle.js';

// A LOAD landing the same instant xwax's single-client control socket is busy with its own real-time thread can transiently fail to connect
const LOAD_RETRY_ATTEMPTS = 5;
const LOAD_RETRY_DELAY_MS = 150;
/** Each retry waits this much longer than the last: 150, 300, 600, 1200ms. */
const LOAD_RETRY_BACKOFF = 2;

/** Sends LOAD <path> to a deck's xwax control socket. */
export async function loadTrack(deckNumber, path, deps = {}) {
  // isDeckServing, not ensureDeckRunning's permissive default: xwax creates its control socket before its control thread serves it
  await ensureDeckRunning(deckNumber, { isReady: isDeckServing, ...deps });
  const { retryAttempts = LOAD_RETRY_ATTEMPTS, retryDelayMs = LOAD_RETRY_DELAY_MS } = deps;

  let lastError;
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    try {
      await sendCommand(deckNumber, `LOAD ${path}`);
      // No relative-mode reapply.
      return;
    } catch (err) {
      lastError = err;
      if (attempt < retryAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * LOAD_RETRY_BACKOFF ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

/** Sends UNLOAD to a deck's xwax control socket, clearing it back to empty. */
export function unloadTrack(deckNumber) {
  return sendCommand(deckNumber, 'UNLOAD');
}

/** True when a command must be dropped because the deck is in passthrough. */
function refusedDuringPassthrough(command, deckNumber, deps) {
  if (!deps.passthrough?.isActive(deckNumber)) return false;
  console.log(`[deck-control] ignoring ${command} for deck ${deckNumber} - passthrough is active`);
  return true;
}

/** Sends RELATIVE ON|OFF to a deck's xwax control socket. */
export async function setRelativeMode(deckNumber, on, deps = {}) {
  deps.relativeModeStore?.set(deckNumber, on);
  if (refusedDuringPassthrough('RELATIVE', deckNumber, deps)) return;
  await ensureDeckRunning(deckNumber, deps);
  return sendCommand(deckNumber, on ? 'RELATIVE ON' : 'RELATIVE OFF');
}

/** Sends KEYLOCK ON|OFF to a deck's xwax control socket */
export async function setKeyLock(deckNumber, on, deps = {}) {
  /** The experiment is off unless somebody opted in. */
  if (on === true && deps.keyLockFeature?.enabled() === false) {
    return { ok: false, reason: 'key-lock-disabled' };
  }
  // Persisted BEFORE sending, so the value survives even if the deck is mid-restart - see deck-key-lock.js.
  deps.keyLockStore?.set(deckNumber, on);
  if (refusedDuringPassthrough('KEYLOCK', deckNumber, deps)) return;
  await ensureDeckRunning(deckNumber, deps);
  return sendCommand(deckNumber, on ? 'KEYLOCK ON' : 'KEYLOCK OFF');
}

/** Sends SEEK <seconds> to a deck's xwax control socket - jumps the playhead and pauses there. Backs tap-to-seek/drag on the app's waveform, relative mode only. */
export function seek(deckNumber, seconds) {
  return sendCommand(deckNumber, `SEEK ${seconds}`);
}

/** Sends RELOCATE <seconds> to a deck's xwax control socket - jumps the playhead WITHOUT pausing (unlike seek, whatever's currently playing/paused keeps holding). Used to keep a shrunk loop's position inside its own new bounds without interrupting playback. */
export function relocate(deckNumber, seconds) {
  return sendCommand(deckNumber, `RELOCATE ${seconds}`);
}

/** Sends TIMECODE <name> - points a RUNNING deck at a different timecode definition. */
export function setTimecode(deckNumber, name) {
  return sendCommand(deckNumber, `TIMECODE ${name}`);
}

/** Sends SET_CUE <seconds> to a deck's xwax control socket - stores an explicit cue point. App snaps to the nearest beat-grid tick before calling this. */
export function setCue(deckNumber, seconds) {
  return sendCommand(deckNumber, `SET_CUE ${seconds}`);
}

/** Sends GOTO_CUE to a deck's xwax control socket - jumps to the stored cue point and pauses. Replaces the old cueToStart (jump to track start). */
export function gotoCue(deckNumber) {
  return sendCommand(deckNumber, 'GOTO_CUE');
}

/** Sends PLAY_CUE to a deck's xwax control socket - jumps to the cue point and starts real digital playback immediately, even with the needle up. */
export function playCue(deckNumber) {
  return sendCommand(deckNumber, 'PLAY_CUE');
}

/** Sends PLAY to a deck's xwax control socket - resumes digital playback from wherever the deck already is, no jump (unlike playCue, not tied to the cue point). */
export function play(deckNumber) {
  return sendCommand(deckNumber, 'PLAY');
}

/** Sends PAUSE to a deck's xwax control socket - pauses at wherever the deck already is, no jump. */
export function pause(deckNumber) {
  return sendCommand(deckNumber, 'PAUSE');
}

/** Sets how much noise the deck's timecoder ignores before reading a wave at all. */
export function setSensitivity(deckNumber, level) {
  sendCommand(deckNumber, `SENSITIVITY ${level}`);
}

/** Sends LOOP <start> <end> - loops [start, end) seconds. Only applied in relative mode. */
export function setLoop(deckNumber, startSeconds, endSeconds) {
  return sendCommand(deckNumber, `LOOP ${startSeconds} ${endSeconds}`);
}

/** Sends LOOP OFF to a deck's xwax control socket - stops looping, playback continues from wherever the loop currently is, no jump (see xwax/control.h's own doc comment). */
export function clearLoop(deckNumber) {
  return sendCommand(deckNumber, 'LOOP OFF');
}

/** The protocol has no application-level acknowledgement for either command (see loadTrack's own doc comment) - "success" just means the socket accepted the write. */
function sendCommand(deckNumber, command) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(deckSocketPath(deckNumber));

    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.end(`${command}\n`);
    });
    socket.once('close', () => resolve());
    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`timed out connecting to deck ${deckNumber}'s control socket`));
    });
  });
}
