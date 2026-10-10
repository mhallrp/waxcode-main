import type { ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('Badge', {
  badge: `
    flex: 0 0 auto;
    color: var(--accent);
    font: 500 11px/1 var(--mono);
    letter-spacing: 1px;
  `,
});

/** A one-word state marker, like IN USE. */
export function Badge({ children }: { children: ReactNode }) {
  return <span className={styles.badge}>{children}</span>;
}
