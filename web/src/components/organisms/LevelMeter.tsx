import { meterFraction } from '../../lib/signal';
import { css } from '../../styles/css';

const styles = css('LevelMeter', {
  meter: `
    margin-bottom: 10px;
  `,
  label: `
    display: block; margin-bottom: 4px; color: var(--ink-faint); font: 500 10px/1 var(--mono); letter-spacing: 1px;
  `,
  track: `
    position: relative;
    height: 8px;
    border-radius: 4px;
    background: var(--bg);
    overflow: hidden;
  `,
  floor: `
    /* Everything below the decode floor, shown as dead space rather than hidden. */
    position: absolute; inset: 0 auto 0 0; background: var(--hairline);
  `,
  fill: `
    position: absolute; inset: 0 auto 0 0; background: var(--accent);
  `,
  reference: `
    position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ink);
  `,
});

interface Props {
  label: string;
  level: number;
  /** Below this nothing can be decoded. */
  floor: number;
  /** Where the box has set its own threshold, right now. */
  reference: number;
}

/** One channel, with the undecodable floor and the live threshold marked on it. */
export function LevelMeter({ label, level, floor, reference }: Props) {
  return (
    <div className={styles.meter}>
      <span className={styles.label}>{label}</span>
      <div className={styles.track}>
        <div className={styles.floor} style={{ width: `${meterFraction(floor) * 100}%` }} />
        <div className={styles.fill} style={{ width: `${meterFraction(level) * 100}%` }} />
        {/* The moving line IS the evidence that nothing needs calibrating by hand. */}
        <div className={styles.reference} style={{ left: `${meterFraction(reference) * 100}%` }} />
      </div>
    </div>
  );
}
