import { useEffect, useState } from 'react';
import type { DeckSignal } from './signal';

/** Live timecode levels, at the box's own 10Hz. */
export function useSignal(enabled: boolean) {
  const [decks, setDecks] = useState<DeckSignal[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/signal/stream');
    source.onmessage = (event) => {
      try {
        setDecks((JSON.parse(event.data) as { decks: DeckSignal[] }).decks ?? []);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    };
    return () => source.close();
  }, [enabled]);

  return decks;
}
