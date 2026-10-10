import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';
import { deckSocketPath } from './xwax-status.js';

const POLL_INTERVAL_MS = 50;
const RECONNECT_DELAY_MS = 200;

// <path> is optional (absent for EMPTY) and greedy to end-of-line - a path can contain spaces but never a newline.
const SIGNAL_LINE = /^SIGNAL (-?\d+) (-?\d+) (-?\d+) (\d+) (\d+) (0|1) (0|1)(?: (-?\d+))?(?: (\d+))?$/;
const SIGNAL_TIMEOUT_MS = 400;

// Trailing fields are optional, each added at a different time
const STATUS_LINE = /^STATUS (EMPTY|IMPORTING|PLAYING|STOPPED) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (0|1) (-?\d+(?:\.\d+)?) (0|1) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)(?: (-?\d+(?:\.\d+)?))?(?: (0|1))?(?: (-?\d+(?:\.\d+)?))?(?: (0|1))?(?: (\/.+))?$/;

/** Keeps one persistent connection open to a deck's xwax control socket */
export class DeckStatusPoller {
  #deckNumber;
  #listeners = new Set();
  #socket = null;
  #buf = '';
  #pollTimer = null;
  #reconnectTimer = null;
  #stopped = true;
  #lastStatus = null;
  #signalWaiters = [];

  constructor(deckNumber) {
    this.#deckNumber = deckNumber;
  }

  /** Returns an unsubscribe function, so callers don't need to keep the listener reference around separately. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get listenerCount() {
    return this.#listeners.size;
  }

  /** Most recently parsed STATUS reply, or null before the first arrives - a synchronous snapshot, only as fresh as the last poll tick. */
  get lastStatus() {
    return this.#lastStatus;
  }

  /** Declare the deck stopped: forget the cached status and tell subscribers it is empty. */
  markStopped() {
    this.#lastStatus = null;
    const empty = {
      state: 'EMPTY',
      remain: 0,
      pitch: 0,
      relative: false,
      cuePoint: 0,
      loopActive: false,
      loopStart: 0,
      loopEnd: 0,
      // null is "unknown", which is the honest answer once the process reporting them is gone.
      elapsed: null,
      timecodeValid: null,
      unreadableSeconds: null,
      keyLock: null,
      path: null,
    };
    for (const listener of this.#listeners) listener(empty);
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    this.#socket?.destroy();
    this.#socket = null;
    this.#failSignalWaiters(new Error('deck control socket stopped'));
  }

  /** Asks xwax for one SIGNAL reply on the poller's OWN connection. */
  requestSignal() {
    const socket = this.#socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('deck control socket not connected'));

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        this.#signalWaiters = this.#signalWaiters.filter((w) => w !== waiter);
        reject(new Error('SIGNAL timed out'));
      }, SIGNAL_TIMEOUT_MS);
      this.#signalWaiters.push(waiter);
      socket.write('SIGNAL\n');
    });
  }

  #failSignalWaiters(error) {
    const waiters = this.#signalWaiters;
    this.#signalWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #connect() {
    if (this.#stopped) return;

    const socket = createConnection(deckSocketPath(this.#deckNumber));
    this.#socket = socket;
    this.#buf = '';

    socket.once('connect', () => {
      socket.write('STATUS\n');
      this.#pollTimer = setInterval(() => {
        if (!socket.destroyed) socket.write('STATUS\n');
      }, POLL_INTERVAL_MS);
    });

    socket.on('data', (chunk) => this.#handleData(chunk));

    // Only 'close' drives reconnection - it always fires exactly once per socket.
    socket.on('error', () => {});
    socket.once('close', () => {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
      if (this.#socket === socket) this.#socket = null;
      this.#failSignalWaiters(new Error('deck control socket closed'));
      if (!this.#stopped) {
        this.#reconnectTimer = setTimeout(() => this.#connect(), RECONNECT_DELAY_MS);
      }
    });
  }

  #handleData(chunk) {
    this.#buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      this.#handleLine(line);
    }
  }

  /** Resolves the OLDEST pending waiter: xwax answers in the order it was asked, on one stream. */
  #handleSignalLine(line) {
    const match = SIGNAL_LINE.exec(line);
    if (!match) return;
    const waiter = this.#signalWaiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve({
      peakLeft: Number(match[1]),
      peakRight: Number(match[2]),
      refLevel: Number(match[3]),
      validCounter: Number(match[4]),
      ticker: Number(match[5]),
      forwards: match[6] === '1',
      safe: match[7] === '1',
      threshold: match[8] === undefined ? null : Number(match[8]),
      sensitivity: match[9] === undefined ? null : Number(match[9]),
    });
  }

  #handleLine(line) {
    if (line.startsWith('SIGNAL ')) {
      this.#handleSignalLine(line);
      return;
    }
    const match = STATUS_LINE.exec(line);
    if (!match) return;
    // path lets a client recover "what's loaded" after its own restart.
    const status = {
      /** WHEN THIS WAS READ, on the box's own clock - not when something later got round to sending it on. */
      at: Number(performance.now().toFixed(3)),
      state: match[1],
      remain: Number(match[2]),
      pitch: Number(match[3]),
      relative: match[4] === '1',
      cuePoint: Number(match[5]),
      loopActive: match[6] === '1',
      loopStart: Number(match[7]),
      loopEnd: Number(match[8]),
      // Position straight off the timecode, valid even mid-import when `remain` is not - see the IMPORTING branch in the fork's control.c.
      elapsed: match[9] === undefined ? null : Number(match[9]),
      // Needle down and reading a locked position - NOT the same as pitch != 0, which is also false when paused.
      timecodeValid: match[10] === undefined ? null : match[10] === '1',
      // Seconds the platter has been turning without a decodable position - see the fork's player.h.
      unreadableSeconds: match[11] === undefined ? null : Number(match[11]),
      // Key lock (master tempo), read back rather than assumed.
      keyLock: match[12] === undefined ? null : match[12] === '1',
      path: match[13] ?? null,
    };
    this.#lastStatus = status;
    for (const listener of this.#listeners) listener(status);
  }
}
