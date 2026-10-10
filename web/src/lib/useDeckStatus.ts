import { useEffect, useState } from 'react';
import { useResume } from './useResume';
import type { DeckNumber, DeckStatus } from '../types';

/**
 * How long a stream may say nothing before it is treated as dead.
 *
 * The box sends a status every 50ms per deck, so three seconds of silence is not hesitation. It
 * matters because silence is INVISIBLE from here: the last status just stays on screen, the
 * playhead carries on from it, and a deck doing nothing reads as a deck playing - which is how a
 * box in the field spent an evening claiming deck A was playing a track it had long since stopped
 * reporting on (2026-10-22). An open EventSource is no evidence to the contrary: the socket stays
 * up whether or not anything is coming down it.
 */
const SILENT_MS = 3000;

/** How often to check - a second's granularity on a three-second window. */
const WATCH_MS = 1000;

/** A deck's live status, straight off the box's own SSE stream. */
export function useDeckStatus(deck: DeckNumber, enabled = true) {
  const [status, setStatus] = useState<DeckStatus | null>(null);
  const [connected, setConnected] = useState(false);
  /** True once the stream has gone quiet for longer than a working one ever does. */
  const [stale, setStale] = useState(false);
  /** Bumped to build a new stream: a silent one is replaced rather than waited on. */
  const [attempt, setAttempt] = useState(0);
  /* A stream does not survive the app being suspended, and cannot be trusted to say so. Coming back
     to the foreground rebuilds it rather than waiting three seconds to find out. */
  const resume = useResume();

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(`/decks/${deck}/status/stream`);
    let heardAt = performance.now();

    source.onopen = () => setConnected(true);
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as DeckStatus;
        heardAt = performance.now();
        setStale(false);
        setStatus(next);
      } catch {
        // A malformed frame is not worth tearing the stream down for; the next one will be fine.
      }
    };
    source.onerror = () => setConnected(false);

    const watchdog = setInterval(() => {
      if (performance.now() - heardAt < SILENT_MS) return;
      setStale(true);
      /* Reopening is what the owner's friend did by hand, by closing and reopening the app - and it
         worked. Doing it here means nobody has to know that is the remedy. */
      setAttempt((n) => n + 1);
    }, WATCH_MS);

    return () => {
      clearInterval(watchdog);
      source.close();
    };
  }, [deck, enabled, attempt, resume]);

  return { status, connected, stale };
}
