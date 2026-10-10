import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useBeatGrid, NUDGE_SECONDS } from './useBeatGrid';

const posts: Array<{ url: string; seconds: number }> = [];
let stored = 0;

beforeEach(() => {
  posts.length = 0;
  stored = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { seconds: number };
      posts.push({ url: String(url), seconds: body.seconds });
      // The box clamps, and its answer is authoritative.
      stored = Math.max(-0.5, Math.min(0.5, body.seconds));
      return { ok: true, json: async () => ({ ok: true, offset: stored }) };
    }
    return { ok: true, json: async () => ({ bpm: 120, firstBeatSeconds: 10, offset: stored }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

test('the grid moves on the press, before the box has stored anything', async () => {
  const view = renderHook(() => useBeatGrid('/x.mp3'));
  await waitFor(() => assert.ok(view.result.current.grid));

  assert.equal(view.result.current.grid?.firstBeatSeconds, 10);

  await act(async () => { await view.result.current.nudge(NUDGE_SECONDS); });

  assert.ok(
    Math.abs((view.result.current.grid?.firstBeatSeconds ?? 0) - (10 + NUDGE_SECONDS)) < 1e-9,
    'the grid moved by one step',
  );
  assert.equal(posts.length, 1, 'and it was saved');
  assert.ok(Math.abs(posts[0]!.seconds - NUDGE_SECONDS) < 1e-9, 'the total offset, not the delta');
});

/* Presses accumulate - somebody adjusts by ear, pressing several times without waiting. */
test('repeated presses accumulate into one stored offset', async () => {
  const view = renderHook(() => useBeatGrid('/x.mp3'));
  await waitFor(() => assert.ok(view.result.current.grid));

  await act(async () => { await view.result.current.nudge(NUDGE_SECONDS); });
  await act(async () => { await view.result.current.nudge(NUDGE_SECONDS); });
  await act(async () => { await view.result.current.nudge(NUDGE_SECONDS); });

  assert.ok(
    Math.abs((view.result.current.grid?.offset ?? 0) - 3 * NUDGE_SECONDS) < 1e-9,
    `three steps, got ${view.result.current.grid?.offset}`,
  );
  assert.ok(Math.abs(posts[2]!.seconds - 3 * NUDGE_SECONDS) < 1e-9, 'the running total is sent');
});

/* The box clamps; a guess it did not accept must not stay on screen. */
test('the box has the last word when it clamps', async () => {
  const view = renderHook(() => useBeatGrid('/x.mp3'));
  await waitFor(() => assert.ok(view.result.current.grid));

  await act(async () => { await view.result.current.nudge(9); });

  assert.equal(view.result.current.grid?.offset, 0.5, 'clamped to what was stored');
  assert.ok(
    Math.abs((view.result.current.grid?.firstBeatSeconds ?? 0) - 10.5) < 1e-9,
    'and the grid follows the stored value, not the press',
  );
});
