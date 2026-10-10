import { test, assert, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useScrub } from './useScrub';
import type { DeckStatus } from '../types';

/**
 * What the waveform is told to draw, through a whole drag and release.
 *
 * The fault being chased: on release the drawing flashes back to where the drag STARTED before
 * settling on where it ended. That can only happen if the released position is ever un-held while
 * the box is still reporting the old one.
 */
const status = (elapsed: number): DeckStatus => ({
  state: 'STOPPED', remain: 100, pitch: 0, relative: false, cuePoint: 0,
  loopActive: false, loopStart: 0, loopEnd: 0, elapsed,
  timecodeValid: true, unreadableSeconds: 0, keyLock: false, path: '/x.mp3',
});

/**
 * rAF driven by a MOCK CLOCK, not flushed instantly.
 *
 * The coast reschedules itself until it converges, so a stub that calls back with the real time
 * never advances, never converges, and recurses until the stack blows - which surfaced as "the seek
 * was never sent" and looked exactly like a product bug.
 */
function fakeClock() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    now += 16;
    fn(now);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  // The settle window is measured on this clock too, so a test that waits has to advance it.
  return (ms: number) => { now += ms; };
}

function harness() {
  const advance = fakeClock();
  const seeks: number[] = [];
  const onSeek = vi.fn(async (seconds: number) => { seeks.push(seconds); return { ok: true }; });

  const view = renderHook(
    ({ position, deckStatus }: { position: number; deckStatus: DeckStatus }) => useScrub({
      bucketCount: 2500, // 100s at 0.04s per bucket
      duration: 100,
      position,
      playing: false,
      status: deckStatus,
      onSeek,
    }),
    { initialProps: { position: 20, deckStatus: status(20) } },
  );

  const target = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  const event = (clientX: number, timeStamp = 0) =>
    ({ pointerId: 1, clientX, timeStamp, currentTarget: target, stopPropagation() {} }) as never;

  return { view, event, seeks, onSeek, advance };
}

test('the drawing follows the finger during a drag', () => {
  const h = harness();
  act(() => h.view.result.current.handlers.onPointerDown(h.event(500)));
  assert.equal(h.view.result.current.scrubPosition, 20, 'starts where the playhead is');

  // Dragging LEFT moves the track forward - the waveform travels under a stationary playhead.
  act(() => h.view.result.current.handlers.onPointerMove(h.event(400, 100)));
  assert.ok((h.view.result.current.scrubPosition ?? 0) > 20, 'moved forward');
});

/*
 * THE BUG. On release the position must stay exactly where the finger left it, through every render
 * that happens while the box is still reporting the old position - which is at least one full status
 * interval, about a second.
 */
test('a released drag holds its position while the box still reports the old one', async () => {
  const h = harness();
  act(() => h.view.result.current.handlers.onPointerDown(h.event(500)));
  act(() => h.view.result.current.handlers.onPointerMove(h.event(400, 13000)));
  const released = h.view.result.current.scrubPosition;
  assert.ok(released !== null && released > 20);

  await act(async () => { h.view.result.current.handlers.onPointerUp(h.event(400, 13100)); });

  assert.equal(h.view.result.current.scrubPosition, released, 'held straight after release');

  // The box has not caught up yet - several renders with the OLD status.
  for (let i = 0; i < 3; i += 1) {
    h.view.rerender({ position: 20, deckStatus: status(20) });
    assert.equal(h.view.result.current.scrubPosition, released, `still held on render ${i + 1}`);
  }
});

test('and lets go once the box reports the new position', async () => {
  const h = harness();
  act(() => h.view.result.current.handlers.onPointerDown(h.event(500)));
  act(() => h.view.result.current.handlers.onPointerMove(h.event(400, 13000)));
  const released = h.view.result.current.scrubPosition!;
  await act(async () => { h.view.result.current.handlers.onPointerUp(h.event(400, 13100)); });

  // Past the settle window - a report can only be a response to the seek once that has passed.
  h.advance(200);
  await act(async () => { h.view.rerender({ position: released, deckStatus: status(released) }); });
  assert.equal(h.view.result.current.scrubPosition, null, 'handed back to the box');
});

test('the seek is sent once, with where the finger left it', async () => {
  const h = harness();
  act(() => h.view.result.current.handlers.onPointerDown(h.event(500)));
  act(() => h.view.result.current.handlers.onPointerMove(h.event(400, 13000)));
  const released = h.view.result.current.scrubPosition!;
  await act(async () => { h.view.result.current.handlers.onPointerUp(h.event(400, 13100)); });

  assert.equal(h.seeks.length, 1);
  assert.ok(Math.abs(h.seeks[0]! - released) < 0.01);
});

/* And the coast itself: a fast flick keeps travelling past where the finger stopped. */
test('a fast flick coasts beyond where the finger let go', async () => {
  const h = harness();
  act(() => h.view.result.current.handlers.onPointerDown(h.event(500)));
  act(() => h.view.result.current.handlers.onPointerMove(h.event(400, 50)));
  const atRelease = h.view.result.current.scrubPosition!;

  await act(async () => { h.view.result.current.handlers.onPointerUp(h.event(400, 60)); });

  assert.equal(h.seeks.length, 1, 'still seeks exactly once');
  assert.ok(h.seeks[0]! > atRelease, 'and lands further on than the finger did');
});

/*
 * Interrupting a coast must not throw away where it had got to.
 *
 * Abandoning the coast without sending a seek is deliberate - the new gesture will send its own -
 * but it means the BOX is still reporting where the track was before the flick. A press that anchors
 * to the box therefore snaps the waveform back to the original position the moment it is touched,
 * which is exactly what a flick-then-tap looked like.
 */
test('pressing during a coast keeps the position the coast had reached', async () => {
  const h = harness();

  // A flick, released with enough velocity to coast.
  act(() => h.view.result.current.handlers.onPointerDown(h.event(500)));
  act(() => h.view.result.current.handlers.onPointerMove(h.event(400, 50)));

  /* Interrupted mid-coast: the release is started but NOT awaited, then a new press lands. The
   * coast sees a new generation, abandons itself, and never commits. */
  h.view.result.current.handlers.onPointerUp(h.event(400, 60));
  const mid = h.view.result.current.scrubPosition;
  assert.ok(mid !== null && mid > 20, 'the coast moved it somewhere past the start');

  act(() => h.view.result.current.handlers.onPointerDown(h.event(300)));

  assert.notEqual(h.view.result.current.scrubPosition, 20, 'must NOT snap back to where the box is');
  assert.equal(h.view.result.current.scrubPosition, mid, 'it carries on from where the coast was');
});

test('and a press with nothing on screen still anchors to the box', () => {
  const h = harness();
  act(() => h.view.result.current.handlers.onPointerDown(h.event(500)));
  assert.equal(h.view.result.current.scrubPosition, 20, 'the deck position, as before');
});
