/**
 * The app's height, measured rather than inherited.
 *
 * `height: 100%` resolves against the viewport, and iOS gets that wrong when a home-screen app is
 * LAUNCHED already in landscape: the first layout uses the portrait height and nothing re-resolves
 * it, because no rotation ever happens. The app ends short, with a gap along the bottom. Rotating
 * away and back fixes it - two forced re-layouts - which is the tell.
 *
 * Opening in portrait and rotating has always been fine, so this is specifically about the value
 * present at first paint. Moving the safe-area padding off body did not fix it (2026-10-17), which
 * ruled the inset out as the cause.
 *
 * Measuring on a timer did not fix it either (2026-10-18): on a COLD launch the wrong value
 * outlives any delay worth waiting, while a warm launch is correct immediately - which is why the
 * bug only ever showed on the first open.
 *
 * So the value is CHECKED rather than timed. The orientation media query and the reported
 * dimensions have to agree; while they do not, the viewport is still lying and the reading is
 * discarded. That ends when iOS tells the truth, however long it takes, instead of when a timer
 * we guessed happens to fire.
 */

const PROPERTY = '--app-height';

/** How often to look while the viewport is still contradicting itself. */
const POLL_MS = 100;

/** Long enough for any launch, short enough to stop rather than poll a browser that never agrees. */
const GIVE_UP_MS = 5_000;

interface Viewport {
  width: number;
  height: number;
}

function read(): Viewport {
  const vv = window.visualViewport;
  return {
    width: vv?.width ?? window.innerWidth,
    height: vv?.height ?? window.innerHeight,
  };
}

/**
 * Whether the viewport agrees with the orientation the device says it is in.
 *
 * A landscape device reporting a portrait-shaped viewport has not caught up yet. Square is
 * allowed either way, since neither reading contradicts the other.
 */
export function viewportAgreesWithOrientation(
  { width, height }: Viewport,
  landscape: boolean,
): boolean {
  if (width <= 0 || height <= 0) return false;
  return landscape ? width >= height : height >= width;
}

/** Writes the height if it can be trusted. Returns whether it could. */
function publish(): boolean {
  const viewport = read();
  /* Without matchMedia there is no second opinion to check the viewport against, so the reading is
     taken at face value - the same behaviour as before this file existed. */
  const query = window.matchMedia?.('(orientation: landscape)');
  if (query === undefined) {
    if (viewport.height > 0) {
      document.documentElement.style.setProperty(PROPERTY, `${Math.round(viewport.height)}px`);
      return true;
    }
    return false;
  }
  if (!viewportAgreesWithOrientation(viewport, query.matches)) return false;

  document.documentElement.style.setProperty(PROPERTY, `${Math.round(viewport.height)}px`);
  return true;
}

/** Starts measuring. Returns a stop function, so it drops into a useEffect. */
export function trackAppHeight(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;

  function stopPolling(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  /** Looks now, and keeps looking until the viewport stops contradicting itself. */
  function settle(): void {
    if (publish()) return;
    if (timer !== null) return;

    const startedAt = Date.now();
    timer = setInterval(() => {
      if (publish() || Date.now() - startedAt > GIVE_UP_MS) stopPolling();
    }, POLL_MS);
  }

  settle();
  window.addEventListener('resize', settle);
  window.addEventListener('orientationchange', settle);
  window.visualViewport?.addEventListener('resize', settle);

  return () => {
    stopPolling();
    window.removeEventListener('resize', settle);
    window.removeEventListener('orientationchange', settle);
    window.visualViewport?.removeEventListener('resize', settle);
  };
}
