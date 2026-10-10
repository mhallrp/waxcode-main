import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { tokens } from '../styles/tokens';
import {
  MOMENTUM_CONVERGENCE_PX, MOMENTUM_THRESHOLD_PX, momentumProgress, momentumTravelPx,
  rubberBanded, springBackProgress,
} from './scrubPhysics';
import type { DeckStatus } from '../types';

interface Options {
  /** Buckets in the whole track; with its length this gives the seconds-per-pixel scale. */
  bucketCount: number;
  duration: number | null;
  position: number;
  playing: boolean;
  status: DeckStatus | null;
  onSeek: (seconds: number) => Promise<unknown>;
}

/** How long a released scrub is held before giving up on the box ever confirming it. */
const COMMIT_TIMEOUT_MS = 2000;
/** A report can only be a response to the seek once this has passed - see the note in `commit`. */
const COMMIT_SETTLE_MS = 150;
/** Near enough to count as arrived, once settled. */
const COMMIT_TOLERANCE_S = 0.25;

/** Dragging the zoomed waveform to move the playhead. */
export function useScrub({ bucketCount, duration, position, playing, status, onSeek }: Options) {
  /** Where the finger has it, or where a coast has it. null when nothing is being dragged. */
  const [scrub, setScrub] = useState<number | null>(null);
  /** Where a released scrub was let go, held until the box actually gets there. */
  const [commit, setCommit] = useState<{ seconds: number; at: number } | null>(null);

  const drag = useRef<{ id: number; x: number; from: number; lastX: number; lastAt: number; velocity: number } | null>(null);
  /** The position currently being DRAWN, mirrored into a ref. */
  const shown = useRef<number | null>(null);
  /** Bumped per gesture, so a coast still running cannot write over the drag that interrupted it. */
  const generation = useRef(0);
  const animation = useRef(0);

  const secondsPerPixel = bucketCount > 0 && duration
    ? duration / bucketCount / tokens.bucketWidthPixels
    : 0;

  useEffect(() => () => cancelAnimationFrame(animation.current), []);

  /** Hands control back once the box reports a position that could only have come AFTER the seek. */
  useEffect(() => {
    if (!commit) return;
    const age = performance.now() - commit.at;
    const arrived = Math.abs((status?.elapsed ?? 0) - commit.seconds) < COMMIT_TOLERANCE_S;
    if ((age > COMMIT_SETTLE_MS && arrived) || age > COMMIT_TIMEOUT_MS) setCommit(null);
  }, [commit, status]);

  /** Runs a curve from one position to another, resolving with where it landed. */
  const glide = useCallback((from: number, to: number, springBack: boolean) => {
    const mine = generation.current;
    return new Promise<number | null>((resolve) => {
      const startedAt = performance.now();
      const distance = to - from;
      const convergence = MOMENTUM_CONVERGENCE_PX * secondsPerPixel;

      const step = () => {
        if (generation.current !== mine) { resolve(null); return; } // a new drag took over
        const elapsed = (performance.now() - startedAt) / 1000;
        const progress = springBack ? springBackProgress(elapsed) : momentumProgress(elapsed);
        const at = from + distance * progress;
        setScrub(at);

        if (springBack ? progress >= 1 : Math.abs(to - at) <= convergence) {
          setScrub(to);
          resolve(to);
          return;
        }
        animation.current = requestAnimationFrame(step);
      };
      animation.current = requestAnimationFrame(step);
    });
  }, [secondsPerPixel]);

  const release = async (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId || duration === null) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    let seconds = scrub ?? position;

    if (seconds < 0 || seconds > duration) {
      // Past an end: ease back to it on the spring curve, never coast further out.
      const target = Math.max(0, Math.min(seconds, duration));
      if (await glide(seconds, target, true) === null) return;
      seconds = target;
    } else {
      const travelPx = momentumTravelPx(current.velocity);
      if (Math.abs(travelPx) > MOMENTUM_THRESHOLD_PX && secondsPerPixel > 0) {
        // Inverted like the drag itself, and clamped: a flick coasts, it does not overshoot the ends.
        const target = Math.max(0, Math.min(seconds - travelPx * secondsPerPixel, duration));
        const landed = await glide(seconds, target, false);
        if (landed === null) return;
        seconds = landed;
      }
    }

    setScrub(null);
    setCommit({ seconds, at: performance.now() });
    // A seek the box refused must not leave the drawing frozen where the finger was.
    if (await onSeek(seconds) === null) setCommit(null);
  };

  /** What to draw: the finger, then a released drag awaiting confirmation, then the box. */
  const scrubPosition = scrub ?? commit?.seconds ?? null;
  shown.current = scrubPosition;

  return {
    scrubPosition,

    /** Take the playhead to `seconds` NOW, abandoning any coast on the way. */
    handOverTo: (seconds: number) => {
      generation.current += 1;
      if (animation.current) cancelAnimationFrame(animation.current);
      drag.current = null;
      setScrub(null);
      setCommit({ seconds, at: performance.now() });
    },

    handlers: {
      onPointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (playing || !duration || secondsPerPixel === 0) return;
        generation.current += 1;
        cancelAnimationFrame(animation.current);
        // Where it is on SCREEN, which after an interrupted coast is not where the box thinks it is.
        const from = shown.current ?? position;
        drag.current = {
          id: event.pointerId, x: event.clientX, from,
          lastX: event.clientX, lastAt: event.timeStamp, velocity: 0,
        };
        setCommit(null);
        setScrub(from);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.stopPropagation();
      },

      onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId || duration === null) return;

        const moved = (event.clientX - current.x) * secondsPerPixel;
        setScrub(rubberBanded(current.from - moved, duration));

        // Smoothed, so one jittery sample at the end of a throw cannot decide the whole coast.
        const elapsed = event.timeStamp - current.lastAt;
        if (elapsed > 0) {
          const sample = ((event.clientX - current.lastX) / elapsed) * 1000;
          current.velocity = current.velocity === 0 ? sample : current.velocity * 0.7 + sample * 0.3;
          current.lastX = event.clientX;
          current.lastAt = event.timeStamp;
        }
      },

      onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => { void release(event); },
      onPointerCancel: (event: ReactPointerEvent<HTMLCanvasElement>) => { void release(event); },
    },
  };
}
