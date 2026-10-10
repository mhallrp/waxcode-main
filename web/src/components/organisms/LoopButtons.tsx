import { css } from '../../styles/css';

const styles = css('LoopButtons', {
  loops: `
    display: flex; gap: var(--gap-sm);
  `,
  loop: `
    flex: 1;
    /* The same row height as every other control on the card, so the two columns line up. */
    height: var(--row);
    padding: 0 6px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    background: transparent;
    color: var(--accent);
    font: 500 15px/1 var(--mono);
    &:disabled {
      border-color: var(--hairline);
      color: var(--ink-faint);
      background: var(--surface2);
      cursor: default;
    }
  `,
  on: `
    background: var(--accent); color: var(--background);
  `,
  flat: ``,
}, `
  /** Flat and monochrome at rest; the deck's colour only on the loop that is RUNNING. */
  $loops.$flat { gap: 4px; }
  $loops.$flat $loop {
    border: 0;
    border-radius: 4px;
    background: var(--surface2);
    color: var(--ink-dim);
    font: 600 13px/1 var(--mono);
  }
  $loops.$flat $loop:hover:not(:disabled) { color: var(--ink); }
  $loops.$flat $on { background: var(--accent); color: var(--background); }
  $loops.$flat $loop:disabled { background: var(--surface2); color: var(--ink-faint); }
`);

const LENGTHS = [1, 2, 4, 8] as const;

interface Props {
  /** The loop length in beats that is currently active, if any. */
  activeBeats: number | null;
  disabled?: boolean;
  onLoop: (beats: number) => void;
  /** The desktop surface: flat and monochrome, with the deck colour kept for the active loop. */
  flat?: boolean;
}

export function LoopButtons({ activeBeats, disabled, onLoop, flat }: Props) {
  return (
    <div className={flat ? `${styles.loops} ${styles.flat}` : styles.loops}>
      {LENGTHS.map((beats) => (
        <button
          key={beats}
          type="button"
          disabled={disabled}
          aria-pressed={activeBeats === beats}
          className={activeBeats === beats ? `${styles.loop} ${styles.on}` : styles.loop}
          onClick={() => onLoop(beats)}
        >
          {beats}
        </button>
      ))}
    </div>
  );
}
