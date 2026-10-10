import { useEffect, useRef, useState } from 'react';

export interface RecordLevel {
  left: number;
  right: number;
}

/** Nothing has arrived yet, which is different from silence and is drawn differently. */
export type RecordLevelState = RecordLevel & { live: boolean };

/** The record input's level, streamed while this is mounted. */
const DECAY_PER_READING = 0.25;

export function useRecordLevel(active: boolean): RecordLevelState {
  const [level, setLevel] = useState<RecordLevelState>({ left: 0, right: 0, live: false });
  const held = useRef({ left: 0, right: 0 });

  useEffect(() => {
    if (!active) {
      held.current = { left: 0, right: 0 };
      setLevel({ left: 0, right: 0, live: false });
      return;
    }

    const source = new EventSource('/record/level/stream');
    source.onmessage = (event) => {
      let reading: RecordLevel;
      try {
        reading = JSON.parse(event.data) as RecordLevel;
      } catch {
        return;
      }
      // Rises instantly, falls gradually - a transient must be visible, a gap must not flicker.
      const next = {
        left: Math.max(reading.left, held.current.left - DECAY_PER_READING),
        right: Math.max(reading.right, held.current.right - DECAY_PER_READING),
      };
      held.current = next;
      setLevel({ ...next, live: true });
    };

    return () => source.close();
  }, [active]);

  return level;
}
