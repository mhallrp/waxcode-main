import { Padlock } from '../atoms/Padlock';
import { css } from '../../styles/css';

const styles = css('LockToggles', {
  toggles: `
    display: flex; gap: var(--gap-sm);
  `,
  toggle: `
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    height: var(--row);
    gap: 8px;
    padding: 0 8px;
    border: 1px solid var(--ink-dim);
    border-radius: var(--radius);
    background: transparent;
    color: var(--ink-dim);
    font: 700 15px/1 var(--sans);
    &:disabled { border-color: var(--hairline); color: var(--ink-faint); cursor: default; }
  `,
  on: `
    color: var(--accent); border-color: var(--accent);
  `,
  flat: ``,
}, `
  /** Same again: these are OFF most of the time */
  $toggles.$flat { gap: 4px; }
  $toggles.$flat $toggle {
    border: 0;
    border-radius: 4px;
    background: var(--surface2);
    color: var(--ink-dim);
    font: 600 12px/1 var(--sans);
  }
  $toggles.$flat $toggle:hover:not(:disabled) { color: var(--ink); }
  $toggles.$flat $on { background: var(--accent); color: var(--background); }
  $toggles.$flat $toggle:disabled { background: var(--surface2); color: var(--ink-faint); }
`);

interface Props {
  positionLock: boolean;
  keyLock: boolean;
  disabled?: boolean;
  onPositionLock: (on: boolean) => void;
  onKeyLock: (on: boolean) => void;
  /** The desktop surface: flat and monochrome, with the deck colour kept for an engaged lock. */
  flat?: boolean;
  /** Whether the key lock experiment is switched on for this box. */
  keyLockAvailable?: boolean;
}

/** Position and Key. */
export function LockToggles({ positionLock, keyLock, disabled, onPositionLock, onKeyLock, flat, keyLockAvailable = false }: Props) {
  return (
    <div className={flat ? `${styles.toggles} ${styles.flat}` : styles.toggles}>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={positionLock}
        className={positionLock ? `${styles.toggle} ${styles.on}` : styles.toggle}
        onClick={() => onPositionLock(!positionLock)}
      >
        <Padlock locked={positionLock} />Position
      </button>
      {keyLockAvailable && (
        <button
          type="button"
          disabled={disabled}
          aria-pressed={keyLock}
          className={keyLock ? `${styles.toggle} ${styles.on}` : styles.toggle}
          onClick={() => onKeyLock(!keyLock)}
        >
          <Padlock locked={keyLock} />Key
        </button>
      )}
    </div>
  );
}
