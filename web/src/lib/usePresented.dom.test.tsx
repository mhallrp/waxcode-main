import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { usePresented } from './usePresented';

/*
 * The mechanism behind both overlay animations, and one that fails INVISIBLY: get it wrong and the
 * screen still appears, just without the slide. Neither half is obvious from reading it.
 */

function Probe({ open }: { open: boolean }) {
  const { mounted, shown } = usePresented(open, 300);
  // As App does it: `mounted` decides whether the overlay exists, `shown` decides where it sits.
  return mounted ? <div data-shown={shown} /> : null;
}

const read = (container: HTMLElement) => {
  const node = container.querySelector('div');
  return { mounted: String(Boolean(node)), shown: node?.dataset.shown ?? 'gone' };
};

/** Runs the two animation frames usePresented waits for. */
async function frames() {
  for (let i = 0; i < 2; i += 1) {
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
  }
}

beforeEach(() => { cleanup(); vi.useRealTimers(); });
afterEach(() => { vi.useRealTimers(); });

/* An element cannot transition out of a state that was never painted. Setting both at once means
 * the browser only ever sees the open state, and nothing animates. */
test('it mounts closed, and only opens on a later frame', async () => {
  const { container, rerender } = render(<Probe open={false} />);
  rerender(<Probe open />);
  assert.deepEqual(read(container), { mounted: 'true', shown: 'false' }, 'mounted, still closed');
  await frames();
  assert.deepEqual(read(container), { mounted: 'true', shown: 'true' }, 'now open');
});

/* And it cannot animate out once it is gone - which is why closing does not unmount immediately. */
test('it stays mounted while it slides back out, then unmounts', async () => {
  vi.useFakeTimers();
  const { container, rerender } = render(<Probe open />);
  rerender(<Probe open={false} />);
  assert.deepEqual(read(container), { mounted: 'true', shown: 'false' }, 'closing, still mounted');

  await act(async () => { vi.advanceTimersByTime(299); });
  assert.equal(read(container).mounted, 'true', 'still there one tick before the end');

  await act(async () => { vi.advanceTimersByTime(2); });
  assert.equal(container.querySelector('div'), null, 'gone once the slide has finished');
});
