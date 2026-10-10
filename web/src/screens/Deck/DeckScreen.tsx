import { Fragment, useRef, useState } from 'react';
import type { DeckNumber } from '../../types';
import { TopBar, type PageId } from '../../components/organisms/TopBar';
import { DeckPanel, titleFromPath } from '../../components/organisms/DeckPanel';
import { useDeck } from './useDeck';
import { RecordButton } from '../../components/organisms/RecordButton';
import { MixRow } from '../../components/organisms/MixRow';
import { OverviewWave } from '../../components/organisms/OverviewWave';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { useConfirm } from '../../lib/useConfirm';
import { useSwipe } from '../../lib/useSwipe';
import { css } from '../../styles/css';

const styles = css('DeckScreen', {
  screen: `
    display: flex; flex-direction: column; height: 100%;
  `,
  viewport: `
    /* min-height: 0 lets the page track take the remaining height instead of overflowing the column. */
    /** Geometry taken from PhoneOverviewView, which is the reference: the card is FLUSH to the safe area horizontally (it has no horizontal */
    flex: 1;
    min-height: 0;
    overflow: hidden;
    padding: 6px 0 16px;
    touch-action: none;
  `,
  pages: `
    display: flex;
    height: 100%;
    /** Stays ONE viewport wide while its children overflow it. */
    width: 100%;
    transition: transform 260ms cubic-bezier(0.22, 0.61, 0.36, 1);
  `,
  page: `
    flex: 0 0 100%; height: 100%;
  `,
  mix: `
    /** One deck above the other, each taking half the card. */
    display: flex;
    flex-direction: column;
    gap: 0;
    height: 100%;
    /* 16 horizontal to match MixOverviewView's rows, which carry .padding(.horizontal, 16). */
    padding: 14px 16px;
    border-radius: var(--radius);
    background: var(--surface);
  `,
  mixDivider: `
    height: 1px; flex: 0 0 auto; background: var(--hairline);
  `,
});

interface Props {
  onOpenSettings: () => void;
  onOpenLibrary: (deck: DeckNumber) => void;
}

/** What a deck's line on the A+B page says it is playing. */
function mixTitle(
  deck: { status: { path: string | null } | null; passthrough: boolean },
  track: { title: string } | null,
): string {
  // Passthrough first: a deck playing a real record is not showing a file, whatever was last loaded.
  if (deck.passthrough) return 'PASSTHROUGH';
  if (track?.title) return track.title;
  return titleFromPath(deck.status?.path ?? null);
}

/** Seconds left, or null when there is nothing to count down - drawn as dashes rather than a zero. */
function mixRemain(deck: {
  status: { state: string } | null;
  passthrough: boolean;
  duration: number | null;
  position: number;
}): number | null {
  if (!deck.status || deck.status.state === 'EMPTY' || deck.passthrough) return null;
  if (deck.duration === null) return null;
  return Math.max(0, deck.duration - deck.position);
}

export function DeckScreen({ onOpenSettings, onOpenLibrary }: Props) {
  const [page, setPage] = useState<PageId>(0);

  /** The toolbar's colours follow the finger, so the swipe drives them directly rather than through state */
  const toolbar = useRef<{ setPosition: (position: number) => void }>(null);

  /** Both decks stay mounted across every page, so their status streams are opened once rather than torn down and rebuilt on each swipe */
  const deckA = useDeck(1, true);
  const deckB = useDeck(2, true);


  /** The library entry comes from the deck itself now */
  const decks = [
    { key: 1 as const, deck: deckA, track: deckA.track },
    { key: 2 as const, deck: deckB, track: deckB.track },
  ];

  /** The menus act on whichever deck is in view. */
  const selected = page === 1 ? deckB : deckA;

  const { trackRef, handlers } = useSwipe({
    count: 3,
    page,
    onPage: (next) => setPage(next as PageId),
    onPosition: (position) => toolbar.current?.setPosition(position),
  });

  const [confirm, dialog] = useConfirm();
  const record = useBoxData(api.record, { everyMs: 1000 });

  async function toggleRecording() {
    const state = record.data;
    if (state?.recording) {
      /** Not styled destructive: everything recorded so far is kept, and a red button would say the opposite of what happens. */
      const ok = await confirm({
        title: 'Stop recording?',
        message: 'The take so far is saved. Anything after this point will not be recorded.',
        confirm: 'Stop Recording',
        cancel: 'Keep Recording',
      });
      if (!ok) return;
    } else if (state?.hasRecording) {
      // Named, because "a recording" is far easier to dismiss than one you recognise.
      const ok = await confirm({
        title: 'Replace the existing recording?',
        message: `${state.name ?? 'The current recording'} will be deleted. Copy it to a USB stick `
          + 'first from Settings if you want to keep it.',
        confirm: 'Replace and Record',
        destructive: true,
      });
      if (!ok) return;
    }

    await api.recordCommand(record.data?.recording ? 'stop' : 'start');
    await record.refresh();
  }

  return (
    <div className={styles.screen}>
      <TopBar
        wipeRef={toolbar}
        page={page}
        onPage={setPage}
        onSettings={onOpenSettings}
        timecodeSide={selected.timecodeSide}
        passthrough={selected.passthrough}
        onTimecodeSide={(side) => void selected.setTimecodeSide(side)}
        onPassthrough={(on) => void selected.setPassthrough(on)}
        record={(
          <RecordButton
            recording={record.data?.recording ?? false}
            elapsedSeconds={record.data?.elapsedSeconds ?? 0}
            onPress={() => void toggleRecording()}
          />
        )}
      />

      <div className={styles.viewport} {...handlers}>
        {/* One track of three pages, moved by transform. The swipe hook writes directly to this
            element's style while a finger is down, so the track follows it without a re-render per
            frame; React's value takes over again the moment the drag ends. */}
        <div ref={trackRef} className={styles.pages} style={{ transform: `translateX(${-page * 100}%)` }}>
          {decks.map(({ key, deck, track }) => (
            <div className={styles.page} key={key}>
              <DeckPanel deck={key} state={deck} track={track} onLoad={() => onOpenLibrary(key)} />
            </div>
          ))}

          {/* Stacked, not side by side: the two decks are compared against each other, and a
              column each makes the eye travel sideways to do it. */}
          <div className={styles.page}>
            <div className={styles.mix}>
              {decks.map(({ key, deck, track }, index) => (
                <Fragment key={key}>
                  {index > 0 && <div className={styles.mixDivider} />}
                  <MixRow
                    deck={key}
                    title={mixTitle(deck, track)}
                    sub={deck.passthrough ? '' : (track?.artist ?? '')}
                    remain={mixRemain(deck)}
                    playing={deck.playing}
                    bpm={deck.displayBpm}
                    waveform={(
                    <OverviewWave
                      peaks={deck.peaks}
                      decoded={deck.decoded}
                      position={deck.position}
                      duration={deck.duration}
                    />
                  )}
                  />
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      </div>
      {dialog}
    </div>
  );
}
