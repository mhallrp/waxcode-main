import type { DeckNumber } from '../types';

/** Where each deck's library browser was last left, so reopening Load Track picks up where you were rather than back at the root. */
export interface LastFolder {
  deviceId: string;
  path: string[];
}

const locations = new Map<DeckNumber, LastFolder>();

export function recallFolder(deck: DeckNumber): LastFolder | null {
  return locations.get(deck) ?? null;
}

export function rememberFolder(deck: DeckNumber, value: LastFolder): void {
  locations.set(deck, value);
}
