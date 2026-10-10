import { useEffect, useRef, useState } from 'react';
import { useResume } from './useResume';
import { TARGET_BUCKET_SECONDS, base64ToBuffer, decodePeaks, type Peak } from './waveform';

interface Slice {
  b64?: string;
  startBucket?: number;
  done?: boolean;
  error?: string;
}

/** A track's waveform, streamed in slices as the box decodes it. */
export function useWaveform(path: string | null, duration: number | null) {
  const [peaks, setPeaks] = useState<Peak[] | null>(null);
  const [decoded, setDecoded] = useState(0);

  /** Read through a ref rather than depended on. */
  const durationRef = useRef(duration);
  durationRef.current = duration;

  /* A stream cut off when the app was suspended leaves a waveform half drawn and no longer being
     sent - and a deck you are about to mix into with half a waveform is not a cosmetic problem.
     Only what never finished is asked for again. */
  const resume = useResume();
  const completedFor = useRef<string | null>(null);

  useEffect(() => {
    // One that already finished for this very track needs nothing doing when the app comes back.
    if (path !== null && completedFor.current === path) return;
    setPeaks(null);
    setDecoded(0);
    /* Cleared with the peaks it describes, never left behind: held across an unload it would match
       the next load of the same track and skip the stream, leaving that deck with no waveform. */
    completedFor.current = null;
    if (!path) return;

    const source = new EventSource(`/analysis/waveform/stream?path=${encodeURIComponent(path)}`);
    // Padded to the track's full length, so a partial sits where it belongs on the timeline rather than being stretched across the whole width
    let padded: Peak[] | null = null;

    source.onmessage = (event) => {
      let slice: Slice;
      try {
        slice = JSON.parse(event.data) as Slice;
      } catch {
        return;
      }
      if (slice.error || !slice.b64) { source.close(); return; }

      const decodedSlice = decodePeaks(base64ToBuffer(slice.b64));

      if (slice.done) {
        completedFor.current = path;
        setPeaks(decodedSlice);
        setDecoded(1);
        source.close();
        return;
      }

      if (!padded) {
        const expected = Math.max(1, Math.round((durationRef.current ?? 0) / TARGET_BUCKET_SECONDS));
        padded = Array.from({ length: expected }, () => ({ min: 0, max: 0, low: 0, mid: 0, high: 0 }));
      }
      const start = slice.startBucket ?? 0;
      for (let i = 0; i < decodedSlice.length && start + i < padded.length; i += 1) {
        padded[start + i] = decodedSlice[i]!;
      }
      setPeaks(padded.slice());
      setDecoded(Math.min(1, (start + decodedSlice.length) / padded.length));
    };

    source.onerror = () => source.close();
    return () => source.close();
  }, [path, resume]);

  return { peaks, decoded };
}
