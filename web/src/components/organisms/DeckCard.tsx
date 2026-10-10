import type { DragEventHandler, ReactNode } from 'react';
import type { DeckNumber, DeckStatus } from '../../types';
import { Button } from '../atoms/Button';
import { Transport } from './Transport';
import { TrackSummary } from './TrackSummary';
import { LockToggles } from './LockToggles';
import { PopupMenu } from '../molecules/PopupMenu';
import { MODES, ModeIcon, SIDES } from './deckMode';
import { useKeyLockFeature } from '../../lib/useKeyLockFeature';
import { css } from '../../styles/css';

const styles = css('DeckCard', {
  card: `
    /* The deck's own colour, which everything inside inherits through --accent. */
    &[data-deck='1'] { --accent: var(--deck-a); --accent-dim: var(--deck-a-dim); }
    &[data-deck='2'] { --accent: var(--deck-b); --accent-dim: var(--deck-b-dim); }
    display: flex;
    align-items: stretch;
    height: 100%;
    padding: 16px;
    /** No gap: each column carries 14px against the divider, so the two halves are evenly spaced from it rather than from each other. */
    gap: 0;
    border-radius: var(--radius);
    background: var(--surface);
  `,
  left: `
    /* min-width: 0 on both, or a long track title stops either column from shrinking. */
    /* 45/55, as the current UI splits it - the right column carries two waveforms and needs the room. */
    display: flex; flex-direction: column; flex: 0 0 45%; min-width: 0; gap: var(--gap-sm); padding-right: 16px;
  `,
  right: `
    display: flex; flex-direction: column; flex: 1; min-width: 0; gap: var(--gap-sm); padding-left: 16px;
  `,
  spacer: `
    /* Pushes the controls to the bottom, so they sit still while the title above them changes length. */
    flex: 1;
  `,
  controls: `
    /** BOTH columns end in one of these, with identical geometry */
    display: flex; flex-direction: column; gap: var(--gap-sm);
  `,
  divider: `
    width: 1px; background: var(--hairline); align-self: stretch; flex: 0 0 auto;
  `,
  load: `
    /** The single filled control on the card: solid accent, dark text. */
    height: var(--row);
    justify-content: center;
    border: 0;
    background: var(--accent);
    color: var(--background);
    font: 700 15px/1 var(--mono);
    text-transform: uppercase;
    letter-spacing: 0.6px;
    &:disabled { background: transparent; color: var(--ink-faint); border: 1px solid var(--hairline); }
  `,
  waveSlot: `
    /* Holds its space whatever is in it, so the controls below never move. */
    flex: 1; min-height: 0; display: flex; flex-direction: column;
  `,
  /** The desktop shape: header, waveform, controls - stacked down the card at full width. */
  stacked: `
    display: flex; flex-direction: column; height: 100%; gap: var(--gap-sm);
  `,
  header: `
    display: flex; align-items: flex-start; gap: var(--gap); min-width: 0; flex: 0 0 auto;
  `,
  headMenus: `
    /** The deck's own timecode side and digital/passthrough, beside its letter. */
    display: flex; align-items: center; gap: 2px; flex: 0 0 auto;
  `,
  modePassthrough: `
    color: var(--accent);
  `,
  letter: `
    /** The deck's identity, big and in its own colour */
    flex: 0 0 auto;
    font: 700 26px/1 var(--mono);
    color: var(--accent);
    letter-spacing: 0.02em;
  `,
  stackedControls: `
    /** One row of NINE equal buttons. */
    display: flex; align-items: center; gap: var(--gap-sm); flex: 0 0 auto;
  `,
  stackedTransport: `
    flex: 3 1 0; min-width: 0;
  `,
  stackedLoops: `
    flex: 4 1 0; min-width: 0;
  `,
  stackedLocks: `
    flex: 2 1 0; min-width: 0;
  `,
  dropping: `
    /** A file is over this deck. */
    outline: 2px solid var(--accent); outline-offset: -2px;
  `,
  waveEmpty: `
    /** Nothing loaded, or passthrough: visibility rather than display, so the space is kept and the layout does not jump */
    & > * { visibility: hidden; }
  `,
});

interface Props {
  deck: DeckNumber;
  status: DeckStatus | null;
  title: string;
  artist: string;
  bpm: number | null;
  positionLock: boolean;
  keyLock: boolean;
  onLoad: () => void;
  onCue: () => void;
  onCuePlay: () => void;
  onPlayPause: () => void;
  onPositionLock: (on: boolean) => void;
  onKeyLock: (on: boolean) => void;
  /** A deck playing a real record through the box has nothing to lock and nothing to cue, so this is what actually gates the controls */
  passthrough: boolean;
  /** Passed in rather than read off the status, because it is OPTIMISTIC: the button shows the state it was pressed into straight away */
  playing: boolean;
  /** The live playhead, so the countdown is derived from it rather than from a lagging field. */
  position: number;
  duration: number | null;
  /** Passed in rather than built here: the waveform needs streams and analysis, and this layer makes no API calls. */
  waveform: ReactNode;
  loops: ReactNode;
  /** 'split' is the phone's two columns; 'stacked' is the desktop's single column. */
  layout?: 'split' | 'stacked';
  /** A file from the laptop is hovering over this deck - see DeckPanel's drop handling. */
  dropping?: boolean;
  /** This deck's own timecode side and mode, shown on the card in the stacked layout. */
  timecodeSide?: string | null;
  onTimecodeSide?: (side: string) => void;
  onPassthrough?: (on: boolean) => void;
  /** Declared explicitly rather than taken as rest props. */
  onDragOver?: DragEventHandler<HTMLElement>;
  onDragLeave?: DragEventHandler<HTMLElement>;
  onDrop?: DragEventHandler<HTMLElement>;
}

