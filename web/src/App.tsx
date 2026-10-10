import { useEffect, useState } from 'react';
import { useIsDesktop } from './lib/useIsDesktop';
import { useKeyboardInset } from './lib/useKeyboardInset';
import type { PinStatus } from './types';
import { PinScreen } from './screens/PinScreen';
import { UpdateScreen } from './screens/UpdateScreen';
import { type UpdateWatch, resumeWatching } from './lib/updateProgress';
import { UpdateBanner } from './components/organisms/UpdateBanner';
import { DeckScreen } from './screens/Deck/DeckScreen';
import { DesktopScreen } from './screens/Desktop/DesktopScreen';
import { SettingsScreen } from './screens/Settings/SettingsScreen';
import { LibraryScreen } from './screens/Library/LibraryScreen';
import { SetupScreen } from './screens/Setup/SetupScreen';
import { useBoxData } from './lib/useBoxData';
import { api } from './lib/api';
import { Sheet } from './components/organisms/Sheet';
import { css } from './styles/css';
import { RotatePrompt } from './components/organisms/RotatePrompt';
import { OfflineNotice } from './components/organisms/OfflineNotice';
import { usePresented } from './lib/usePresented';
import { startLibrary } from './lib/useLibrary';
import { useReachable } from './lib/useReachable';
import type { PaneId } from './screens/Settings/SettingsScreen';
import type { DeckNumber } from './types';

const styles = css('App', {
  /** Just the background. */
  holding: `
    position: fixed;
    inset: 0;
    background: var(--bg);
  `,
  fullScreen: `
    /** Over the decks, edge to edge. */
    position: fixed;
    inset: 0;
    z-index: 10;
    background: var(--bg);
    padding-top: env(safe-area-inset-top);
    /** A push comes in from the right OVER what it covers, so the deck stays put underneath for the whole slide */
    transform: translateX(100%);
    transition: transform 300ms cubic-bezier(0.32, 0.72, 0, 1);
    @media (prefers-reduced-motion: reduce) { transition: none; }
  `,
  fullScreenOpen: `
    transform: translateX(0);
  `,
});

/** Matched to the transitions in the styles above - an overlay unmounts when its slide finishes. */
const SHEET_MS = 320;
const PUSH_MS = 300;

/** Nothing, Settings, or the library opened for one particular deck. */
type Overlay = { kind: 'settings'; pane?: PaneId } | { kind: 'library'; deck: DeckNumber } | null;

/** What the address bar asked for, read once. */
function requestedOverlay(): Overlay {
  return window.location.hash === '#network' ? { kind: 'settings', pane: 'network' } : null;
}

/** Whether the captive portal sent us here. */
const wantsSetup = () => window.location.hash === '#setup';

/** The shell: the decks are the app, and everything else is presented over them. */
export function App() {
  const [overlay, setOverlay] = useState<Overlay>(requestedOverlay);
  const [dismissedSetup, setDismissedSetup] = useState(false);
  /** Only asked on http. */
  const version = useBoxData(api.version, { everyMs: window.isSecureContext ? undefined : 5000 });
  /** The box's answer first, the fragment only as a fallback for a browser that kept it. */
  const setup = !dismissedSetup && (version.data?.onSetupNetwork === true || wantsSetup());
  const reachable = useReachable();
  /** Fetched here rather than by the Load Track screen, so it is already in hand when that screen opens. */
  useEffect(startLibrary, []);

  const settings = usePresented(overlay?.kind === 'settings', SHEET_MS);
  const library = usePresented(overlay?.kind === 'library', PUSH_MS);
  /** Held separately from `overlay`, which is already null by the time the slide out runs */
  const [deck, setDeck] = useState<DeckNumber>(1);
  const isDesktop = useIsDesktop();
  /** Holds the view still when the keyboard opens and publishes how much it covers. */
  useKeyboardInset();

  /** Off on almost every box, so this is normally one request that answers "not required" and is never thought about again. */
  const pin = useBoxData<PinStatus>(api.pinStatus, { everyMs: 60_000 });
  const [unlocked, setUnlocked] = useState(false);
  /** Resumed from storage, because this page gets reloaded mid-update - by us */
  const [updating, setUpdating] = useState<UpdateWatch | null>(() => resumeWatching());

  useEffect(() => {
    const onStart = (event: Event) => setUpdating((event as CustomEvent<UpdateWatch>).detail);
    window.addEventListener('waxcode:update-started', onStart);
    return () => window.removeEventListener('waxcode:update-started', onStart);
  }, []);

  /** Returned INSTEAD of the app, not over it: every hook above has already run, so this is safe, and nothing behind it mounts. */
  if (pin.data?.required === true && !unlocked) {
    return <PinScreen onUnlocked={() => { setUnlocked(true); void pin.refresh(); }} />;
  }

  /** Nothing until the box has said what it is. */
  if (version.loading && version.data === null) {
    return <div className={styles.holding} />;
  }

  /** Over everything while an update runs. */
  if (updating !== null) {
    return <UpdateScreen watch={updating} onLeave={() => setUpdating(null)} />;
  }

  return (
    <>
      {/* FLOATS over both layouts rather than taking a row. A row pushed the decks off the bottom of
          a landscape phone, whose layout is a fixed height - see UpdateBanner for the z-index it
          takes and why it sits under anything the owner opened deliberately. */}
      <UpdateBanner />
      {/* One layout or the other, chosen once rather than one tree bent into both shapes. The phone
          layout is correct at every width, so it stays the default and the desktop one is the
          departure - see useIsDesktop for why width alone is not the test. */}
      {isDesktop ? (
        <DesktopScreen onOpenSettings={() => setOverlay({ kind: 'settings' })} />
      ) : (
        <DeckScreen
          onOpenSettings={() => setOverlay({ kind: 'settings' })}
          onOpenLibrary={(which) => { setDeck(which); setOverlay({ kind: 'library', deck: which }); }}
        />
      )}

      {settings.mounted && (
        <Sheet title="Settings" shown={settings.shown} onClose={() => setOverlay(null)}>
          <SettingsScreen initialPane={overlay?.kind === 'settings' ? overlay.pane : undefined} />
        </Sheet>
      )}

      {/* `required` when the box is on its OWN network: first-time setup, with nowhere else to be
          and no way past the two choices. Reached deliberately on a working box, it stays escapable. */}
      {setup && (
        <SetupScreen
          onSkip={() => setDismissedSetup(true)}
          required={version.data?.onSetupNetwork === true}
        />
      )}

      {/* Not during setup. The captive portal opens in a PORTRAIT sheet, so demanding landscape
          there hides the only screen somebody can act on - and setup reads fine either way. Only
          the decks need the rotation, and only the decks ask for it. */}
      {!setup && !isDesktop && <RotatePrompt />}
      {/* Last, and over everything: an unreachable box makes every screen below it a lie. */}
      {!reachable && <OfflineNotice />}

      {/* A full screen with its own Back, not a sheet: it carries a header of its own, and a second
          bar above it would leave the breadcrumb sitting under a title that says the same thing. */}
      {library.mounted && !isDesktop && (
        <div className={library.shown ? `${styles.fullScreen} ${styles.fullScreenOpen}` : styles.fullScreen}>
          <LibraryScreen
            deck={deck}
            onLoaded={() => setOverlay(null)}
            onBack={() => setOverlay(null)}
          />
        </div>
      )}
    </>
  );
}
