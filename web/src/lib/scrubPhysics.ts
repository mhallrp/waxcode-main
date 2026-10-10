/** How a scrub resists the ends of a track, and how it coasts after a flick. */

/** The overshoot asymptotes at 1.5 SECONDS of track, not a fraction of the view. */
export const MAX_OVERSHOOT_SECONDS = 1.5;

/** A deliberately separate, faster, differently shaped curve from the decay below. */
export const SPRING_BACK_MS = 300;

/** UIScrollView's normal deceleration, so a flick feels like native scrolling. */
export const MOMENTUM_DECAY = 1000 * Math.log(0.998);

/** Below this much residual travel there is nothing to coast - seek straight away. */
export const MOMENTUM_THRESHOLD_PX = 4;

/** How close the coast must get before the seek fires. */
export const MOMENTUM_CONVERGENCE_PX = 0.5;

/** Past either end, the drag keeps moving but with exponentially less effect, asymptoting 1.5s out. */
export function rubberBanded(seconds: number, duration: number): number {
  if (seconds < 0) {
    return -MAX_OVERSHOOT_SECONDS * (1 - Math.exp(seconds / MAX_OVERSHOOT_SECONDS));
  }
  if (seconds > duration) {
    return duration + MAX_OVERSHOOT_SECONDS * (1 - Math.exp(-(seconds - duration) / MAX_OVERSHOOT_SECONDS));
  }
  return seconds;
}

/** Total remaining travel of the decay curve, in pixels, for a release at this velocity. */
export function momentumTravelPx(velocityPxPerSecond: number): number {
  return velocityPxPerSecond / -MOMENTUM_DECAY;
}

/** 0..1 along the coast at `elapsed` seconds. Asymptotic - it never quite reaches 1. */
export function momentumProgress(elapsedSeconds: number): number {
  return 1 - Math.exp(MOMENTUM_DECAY * elapsedSeconds);
}

/** 0..1 along the spring back to an end. Cubic ease-out over SPRING_BACK_MS, and it does reach 1. */
export function springBackProgress(elapsedSeconds: number): number {
  const t = Math.min(elapsedSeconds / (SPRING_BACK_MS / 1000), 1);
  return 1 - (1 - t) ** 3;
}
