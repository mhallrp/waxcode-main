/** How much of the screen the on-screen keyboard is covering. */

/** The custom property the layout reads. Zero whenever no keyboard is up. */
export const KEYBOARD_INSET_VAR = '--keyboard-inset';

export interface ViewportLike {
  height: number;
  offsetTop: number;
}

/** The covered height in CSS pixels, given the layout viewport height and the visual viewport. */
export function keyboardInset(layoutHeight: number, visual: ViewportLike | null | undefined): number {
  if (!visual || !Number.isFinite(layoutHeight) || layoutHeight <= 0) return 0;
  if (!Number.isFinite(visual.height) || visual.height <= 0) return 0;

  const covered = layoutHeight - visual.height - (Number.isFinite(visual.offsetTop) ? visual.offsetTop : 0);

  /** Negative means the visual viewport is somehow taller than the layout one, which happens transiently mid-rotation. */
  if (!Number.isFinite(covered) || covered <= 0) return 0;

  /** A few pixels of disagreement is normal and is not a keyboard. */
  return covered < 24 ? 0 : Math.round(covered);
}
