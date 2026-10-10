import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { css } from '../../styles/css';

const styles = css('Sheet', {
  sheet: `
    position: fixed;
    /** All four sides, so the panel reaches the screen edges and its CONTENT keeps clear of the island and the home indicator */
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    z-index: 10;
    /** Presented, not swapped in. */
    transform: translateY(100%);
    transition: transform 320ms cubic-bezier(0.32, 0.72, 0, 1);
    @media (prefers-reduced-motion: reduce) { transition: none; }
  `,
  open: `
    transform: translateY(0);
  `,
  head: `
    /** No fill and no rule under it. */
    z-index: 1;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    /** 44px of control, sat 16px down from the top edge. */
    height: calc(44px + 16px + env(safe-area-inset-top, 0px));
    padding-top: calc(16px + env(safe-area-inset-top, 0px));
  `,
  title: `
    font: 500 13px/1 var(--mono);
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--ink);
  `,
  done: `
    /** A pill, not bare text: it is the only way out of the panel, and at this size a word alone reads as a caption rather than a control. */
    position: absolute;
    right: calc(16px + env(safe-area-inset-right, 0px));
    padding: 9px 20px;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    background: transparent;
    color: var(--ink);
    font: 16px var(--sans);
  `,
  body: `
    flex: 1; min-height: 0;
  `,
});

interface Props {
  title: string;
  /** Drives the slide. The caller keeps this mounted while it plays out - see usePresented. */
  shown: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** A full-screen panel presented over whatever is behind it, with the page beneath left in place. */
export function Sheet({ title, shown, onClose, children }: Props) {
  // Escape closes it. Cheap on a phone, and the only way out on a keyboard.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={shown ? `${styles.sheet} ${styles.open}` : styles.sheet}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <header className={styles.head}>
        <span className={styles.title}>{title}</span>
        <button type="button" className={styles.done} onClick={onClose}>Done</button>
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
