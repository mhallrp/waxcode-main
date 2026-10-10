import { test, assert } from 'vitest';
import { keyboardInset } from './keyboardInset';

/*
 * The arithmetic behind "the entire view moves up and the keyboard takes the space". Safari ignores
 * interactive-widget=overlays-content, so the visual viewport is the only thing that knows a keyboard
 * is up - and getting this subtly wrong shows as a search field drifting or sliding off screen.
 */

test('no keyboard is no inset', () => {
  assert.equal(keyboardInset(844, { height: 844, offsetTop: 0 }), 0);
});

test('a keyboard shrinking the visual viewport is measured', () => {
  // An iPhone 14 in portrait with the keyboard up: 844 layout, about 508 visible.
  assert.equal(keyboardInset(844, { height: 508, offsetTop: 0 }), 336);
});

test('offsetTop counts as much as height', () => {
  /* The case that breaks a height-only measurement: when Safari scrolls the view up to reveal the
   * focused input it keeps the visual viewport's HEIGHT and gives it an offset instead. Measuring
   * height alone reports no keyboard at the exact moment there is one. */
  assert.equal(keyboardInset(844, { height: 508, offsetTop: 100 }), 236);
  // Both move together in practice: the keyboard shrinks the height AND Safari offsets the view.
  assert.equal(keyboardInset(844, { height: 600, offsetTop: 200 }), 44);

  /* Full height WITH a large offset cannot be a keyboard - a keyboard always costs height - so it is
   * clamped rather than reported. Getting that wrong would push the field off the bottom. */
  assert.equal(keyboardInset(844, { height: 844, offsetTop: 300 }), 0);
});

test('a few pixels of disagreement is not a keyboard', () => {
  /* The address bar resizing, or rounding between the two viewports. Treated as a keyboard it would
   * make the search field twitch by a pixel or two at rest. */
  assert.equal(keyboardInset(844, { height: 840, offsetTop: 0 }), 0);
  assert.equal(keyboardInset(844, { height: 823, offsetTop: 0 }), 0, '21px is still noise');
  assert.equal(keyboardInset(844, { height: 820, offsetTop: 0 }), 24, 'and 24 is real');
});

test('a visual viewport taller than the layout is clamped, not trusted', () => {
  // Happens transiently mid-rotation. A negative inset would pull the field off the bottom.
  assert.equal(keyboardInset(390, { height: 844, offsetTop: 0 }), 0);
});

test('missing or nonsensical input is zero rather than NaN', () => {
  /* A NaN would reach CSS as `calc(6px + NaNpx)`, which invalidates the whole declaration and drops
   * the field to wherever it would sit with no positioning at all. */
  assert.equal(keyboardInset(844, null), 0);
  assert.equal(keyboardInset(844, undefined), 0);
  assert.equal(keyboardInset(Number.NaN, { height: 508, offsetTop: 0 }), 0);
  assert.equal(keyboardInset(844, { height: Number.NaN, offsetTop: 0 }), 0);
  assert.equal(keyboardInset(844, { height: 508, offsetTop: Number.NaN }), 336, 'a bad offset is ignored, not fatal');
  assert.equal(keyboardInset(0, { height: 508, offsetTop: 0 }), 0);
});
