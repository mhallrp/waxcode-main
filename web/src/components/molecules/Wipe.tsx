import { forwardRef, type ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('Wipe', {
  wipe: `
    /** inline-grid with both layers in the same cell, so they stack without absolute positioning and the element still sizes itself to its content. */
    display: inline-grid; align-items: center;
    & > * {
      grid-area: 1 / 1;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      white-space: nowrap;
    }
  `,
  before: `
    /** Complementary clips: \`before\` keeps everything RIGHT of the wipe edge, \`after\` everything left of it. */
    color: var(--wipe-before, var(--ink-faint));
    clip-path: inset(0 0 0 calc(var(--wipe, 0) * 100%));
  `,
  after: `
    color: var(--wipe-after, var(--ink));
    clip-path: inset(0 calc(100% - var(--wipe, 0) * 100%) 0 0);
  `,
});

/** A left-to-right colour reveal, driven by CSS custom properties set from outside. */
export const Wipe = forwardRef<HTMLSpanElement, { children: ReactNode }>(
  function Wipe({ children }, ref) {
    return (
      <span className={styles.wipe} ref={ref}>
        <span className={styles.before}>{children}</span>
        <span className={styles.after} aria-hidden="true">{children}</span>
      </span>
    );
  },
);
