import { useState } from 'react';
import type { DeckNumber } from '../../types';
import { TopBar } from '../../components/organisms/TopBar';
import { DeckPanel } from '../../components/organisms/DeckPanel';
import { RecordButton } from '../../components/organisms/RecordButton';
import { BrowserPane } from './BrowserPane';
import { useDeck } from '../Deck/useDeck';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { useConfirm } from '../../lib/useConfirm';
import { css } from '../../styles/css';
import { loadOverPlayingWarning } from '../../lib/confirmLoad';

/** What the owner dragged the splitter to with the window fully open: decks at their smallest, browser taking the rest. */
const BROWSER_FRACTION = 0.6;

const styles = css('DesktopScreen', {
  screen: `
    display: flex; flex-direction: column; height: 100%; min-height: 0;
    /** Nothing on this screen is prose. */
    user-select: none;
    -webkit-user-select: none;
  `,
  decks: `
    /** Traktor's shape: the two decks side by side across the top, the browser underneath. */
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    gap: var(--gap);
    /** A real gap underneath, not 0: the deck cards and the browser were sitting flush against each other */
    padding: var(--gap);
  `,
  deck: `
    flex: 1 1 0; min-width: 0; display: flex; flex-direction: column;
  `,
  browser: `
    /** Pinned at the size the owner dragged the splitter to, which is roughly Traktor's own split */
    flex: 0 0 auto;
    height: ${BROWSER_FRACTION * 100}vh;
    min-height: 0;
    /* No top padding: the decks' own bottom padding is the gap between them. */
    display: flex;
    flex-direction: column;
    padding: 0 var(--gap) var(--gap);
  `,
}, `
  /** A search field you cannot select inside is its own bug - the no-select above is aimed at stray drags over labels, not at typing. */
  $screen input, $screen textarea { user-select: text; -webkit-user-select: text; }
`);


interface Props {
  onOpenSettings: () => void;
}

/** The desktop layout: both decks at once, with the browser always on screen. */
export function DesktopScreen({ onOpenSettings }: Props) {
  const deckA = useDeck(1, true);
  const deckB = useDeck(2, true);

  /** What a dropped file is doing right now, shown on the browser pane's status line rather than over the deck */
  const [staging, setStaging] = useState<string | null>(null);

  /** A file dragged from the desktop onto a deck: staged on the box, then loaded onto that deck. */
  /** Whatever landed on a deck: a box path loads directly, anything else has to be sent first. */
  async function dropOnDeck(
    deck: DeckNumber,
    dropped: { file?: File; path?: string },
  ) {
    const warning = loadOverPlayingWarning(deck);
    if (warning && !(await confirm(warning))) return;

    if (dropped.path) {
      await api.deck(deck).load(dropped.path);
      return;
    }
    const file = dropped.file;
    // Asked BEFORE the upload, not after: sending a file and then refusing to load it wastes the wait.
    if (file) await sendAndLoad(deck, file);
  }


  async function sendAndLoad(deck: DeckNumber, file: File) {
    setStaging(`Sending ${file.name}...`);
    const sent = await api.sendUpload(file, (fraction) => {
      setStaging(`Sending ${file.name} - ${Math.round(fraction * 100)}%`);
    });
    if (!sent.ok) {
      setStaging(`${file.name}: ${sent.detail ?? 'could not be sent'}`);
      return;
    }
    setStaging(null);
    const loaded = await api.deck(deck).load(sent.path);
    if (!loaded.ok) setStaging(`${file.name} was sent, but would not load`);
  }

  const decks = [
    { key: 1 as const, deck: deckA },
    { key: 2 as const, deck: deckB },
  ];

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
        message: `${state.name ?? 'The current recording'} will be deleted. Download it from Settings `
          + 'first if you want to keep it.',
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
        /** No pager: both decks are on screen, so there is nowhere to swipe to. */
        page={null}
        showDeckMenus={false}
        onSettings={onOpenSettings}
        timecodeSide={null}
        passthrough={false}
        onTimecodeSide={() => {}}
        onPassthrough={() => {}}
        record={(
          <RecordButton
            recording={record.data?.recording ?? false}
            elapsedSeconds={record.data?.elapsedSeconds ?? 0}
            onPress={() => void toggleRecording()}
          />
        )}
      />

      <div className={styles.decks}>
        {decks.map(({ key, deck }) => (
          <div className={styles.deck} key={key}>
            {/* Load targets this deck rather than opening a screen: the browser is already visible. */}
            <DeckPanel
              deck={key}
              state={deck}
              track={deck.track}
              layout="stacked"
              onLoad={() => {}}
              onDropTrack={(dropped) => void dropOnDeck(key, dropped)}
            />
          </div>
        ))}
      </div>

      <div className={styles.browser}>
        <BrowserPane status={staging} />
      </div>
      {dialog}
    </div>
  );
}
