import { test, assert, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { UpdateScreen } from './UpdateScreen';
import { startWatching } from '../lib/updateProgress';

/*
 * The screen that replaces the broken flow: press Install, the banner says "Installing", the page
 * reloads a few seconds later because /version answered, the state is lost, and the banner offers the
 * same update again. The owner pressed it three times while the box logged "already in progress".
 */

let reported: string | null;
let originalFetch: typeof globalThis.fetch;
const watch = { target: 'v0.10.15', startedAt: Date.now() };

beforeEach(() => {
  localStorage.clear();
  reported = 'v0.10.14';
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (reported === null) throw new Error('unreachable');
    return { ok: true, json: async () => ({ version: reported }) };
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = originalFetch; cleanup(); });

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

test('while the box still reports the OLD version it says installing, and does NOT finish', async () => {
  render(<UpdateScreen watch={watch} onLeave={() => {}} />);
  await settle();
  /* The exact bug: /version answers for several seconds after the POST. Any answer is not success. */
  assert.ok(screen.getByText(/Installing/));
  assert.equal(screen.queryByText(/Up to date/), null);
});

test('an unreachable box is the restart, and is reported as progress not failure', async () => {
  reported = null;
  render(<UpdateScreen watch={watch} onLeave={() => {}} />);
  await settle();
  assert.ok(screen.getByText(/Restarting/));
});

test('it finishes only when the box reports the version that was asked for', async () => {
  reported = 'v0.10.15';
  render(<UpdateScreen watch={watch} onLeave={() => {}} />);
  await settle();
  assert.ok(screen.getByText(/Up to date/));
});

test('there is no Cancel, because an accepted update cannot be stopped', async () => {
  render(<UpdateScreen watch={watch} onLeave={() => {}} />);
  await settle();
  /* A button claiming to cancel would be a lie. Leaving stops watching, which is all this does. */
  assert.equal(screen.queryByRole('button', { name: /cancel/i }), null);
  assert.ok(screen.getByRole('button', { name: /Leave this screen/i }));
});

test('leaving clears the watch, so a reload does not drop straight back here', async () => {
  startWatching('v0.10.15');
  let left = false;
  render(<UpdateScreen watch={watch} onLeave={() => { left = true; }} />);
  await settle();
  await act(async () => { screen.getByRole('button', { name: /Leave this screen/i }).click(); });
  assert.equal(left, true);
  assert.equal(localStorage.getItem('waxcode.update'), null);
});

test('a long wait on the old version says so rather than spinning forever', async () => {
  vi.useFakeTimers();
  try {
    const stale = { target: 'v0.10.15', startedAt: Date.now() - 9 * 60_000 };
    render(<UpdateScreen watch={stale} onLeave={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    assert.match(document.body.textContent ?? '', /taking longer than it should/);
    /* And says plainly that leaving is safe, because by then somebody is worried. */
    assert.match(document.body.textContent ?? '', /safe to leave/);
  } finally { vi.useRealTimers(); }
});
