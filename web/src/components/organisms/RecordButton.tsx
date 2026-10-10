import { clock } from '../../lib/format';
import { css } from '../../styles/css';

const styles = css('RecordButton', {
  button: `
    /** The elapsed time lives inside the button, beside the glyph. */
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 10px;
    border: 0;
    background: transparent;
    color: var(--ink);
  `,
  rolling: `
    color: var(--recording);
  `,
  time: `
    font: 600 13px/1 var(--mono); font-variant-numeric: tabular-nums;
  `,
});

interface Props {
  recording: boolean;
  elapsedSeconds: number;
  onPress: () => void;
}

/** A ring around a dot when idle, a stop square while rolling. The elapsed time sits beside it. */
export function RecordButton({ recording, elapsedSeconds, onPress }: Props) {
  return (
    <button
      type="button"
      className={recording ? `${styles.button} ${styles.rolling}` : styles.button}
      aria-label={recording ? 'Stop recording' : 'Record the mix'}
      aria-pressed={recording}
      onClick={onPress}
    >
      {recording ? (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
          strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
        </svg>
      )}
      {/* Only while rolling: an idle 0:00 reads as a stalled recording. */}
      {recording && <span className={styles.time}>{clock(elapsedSeconds)}</span>}
    </button>
  );
}
