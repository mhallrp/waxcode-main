/** Turns a deck's reported position into a stable playback speed, for the BPM readout. */

/** One platter revolution at 33 1/3 rpm, divided by measured speed so it stays one REAL revolution. */
const REVOLUTION_SECONDS = 60 / (100 / 3);
/** Below this the platter is not meaningfully turning, so its speed says nothing about tempo. */
const PITCH_FLOOR = 0.05;
/** This far from what is held is a real speed change, not ripple - trust it at once. */
const RESEED_GAP = 0.05;
/** A position step larger than this is a seek, cue or loop wrap, not playback. */
const DISCONTINUITY_SECONDS = 0.15;
const WINDOW_MIN = 0.5;
const WINDOW_MAX = 6.0;
const MINIMUM_SAMPLES = 8;

/** The displayed BPM is quantised to this grid */
const BPM_GRID_STEP = 0.05;
const PITCH_GRID_STEP = 0.001;
/** How far past its grid point the measurement must go before the display moves, in steps. */
const BPM_GRID_HYSTERESIS = 3.0;
const PITCH_GRID_HYSTERESIS = 1.5;

interface Sample { t: number; elapsed: number }

/** Distance over time between the two ENDS of the window - the uniform mean speed across it, and that is the whole mechanism. */
function averageSpeed(samples: Sample[]): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;
  const span = last.t - first.t;
  if (span <= 0) return null;
  return (last.elapsed - first.elapsed) / span;
}

export function createBpmSpeedTracker() {
  let samples: Sample[] = [];
  /** Which grid point the display sits on. null until the first measurement. */
  let displayIndex: number | null = null;
  let baseBPM: number | null = null;

  /** Live measurement, 1.0 being nominal. Moves constantly by design; not for display. */
  let speed: number | null = null;
  /** What the readout should SHOW. Held still until the measurement genuinely moves. */
  let displaySpeed: number | null = null;

  /** Applies the quantisation and its hysteresis. */
  function publish(measured: number) {
    speed = measured;

    const step = baseBPM && baseBPM > 0 ? BPM_GRID_STEP / baseBPM : PITCH_GRID_STEP;
    const hysteresis = baseBPM && baseBPM > 0 ? BPM_GRID_HYSTERESIS : PITCH_GRID_HYSTERESIS;

    /** Anchored at NOMINAL, not at zero, so index 0 is exactly the track's own tempo. */
    if (displayIndex !== null
      && Math.abs(measured - (1 + displayIndex * step)) <= hysteresis * step) {
      return; // still close enough to what is shown - hold
    }
    displayIndex = Math.round((measured - 1) / step);
    displaySpeed = 1 + displayIndex * step;
  }

  return {
    /** What to multiply the track's tempo by, or null while nothing is known. */
    get displaySpeed() { return displaySpeed; },

    /** A new track starts from its own tempo, not the last one's platter speed. */
    reset() {
      samples = [];
      speed = null;
      displaySpeed = null;
      displayIndex = null;
    },

    /** A speed already known for certain - PLAY pins 1.0 rather than letting it be averaged toward. */
    pin(value: number) {
      samples = [];
      displayIndex = null;
      publish(value);
    },

    /** `boxTime` MUST be the box's own clock (STATUS's `sentAt`), never arrival time. */
    observe(options: {
      elapsed: number | null;
      boxTime: number | null;
      pitch: number;
      timecodeValid: boolean | null;
      baseBPM: number | null;
    }) {
      if (baseBPM !== options.baseBPM) {
        // The old index counted steps of a different size, so the grid is rebuilt from scratch.
        baseBPM = options.baseBPM;
        displayIndex = null;
      }

      /** Needle up, or not turning: HOLD. */
      if (options.timecodeValid === false || Math.abs(options.pitch) < PITCH_FLOOR) return;

      const { elapsed, boxTime, pitch } = options;

      /** Without BOTH a position and the box's own clock there is nothing honest to fit, so fall back to smoothing the reported pitch. */
      if (elapsed === null || boxTime === null) {
        if (speed === null) publish(pitch);
        else publish(Math.abs(speed - pitch) < RESEED_GAP ? speed * 0.97 + pitch * 0.03 : pitch);
        return;
      }

      const last = samples[samples.length - 1];
      if (last) {
        const dt = boxTime - last.t;
        const expected = dt * (speed ?? pitch);
        if (dt <= 0 || Math.abs((elapsed - last.elapsed) - expected) > DISCONTINUITY_SECONDS) {
          samples = [];
        }
      }
      samples.push({ t: boxTime, elapsed });

      const window = Math.min(
        Math.max(REVOLUTION_SECONDS / Math.max(Math.abs(speed ?? pitch), 0.25), WINDOW_MIN),
        WINDOW_MAX,
      );
      samples = samples.filter((sample) => boxTime - sample.t <= window);

      /** Until a full revolution has been collected, trust the deck's own pitch */
      const first = samples[0];
      if (samples.length < MINIMUM_SAMPLES || !first || boxTime - first.t < window * 0.9) {
        if (speed === null || Math.abs((speed ?? pitch) - pitch) >= RESEED_GAP) publish(pitch);
        return;
      }

      const measured = averageSpeed(samples);
      if (measured !== null) publish(measured);
    },
  };
}
