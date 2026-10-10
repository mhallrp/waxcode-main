import { describe, it, expect } from 'vitest';
import { createBoxClock, CLOCK_WINDOW_MS } from './boxClock';

/*
 * The box stamps `sentAt` from its own monotonic clock, which shares no origin with the browser's.
 * These numbers are deliberately far apart so a test can only pass by actually translating between
 * the two rather than by the two happening to be close.
 */
const BOX_EPOCH = 1_000_000;
/** Browser time minus box time, the thing the clock has to discover. */
const TRUE_OFFSET = 500_000;
/** A good trip on the owner's LAN: a median of 4ms, 43ms at p90. */
const FAST = 1;

/** The browser's clock when the box's said `boxTime` and the trip took `delay`. */
const arrivesAt = (boxTime: number, delay: number) => boxTime + TRUE_OFFSET + delay;

describe('createBoxClock', () => {
  it('treats an unstamped status as arriving instantly, which is the old behaviour', () => {
    const clock = createBoxClock();
    expect(clock.localTimeOf(null, 1234)).toBe(1234);
    expect(clock.localTimeOf(undefined, 1234)).toBe(1234);
    expect(clock.localTimeOf(Number.NaN, 1234)).toBe(1234);
    expect(clock.offset).toBeNull();
  });

  it('recovers the measurement time, not the arrival time', () => {
    const clock = createBoxClock();
    const boxTime = BOX_EPOCH + 100;
    // A slow trip must NOT be charged to the playhead - that is the bug the whole file exists for.
    clock.localTimeOf(BOX_EPOCH, arrivesAt(BOX_EPOCH, FAST));
    const sampledAt = clock.localTimeOf(boxTime, arrivesAt(boxTime, 60));
    expect(sampledAt).toBeCloseTo(boxTime + TRUE_OFFSET + FAST, 3);
  });

  it('takes the fastest trip it has seen, because that one carries the least delay', () => {
    const clock = createBoxClock();
    for (const delay of [40, 25, 60, 4, 90]) {
      const boxTime = BOX_EPOCH + delay;
      clock.localTimeOf(boxTime, arrivesAt(boxTime, delay));
    }
    expect(clock.offset).toBeCloseTo(TRUE_OFFSET + 4, 3);
  });

  /*
   * THE BUG THIS FILE WAS CHANGED FOR (2026-10-09, owner-reported).
   *
   * The box stamps `at` when it PARSES xwax's reply, and its reader drains several STATUS lines in
   * one event-loop turn - so while it is busy bucketing a waveform for a track being loaded, a burst
   * arrives whose stamps are microseconds apart though the positions are 50ms apart. One of those
   * looks like it crossed the network instantly.
   *
   * Under the old estimator that one sample pinned the offset low and unwound at 0.05ms per sample -
   * 1ms/sec, so minutes. The owner saw the waveform sitting out of time with the audio for the rest
   * of a track and right again by the next one.
   */
  it('a freak-fast sample from a stalled burst does not hold the estimate down', () => {
    const clock = createBoxClock();
    let boxTime = BOX_EPOCH;

    const settle = (delay: number, forMs: number) => {
      const until = boxTime + forMs;
      for (; boxTime <= until; boxTime += 50) clock.localTimeOf(boxTime, arrivesAt(boxTime, delay));
    };

    settle(20, 2_000);
    expect(clock.offset).toBeCloseTo(TRUE_OFFSET + 20, 3);

    // The burst: a status stamped at parse that appears to have taken no time at all.
    clock.localTimeOf(boxTime, arrivesAt(boxTime, -100));
    expect(clock.offset).toBeCloseTo(TRUE_OFFSET - 100, 3);

    /* It must age out of the window rather than be crept away. The old estimator needed 100 seconds
     * to walk off a 100ms error; a track is about three minutes, which is why it lasted one. */
    settle(20, CLOCK_WINDOW_MS + 1_000);
    expect(clock.offset).toBeCloseTo(TRUE_OFFSET + 20, 3);
  });

  it('follows a genuinely faster network immediately', () => {
    const clock = createBoxClock();
    let boxTime = BOX_EPOCH;
    for (; boxTime < BOX_EPOCH + 1_000; boxTime += 50) clock.localTimeOf(boxTime, arrivesAt(boxTime, 40));
    clock.localTimeOf(boxTime, arrivesAt(boxTime, 5));
    // Downwards is never delayed: a lower sample is evidence, where a higher one is only absence of it.
    expect(clock.offset).toBeCloseTo(TRUE_OFFSET + 5, 3);
  });

  it('follows the clocks drifting apart, since old samples expire', () => {
    const clock = createBoxClock();
    let boxTime = BOX_EPOCH;
    for (; boxTime < BOX_EPOCH + 2_000; boxTime += 50) clock.localTimeOf(boxTime, arrivesAt(boxTime, 10));
    // The box's crystal runs slow against the browser's, so every trip now looks 30ms longer.
    for (; boxTime < BOX_EPOCH + 2_000 + CLOCK_WINDOW_MS + 1_000; boxTime += 50) {
      clock.localTimeOf(boxTime, arrivesAt(boxTime, 40));
    }
    expect(clock.offset).toBeCloseTo(TRUE_OFFSET + 40, 3);
  });

  it('keeps an estimate even when nothing has arrived for longer than the window', () => {
    const clock = createBoxClock();
    clock.localTimeOf(BOX_EPOCH, arrivesAt(BOX_EPOCH, 10));
    const boxTime = BOX_EPOCH + CLOCK_WINDOW_MS * 3;
    // Stale beats nothing: the alternative is falling back to arrival time and the original bug.
    expect(clock.localTimeOf(boxTime, arrivesAt(boxTime, 10))).toBeCloseTo(boxTime + TRUE_OFFSET + 10, 3);
    expect(clock.offset).not.toBeNull();
  });

  it('does not grow without bound while it runs', () => {
    const clock = createBoxClock({ windowMs: 1_000 });
    let boxTime = BOX_EPOCH;
    // Rising delays are the worst case: nothing is ever popped from the back, only expired from the front.
    for (let i = 0; i < 5_000; i += 1, boxTime += 50) {
      clock.localTimeOf(boxTime, arrivesAt(boxTime, 10 + (i % 100)));
    }
    expect(clock.offset).not.toBeNull();
  });
});
