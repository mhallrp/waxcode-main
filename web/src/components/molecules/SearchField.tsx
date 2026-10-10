import { css } from '../../styles/css';

const styles = css('SearchField', {
  field: `
    /** Rides above the keyboard rather than under it, leaving the list behind it alone. */
    position: absolute;
    left: 12px;
    right: 0;
    bottom: calc(6px + var(--keyboard-inset, 0px));
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 46px;
    padding: 0 16px;
    border-radius: 23px;
    background: var(--surface2);
    color: var(--ink-faint);
    box-shadow: 0 6px 20px rgb(0 0 0 / 45%);
    & input {
      flex: 1;
      min-width: 0;
      border: 0;
      background: transparent;
      color: var(--ink);
      /* 16px, or iOS zooms the page when the field takes focus. */
      font: 16px var(--sans);
    }
    & input:focus { outline: none; }
    & input::-webkit-search-cancel-button { display: none; }
  `,
  clear: `
    display: flex; padding: 0; border: 0; background: transparent; color: var(--ink-faint);
  `,
});

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/** Floats at the foot of the list rather than sitting above it. */
export function SearchField({ value, onChange, placeholder = 'Search tracks or artists' }: Props) {
  return (
    <div className={styles.field}>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
        strokeWidth="1.9" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
      </svg>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value !== '' && (
        <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => onChange('')}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm3.4 12.1a.9.9 0 11-1.3 1.3L12 13.3l-2.1 2.1a.9.9 0 11-1.3-1.3l2.1-2.1-2.1-2.1a.9.9 0 111.3-1.3l2.1 2.1 2.1-2.1a.9.9 0 111.3 1.3L13.3 12z" />
          </svg>
        </button>
      )}
    </div>
  );
}
