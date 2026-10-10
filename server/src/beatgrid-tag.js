import { parseFile } from 'music-metadata';

/** Uses a file's BPM tag to catch METRIC-LEVEL errors only - never to fine-tune a tempo. */

/** 2/1 and 1/2 are deliberately absent: a doubled grid still lands on every kick */
const METRIC_RATIOS = [2 / 3, 3 / 2, 4 / 3, 3 / 4];

/** Wide enough to match a metric ratio through ordinary tempo error, far too tight to catch a rounding disagreement */
const METRIC_TOLERANCE = 0.02;

/** Tag BPM for a file, or null. Reads tag headers only - no decode, so this costs nothing next to the analysis it informs. */
export async function readTaggedBpm(path) {
  try {
    const { common } = await parseFile(path, { skipCovers: true, duration: false });
    const bpm = Number(common?.bpm);
    return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
  } catch {
    // A tag we cannot read is simply an absent one - never a reason to fail the grid.
    return null;
  }
}

/** Returns the tempo to use. */
export function correctMetricLevel(computed, tagBpm) {
  if (!(computed > 0) || !(tagBpm > 0)) return { bpm: computed, corrected: false };

  // Already at the tagged level, give or take ordinary tempo error - nothing to correct.
  if (Math.abs(computed - tagBpm) / tagBpm <= METRIC_TOLERANCE) return { bpm: computed, corrected: false };

  for (const ratio of METRIC_RATIOS) {
    const target = tagBpm * ratio;
    if (Math.abs(computed - target) / target <= METRIC_TOLERANCE) {
      return { bpm: computed / ratio, corrected: true };
    }
  }

  return { bpm: computed, corrected: false };
}
