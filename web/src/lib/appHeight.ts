/**
 * The app's height, measured rather than inherited.
 *
 * `height: 100%` resolves against the viewport, and iOS gets that wrong when a home-screen app is
 * LAUNCHED already in landscape: the first layout uses the portrait height and nothing re-resolves
 * it, because no rotation ever happens. The result is the app ending short with a gap along the
 * bottom. Rotating away and back fixes it, which is the tell - two forced re-layouts.
 *
 * Opening in portrait and rotating has always been fine, so this is specifically about the value
 * present at first paint. Moving the safe-area padding off body (2026-10-17) did not fix it, which
 * ruled out the inset as the cause.
 *
 * So the height is read from the viewport and written to a custom property, and read again after
 * the first frames in case the value was wrong when we asked. CSS keeps `100%` as its fallback, so
 * a browser where this never runs behaves exactly as before.
 */

const PROPERTY = '--app-height';

/** Reads the most trustworthy height available and publishes it. */
function measure(): void {
  // visualViewport is the one that tracks what is actually on screen; innerHeight is the fallback.
  const height = window.visualViewport?.height ?? window.innerHeight;
  if (height > 0) document.documentElement.style.setProperty(PROPERTY, `${Math.round(height)}px`);
}

/** Starts measuring. Returns a stop function, so it drops into a useEffect. */
export function trackAppHeight(): () => void {
  measure();

  /*
   * Measured again after the first frames and once more shortly after. A launch straight into
   * landscape reports the wrong height for the first moments, and there is no event to wait for -
   * nothing resizes, nothing rotates. These are the re-reads that a rotation would have forced.
   */
  const raf = requestAnimationFrame(() => {
    measure();
    requestAnimationFrame(measure);
  });
  const settle = window.setTimeout(measure, 300);

  window.addEventListener('resize', measure);
  window.addEventListener('orientationchange', measure);
  window.visualViewport?.addEventListener('resize', measure);

  return () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(settle);
    window.removeEventListener('resize', measure);
    window.removeEventListener('orientationchange', measure);
    window.visualViewport?.removeEventListener('resize', measure);
  };
}
