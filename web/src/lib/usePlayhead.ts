import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeckStatus } from '../types';
import { createBoxClock } from './boxClock';

/** How long a deliberate jump outranks a disagreeing status - comfortably over one status interval. */
const JUMP_GRACE_MS = 1500;
/** Near enough that the box is reporting the jump rather than the position before it. */
const JUMP_TOLERANCE_SECONDS = 0.35;

/** Where the playhead is right now, between status updates. */
export function usePlayhead(status: DeckStatus | null, duration: number | null) {
  const [position, setPosition] = useState(0);
  const anchor = useRef({ at: 0, seconds: 0, pitch: 0 });
  /** Per deck, and never reset: it only gets better the longer it runs */
  const clock = useRef(createBoxClock());
  /** A deliberate jump the box has not caught up with yet. */
  const pinned = useRef<{ seconds: number; pitch: number; at: number } | null>(null);

  /** Move the playhead NOW, for an action whose result the client already knows. */
  const anchorTo = useCallback((seconds: number, pitch: number) => {
    anchor.current = { at: performance.now(), seconds, pitch };
    pinned.current = { seconds, pitch, at: performance.now() };
    setPosition(seconds);
  }, []);

  // A new STATUS is the truth: re-anchor to it rather than drifting on from a prediction.
  useEffect(() => {
    if (!status) return;
    const elapsed = status.elapsed ?? (duration !== null ? duration - status.remain : 0);
    const seconds = Number.isFinite(elapsed) ? elapsed : 0;

    /** When the box took this reading, in local terms. */
    const measuredAt = clock.current.localTimeOf(status.sentAt, performance.now());

    const pin = pinned.current;
    if (pin) {
      const age = measuredAt - pin.at;
      // Where the jump should have reached by now, if the box did what it was asked.
      const expected = pin.seconds + (pin.pitch * age) / 1000;
      if (Math.abs(seconds - expected) < JUMP_TOLERANCE_SECONDS) {
        pinned.current = null; // the box agrees - hand back to it
      } else if (age < JUMP_GRACE_MS) {
        return; // stale, from before the jump landed. Ignore it rather than snapping backwards.
      } else {
        pinned.current = null; // no agreement is coming; the box wins rather than the guess
      }
    }

    const pitch = status.state === 'PLAYING' ? status.pitch : 0;
    anchor.current = { at: measuredAt, seconds, pitch };
    /** Published immediately, not left to the next animation frame. */
    setPosition(seconds + (pitch * (performance.now() - measuredAt)) / 1000);
  }, [status, duration]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const { at, seconds, pitch } = anchor.current;
      const predicted = at === 0 ? 0 : seconds + ((performance.now() - at) / 1000) * pitch;
      /** NOT floored at zero. */
      setPosition(predicted);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return { position, anchorTo };
}
