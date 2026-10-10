import { useEffect, useRef } from 'react';
import {
  OVERVIEW_BUCKETS, downsample, drawPeaks, fitCanvas, runInStart, type Peak,
} from '../../lib/waveform';
import { tokens } from '../../styles/tokens';
import { NUDGE_SECONDS, type BeatGrid } from '../../lib/useBeatGrid';
import { createFractionEase } from '../../lib/easeFraction';
import { css } from '../../styles/css';

const styles = css('Waveform', {
  waves: `
    /** The overview stays proportional so the pair scales with the screen; the focused canvas takes whatever is left. */
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    margin-top: 0;
    /** No column gap: the only one wanted is between the two canvases, and focusedSlot carries it. */
    gap: 0;
  `,
  focusedSlot: `
    /** Takes the remaining height rather than a fixed share, so nothing above it leaves a hole. */
    position: relative; width: 100%; flex: 1 1 auto; min-height: 0; margin-bottom: 6px;
  `,
  focused: `
    /* touch-action: none so a drag here scrubs rather than being taken as a page swipe or a scroll. */
    display: block; width: 100%; height: 100%; touch-action: none;
  `,
  overview: `
    display: block; width: 100%; height: 25%; flex: 0 0 auto; cursor: pointer;
  `,
  overviewLocked: `
    /* No pointer cursor while it cannot be used - the surface should not invite a tap it refuses. */
    cursor: default;
  `,
  nudgeRow: `
    /** ABOVE the waveform, not over it. */
    display: flex;
    justify-content: flex-end;
    /** TOP, not centre. */
    align-items: flex-start;
    gap: 2px;
    flex: 0 0 auto;
    /** 20px of button plus 4px below. */
    height: 24px;
  `,
  nudgeButton: `
    /** Small to look at, big to hit. */
    position: relative;
    /** Centred EXPLICITLY. */
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--ink-faint);
    font: 500 15px/1 var(--mono);
    cursor: pointer;
    touch-action: manipulation;
    &:active { background: var(--hairline); color: var(--ink); }
    /** The real target: 38px tall against a 20px box, and invisible. */
    &::after {
      content: '';
      position: absolute;
      inset: -14px -2px -4px;
    }
  `,
  nudgeSet: `
    /* The only remaining sign that this track's grid has been moved, now the readout has gone. */
    color: var(--accent);
  `,
  placeholder: `
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--ink-faint);
    font-size: 12px;
  `,
  spinner: `
    width: 13px;
    height: 13px;
    border: 2px solid var(--hairline);
    border-top-color: var(--ink-faint);
    border-radius: 50%;
    animation: spin 800ms linear infinite;
  `,
}, `
  @keyframes spin { to { transform: rotate(360deg); } }
  /** Someone who has asked for less motion still needs to know it is working, so the spinner stays but stops spinning */
  @media (prefers-reduced-motion: reduce) {
    $spinner { animation: none; }
  }
`);

interface Props {
  peaks: Peak[] | null;
  /** 0..1 of the track that has arrived. The overview is revealed only that far. */
  decoded: number;
  position: number;
  duration: number | null;
  grid: BeatGrid | null;
  cuePoint: number | null;
  /** Shown while a track is still being analysed - the zoomed view has nothing useful to draw yet. */
  analysing: boolean;
  /** A running deck ignores a tap on the overview - see the canvas's own note. */
  playing: boolean;
  loop: { start: number; end: number } | null;
  onSeek: (seconds: number) => void;
  /** Pointer handlers for dragging the zoomed canvas to scrub. */
  scrubHandlers?: Record<string, unknown>;
  /** Moves this track's grid by a few milliseconds. Absent means no adjuster is offered. */
  onNudgeGrid?: (deltaSeconds: number) => void;
}

const MARKER = '#F1EEE9';

