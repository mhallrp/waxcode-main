import type { ReactNode } from 'react';
import { Value } from '../atoms/Value';
import { css } from '../../styles/css';

const styles = css('Reading', {
  reading: `
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 11px 0;
    border-bottom: 1px solid var(--hairline);
    font-size: 14px;
    color: var(--ink-dim);
  `,
});

/** A name on the left, a value on the right. The app's way of stating a fact. */
export function Reading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.reading}>
      <span>{label}</span>
      <Value>{children}</Value>
    </div>
  );
}
