import type { ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('Value', {
  value: `
    font: 500 14px/1 var(--mono); color: var(--ink);
  `,
});

/** A read-back value. Monospaced, because these are mostly numbers and names that get compared. */
export function Value({ children }: { children: ReactNode }) {
  return <b className={styles.value}>{children}</b>;
}
