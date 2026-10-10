import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from 'react';
import { PopupMenu } from '../molecules/PopupMenu';
import { Wipe } from '../molecules/Wipe';
import { applyWipe, toolbarWipes } from '../../lib/wipes';
import { FullscreenButton } from './FullscreenButton';
import { Brand } from '../atoms/Brand';
import { MODES, ModeIcon, SIDES } from './deckMode';
import { css } from '../../styles/css';

const styles = css('TopBar', {
  bar: `
    /** gap: 0 is not an oversight - the toolbar is an HStack(spacing: 0) and every item in it carries its own 10px of padding. */
    display: flex;
    align-items: center;
    gap: 0;
    /** 16 on both, from DeckTopBar's own .padding(.horizontal) and PhoneOverviewView's .padding(.top, 16) above it. */
    padding: 16px 16px 0;
    flex: 0 0 auto;
  `,
  pips: `
    /** flex: 1 pushes everything after it to the right, so no spacer element is needed. */
    display: flex; align-items: center; gap: 22px; flex: 1;
  `,
  pip: `
    display: inline-flex;
    align-items: center;
    /** 9px, and the dot below is 8px. */
    gap: 9px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--ink-faint);
    font: 600 15px/1 var(--mono);
    text-transform: uppercase;
    letter-spacing: 2px;
    &[data-page='0'] { --accent: var(--deck-a); }
    &[data-page='1'] { --accent: var(--deck-b); }
    &[data-page='2'] { --accent: var(--ink); }
  `,
  active: `
    color: var(--accent);
  `,
  spacer: `
    flex: 1;
  `,
  dot: `
    width: 8px; height: 8px; border-radius: 50%; background: currentColor;
  `,
  icon: `
    /** Padding, not a bigger glyph - the app grows the tappable area with .padding(10) while leaving the icon its own 20px. */
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    padding: 10px;
    border: 0;
    background: transparent;
    color: var(--ink);
  `,
  modePassthrough: `
    /* Amber while a real record is going through the box, so the mode is legible without opening it. */
    color: var(--deck-b);
  `,
});

export type PageId = 0 | 1 | 2;

const PAGES: ReadonlyArray<{ id: PageId; label: string }> = [
  { id: 0, label: 'Deck A' },
  { id: 1, label: 'Deck B' },
  { id: 2, label: 'A+B' },
];

interface Props {
  /** null on a layout with no pages to swipe between - the desktop one, where both decks show. */
  page: PageId | null;
  onPage?: (page: PageId) => void;
  onSettings: () => void;
  /** The selected deck's settings - these menus act on whichever deck is in view. */
  timecodeSide: string | null;
  passthrough: boolean;
  onTimecodeSide: (side: string) => void;
  onPassthrough: (on: boolean) => void;
  record: ReactNode;
  /** False where each deck card carries its own pair instead */
  showDeckMenus?: boolean;
  /** Lets the deck screen drive the colour handoff from the live swipe position. */
  wipeRef?: Ref<{ setPosition: (position: number) => void }>;
}

export function TopBar({
  page, onPage, onSettings, timecodeSide, passthrough, record, wipeRef, showDeckMenus = true, ...rest
}: Props) {
  const sideLabel = SIDES.find((s) => s.value === timecodeSide)?.label ?? 'Serato A';

  const pips = useRef<Array<HTMLSpanElement | null>>([]);
  const timecode = useRef<HTMLSpanElement>(null);
  const timecodeWrap = useRef<HTMLDivElement>(null);

  /** Written straight onto the elements rather than held in state: this runs with a finger */
  const setPosition = (position: number) => {
    const wipes = toolbarWipes(position);
    applyWipe(pips.current[0] ?? null, wipes.deckA);
    applyWipe(pips.current[1] ?? null, wipes.deckB);
    applyWipe(pips.current[2] ?? null, wipes.mix);
    applyWipe(timecode.current, wipes.timecode);
    if (timecodeWrap.current) {
      timecodeWrap.current.style.opacity = String(wipes.timecodeOpacity);
      // Inert rather than removed: taking it out would shift the whole bar mid-swipe.
      timecodeWrap.current.style.pointerEvents = wipes.timecodeDisabled ? 'none' : '';
    }
  };

  useImperativeHandle(wipeRef, () => ({ setPosition }));
  // Settles the colours when the page changes without a drag - a pip tap, or the first render.
  useEffect(() => { setPosition(page ?? 0); }, [page]);

  return (
    <header className={styles.bar}>
      {/* The pips carry no active class: their colour is the wipe's, which is mid-transition
          whenever a finger is down and would fight a class that snaps. */}
      {/* Where the pager is not. On desktop the bar's left was simply empty, and a logo is a better
          answer than a gap - it is also the only place the box says its own name. */}
      {page === null && <Brand />}

      {/* Absent entirely rather than hidden when there is nothing to page between: an empty pager
          still takes its width, and the bar's remaining controls should have it. */}
      {page !== null && (
      <div className={styles.pips}>
        {PAGES.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={item.id === page}
            className={styles.pip}
            data-page={item.id}
            onClick={() => onPage?.(item.id)}
          >
            <Wipe ref={(node) => { pips.current[item.id] = node; }}>
              <span className={styles.dot} />{item.label}
            </Wipe>
          </button>
        ))}
      </div>
      )}

      {showDeckMenus && (
        <>
          <div ref={timecodeWrap}>
            <PopupMenu
              label={<Wipe ref={timecode}>{sideLabel}</Wipe>}
              ariaLabel="Timecode side"
              options={SIDES}
              value={timecodeSide}
              onChange={rest.onTimecodeSide}
            />
          </div>
          {/* An icon, not the word - the mode is a glance, and its shape says which one it is. */}
          <PopupMenu
            label={<ModeIcon passthrough={passthrough} />}
            ariaLabel="Deck mode"
            variant="icon"
            triggerClassName={passthrough ? styles.modePassthrough : undefined}
            options={MODES}
            value={passthrough ? 'passthrough' : 'digital'}
            onChange={(mode) => rest.onPassthrough(mode === 'passthrough')}
          />
        </>
      )}

      {/* The pager carries flex: 1 and is what pushes everything after it to the right. Without a
          pager there is nothing doing that job, so this stands in for it - otherwise record,
          fullscreen and settings sit bunched against the left edge. */}
      {page === null && <span className={styles.spacer} />}

      {record}
      <FullscreenButton />

      <button type="button" className={styles.icon} aria-label="Settings" onClick={onSettings}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.6 1.6 0 0 0 15 19.4a1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.09A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.09A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.6h.09A1.6 1.6 0 0 0 10 3.13V3a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9v.09a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.09a1.6 1.6 0 0 0-1.51 1z" />
        </svg>
      </button>
    </header>
  );
}
