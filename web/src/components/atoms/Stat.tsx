import type { ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('Stat', {
  stat: `
    display: flex; flex-direction: column; gap: 3px;
  `,
  label: `
    font-style: normal;
    font-size: 9px;
    letter-spacing: 1.1px;
    text-transform: uppercase;
    color: var(--ink-faint);
  `,
  value: `
    font: 600 20px/1 var(--mono);
    /* Tabular figures, or a counting clock jiggles its own width every second. */
    font-variant-numeric: tabular-nums;
    color: var(--accent);
    white-space: nowrap;
  `,
  low: `
    /* Running out. Amber rather than red: it is a warning to mix, not a fault. */
    color: var(--alert);
  `,
});

interface Props {
  label: string;
  children: ReactNode;
  /** 'low' turns the value amber - used for the last thirty seconds of a playing track. */
  tone?: 'low';
}

/** A small caption over a value. The deck's way of showing BPM, time remaining and so on. */
export function Stat({ label, children, tone }: Props) {
  return (
    <span className={styles.stat}>
      <i className={styles.label}>{label}</i>
      <b className={tone === 'low' ? `${styles.value} ${styles.low}` : styles.value}>{children}</b>
    </span>
  );
}
