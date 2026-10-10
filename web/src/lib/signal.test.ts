import { test, assert } from 'vitest';
import { meterFraction, verdictFor, type DeckSignal } from './signal';

const FULL = 2147483647;
const FLOOR = 128 << 16;
const at = (fraction: number) => Math.round(fraction * FULL);

/** A deck tracking perfectly, which each test then breaks in one specific way. */
const healthy: DeckSignal = {
  deck: 1,
  peakLeft: at(0.5),
  peakRight: at(0.5),
  threshold: FLOOR,
  safe: true,
  forwards: true,
  validCounter: 64,
};

test('a healthy deck reads as good', () => {
  assert.equal(verdictFor(healthy), 'good');
});

test('an offline deck is reported as off, not as having no signal', () => {
  assert.equal(verdictFor({ deck: 1, offline: true }), 'offline');
});

test('both channels below the floor is no signal', () => {
  assert.equal(verdictFor({ ...healthy, peakLeft: 0, peakRight: 0 }), 'noSignal');
});

/* Named by the side that is DEAD, not the side still working - the message tells someone which lead
 * to go and check, so getting this backwards sends them to the wrong plug. */
test('one channel far below the floor names the dead side', () => {
  assert.equal(verdictFor({ ...healthy, peakRight: 0 }), 'rightChannelDead');
  assert.equal(verdictFor({ ...healthy, peakLeft: 0 }), 'leftChannelDead');
});

test('one channel merely quiet is weak, not dead', () => {
  // Below the floor, but not below a quarter of it.
  assert.equal(verdictFor({ ...healthy, peakRight: Math.round(FLOOR * 0.5) }), 'channelWeak');
});

/*
 * The ORDER is the design. A swapped pair and a noisy signal both have plenty of level, and testing
 * for noise first would report every reversed deck as "clean the record" - which it is not.
 */
test('a reversed but locked signal is reported as swapped, not as noisy', () => {
  assert.equal(verdictFor({ ...healthy, forwards: false }), 'channelsSwapped');
});

test('enough level but no solid lock is noisy', () => {
  assert.equal(verdictFor({ ...healthy, validCounter: 4 }), 'noisy');
  assert.equal(verdictFor({ ...healthy, safe: false }), 'noisy');
});

test('the meter is logarithmic, so the quiet half of the scale is usable', () => {
  assert.equal(meterFraction(1), 1);
  assert.equal(meterFraction(0), 0);
  // -6dB is a half of full scale in amplitude, and must NOT plot at half height.
  assert.ok(meterFraction(0.5) > 0.9, 'a linear meter would put this at 0.5');
});
