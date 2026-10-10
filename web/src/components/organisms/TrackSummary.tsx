import { Stat } from '../atoms/Stat';
import { clock, bpm as formatBpm } from '../../lib/format';
import { css } from '../../styles/css';

const styles = css('TrackSummary', {
  title: `
    font: 700 24px/1.22 var(--sans); color: var(--ink); overflow-wrap: anywhere;
  `,
  idle: `
    /* "No track" is the idle SUBTITLE in the app, not a title - so it is faint, not full ink. */
    color: var(--ink-faint);
  `,
  artist: `
    /* min-height reserves the line, so a card with no artist does not sit taller than one with. */
    margin-top: 3px; min-height: 1.2em; font: 400 18px/1.2 var(--sans); color: var(--ink-dim);
  `,
  stats: `
    display: flex; gap: 30px; margin-top: 14px;
  `,
  /** The wide variant: title block left, readouts right, on ONE row - Traktor's header, and the reason is the same. */
  wide: `
    display: flex; align-items: flex-start; gap: var(--gap); min-width: 0;
  `,
  wideTitles: `
    flex: 1 1 auto; min-width: 0;
  `,
  wideTitle: `
    font: 700 17px/1.2 var(--sans); color: var(--ink);
    /** Clipped rather than wrapped: two decks side by side must stay the same height whatever they are called */
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  `,
  wideArtist: `
    margin-top: 2px; min-height: 1.2em; font: 400 13px/1.2 var(--sans); color: var(--ink-dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  `,
  wideStats: `
    display: flex; gap: 18px; flex: 0 0 auto; margin: 0;
  `,
  warning: `
    margin: 14px 0 0;
    max-width: 44ch;
    color: var(--warning);
    font-size: 12px;
    line-height: 1.4;
  `,
});

interface Props {
  /** Nothing loaded. Hides the readouts - dashes on an idle deck read as stuck rather than empty. */
  empty?: boolean;
  /** A real record going through the box. Shows its own title and hides everything track-shaped. */
  passthrough?: boolean;
  title: string;
  artist: string;
  bpm: number | null;
  /** Live position, so the countdown is derived rather than read from a field that lags a decode. */
  position: number;
  duration: number | null;
  playing: boolean;
  /** Non-null and rising means the platter is turning but the position cannot be decoded. */
  unreadableSeconds: number | null;
  /** One row rather than a stack - the desktop layout, where vertical room belongs to the waveform. */
  wide?: boolean;
}

/** What is loaded and where it is. Pure display - every value arrives as a prop. */
export function TrackSummary({
  empty, passthrough, title, artist, bpm, position, duration, playing, unreadableSeconds, wide,
}: Props) {
  /** "left / total", derived from the track's own length and the live position. */
  const left = duration !== null ? Math.max(0, duration - position) : null;
  // Guarded on PLAYING: a deck parked near the end of a track is not running out.
  const low = playing && left !== null && left > 0 && left < 30;
  /** Four seconds, not two: brief dropouts are normal when a needle lands, and the same gates as the readouts this sits under */
  const unreadable = !passthrough && !empty && (unreadableSeconds ?? 0) >= 4;

  const readouts = !empty && !passthrough && (
    <div className={wide ? styles.wideStats : styles.stats}>
      <Stat label="BPM">{formatBpm(bpm)}</Stat>
      <Stat label="Remain" tone={low ? 'low' : undefined}>
        {duration === null ? '--:-- / --:--' : `${clock(left)} / ${clock(duration)}`}
      </Stat>
    </div>
  );

  if (wide) {
    return (
      <div>
        <div className={styles.wide}>
          <div className={styles.wideTitles}>
            <div className={empty && !passthrough ? `${styles.wideTitle} ${styles.idle}` : styles.wideTitle}>
              {passthrough ? 'Passthrough active' : title}
            </div>
            <div className={styles.wideArtist}>{passthrough ? '' : artist}</div>
          </div>
          {readouts}
        </div>
        {unreadable && (
          <p className={styles.warning}>
            The platter is turning but the position can&rsquo;t be read. Check the needle, and that
            the record matches the timecode side set above.
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Only a real loaded title, and "Passthrough active", are full ink - "No track" is the idle
          SUBTITLE in the app, not a title. */}
      <div className={empty && !passthrough ? `${styles.title} ${styles.idle}` : styles.title}>
        {passthrough ? 'Passthrough active' : title}
      </div>
      <div className={styles.artist}>{passthrough ? '' : artist}</div>
      {/* Readouts describe a loaded track, so an idle deck shows none rather than a row of dashes. */}
      {readouts}
      {unreadable && (
        <p className={styles.warning}>
          The platter is turning but the position can&rsquo;t be read. Check the needle, and that the
          record matches the timecode side set above.
        </p>
      )}
    </div>
  );
}
