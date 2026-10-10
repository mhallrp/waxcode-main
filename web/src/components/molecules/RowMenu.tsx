import { useEffect } from 'react';
import { css } from '../../styles/css';

const styles = css('RowMenu', {
  backdrop: `
    /** Catches the click that dismisses, and nothing else. */
    position: fixed; inset: 0; z-index: 40;
  `,
  menu: `
    position: fixed; z-index: 41;
    min-width: 170px;
    padding: 4px;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface2);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  `,
  item: `
    display: block; width: 100%;
    padding: 8px 10px;
    border: 0; border-radius: 4px;
    background: none;
    color: var(--ink);
    font: 500 13px/1 var(--sans);
    text-align: left;
    cursor: pointer;
    &:hover { background: var(--bg); }
  `,
  destructive: `
    color: var(--alert);
  `,
});

export interface RowMenuItem {
  label: string;
  destructive?: boolean;
  onSelect: () => void;
}

interface Props {
  at: { x: number; y: number };
  items: RowMenuItem[];
  onClose: () => void;
}

/** A small menu where the pointer is - what a right-click on a row opens. */
export function RowMenu({ at, items, onClose }: Props) {
  useEffect(() => {
    // Escape as well as a click away - a menu that can only be dismissed by clicking is a trap for anyone working from the keyboard.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Clamped so a right-click near the bottom or right edge does not open a menu half off screen. */
  const left = Math.min(at.x, window.innerWidth - 190);
  const top = Math.min(at.y, window.innerHeight - (items.length * 34 + 16));

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className={styles.menu} style={{ left, top }} role="menu">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.destructive ? `${styles.item} ${styles.destructive}` : styles.item}
            onClick={() => { onClose(); item.onSelect(); }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
