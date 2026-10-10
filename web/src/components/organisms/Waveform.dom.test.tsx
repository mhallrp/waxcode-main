import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Waveform } from './Waveform';

/*
 * Tapping the overview is a JUMP to an arbitrary point. On a deck under a needle that means the
 * audio leaves where the record is - the platter carries on from a position the track is no longer
 * at. Scrubbing the zoomed canvas is the gesture for moving a playing deck; this one is for setting
 * up a stopped one.
 */

beforeEach(() => {
  cleanup();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());

function overviewOf(playing: boolean, onSeek: (seconds: number) => void) {
  const { container } = render(
    <Waveform
      peaks={[{ min: -1, max: 1, low: 1, mid: 1, high: 1 }]}
      decoded={1}
      position={0}
      duration={100}
      grid={null}
      cuePoint={null}
      analysing={false}
      playing={playing}
      loop={null}
      onSeek={onSeek}
    />,
  );
  const canvases = container.querySelectorAll('canvas');
  // The zoomed canvas is first, the overview second - see the component's own layout.
  return canvases[1]!;
}

/** jsdom gives every element a zero-sized rect, so the maths needs a real one to land on. */
function tapMiddle(canvas: Element) {
  canvas.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 10, right: 200, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, bubbles: true }));
}

test('tapping the overview seeks while the deck is stopped', () => {
  const seeks: number[] = [];
  tapMiddle(overviewOf(false, (seconds) => seeks.push(seconds)));
  assert.deepEqual(seeks, [50], 'halfway across a 100s track');
});

test('tapping the overview does nothing while the deck is playing', () => {
  const seeks: number[] = [];
  tapMiddle(overviewOf(true, (seconds) => seeks.push(seconds)));
  assert.deepEqual(seeks, [], 'a running deck must not be jumped from under the needle');
});