/** The two canvases: the whole track above, a fixed-zoom window around the playhead below. */
export function Waveform({
  peaks, decoded, position, duration, grid, cuePoint, analysing, playing, loop, onSeek, scrubHandlers,
  onNudgeGrid,
}: Props) {
  /** Rounded for display only - the stored value is seconds */
  const offsetMs = Math.round((grid?.offset ?? 0) * 1000);


  const overviewRef = useRef<HTMLCanvasElement>(null);
  const focusedRef = useRef<HTMLCanvasElement>(null);

  // Kept in a ref so the draw loop is started once, not restarted on every prop change.
  const props = useRef<Props>({ peaks, decoded, position, duration, grid, cuePoint, analysing, playing, loop, onSeek });
  props.current = { peaks, decoded, position, duration, grid, cuePoint, analysing, playing, loop, onSeek };

  useEffect(() => {
    let frame = 0;
    /** Smooths the segment-by-segment arrival of the waveform into one movement. */
    const easeDecoded = createFractionEase();
    // Recomputed only when the peaks themselves change, not per frame - 150 averaged buckets out of ~10,000 is real work.
    let reduced: { source: Peak[] | null; value: Peak[] } = { source: null, value: [] };

    /** The rAF timestamp, which the easing needs - a per-frame constant would run at double speed on a 120Hz screen. */
    const draw = (now: number) => {
      const current = props.current;
      const overview = overviewRef.current;
      const focused = focusedRef.current;

      if (overview) {
        const fit = fitCanvas(overview);
        if (fit && current.peaks) {
          if (reduced.source !== current.peaks) {
            reduced = { source: current.peaks, value: downsample(current.peaks, OVERVIEW_BUCKETS) };
          }
          const { ctx, width, height } = fit;
          // Revealed only as far as the box has actually decoded, so a partial never claims to be a finished waveform.
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, width * Math.max(0, Math.min(easeDecoded(current.decoded || 1, now), 1)), height);
          ctx.clip();
          drawPeaks(ctx, reduced.value, 0, reduced.value.length, width, height);
          ctx.restore();

          if (current.duration && current.duration > 0) {
            const x = (current.position / current.duration) * width;
            ctx.fillStyle = MARKER;
            ctx.fillRect(x - 1, 0, 2, height);
          }
        }
      }

      // The window only once the WHOLE track is here: a fraction of a track drawn at full zoom reads as a finished waveform that is mysteriously
      if (focused) {
        const fit = fitCanvas(focused);
        const complete = current.peaks && current.decoded >= 1;
        if (fit && complete && current.peaks && current.duration) {
          const { ctx, width, height } = fit;
          const perBucket = current.duration / current.peaks.length;
          const visibleSeconds = (width / tokens.bucketWidthPixels) * perBucket;
          const half = visibleSeconds / 2;
          // Before the track starts the marker parks on the run-in's own bar line, which is the same line the grid draws
          const centre = Math.max(current.position, runInStart(current.grid));
          const xFor = (seconds: number) => ((seconds - (centre - half)) / visibleSeconds) * width;

          drawPeaks(ctx, current.peaks, (centre - half) / perBucket, (centre + half) / perBucket, width, height);

          if (current.loop) {
            const x1 = xFor(current.loop.start);
            const x2 = xFor(current.loop.end);
            ctx.fillStyle = 'rgba(255,255,255,0.14)';
            ctx.fillRect(x1, 0, Math.max(x2 - x1, 1), height);
            ctx.fillStyle = 'rgba(241,238,233,0.55)';
            ctx.fillRect(x1, 0, 1, height);
            ctx.fillRect(x2 - 1, 0, 1, height);
          }

          if (current.grid && current.grid.bpm > 0) {
            const interval = 60 / current.grid.bpm;
            const first = current.grid.firstBeatSeconds ?? 0;
            const floor = runInStart(current.grid);
            ctx.fillStyle = 'rgba(241,238,233,0.18)';
            let beat = first + Math.floor((centre - half - first) / interval) * interval;
            for (; beat < centre + half; beat += interval) {
              if (beat >= floor) ctx.fillRect(xFor(beat), 0, 1, height);
            }
          }

          if (current.cuePoint !== null) {
            ctx.fillStyle = tokens.cueColor;
            ctx.fillRect(xFor(current.cuePoint) - 1, 0, 2, height);
          }

          ctx.fillStyle = MARKER;
          ctx.fillRect(width / 2 - 1, 0, 2, height);
        }
      }

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className={styles.waves}>
      {/* Above the waveform, right-aligned, and always ready - there is no mode to enter. */}
      {onNudgeGrid && grid && (
        <div className={styles.nudgeRow}>
          <button
            type="button"
            className={offsetMs === 0 ? styles.nudgeButton : `${styles.nudgeButton} ${styles.nudgeSet}`}
            aria-label="Move the beat grid earlier"
            /** pointerDown, not click: this is adjusted while listening, and a click waits for the release. */
            onPointerDown={(event) => { event.stopPropagation(); onNudgeGrid(-NUDGE_SECONDS); }}
          >
            &minus;
          </button>
          <button
            type="button"
            className={offsetMs === 0 ? styles.nudgeButton : `${styles.nudgeButton} ${styles.nudgeSet}`}
            aria-label="Move the beat grid later"
            onPointerDown={(event) => { event.stopPropagation(); onNudgeGrid(NUDGE_SECONDS); }}
          >
            +
          </button>
        </div>
      )}
      <div className={styles.focusedSlot}>
        <canvas ref={focusedRef} className={styles.focused} {...scrubHandlers} />
        {analysing && (
          <div className={styles.placeholder}>
            <span className={styles.spinner} />
            <span>Analysing</span>
          </div>
        )}
      </div>
      <canvas
        ref={overviewRef}
        className={playing ? `${styles.overview} ${styles.overviewLocked}` : styles.overview}
        onPointerDown={(event) => {
          /** Never while the deck is RUNNING. */
          const { duration: total, playing: running } = props.current;
          if (!total || running) return;
          const rect = event.currentTarget.getBoundingClientRect();
          onSeek(((event.clientX - rect.left) / rect.width) * total);
        }}
      />
    </div>
  );
}
