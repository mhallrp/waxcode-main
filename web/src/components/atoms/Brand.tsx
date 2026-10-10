import { css } from '../../styles/css';

const styles = css('Brand', {
  brand: `
    display: flex; align-items: center; gap: 9px; flex: 0 0 auto;
    /** Not a button and not a link - it goes nowhere. */
    color: var(--ink);
    user-select: none;
  `,
  mark: `
    /** The real app icon, not a redrawing of it. */
    flex: 0 0 auto;
    display: block;
    width: 22px;
    height: 22px;
    border-radius: 5px;
  `,
  word: `
    font: 700 14px/1 var(--mono); letter-spacing: 2px; text-transform: uppercase;
  `,
});

/** The box's own mark and name, from the same icon the browser tab and home screen use. */
export function Brand() {
  return (
    <span className={styles.brand}>
      <img className={styles.mark} src="/icon-192.png" alt="" aria-hidden="true" />
      <span className={styles.word}>Waxcode</span>
    </span>
  );
}
