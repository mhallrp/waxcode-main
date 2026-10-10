import type { ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('Label', {
  label: `
    display: block;
    margin-bottom: 10px;
    color: var(--ink-faint);
    font: 500 10px/1 var(--mono);
    letter-spacing: 1px;
    text-transform: uppercase;
  `,
});

/** A small capitalised heading above a group. The app's section marker. */
export function Label({ children }: { children: ReactNode }) {
  return <span className={styles.label}>{children}</span>;
}
