import { test, assert, vi, beforeEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useWaveform } from './useWaveform';
import { resetResumesForTest } from './useResume';

const streams: Array<{ url: string; onmessage: ((event: { data: string }) => void) | null }> = [];

/** One finished waveform, in the shape the box streams it. */
function sendWholeWaveform() {
  const count = 10;
  const bytes = new Uint8Array(2 + count * 5);
  new DataView(bytes.buffer).setUint16(0, count, true);
  const b64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
  act(() => { streams[streams.length - 1]?.onmessage?.({ data: JSON.stringify({ done: true, b64 }) }); });
}

const comeBackToTheApp = () => act(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});

beforeEach(() => {
  cleanup();
  resetResumesForTest();
  streams.length = 0;
  vi.stubGlobal('EventSource', class {
    url: string;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) { this.url = url; streams.push(this as never); }
    close() {}
  });
});

test('a waveform cut off by the app being suspended is asked for again', () => {
  renderHook(() => useWaveform('/music/a.mp3', 100));
  assert.equal(streams.length, 1);

  // Nothing finished it - the app went away mid-stream.
  comeBackToTheApp();
  assert.equal(streams.length, 2, 'a half-drawn waveform was left half drawn');
});

test('a waveform that already arrived is not fetched again on every resume', () => {
  const view = renderHook(() => useWaveform('/music/a.mp3', 100));
  sendWholeWaveform();
  assert.equal(view.result.current.decoded, 1);

  comeBackToTheApp();
  assert.equal(streams.length, 1, 'it re-downloaded a waveform it already had');
  assert.equal(view.result.current.decoded, 1, 'and it is still drawn');
});

/* The deck being emptied and the same track put back on it. The "already have this one" note is
 * about the peaks currently in hand, so it has to go when they do. */
test('the same track loaded again after an unload still gets its waveform', () => {
  const view = renderHook(({ path }) => useWaveform(path, 100), {
    initialProps: { path: '/music/a.mp3' as string | null },
  });
  sendWholeWaveform();

  view.rerender({ path: null });
  assert.equal(view.result.current.peaks, null);

  view.rerender({ path: '/music/a.mp3' });
  assert.equal(streams.length, 2, 'the deck was left with no waveform at all');
});
