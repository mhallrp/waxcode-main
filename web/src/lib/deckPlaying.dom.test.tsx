import { test, assert, beforeEach, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { act } from 'react';
import { setDeckPlaying, useDeckPlaying } from './deckPlaying';

beforeEach(() => { setDeckPlaying(1, false); setDeckPlaying(2, false); });
afterEach(cleanup);

test('a reader follows the deck it asked about, and ignores the other', () => {
  let renders = 0;
  function Probe() {
    renders += 1;
    return <span data-testid="p">{useDeckPlaying(1) ? 'playing' : 'stopped'}</span>;
  }
  const view = render(<Probe />);
  assert.equal(view.getByTestId('p').textContent, 'stopped');

  act(() => setDeckPlaying(1, true));
  assert.equal(view.getByTestId('p').textContent, 'playing');

  /* 20 statuses a second all saying PLAYING must not re-render every reader 20 times a second -
   * the library is a long scrolling list and this would run the whole way down it. */
  const settled = renders;
  act(() => { setDeckPlaying(1, true); setDeckPlaying(1, true); setDeckPlaying(1, true); });
  assert.equal(renders, settled, 'a repeated value must not wake anyone');

  act(() => setDeckPlaying(2, true));
  assert.equal(renders, settled, 'nor must the other deck');
});
