import { Icon } from '../../components/atoms/Icon';
import { PopupMenu } from '../../components/molecules/PopupMenu';
import { Breadcrumbs } from '../../components/organisms/Breadcrumbs';
import type { SortField } from '../../lib/library';
import { css } from '../../styles/css';

const styles = css('LibraryHead', {
  head: `
    /** The rule under the bar spans the screen, not just the padded content */
    display: flex;
    align-items: center;
    gap: 14px;
    flex: 0 0 auto;
    border-bottom: 1px solid var(--hairline);
    margin: 0 calc(-14px - env(safe-area-inset-right, 0px)) 4px calc(-14px - env(safe-area-inset-left, 0px));
    padding: 0 calc(14px + env(safe-area-inset-right, 0px)) 10px calc(14px + env(safe-area-inset-left, 0px));
  `,
  back: `
    /* Sized to the sidebar, so the breadcrumb begins exactly where the list below it does. */
    width: 220px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 0;
    border: 0;
    background: transparent;
    color: var(--ink);
    font: 500 15px/1 var(--sans);
  `,
  icon: `
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    padding: 10px;
    border: 0;
    background: transparent;
    color: var(--ink-dim);
  `,
  starOn: `
    color: var(--accent);
  `,
});

interface Props {
  trail: string[];
  onJump: (depth: number) => void;
  /** Absent in the desktop browser pane, which is never covering anything to go back from. */
  onBack?: () => void;
  /** Hidden at a device's root - favouriting "the whole stick" is not a shortcut. */
  showFavourite: boolean;
  isFavourite: boolean;
  onFavourite: () => void;
  /** Null when nothing is imposed on the folder - which is its arranged order, and the state it rests in. */
  sort: SortField | null;
  onSort: (sort: SortField | null) => void;
  ascending: boolean;
  onAscending: (ascending: boolean) => void;
}

const SORTS = [
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'bpm', label: 'BPM' },
] as const satisfies ReadonlyArray<{ value: SortField; label: string }>;

/** One bar, not two: Back is sized to the sidebar so the breadcrumb starts where the list does. */
export function LibraryHead(props: Props) {
  return (
    <div className={styles.head}>
      {props.onBack && (
      <button type="button" className={styles.back} onClick={props.onBack}>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
          strokeWidth="2.4" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        Back
      </button>
      )}

      <Breadcrumbs trail={props.trail} onJump={props.onJump} />

      {props.showFavourite && (
        <button
          type="button"
          className={props.isFavourite ? `${styles.icon} ${styles.starOn}` : styles.icon}
          aria-label="Add this folder to Favourites"
          aria-pressed={props.isFavourite}
          onClick={props.onFavourite}
        >
          <Icon name="star" filled={props.isFavourite} />
        </button>
      )}

      {/* A menu, not a row of buttons: sorting is a preference, not a destination. */}
      <PopupMenu
        variant="icon"
        ariaLabel="Sort"
        label={(
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
            strokeWidth="1.7" aria-hidden="true">
            <path d="M7 20V4m0 0L4 7.5M7 4l3 3.5M17 4v16m0 0l3-3.5M17 20l-3-3.5" />
          </svg>
        )}
        options={[
          ...SORTS,
          { value: props.ascending ? 'desc' : 'asc', label: props.ascending ? 'Z to A' : 'A to Z' },
        ]}
        value={props.sort}
        onChange={(value) => {
          if (value === 'asc' || value === 'desc') { props.onAscending(value === 'asc'); return; }
          /** Choosing the sort that is already on turns it OFF, back to the arranged order. */
          props.onSort(value === props.sort ? null : (value as SortField));
        }}
      />
    </div>
  );
}
