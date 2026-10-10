import { useMemo } from 'react';
import { api } from './api';
import { useBoxData } from './useBoxData';
import type { Track } from '../types';

/** The library's own entry for whatever a deck has loaded. */
export function useLoadedTrack(path: string | null): Track | null {
  const library = useBoxData(api.library, { everyMs: 30_000 });

  return useMemo(() => {
    if (!path) return null;
    for (const device of library.data?.devices ?? []) {
      const found = device.tracks.find((track) => track.path === path);
      if (found) return found;
    }
    return null;
  }, [path, library.data]);
}
