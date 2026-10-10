import type { ReactNode } from 'react';
import { clock } from '../../lib/format';
import { css } from '../../styles/css';

const styles = css('MixRow', {
  row: `
    /** Each row takes half the card and puts its content at the TOP of that half */
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    gap: 10px;
    padding: 18px 0;
  `,
  head: `
    display: flex; align-items: baseline; gap: 12px;
  `,
  letter: `
    font: 700 22px/1 var(--mono);
    $row[data-mix-deck='1'] & { color: var(--deck-a); }
    $row[data-mix-deck='2'] & { color: var(--deck-b); }
  `,
  meta: `
    /* min-width: 0 so a long title ellipsises rather than pushing the readout off the row. */
    min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px;
  `,
  title: `
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600;
  `,
  sub: `
    color: var(--ink-dim); font-size: 12px; min-height: 1.2em;
  `,
  readout: `
    display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: 0 0 auto;
    & b {
      font: 600 26px/1 var(--mono);
      font-variant-numeric: tabular-nums;
      color: var(--ink);
    }
  `,
  low: `
    color: var(--deck-b);
  `,
}, `
  $readout i {
    font: 13px/1 var(--mono);
    font-style: normal;
    font-variant-numeric: tabular-nums;
    color: var(--ink-dim);
  }
`);

interface Props {
  deck: 1 | 2;
  title: string;
  sub: string;
  /** Seconds remaining, or null when there is nothing loaded. */
  remain: number | null;
  playing: boolean;
  bpm: number | null;
  waveform: ReactNode;
}

/** One deck's line on the A+B page: who it is, what is on it, and how long is left. */
export function MixRow({ deck, title, sub, remain, playing, bpm, waveform }: Props) {
  // Amber inside the last thirty seconds while playing - the same threshold the deck cards use.
  const low = playing && remain !== null && remain <= 30;

  return (
    <section className={styles.row} data-mix-deck={deck}>
      <div className={styles.head}>
        <span className={styles.letter}>{deck === 1 ? 'A' : 'B'}</span>
        <div className={styles.meta}>
          <span className={styles.title}>{title}</span>
          <span className={styles.sub}>{sub}</span>
        </div>
        {/* The number every mix decision is made against, so it is the largest thing in the row. */}
        <span className={styles.readout}>
          <b className={low ? styles.low : undefined}>{remain === null ? '--:--' : clock(remain)}</b>
          <i>{bpm ? bpm.toFixed(1) : ''}</i>
        </span>
      </div>
      {waveform}
    </section>
  );
}
