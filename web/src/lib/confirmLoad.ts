import { isDeckPlaying } from './deckPlaying';
import type { ConfirmOptions } from '../components/organisms/ConfirmDialog';
import type { DeckNumber } from '../types';

/** The question to ask before loading over a deck that is playing, or null if there is nothing to ask. */
export function loadOverPlayingWarning(deck: DeckNumber): ConfirmOptions | null {
  if (!isDeckPlaying(deck)) return null;
  return {
    title: `Deck ${deck} is playing`,
    message: 'Loading now will stop it. Anyone listening will hear it cut out.',
    confirm: 'Load anyway',
    cancel: 'Cancel',
    /** Destructive: it interrupts a live output, which is the one thing in this app that cannot be undone */
    destructive: true,
  };
}
