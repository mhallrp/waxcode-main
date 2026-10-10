import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PopupMenu } from './PopupMenu';

/*
 * A trigger near the right of the top bar opened a 150px menu straight off the side of the phone.
 * Left alignment under the trigger is right where there is room; it just must not run off
 * (owner-reported, 2026-09-30).
 */

const OPTIONS = [
  { value: 'digital', label: 'Digital' },
  { value: 'passthrough', label: 'Passthrough' },
];

beforeEach(() => cleanup());
afterEach(() => vi.restoreAllMocks());

/** jsdom gives every element a zero rect, so the geometry has to be stated. */
function withMenuAt(right: number, viewport = 390, safeRight = 0) {
  vi.stubGlobal('innerWidth', viewport);
  document.documentElement.style.setProperty('--safe-right', `${safeRight}px`);
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('role') === 'menu') {
      return { left: right - 150, right, top: 0, bottom: 40, width: 150, height: 40, x: right - 150, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    return original.call(this);
  });
  render(<PopupMenu label="Mode" ariaLabel="Deck mode" options={OPTIONS} value="digital" onChange={() => {}} />);
  // fireEvent, not .click - a raw DOM click does not flush the state change.
  fireEvent.click(screen.getByLabelText('Deck mode'));
  return screen.getByRole('menu');
}

test('a menu with room is left aligned under its trigger, untouched', () => {
  const menu = withMenuAt(200);
  assert.equal(menu.style.transform, '', 'nothing to correct');
});

test('a menu that would run off the right is pulled back on screen', () => {
  // 150px menu ending at 420 on a 390 viewport: 38px past the 8px margin.
  const menu = withMenuAt(420);
  assert.match(menu.style.transform, /translateX\(-38px\)/);
});

/*
 * The case the first clamp missed, caught on a real screen: every screen in this app pads itself by
 * env(safe-area-inset-right), so a menu can sit entirely inside the viewport while hanging past the
 * CONTENT and into the rounded corner - which is what it looks like from the outside.
 */
test('a menu is pulled inside the safe area, not just inside the viewport', () => {
  // Ends at 370 on a 390 viewport - inside it - but 44 past a content edge inset by 60.
  const menu = withMenuAt(370, 390, 60);
  assert.match(menu.style.transform, /translateX\(-48px\)/);
});
