import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { useResume } from './useResume';
import type { FxState } from '../types';

/**
 * The mixer's FX send and return, with the box as the effect.
 *
 * Box-wide, not per deck: there is one send and one return on the mixer, and the per-channel send
 * knobs are what decide how much of each deck goes into it. The app holds the settings; your hands
 * do the playing.
 *
 * Shared through a module store rather than fetched per deck, because both deck cards show the
 * same switch and two of them asking separately would let them disagree.
 */

let state: FxState | null = null;
const listeners = new Set<() => void>();
/** Both deck cards ask at the same moment; one request answers both. */
let inFlight: Promise<void> | null = null;

function publish(next: FxState): void {
  state = next;
  for (const listener of listeners) listener();
}

function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    // A GET throws if the box is unreachable; the switch keeps whatever it last knew.
    try {
      publish(await api.fx());
    } catch { /* a stale switch beats a switch that flickers off whenever the box is busy */ }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Answered by the box, never assumed: Phono mode refuses this outright. */
export async function setFxEnabled(enabled: boolean): Promise<void> {
  const answer = await api.setFx({ enabled });
  if (answer.ok) publish(answer as FxState);
}

export function useFx(): FxState | null {
  const value = useSyncExternalStore(subscribe, () => state, () => state);
  const resume = useResume();

  useEffect(() => {
    /* Asked on the way in, and again whenever the app comes back - the Phono/Line setting can have
       changed in Settings while this was off screen, and that decides whether it exists at all. */
    void refresh();
  }, [resume]);

  return value;
}

/** Tests only. */
export function resetFxForTest(): void {
  state = null;
  inFlight = null;
}
