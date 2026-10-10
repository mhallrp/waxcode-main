import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { Device } from '../types';

/** The library, fetched once at startup and kept - not fetched when Load Track opens. */

const REMEMBERED = 'waxcode.library';
const SCAN_POLL_MS = 2000;

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
    publish(next);
    remember(next);
    if (next.some((device) => device.scanning)) setTimeout(() => void refresh(), SCAN_POLL_MS);
  } catch {
    // Keep whatever is already shown. A box that answered once is worth more than an empty list.
  }
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
