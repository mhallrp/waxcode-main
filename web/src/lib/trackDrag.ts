/** How a dragged track identifies itself to a deck. */
export const BOX_TRACK = 'application/x-waxcode-track';

/** A row being dragged within a track list, to put it somewhere else in that list. */
export const LIST_ROW = 'application/x-waxcode-row';

/** True when the drag carries a file from the desktop, rather than anything of ours. */
export const carriesDesktopFile = (types: readonly string[]) => types.includes('Files');

/** Anything a deck knows how to accept. */
export const carriesTrack = (types: readonly string[]) =>
  carriesDesktopFile(types) || types.includes(BOX_TRACK)
  /** An EMPTY list is accepted on purpose. */
  || types.length === 0;
