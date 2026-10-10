import type { ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('Notice', {
  notice: `
    margin-bottom: 18px;
    padding: 12px 14px;
    border: 1px solid var(--hairline);
    border-left: 2px solid var(--warning);
    border-radius: var(--radius);
    color: var(--ink-dim);
    font-size: 12px;
    line-height: 1.5;
    & b { display: block; margin-bottom: 4px; color: var(--ink); font: 500 13px/1.4 var(--mono); }
  `,
});

/** Something the box is doing that needs explaining, and how it ends. */
export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.notice}>
      <b>{title}</b>
      <span>{children}</span>
    </div>
  );
}
