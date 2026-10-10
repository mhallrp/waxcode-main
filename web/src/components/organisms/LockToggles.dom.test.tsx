import { test, assert, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { LockToggles } from './LockToggles';

afterEach(cleanup);

const toggles = (extra: Partial<Parameters<typeof LockToggles>[0]> = {}) => (
  <LockToggles
    positionLock={false}
    keyLock={false}
    onPositionLock={() => {}}
    onKeyLock={() => {}}
    {...extra}
  />
);

/*
 * The FX loop's return shares deck 1's phono output jack, which in Phono mode is carrying a real
 * record at cartridge level. The box refuses to run the two at once; the switch must not be sitting
 * there inviting somebody to try.
 */
test('no FX switch when the box is not offering one', () => {
  render(toggles({ fxAvailable: false, onFx: () => {} }));
  assert.equal(screen.queryByRole('button', { name: 'FX' }), null);
  assert.ok(screen.getByRole('button', { name: /position/i }), 'the others are still there');
});

test('the FX switch appears when the box offers it, and reports what it is', () => {
  let asked: boolean | null = null;
  render(toggles({ fxAvailable: true, fx: false, onFx: (on) => { asked = on; } }));

  const button = screen.getByRole('button', { name: 'FX' });
  assert.equal(button.getAttribute('aria-pressed'), 'false');

  fireEvent.click(button);
  assert.equal(asked, true);
});

test('an FX loop that is running reads as on', () => {
  render(toggles({ fxAvailable: true, fx: true, onFx: () => {} }));
  assert.equal(screen.getByRole('button', { name: 'FX' }).getAttribute('aria-pressed'), 'true');
});
