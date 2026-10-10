import { writeFileSync } from 'node:fs';
import { cablePresentSince } from './cable-presence.js';

const LED_TRIGGER_PATH = '/sys/class/leds/ACT/trigger';
const LED_DELAY_ON_PATH = '/sys/class/leds/ACT/delay_on';
const LED_DELAY_OFF_PATH = '/sys/class/leds/ACT/delay_off';

// Three rates, far enough apart to tell at a glance. 300ms is the boot blink in pi/led-booting.sh.
const CABLE_BLINK_MS = 150;          // a cable is in: setup mode
const SETUP_NETWORK_BLINK_MS = 900;  // offering its own network, nothing attached

// The udev chmod lands within a few ms of the trigger change; these bound the wait for it.
const LED_DELAY_WRITE_ATTEMPTS = 5;
const LED_DELAY_RETRY_MS = 20;

/** Retries a udev permissions race; on failure restores the trigger, since a half-set blink lies. */
function setBlink(delayMs, writeFn) {
  writeFn(LED_TRIGGER_PATH, 'timer');
  for (let attempt = 0; attempt < LED_DELAY_WRITE_ATTEMPTS; attempt++) {
    try {
      writeFn(LED_DELAY_ON_PATH, String(delayMs));
      writeFn(LED_DELAY_OFF_PATH, String(delayMs));
      return;
    } catch (err) {
      if (attempt === LED_DELAY_WRITE_ATTEMPTS - 1) {
        try { writeFn(LED_TRIGGER_PATH, 'mmc0'); } catch { /* nothing left to try */ }
        throw err;
      }
      sleepSync(LED_DELAY_RETRY_MS);
    }
  }
}

/** Deliberately blocking: this runs on a slow poll tick, and the wait is a few milliseconds. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Reverts the ACT LED from its boot-time blink (pi/led-booting.sh) back to its stock mmc0 trigger */
export function markReady({ writeFn = writeFileSync } = {}) {
  try {
    writeFn(LED_TRIGGER_PATH, 'mmc0');
  } catch (err) {
    console.log(`[led-status] couldn't revert ACT LED to ready state: ${err.message}`);
  }
}

/** Keeps the ACT LED showing what the box is doing: cable in, offering its network, or idle. */
export function startLedStatusLoop({
  cablePresentSince: cablePresentSinceFn = cablePresentSince,
  // null means "no opinion", not "not broadcasting".
  wifiMode = null,
  writeFn = writeFileSync,
  pollIntervalMs = 1000,
}) {
  let lastState = null;

  function tick() {
    /** Cable first: a cable raises the AP too, and the fast blink already says "you plugged something in". */
    const state = cablePresentSinceFn() !== null ? 'cable-in'
      : wifiMode?.isApUp() ? 'setup-network'
      : 'ready';
    if (state === lastState) return;
    try {
      if (state === 'cable-in') setBlink(CABLE_BLINK_MS, writeFn);
      else if (state === 'setup-network') setBlink(SETUP_NETWORK_BLINK_MS, writeFn);
      else writeFn(LED_TRIGGER_PATH, 'mmc0');
      // Only on success: a failed write must be retried next tick, not recorded as done.
      lastState = state;
    } catch (err) {
      console.log(`[led-status] couldn't update ACT LED for state "${state}": ${err.message}`);
    }
  }

  tick();
  const timer = setInterval(tick, pollIntervalMs);
  return { stop: () => clearInterval(timer) };
}
