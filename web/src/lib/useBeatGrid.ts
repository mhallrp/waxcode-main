import { useCallback, useEffect, useRef, useState } from 'react';

export interface BeatGrid {
  bpm: number;
  firstBeatSeconds?: number;
  /** How far this track's grid has been nudged from what the analysis produced. */
  offset?: number;
}

/** How far one press moves the grid: one pixel of the waveform as it is actually drawn. */
export const NUDGE_SECONDS = 0.02;

/** A track's grid, and the means to nudge it. */
export function useBeatGrid(path: string | null) {
  const [grid, setGrid] = useState<BeatGrid | null>(null);

  /** Read by nudge, which needs the CURRENT offset and cannot depend on `grid` */
  const gridRef = useRef<BeatGrid | null>(null);
  gridRef.current = grid;

  /** Sets the offset to an absolute value, deriving the grid from the UNSHIFTED analysis. */
  const apply = useCallback((offset: number) => {
    setGrid((before) => {
      if (!before) return before;
      const unshifted = (before.firstBeatSeconds ?? 0) - (before.offset ?? 0);
      return { ...before, firstBeatSeconds: unshifted + offset, offset };
    });
  }, []);

  useEffect(() => {
    setGrid(null);
    if (!path) return;
    let current = true;

    fetch(`/analysis/beatgrid?path=${encodeURIComponent(path)}`)
      .then((res) => (res.ok ? (res.json() as Promise<BeatGrid>) : null))
      .then((value) => { if (current && value?.bpm) setGrid(value); })
      .catch(() => { /* no grid is a normal outcome - the waveform still draws */ });

    return () => { current = false; };
  }, [path]);

  /** Moves the grid, on the press. */
  const nudge = useCallback(async (deltaSeconds: number) => {
    if (!path) return;

    const wanted = (gridRef.current?.offset ?? 0) + deltaSeconds;
    apply(wanted);

    try {
      const res = await fetch(`/analysis/beatgrid/offset?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: wanted }),
      });
      const answer = await res.json() as { offset?: number };
      // Clamped, or refused - the box's number wins over a guess it did not accept.
      if (typeof answer.offset === 'number' && answer.offset !== wanted) apply(answer.offset);
    } catch {
      /** The press stands. */
    }
  }, [path, apply]);

  return { grid, nudge };
}
