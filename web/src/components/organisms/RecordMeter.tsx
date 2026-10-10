import { meterFraction } from '../../lib/signal';
import { css } from '../../styles/css';
import type { RecordLevelState } from '../../lib/useRecordLevel';

/** Above this the input is close enough to clipping to say so. */
const HOT = 0.89;

const styles = css('RecordMeter', {
  meter: `
    /** Space ABOVE as well as below. */
    margin: var(--gap) 0 var(--gap-sm);
  `,
  row: `
    display: flex; align-items: center; gap: 8px; margin-bottom: 4px;
  `,
  channel: `
    width: 9px; flex: 0 0 auto; color: var(--ink-faint); font: 500 10px/1 var(--mono);
  `,
  track: `
    position: relative; flex: 1; height: 8px; border-radius: 4px; background: var(--bg); overflow: hidden;
  `,
  fill: `
    position: absolute; inset: 0 auto 0 0; background: var(--accent);
    /* Only the fall is eased. A rise must land on the frame it arrived, or a transient is lost. */
    transition: width 90ms linear;
  `,
  hot: `
    background: var(--alert);
  `,
  caption: `
    color: var(--ink-faint); font-size: 11px;
  `,
});

/** The record input, so somebody can see a signal before committing to a take. */
export function RecordMeter({ level }: { level: RecordLevelState }) {
  const channels: Array<['L' | 'R', number]> = [['L', level.left], ['R', level.right]];
  const hot = level.left >= HOT || level.right >= HOT;
  const silent = level.live && level.left === 0 && level.right === 0;

  return (
    <div className={styles.meter}>
      {channels.map(([name, value]) => (
        <div className={styles.row} key={name}>
          <span className={styles.channel}>{name}</span>
          <div className={styles.track}>
            <div
              className={value >= HOT ? `${styles.fill} ${styles.hot}` : styles.fill}
              style={{ width: `${meterFraction(value) * 100}%` }}
            />
          </div>
        </div>
      ))}
      <span className={styles.caption}>
        {!level.live && 'Checking the input…'}
        {hot && 'Too hot — turn the mixer down or it will distort.'}
        {!hot && silent && 'No signal. Check the mixer is connected to the record input.'}
        {!hot && !silent && level.live && 'Signal on the record input.'}
      </span>
    </div>
  );
}
