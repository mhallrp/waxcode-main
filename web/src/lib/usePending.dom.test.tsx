import { test, assert, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePending } from './usePending';

afterEach(() => vi.useRealTimers());

test('the pressed value shows at once, before the box has said anything', () => {
  const view = renderHook(({ actual }: { actual: number | null }) => usePending(actual), {
    initialProps: { actual: null as number | null },
  });
  assert.equal(view.result.current[0], null);

  act(() => { view.result.current[1](4); });
  assert.equal(view.result.current[0], 4, 'shown on the tap, not on the reply');
});

test('agreement hands control straight back to the box', () => {
  const view = renderHook(({ actual }: { actual: number | null }) => usePending(actual), {
    initialProps: { actual: null as number | null },
  });
  act(() => { view.result.current[1](4); });
  view.rerender({ actual: 4 });
  assert.equal(view.result.current[0], 4);

  // Once the box agrees the optimistic value is gone, so a LATER change from the box is followed.
  view.rerender({ actual: 8 });
  assert.equal(view.result.current[0], 8, 'not stuck on what was pressed');
});

/* A command the box never applied must not leave a button showing a state the deck never reached. */
test('an optimistic value expires if the box never agrees', () => {
  vi.useFakeTimers();
  const view = renderHook(({ actual }: { actual: number | null }) => usePending(actual, 1000), {
    initialProps: { actual: null as number | null },
  });

  act(() => { view.result.current[1](4); });
  assert.equal(view.result.current[0], 4);

  act(() => { vi.advanceTimersByTime(1100); });
  assert.equal(view.result.current[0], null, 'back to what the box actually says');
});

test('a refused command can be taken back at once', () => {
  const view = renderHook(({ actual }: { actual: boolean }) => usePending(actual), {
    initialProps: { actual: false },
  });
  act(() => { view.result.current[1](true); });
  assert.equal(view.result.current[0], true);

  act(() => { view.result.current[2](); });
  assert.equal(view.result.current[0], false, 'the box said no, so the button follows');
});
