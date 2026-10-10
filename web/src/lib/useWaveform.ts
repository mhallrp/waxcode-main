import { useEffect, useRef, useState } from 'react';
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

  useEffect(() => {
    setPeaks(null);
    setDecoded(0);
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
  }, [path]);

  return { peaks, decoded };
}
