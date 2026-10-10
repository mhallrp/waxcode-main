import { test, assert, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCoarsePointer } from './useCoarsePointer';

afterEach(() => vi.unstubAllGlobals());

/* The user agent cannot answer this: iPadOS has reported itself as a Mac since version 13. */
test('a finger reads as coarse and a trackpad does not', () => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === '(pointer: coarse)', addEventListener() {}, removeEventListener() {},
  }));
  assert.equal(renderHook(() => useCoarsePointer()).result.current, true);

  vi.stubGlobal('matchMedia', () => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  }));
  assert.equal(renderHook(() => useCoarsePointer()).result.current, false);
});

test('a browser without matchMedia is treated as a pointer, not a crash', () => {
  vi.stubGlobal('matchMedia', undefined);
  assert.equal(renderHook(() => useCoarsePointer()).result.current, false);
});
