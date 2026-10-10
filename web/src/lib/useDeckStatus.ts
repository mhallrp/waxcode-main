import { useEffect, useState } from 'react';
import type { DeckNumber, DeckStatus } from '../types';

/** A deck's live status, straight off the box's own SSE stream. */
export function useDeckStatus(deck: DeckNumber, enabled = true) {
  const [status, setStatus] = useState<DeckStatus | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(`/decks/${deck}/status/stream`);

    source.onopen = () => setConnected(true);
    source.onmessage = (event) => {
      try {
        setStatus(JSON.parse(event.data) as DeckStatus);
      } catch {
        // A malformed frame is not worth tearing the stream down for; the next one will be fine.
      }
    };
    source.onerror = () => setConnected(false);

    return () => source.close();
  }, [deck, enabled]);

  return { status, connected };
}
