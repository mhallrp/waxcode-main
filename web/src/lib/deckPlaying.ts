import { useSyncExternalStore } from 'react';
import type { DeckNumber } from '../types';

/** Which decks are playing, readable from anywhere without opening a second status stream. */
const playing: Record<number, boolean> = {};
const listeners = new Set<() => void>();

export function setDeckPlaying(deck: DeckNumber, value: boolean) {
  if (playing[deck] === value) return; // no wake-up for a status that says what the last one did
  playing[deck] = value;
  for (const listener of listeners) listener();
}

/** Outside React, for a load handler that only needs the answer at the moment of the tap. */
export function isDeckPlaying(deck: DeckNumber) {
  return playing[deck] === true;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useDeckPlaying(deck: DeckNumber) {
  return useSyncExternalStore(subscribe, () => playing[deck] === true, () => false);
}