/** One deck. */
export function DeckCard(props: Props) {
  const { deck, status, title, artist, bpm, positionLock, keyLock, passthrough } = props;
  /** Off unless somebody opted in - key lock degrades audio whichever way it is configured */
  const keyLockAvailable = useKeyLockFeature();
  /** The box's own definition: anything the app knows about, or any status that is not EMPTY. */
  const empty = !(status && status.state !== 'EMPTY');

  /** What each control needs before it means anything, matching the deck card's own gates: cue - a loaded track, and not passthrough loops */
  const canCue = !passthrough && !empty;

  const summary = (wide: boolean) => (
    <TrackSummary
      empty={empty}
      passthrough={passthrough}
      title={empty ? 'No track' : title}
      artist={empty ? '' : artist}
      bpm={empty ? null : bpm}
      position={props.position}
      duration={props.duration}
      playing={props.playing}
      unreadableSeconds={status?.unreadableSeconds ?? null}
      wide={wide}
    />
  );

  const waveSlot = (
    <div className={empty || passthrough ? `${styles.waveSlot} ${styles.waveEmpty}` : styles.waveSlot}>
      {props.waveform}
    </div>
  );

  const locks = (
    <LockToggles
      positionLock={positionLock}
      keyLock={keyLock}
      keyLockAvailable={keyLockAvailable}
      disabled={passthrough}
      onPositionLock={props.onPositionLock}
      onKeyLock={props.onKeyLock}
    />
  );

  if (props.layout === 'stacked') {
    return (
      <section
        className={props.dropping ? `${styles.card} ${styles.stacked} ${styles.dropping}` : `${styles.card} ${styles.stacked}`}
        data-deck={deck}
        onDragOver={props.onDragOver}
        onDragLeave={props.onDragLeave}
        onDrop={props.onDrop}
      >
        <div className={styles.header}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>{summary(true)}</div>
          <div className={styles.headMenus}>
            <PopupMenu
              label={SIDES.find((side) => side.value === props.timecodeSide)?.label ?? 'Serato A'}
              ariaLabel={`Timecode side, deck ${deck === 1 ? 'A' : 'B'}`}
              options={SIDES}
              value={props.timecodeSide ?? null}
              onChange={(side) => props.onTimecodeSide?.(side)}
            />
            {/* An icon, not the word - the mode is a glance, and its shape says which one it is. */}
            <PopupMenu
              label={<ModeIcon passthrough={passthrough} />}
              ariaLabel={`Deck mode, deck ${deck === 1 ? 'A' : 'B'}`}
              variant="icon"
              triggerClassName={passthrough ? styles.modePassthrough : undefined}
              options={MODES}
              value={passthrough ? 'passthrough' : 'digital'}
              onChange={(mode) => props.onPassthrough?.(mode === 'passthrough')}
            />
          </div>
          <span className={styles.letter}>{deck === 1 ? 'A' : 'B'}</span>
        </div>

        {waveSlot}

        {/* No Load Track: the browser is permanently on screen in this layout, so a button whose
            only job was to open it has nothing left to do. */}
        <div className={styles.stackedControls}>
          <div className={styles.stackedTransport}>
            <Transport
              playing={props.playing}
              disabled={!canCue}
              onCue={props.onCue}
              onCuePlay={props.onCuePlay}
              onPlayPause={props.onPlayPause}
            />
          </div>
          <div className={styles.stackedLoops}>{props.loops}</div>
          <div className={styles.stackedLocks}>
            <LockToggles
              flat
              positionLock={positionLock}
              keyLock={keyLock}
              keyLockAvailable={keyLockAvailable}
              disabled={passthrough}
              onPositionLock={props.onPositionLock}
              onKeyLock={props.onKeyLock}
            />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.card} data-deck={deck}>
      <div className={styles.left}>
        {summary(false)}

        <div className={styles.spacer} />

        <div className={styles.controls}>
            <Transport
              flat
              playing={props.playing}
              disabled={!canCue}
              onCue={props.onCue}
              onCuePlay={props.onCuePlay}
              onPlayPause={props.onPlayPause}
            />
          {/* A deck passing a real record through has nothing to load onto. */}
          <Button variant="row" className={styles.load} disabled={passthrough} onClick={props.onLoad}>
            <span>Load Track</span>
          </Button>
        </div>
      </div>

      <div className={styles.divider} />

      <div className={styles.right}>
        {/* Always present, greedy, no minimum height: the area keeps its space and simply draws
            nothing, so the loop row stays pinned to the bottom instead of jumping up when a deck
            empties. */}
        {waveSlot}
        <div className={styles.controls}>
          {props.loops}
          {/* NOT gated on a track. These are settings the deck comes back up with, so they are
              adjustable on an empty deck - only passthrough turns them off, since a deck playing a
              real record has nothing to lock. */}
          {locks}
        </div>
      </div>
    </section>
  );
}
