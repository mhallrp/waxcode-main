import type { ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('Hint', {
  hint: `
    margin: 14px 0 0;
    max-width: 58ch;
    color: var(--ink-faint);
    font-size: 12px;
    line-height: 1.5;
  `,
});

/** Explanatory text under a control. Never an error - see ErrorText. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className={styles.hint}>{children}</p>;
}
