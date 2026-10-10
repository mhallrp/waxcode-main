import { useState } from 'react';
import type { DragEvent } from 'react';
import type { DeckNumber, Track } from '../../types';
import { BOX_TRACK, carriesDesktopFile, carriesTrack } from '../../lib/trackDrag';
import { DeckCard } from './DeckCard';
import { Waveform } from './Waveform';
import { LoopButtons } from './LoopButtons';
import type { useDeck } from '../../screens/Deck/useDeck';

type Deck = ReturnType<typeof useDeck>;

interface Props {
  deck: DeckNumber;
  state: Deck;
  track: Track | null;
  onLoad: () => void;
  layout?: 'split' | 'stacked';
  /** Something was dropped on THIS deck. */
  onDropTrack?: (dropped: { file?: File; path?: string }) => void;
}

/** Filenames are all the box gives us until the library carries the title through. */
export function titleFromPath(path: string | null): string {
  if (!path) return 'No track';
  return path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'No track';
}

/** One deck, wired up - the card, its waveform and its loops. */
export function DeckPanel({ deck, state, track, onLoad, layout, onDropTrack }: Props) {
  const [dropping, setDropping] = useState(false);

  /** Only something this deck can actually accept lights it up. */
  const accepts = (event: DragEvent) => carriesTrack(Array.from(event.dataTransfer.types));

  const drag = onDropTrack ? {
    onDragOver: (event: DragEvent) => {
      if (!accepts(event)) return;
      // Required: without preventDefault the browser navigates to the file instead of dropping it.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDropping(true);
    },
    onDragLeave: () => setDropping(false),
    onDrop: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      setDropping(false);

      const types = Array.from(event.dataTransfer.types);
      /** FILES FIRST, and by what is actually there rather than by what was advertised. */
      if (event.dataTransfer.files.length > 0 || carriesDesktopFile(types)) {
        /** One file. */
        const file = event.dataTransfer.files[0];
        if (file) onDropTrack({ file });
        return;
      }
      if (types.includes(BOX_TRACK)) {
        onDropTrack({ path: event.dataTransfer.getData(BOX_TRACK) });
        return;
      }

    },
  } : {};

  return (
    <DeckCard
      {...drag}
      layout={layout}
      dropping={dropping}
      deck={deck}
      timecodeSide={state.timecodeSide}
      onTimecodeSide={(side) => void state.setTimecodeSide(side)}
      onPassthrough={(on) => void state.setPassthrough(on)}
      status={state.status}
      title={track?.title || titleFromPath(state.status?.path ?? null)}
      artist={track?.artist ?? ''}
      /** Tag first, analysed grid second - the same order, and the same reason */
      /** The LIVE value - the track's tempo scaled by the platter, as a turntable's own readout does. */
      bpm={state.displayBpm}
      passthrough={state.passthrough}
      playing={state.playing}
      position={state.position}
      duration={state.duration}
      positionLock={state.positionLock}
      keyLock={state.keyLock}
      onLoad={onLoad}
      onCue={() => void state.cue()}
      onCuePlay={() => void state.cuePlay()}
      onPlayPause={() => void state.playPause()}
      onPositionLock={(on) => void state.setPositionLock(on)}
      onKeyLock={(on) => void state.setKeyLock(on)}
      waveform={(
        <Waveform
          peaks={state.peaks}
          decoded={state.decoded}
          /** The run-in-capable reading, NOT the clamped one - this is the only view where a position before the track starts is meaningful. */
          position={state.waveformPosition}
          duration={state.duration}
          grid={state.grid}
          cuePoint={state.status?.cuePoint ?? null}
          loop={state.loop}
          // Not while a deck is empty, and not while it is passing a real record through.
          analysing={Boolean(state.status?.path) && state.decoded < 1 && !state.passthrough}
          playing={state.playing}
          onSeek={(seconds) => void state.seek(seconds)}
          scrubHandlers={state.scrubHandlers}
          onNudgeGrid={(delta) => void state.nudgeGrid(delta)}
        />
      )}
      loops={(
        <LoopButtons
          /** Flat only in the stacked layout - the phone keeps its outlined pills, which are right for a thumb. */
          flat={layout === 'stacked'}
          activeBeats={state.activeLoopBeats}
          /** A real beat grid AND not passthrough - a deck playing a record through the box has nothing to loop. */
          disabled={!state.grid || state.passthrough}
          onLoop={(beats) => void state.toggleLoop(beats)}
        />
      )}
    />
  );
}
