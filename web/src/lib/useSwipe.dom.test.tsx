import { test, assert, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSwipe } from './useSwipe';

/**
 * The invariant: the pointer is NOT captured until a drag is real.
 *
 * Capturing on pointerdown redirects every later event to the capturing element, so the click never
 * reaches the button underneath. That is exactly what broke Load Track - and the render-level smoke
 * test did not catch it, because calling .click in jsdom never goes through pointer events at all.
 */
let now = 0;
/** Advances the clock the way a real gesture does, between simulated pointer events. */
function elapse(ms: number) {
  now += ms;
}

function harness(page = 0) {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const onPage = vi.fn();
  const { result } = renderHook(() => useSwipe({ count: 3, page, onPage }));
  const setPointerCapture = vi.fn();
  const target = {
    setPointerCapture,
    clientWidth: 1000,
  } as unknown as HTMLDivElement;

  /* `target` matters: a press that lands on a canvas or a control is not a page swipe, and the hook
   * bails on it entirely. Defaults to a plain div, which is. */
  const event = (clientX: number, tag = 'div') => ({
    pointerId: 1,
    pointerType: 'touch',
    buttons: 1,
    clientX,
    currentTarget: target,
    target: { closest: (selector: string) => (selector.includes(tag) ? {} : null) },
  }) as never;

  return { handlers: result.current.handlers, setPointerCapture, onPage, event };
}

test('a press does not capture the pointer, so a tap still reaches the button', () => {
  const { handlers, setPointerCapture } = harness();
  handlers.onPointerDown(harness().event(500));
  assert.equal(setPointerCapture.mock.calls.length, 0);
});

test('a tap - press and release without moving - changes nothing', () => {
  const h = harness();
  h.handlers.onPointerDown(h.event(500));
  h.handlers.onPointerUp(h.event(502));
  assert.equal(h.setPointerCapture.mock.calls.length, 0, 'never captured');
  assert.equal(h.onPage.mock.calls.length, 0, 'and never changed page');
});

test('a small wobble is still a tap, not a drag', () => {
  const h = harness();
  h.handlers.onPointerDown(h.event(500));
  h.handlers.onPointerMove(h.event(505)); // under the 8px threshold
  assert.equal(h.setPointerCapture.mock.calls.length, 0);
});

test('a real drag captures the pointer, once', () => {
  const h = harness();
  h.handlers.onPointerDown(h.event(500));
  h.handlers.onPointerMove(h.event(460));
  h.handlers.onPointerMove(h.event(400));
  assert.equal(h.setPointerCapture.mock.calls.length, 1, 'captured exactly once');
});

test('dragging far enough turns the page', () => {
  const h = harness(0);
  h.handlers.onPointerDown(h.event(900));
  elapse(120);
  h.handlers.onPointerMove(h.event(500));
  h.handlers.onPointerUp(h.event(400));
  assert.deepEqual(h.onPage.mock.calls, [[1]]);
});

/* 20px over a third of a second is a nudge, not a swipe - and must not turn the page. This failed
 * first time round: velocity taken from the last two events reported thousands of pixels per second
 * and projected the nudge half a screen. */
test('a slow, short drag springs back rather than turning the page', () => {
  const h = harness(0);
  h.handlers.onPointerDown(h.event(500));
  elapse(300);
  h.handlers.onPointerMove(h.event(480));
  h.handlers.onPointerUp(h.event(480));
  assert.equal(h.onPage.mock.calls.length, 0);
});

/* The other half of the same rule: a SHORT movement that is genuinely fast is a flick, and should
 * turn the page even though it never travelled a quarter of the screen. */
test('a fast flick turns the page even though it is short', () => {
  const h = harness(0);
  h.handlers.onPointerDown(h.event(500));
  elapse(50);
  h.handlers.onPointerMove(h.event(420));
  h.handlers.onPointerUp(h.event(420));
  assert.deepEqual(h.onPage.mock.calls, [[1]]);
});

test('it will not page past either end', () => {
  const first = harness(0);
  first.handlers.onPointerDown(first.event(100));
  elapse(120);
  first.handlers.onPointerMove(first.event(600));
  first.handlers.onPointerUp(first.event(700));
  assert.equal(first.onPage.mock.calls.length, 0, 'already on the first page');

  const last = harness(2);
  last.handlers.onPointerDown(last.event(900));
  elapse(120);
  last.handlers.onPointerMove(last.event(400));
  last.handlers.onPointerUp(last.event(300));
  assert.equal(last.onPage.mock.calls.length, 0, 'already on the last page');
});

/*
 * A drag that starts on the waveform is a SCRUB, not a page swipe. Letting the page take it made the
 * deck card slide sideways when someone tried to move the playhead - reported 2026-09-28.
 */
test('a press that starts on the waveform is left entirely alone', () => {
  const h = harness(0);
  h.handlers.onPointerDown(h.event(500, 'canvas'));
  elapse(120);
  h.handlers.onPointerMove(h.event(100, 'canvas'));
  h.handlers.onPointerUp(h.event(100, 'canvas'));
  assert.equal(h.setPointerCapture.mock.calls.length, 0, 'never captured');
  assert.equal(h.onPage.mock.calls.length, 0, 'and never turned the page');
});

test('a press on a control is left alone too', () => {
  const h = harness(0);
  h.handlers.onPointerDown(h.event(500, 'button'));
  elapse(120);
  h.handlers.onPointerMove(h.event(100, 'button'));
  h.handlers.onPointerUp(h.event(100, 'button'));
  assert.equal(h.onPage.mock.calls.length, 0);
});
