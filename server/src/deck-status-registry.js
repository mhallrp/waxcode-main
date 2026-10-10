import { DeckStatusPoller } from './deck-status-poller.js';

/** One DeckStatusPoller per deck, lazily created and shared across every subscriber regardless of transport (HTTP/SSE) */
export function createDeckStatusRegistry({ deckCount, createPoller = (deckNumber) => new DeckStatusPoller(deckNumber) } = {}) {
  const pollers = new Map();

  function statusPollerFor(deckNumber) {
    if (deckNumber < 1 || deckNumber > deckCount) return null;
    let poller = pollers.get(deckNumber);
    if (!poller) {
      poller = createPoller(deckNumber);
      pollers.set(deckNumber, poller);
    }
    return poller;
  }

  function stopAll() {
    for (const poller of pollers.values()) poller.stop();
  }

  /** A synchronous "is any deck spinning" check, for background work that should wait rather
   * than compete. */
  function anyDeckPlaying() {
    for (const poller of pollers.values()) {
      if (poller.lastStatus?.state === 'PLAYING') return true;
    }
    return false;
  }

  return { statusPollerFor, stopAll, anyDeckPlaying };
}
