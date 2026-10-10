import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useReachable } from './useReachable';

/*
 * The signal behind the offline screen. Getting the threshold wrong is not a crash - it is an
 * overlay that flickers over a working box, or one that never appears over a dead one.
 */

function Probe() {
  return <div data-reachable={useReachable()} />;
}

const reachable = (container: HTMLElement) => container.querySelector('div')!.dataset.reachable;

/** One heartbeat plus the promise it awaits. */
async function beat() {
  await act(async () => {
    vi.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => { cleanup(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('a box that answers is reachable, and stays that way', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version: 'v1' }) })));
  const { container } = render(<Probe />);
  await beat();
  assert.equal(reachable(container), 'true');
});

/* One miss is a dropped packet on a busy network. An overlay that appears for a single beat and
 * vanishes again is worse than no overlay at all, so it takes two. */
test('one miss is ignored; two means the box is gone', async () => {
  const fetchMock = vi.fn(async () => { throw new Error('unreachable'); });
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<Probe />);

  // The mount's own beat is the first miss.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  assert.equal(reachable(container), 'true', 'still trusted after one');

  await beat();
  assert.equal(reachable(container), 'false', 'gone after two');
});

/* And it must clear itself. Nobody should have to relaunch the app because the box was rebooted. */
test('it recovers on the first answer, with no reload', async () => {
  let up = false;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!up) throw new Error('unreachable');
    return { ok: true, status: 200, json: async () => ({ version: 'v1' }) };
  }));

  const { container } = render(<Probe />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await beat();
  assert.equal(reachable(container), 'false');

  up = true;
  await beat();
  assert.equal(reachable(container), 'true', 'back without a reload');
});
