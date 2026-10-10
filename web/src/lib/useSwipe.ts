import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

interface Options {
  count: number;
  page: number;
  onPage: (page: number) => void;
  /** The CONTINUOUS position, 0..count-1, reported on every frame of a drag. */
  onPosition?: (position: number) => void;
}

/** Projected, not measured: a short flick and a slow drag of the same distance mean different things */
const FLICK_PROJECTION_SECONDS = 0.25;
/** A fraction of the viewport. Past this, the page changes. */
const COMMIT_FRACTION = 0.25;
/** How far a pointer must travel before this is a DRAG rather than a tap. */
const DRAG_THRESHOLD_PX = 8;

/** Drag between pages, with the track following the finger. */
export function useSwipe({ count, page, onPage, onPosition }: Options) {
  const drag = useRef<{
    id: number; x: number; startedAt: number; dx: number; dragging: boolean;
  } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const apply = (offsetPx: number, animate: boolean) => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = animate ? '' : 'none';
    track.style.transform = `translateX(calc(${-page * 100}% + ${offsetPx}px))`;

    // A drag LEFT is a rising position, hence the minus.
    const width = track.clientWidth || 1;
    onPosition?.(Math.max(0, Math.min(page - offsetPx / width, count - 1)));
  };

  return {
    trackRef,
    handlers: {
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.pointerType === 'mouse' && event.buttons !== 1) return;
        /** Anything that handles its own drag is left entirely alone */
        if ((event.target as HTMLElement | null)?.closest?.('canvas, button, select, input')) return;
        drag.current = {
          id: event.pointerId, x: event.clientX, startedAt: performance.now(),
          dx: 0, dragging: false,
        };
      },

      onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;

        const dx = event.clientX - current.x;
        if (!current.dragging) {
          if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
          // Now it is a drag, so take the pointer.
          current.dragging = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }

        current.dx = dx;
        apply(dx, false);
      },

      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        drag.current = null;
        // Never moved far enough to be a drag, so it was a tap: leave the click alone.
        if (!current || current.id !== event.pointerId || !current.dragging) return;

        const width = event.currentTarget.clientWidth || 1;
        /** Averaged over the whole gesture, not taken from the last two events. */
        const seconds = Math.max(performance.now() - current.startedAt, 1) / 1000;
        const projected = current.dx + (current.dx / seconds) * FLICK_PROJECTION_SECONDS;
        let next = page;
        if (projected < -width * COMMIT_FRACTION) next = Math.min(count - 1, page + 1);
        else if (projected > width * COMMIT_FRACTION) next = Math.max(0, page - 1);

        apply(0, true);
        if (next !== page) onPage(next);
      },

      // A cancelled pointer (a system gesture taking over) must not leave the track mid-drag.
      onPointerCancel: () => {
        if (drag.current?.dragging) apply(0, true);
        drag.current = null;
      },
    },
  };
}
