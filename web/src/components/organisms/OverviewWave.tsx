import { useEffect, useRef } from 'react';
import { OVERVIEW_BUCKETS, downsample, drawPeaks, fitCanvas, type Peak } from '../../lib/waveform';
import { createFractionEase } from '../../lib/easeFraction';
import { css } from '../../styles/css';

const styles = css('OverviewWave', {
  wave: `
    display: block; width: 100%; background: transparent;
  `,
});

interface Props {
  peaks: Peak[] | null;
  decoded: number;
  position: number;
  duration: number | null;
  height?: number;
}

const MARKER = '#F1EEE9';

/** The whole track at a glance, with a playhead. */
export function OverviewWave({ peaks, decoded, position, duration, height = 44 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const props = useRef<Props>({ peaks, decoded, position, duration });
  props.current = { peaks, decoded, position, duration };

  useEffect(() => {
    let frame = 0;
    /** Smooths the segment-by-segment arrival of the waveform into one movement. */
    const easeDecoded = createFractionEase();
    // Reduced only when the peaks themselves change - 150 averaged buckets out of ~10,000 is work.
    let reduced: { source: Peak[] | null; value: Peak[] } = { source: null, value: [] };

    /** The rAF timestamp, which the easing needs - a per-frame constant would run at double speed on a 120Hz screen. */
    const draw = (now: number) => {
      const canvas = canvasRef.current;
      const current = props.current;
      if (canvas) {
        const fit = fitCanvas(canvas);
        if (fit && current.peaks) {
          if (reduced.source !== current.peaks) {
            reduced = { source: current.peaks, value: downsample(current.peaks, OVERVIEW_BUCKETS) };
          }
          const { ctx, width, height: h } = fit;
          // Revealed only as far as the box has decoded, so a partial never claims to be finished.
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, width * Math.max(0, Math.min(easeDecoded(current.decoded || 1, now), 1)), h);
          ctx.clip();
          drawPeaks(ctx, reduced.value, 0, reduced.value.length, width, h);
          ctx.restore();

          if (current.duration && current.duration > 0) {
            ctx.fillStyle = MARKER;
            ctx.fillRect((current.position / current.duration) * width - 1, 0, 2, h);
          }
        }
      }
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvasRef} className={styles.wave} style={{ height }} />;
}
