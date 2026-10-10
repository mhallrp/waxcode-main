/** How the toolbar's colours hand off as a swipe moves. */

export interface WipeState {
  wipe: number;
  before: string;
  after: string;
}

export interface ToolbarWipes {
  deckA: WipeState;
  deckB: WipeState;
  mix: WipeState;
  timecode: WipeState;
  /** The side picker fades out on A+B and stops being tappable - it can only ever set one deck. */
  timecodeOpacity: number;
  timecodeDisabled: boolean;
}

const clamp = (value: number) => Math.max(0, Math.min(value, 1));

export function toolbarWipes(position: number): ToolbarWipes {
  /** Two separate runs, deliberately. */
  const progress = clamp(position);
  const mixProgress = clamp(position - 1);
  const leavingB = mixProgress > 0;

  return {
    deckA: { wipe: progress, before: 'var(--deck-a)', after: 'var(--ink-faint)' },

    deckB: leavingB
      ? { wipe: mixProgress, before: 'var(--deck-b)', after: 'var(--ink-faint)' }
      : { wipe: progress, before: 'var(--ink-faint)', after: 'var(--deck-b)' },

    // Neutral ink, not a deck accent: A+B is not a deck, and borrowing either colour would read as that deck being selected.
    mix: { wipe: mixProgress, before: 'var(--ink-faint)', after: 'var(--ink)' },

    timecode: leavingB
      ? { wipe: mixProgress, before: 'var(--deck-b)', after: 'var(--ink-faint)' }
      : { wipe: progress, before: 'var(--deck-a)', after: 'var(--deck-b)' },

    // Faded in place rather than removed: taking it out would shift the whole bar mid-swipe.
    timecodeOpacity: 1 - mixProgress,
    timecodeDisabled: mixProgress >= 1,
  };
}

/** Writes one wipe onto an element. Imperative because this runs with a finger, every frame. */
export function applyWipe(node: HTMLElement | null, state: WipeState) {
  if (!node) return;
  node.style.setProperty('--wipe', String(state.wipe));
  node.style.setProperty('--wipe-before', state.before);
  node.style.setProperty('--wipe-after', state.after);
}
