import { test, assert, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePlayhead } from './usePlayhead';
import type { DeckStatus } from '../types';

const status = (elapsed: number, state: DeckStatus['state'] = 'STOPPED'): DeckStatus => ({
  state, remain: 100 - elapsed, pitch: state === 'PLAYING' ? 1 : 0, relative: false, cuePoint: 0,
  loopActive: false, loopStart: 0, loopEnd: 0, elapsed,
  timecodeValid: true, unreadableSeconds: 0, keyLock: false, path: '/x.mp3',
});

/**
 * A new STATUS must be published IMMEDIATELY, not on the next animation frame.
 *
 * The reported position otherwise lags the anchor by a frame, and that frame is visible: a released
 * scrub hands back the instant the box confirms the new position, and if this is still reporting the
 * OLD prediction at that moment the playhead flashes back to where the drag started before settling.
 * One stale frame is all it takes, which is why no amount of looking at the scrub code found it.
 */
test('a new status is reported at once, without waiting for a frame', () => {
  // rAF never fires, so anything reported must have been published synchronously.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});

  const view = renderHook(({ s }: { s: DeckStatus }) => usePlayhead(s, 100), {
    initialProps: { s: status(20) },
  });
  assert.equal(view.result.current.position, 20);

  view.rerender({ s: status(75) });
  assert.equal(view.result.current.position, 75, 'the jump is visible on this render, not the next frame');
});

test('a deck with no status reports zero rather than drifting', () => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const view = renderHook(() => usePlayhead(null, 100));
  assert.equal(view.result.current.position, 0);
});

/* An older xwax sends no `elapsed`, so the position has to come from the track's length and what is
 * left - which must not read as zero, or the playhead parks at the start of every track. */
test('a status without an elapsed field falls back to length minus remaining', () => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const older = { ...status(0), elapsed: null, remain: 40 };
  const view = renderHook(() => usePlayhead(older, 100));
  assert.equal(view.result.current.position, 60);
});

/*
 * A transport action whose outcome the client already knows must move the playhead NOW.
 *
 * Cue-play jumps to the cue point and starts running. Waiting for a status to confirm that costs up
 * to a full second, which is what made the button feel unresponsive on a network that is not slow.
 */
test('anchoring moves the playhead immediately, without a status', () => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});

  /* A STABLE status object. Building a fresh one inside the render function makes the re-anchoring
   * effect fire on every render - including the one the optimistic move causes - which undoes it
   * immediately. The real status comes from state and only changes when a message arrives. */
  const held = status(40);
  const view = renderHook(({ s }: { s: DeckStatus }) => usePlayhead(s, 100), {
    initialProps: { s: held },
  });
  assert.equal(view.result.current.position, 40);

  act(() => view.result.current.anchorTo(12, 1));
  assert.equal(view.result.current.position, 12, 'at the cue point on this render');
});

/*
 * A status that PREDATES a deliberate jump must be ignored.
 *
 * STATUS arrives about once a second, so one generated before the box acted on a cue still reports
 * the old position. Re-anchoring to it drags the playhead back and then forward again when the next
 * one lands - the glitch after pressing cue.
 */
test('a stale status does not drag the playhead back after a jump', () => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});

  const view = renderHook(({ s }: { s: DeckStatus }) => usePlayhead(s, 100), {
    initialProps: { s: status(40) },
  });
  act(() => view.result.current.anchorTo(12, 0));

  // The box is still reporting where the track was before the cue.
  view.rerender({ s: status(40) });
  assert.equal(view.result.current.position, 12, 'held at the jump, not snapped back to 40');
});

test('and hands back the moment the box agrees', () => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});

  const view = renderHook(({ s }: { s: DeckStatus }) => usePlayhead(s, 100), {
    initialProps: { s: status(40) },
  });
  act(() => view.result.current.anchorTo(12, 0));
  view.rerender({ s: status(12.1) }); // within tolerance of the jump
  assert.equal(view.result.current.position, 12.1, 'the box is the truth once it catches up');
});

/* The grace is bounded: a command the box never applied has to correct itself rather than leaving
 * the playhead parked somewhere it never went. */
test('the box wins once no agreement is coming', () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});

  const view = renderHook(({ s }: { s: DeckStatus }) => usePlayhead(s, 100), {
    initialProps: { s: status(40) },
  });
  act(() => view.result.current.anchorTo(12, 0));

  now += 2000; // well past the grace
  view.rerender({ s: status(40) });
  assert.equal(view.result.current.position, 40, 'the jump never happened, so the box is right');
});

/**
 * The run-in jitter (owner-reported, 2026-09-30).
 *
 * With a cue offset the needle sits before the track and xwax reports a NEGATIVE elapsed. This
 * published the raw value on every status and a zero-floored one on every animation frame, so the
 * playhead flipped between the two about once a second - violent jitter through the run-in, and the
 * cue marker dragged around with it because the focused waveform is centred on this.
 */
test('a position before the track starts is reported as it is, not floored at zero', () => {
  const frames: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frames.push(fn); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});

  const view = renderHook(({ s }: { s: DeckStatus }) => usePlayhead(s, 100), {
    initialProps: { s: status(-3.2) },
  });
  assert.equal(view.result.current.position, -3.2, 'the status itself');

  // The animation frame must agree with it rather than snapping to zero.
  act(() => { frames.shift()?.(); });
  assert.ok(
    view.result.current.position < 0,
    `a frame must not floor the run-in at zero (got ${view.result.current.position})`,
  );
});
