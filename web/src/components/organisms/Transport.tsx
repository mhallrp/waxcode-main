import { Button } from '../atoms/Button';
import { css } from '../../styles/css';

const styles = css('Transport', {
  transport: `
    display: flex; gap: var(--gap-sm);
    & button {
      flex: 1;
      height: var(--row);
      padding: 0 8px;
      /* A raised surface, not a hollow outline - these are the controls the hand goes to. */
      background: var(--surface2);
      font: 600 15px/1 var(--mono);
      letter-spacing: 1.1px;
    }
  `,
  cue: `
    /* Green text AND border, as the app's cue buttons are. */
    color: var(--play); border-color: var(--play);
  `,
  play: `
    color: var(--play); border-color: var(--play);
    display: flex; align-items: center; justify-content: center;
  `,
  /* The desktop surface. Geometry is untouched - only the paint. See the flat rules below. */
  flat: ``,
}, `
  /** Written LAST and scoped to .transport, which makes it (0,1,1) against the bare .cue's (0,1,0). */
  $transport button:disabled {
    color: var(--ink-faint);
    border-color: var(--hairline);
    background: transparent;
    cursor: default;
  }

  /** THE DESKTOP SURFACE. */
  $transport.$flat { gap: 4px; }
  $transport.$flat button {
    border: 0;
    border-radius: 4px;
    background: var(--surface2);
    color: var(--ink-dim);
    font: 600 13px/1 var(--mono);
    letter-spacing: 0.8px;
  }
  $transport.$flat button:hover:not(:disabled) { color: var(--ink); }
  $transport.$flat $play { background: var(--play); color: var(--background); }
  $transport.$flat button:disabled { background: var(--surface2); color: var(--ink-faint); }
`);

interface Props {
  playing: boolean;
  disabled?: boolean;
  onCue: () => void;
  onCuePlay: () => void;
  onPlayPause: () => void;
  /** The desktop surface: flat and monochrome, with the deck colour kept for state. */
  flat?: boolean;
}

/** CUE, CUEP and play/pause. Knows whether a deck is playing; knows nothing about which deck. */
export function Transport({ playing, disabled, onCue, onCuePlay, onPlayPause, flat }: Props) {
  return (
    <div className={flat ? `${styles.transport} ${styles.flat}` : styles.transport}>
      <Button className={styles.cue} disabled={disabled} onClick={onCue}>CUE</Button>
      <Button className={styles.cue} disabled={disabled} onClick={onCuePlay}>CUEP</Button>
      <Button
        className={styles.play}
        disabled={disabled}
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={onPlayPause}
      >
        {/* A filled disc with the glyph knocked OUT of it (fill-rule: evenodd), not a bare
            triangle on nothing - which is what makes it read as a button face rather than a mark. */}
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
          {playing
            ? <path fillRule="evenodd" d="M12 2a10 10 0 100 20 10 10 0 000-20zM9.8 8h1.6v8H9.8zm3 0h1.6v8h-1.6z" />
            : <path fillRule="evenodd" d="M12 2a10 10 0 100 20 10 10 0 000-20zM9.8 7.8l6.4 3.8a.45.45 0 010 .8l-6.4 3.8a.45.45 0 01-.7-.4V8.2a.45.45 0 01.7-.4z" />}
        </svg>
      </Button>
    </div>
  );
}
