import { test, assert, beforeEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useResume, resetResumesForTest } from './useResume';

beforeEach(() => { cleanup(); resetResumesForTest(); });

/** jsdom reports the document as visible and will not let it be assigned - so it is defined over. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

test('coming back to the foreground is an event; going away is not', () => {
  const view = renderHook(() => useResume());
  const start = view.result.current;

  act(() => setVisibility('hidden'));
  assert.equal(view.result.current, start, 'leaving is not something anything needs to act on');

  act(() => setVisibility('visible'));
  assert.equal(view.result.current, start + 1, 'coming back is');
});

test('a first load is not a resume', () => {
  // pageshow fires on every load; only a restore from the back/forward cache is a return.
  const view = renderHook(() => useResume());
  const start = view.result.current;

  act(() => { window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false })); });
  assert.equal(view.result.current, start);

  act(() => { window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true })); });
  assert.equal(view.result.current, start + 1);
});

test('every reader is told, from one pair of listeners', () => {
  const a = renderHook(() => useResume());
  const b = renderHook(() => useResume());

  act(() => setVisibility('visible'));
  assert.equal(a.result.current, b.result.current);
  assert.ok(a.result.current > 0);
});
