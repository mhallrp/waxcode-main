import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { Device } from '../types';

/** The library, fetched once at startup and kept - not fetched when Load Track opens. */

const REMEMBERED = 'waxcode.library';
const SCAN_POLL_MS = 2000;
/** While somebody is looking at the library. A stick can be pushed in at any moment, and nothing
 *  on the box tells a browser about it - the scan poll below only runs once a device is ALREADY
 *  known and scanning, so an empty box stayed empty until the app was restarted. */
const WATCH_POLL_MS = 4000;

let devices: Device[] | null = null;
const listeners = new Set<() => void>();

function publish(next: Device[]) {
  devices = next;
  for (const listener of listeners) listener();
}

/** Whatever was there last time. Wrapped because a private window throws rather than returning null. */
function recall(): Device[] | null {
  try {
    const raw = localStorage.getItem(REMEMBERED);
    return raw ? (JSON.parse(raw) as Device[]) : null;
  } catch {
    return null;
  }
}

function remember(next: Device[]) {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(next));
  } catch {
    // Full, or private. The library still works; it just will not be instant next launch.
  }
}

let started = false;

/** Called once, from the app shell. Safe to call again - the second call does nothing. */
export function startLibrary() {
  if (started) return;
  started = true;

  const remembered = recall();
  if (remembered?.length) publish(remembered);

  void refresh();
}

/** Reads the library, and keeps reading while anything is still scanning. */
async function refresh(): Promise<void> {
  try {
    const next = (await api.library()).devices ?? [];
    /* Only when something actually changed. The watch poll below runs every few seconds while the
       library is open, and publishing an identical list still re-renders every row - which read as
       the track list flashing on its own (owner, 2026-10-16). */
    if (JSON.stringify(next) !== JSON.stringify(devices)) {
      publish(next);
      remember(next);
    }
    if (next.some((device) => device.scanning)) setTimeout(() => void refresh(), SCAN_POLL_MS);
  } catch {
    // Keep whatever is already shown. A box that answered once is worth more than an empty list.
  }
}

let watchers = 0;
let watchTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Keeps the library fresh while a screen is showing it. Returns the stop function, so it drops
 * straight into a useEffect. Reference-counted: two screens watching cost one poll, and the timer
 * stops when the last one goes away.
 */
export function watchLibrary(): () => void {
  watchers += 1;
  if (watchTimer === null) watchTimer = setInterval(() => void refresh(), WATCH_POLL_MS);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers -= 1;
    if (watchers === 0 && watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  };
}

/** Forces a re-read - after a stick is inserted, after writing to one, or when somebody asks. */
export function refreshLibrary(afterMs = 0) {
  if (afterMs > 0) setTimeout(() => void refresh(), afterMs);
  else void refresh();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useLibrary(): Device[] | null {
  return useSyncExternalStore(subscribe, () => devices, () => devices);
}
