import { tokens } from '../styles/tokens';

/** Turning the box's peak data into pixels. */

export interface Peak {
  min: number;
  max: number;
  low: number;
  mid: number;
  high: number;
}

/** uint16 count, then 5 bytes per bucket: signed min, signed max, and three unsigned band weights. */
export function decodePeaks(buffer: ArrayBuffer): Peak[] {
  const view = new DataView(buffer);
  const count = view.getUint16(0, true);
  const peaks: Peak[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const o = 2 + i * 5;
    peaks[i] = {
      min: view.getInt8(o),
      max: view.getInt8(o + 1),
      low: view.getUint8(o + 2),
      mid: view.getUint8(o + 3),
      high: view.getUint8(o + 4),
    };
  }
  return peaks;
}

export function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Non-bass content is held down above a ceiling, so a bright hi-hat does not draw as tall as a kick. */
function throttled(magnitude: number, nonBassWeight: number): number {
  const { nonBassCeiling, nonBassCeilingRatio } = tokens;
  if (magnitude <= nonBassCeiling) return magnitude;
  return nonBassCeiling + (magnitude - nonBassCeiling) * (1 - nonBassWeight * (1 - nonBassCeilingRatio));
}

/** The three band weights mixed into one colour, exactly as WaveformRendering does it. */
export function blended(peak: Peak): string {
  const { lowColor, midColor, highColor } = tokens.bands;
  const low = peak.low / 255;
  const mid = peak.mid / 255;
  const high = peak.high / 255;
  const channel = (i: 0 | 1 | 2) =>
    Math.round((low * lowColor[i] + mid * midColor[i] + high * highColor[i]) * 255);
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}

/** The overview draws this many bars, not the track's several thousand. */
export const OVERVIEW_BUCKETS = 150;

/** The box's own bucket length, for sizing a partial waveform's padding. */
export const TARGET_BUCKET_SECONDS = 0.04;

/** Averaging, not min/max. */
export function downsample(peaks: Peak[], targetCount: number): Peak[] {
  if (peaks.length <= targetCount || targetCount <= 0) return peaks;
  const out: Peak[] = new Array(targetCount);
  for (let i = 0; i < targetCount; i += 1) {
    const start = Math.floor((i * peaks.length) / targetCount);
    const end = Math.min(peaks.length, Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / targetCount)));
    let min = 0; let max = 0; let low = 0; let mid = 0; let high = 0;
    for (let j = start; j < end; j += 1) {
      const peak = peaks[j]!;
      min += peak.min; max += peak.max; low += peak.low; mid += peak.mid; high += peak.high;
    }
    const count = end - start;
    // Truncating toward zero, matching Swift's Int8(sum / count) integer division.
    out[i] = {
      min: Math.trunc(min / count), max: Math.trunc(max / count),
      low: Math.trunc(low / count), mid: Math.trunc(mid / count), high: Math.trunc(high / count),
    };
  }
  return out;
}

/** Sizes the backing store to the device's pixels and returns a context in CSS pixels. */
export function fitCanvas(canvas: HTMLCanvasElement) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** Draws buckets `from`..`to` across the full width. Fractional bounds are how the window scrolls. */
export function drawPeaks(
  ctx: CanvasRenderingContext2D,
  peaks: Peak[],
  from: number,
  to: number,
  width: number,
  height: number,
) {
  if (peaks.length === 0) return;
  const midY = height / 2;
  const slot = width / Math.max(1, to - from);
  const barWidth = Math.max(slot * (1 - tokens.barGapFraction), tokens.minBarWidth);

  for (let i = Math.max(0, Math.floor(from)); i <= Math.min(peaks.length - 1, Math.ceil(to)); i += 1) {
    const peak = peaks[i]!;
    const nonBass = 1 - peak.low / 255;
    const top = midY - (throttled(peak.max, nonBass) / 127) * midY;
    const bottom = midY + (throttled(-peak.min, nonBass) / 128) * midY;
    ctx.fillStyle = blended(peak);
    ctx.fillRect((i - from) * slot - barWidth / 2, top, barWidth, Math.max(bottom - top, 1));
  }
}

/** Where the playhead waits BEFORE a track starts: one bar before the downbeat nearest time zero. */
export function barPhaseSeconds(grid: { bpm: number; firstBeatSeconds?: number } | null): number {
  if (!grid || grid.bpm <= 0) return grid?.firstBeatSeconds ?? 0;
  const beat = 60 / grid.bpm;
  const first = grid.firstBeatSeconds ?? 0;
  return first + Math.round(-first / beat) * beat;
}

/** Where the focused waveform's marker may actually sit. */
export function waveformPlayhead(
  raw: number,
  grid: { bpm: number; firstBeatSeconds?: number } | null,
  duration: number | null,
): number {
  const floored = Math.max(raw, runInStart(grid));
  return duration === null ? floored : Math.min(floored, duration);
}

export function runInStart(grid: { bpm: number; firstBeatSeconds?: number } | null): number {
  if (!grid || grid.bpm <= 0) return 0;
  return barPhaseSeconds(grid) - (60 / grid.bpm) * 4;
}

/** The grid beat nearest a position. */
export function nearestBeat(seconds: number, grid: { bpm: number; firstBeatSeconds?: number } | null): number {
  if (!grid || grid.bpm <= 0) return Math.max(0, seconds);
  const interval = 60 / grid.bpm;
  const first = grid.firstBeatSeconds ?? 0;
  return Math.max(0, first + Math.round((seconds - first) / interval) * interval);
}
