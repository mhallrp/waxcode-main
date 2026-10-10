/** Small pure helpers, shared by whatever needs to show a number to a person. */

/** Seconds as m:ss. Negative clamps to 0 - a deck briefly reports past the end. */
export function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/** Two decimal places, because a BPM that jitters in the third is worse than no BPM. */
export function bpm(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? '—' : value.toFixed(2);
}
