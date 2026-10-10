import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markReady, startLedStatusLoop } from '../src/led-status.js';

const TRIGGER = '/sys/class/leds/ACT/trigger';
const DELAY_ON = '/sys/class/leds/ACT/delay_on';

/** Collects what the loop writes, and lets a test drive the two inputs it reads. */
function harness({ cable = null, apUp = false, writeFn } = {}) {
  const calls = [];
  const loop = startLedStatusLoop({
    cablePresentSince: () => cable,
    wifiMode: { isApUp: () => apUp },
    writeFn: writeFn ?? ((path, value) => calls.push({ path, value })),
    pollIntervalMs: 10,
  });
  return { calls, loop, blinkMs: () => calls.find((c) => c.path === DELAY_ON)?.value };
}

test('markReady writes mmc0 to the LED trigger path', () => {
  const calls = [];
  markReady({ writeFn: (path, value) => calls.push({ path, value }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, TRIGGER);
  assert.equal(calls[0].value, 'mmc0');
});

test('markReady does not throw if the write fails (no such LED on this machine)', () => {
  assert.doesNotThrow(() => markReady({ writeFn: () => { throw new Error('ENOENT'); } }));
});

test('a cable in the box blinks fast', () => {
  const h = harness({ cable: 1_000 });
  h.loop.stop();
  assert.equal(h.blinkMs(), '150');
});

test('no cable but the AP is up blinks slowly - the state with no other signal', () => {
  const h = harness({ cable: null, apUp: true });
  h.loop.stop();
  assert.equal(h.blinkMs(), '900');
});

test('a cable wins over the AP, since one action should not produce two signals', () => {
  /* Plugging a cable in raises the setup network too, so both are true at once. The fast blink
     already means "you plugged something in". */
  const h = harness({ cable: 1_000, apUp: true });
  h.loop.stop();
  assert.equal(h.blinkMs(), '150');
});

test('nothing to report leaves the LED as ordinary disk activity', () => {
  const h = harness({ cable: null, apUp: false });
  h.loop.stop();
  assert.deepEqual(h.calls, [{ path: TRIGGER, value: 'mmc0' }]);
});

test('it only writes when the state actually changes', async () => {
  let cable = null;
  const calls = [];
  const loop = startLedStatusLoop({
    cablePresentSince: () => cable,
    wifiMode: { isApUp: () => false },
    writeFn: (path, value) => calls.push({ path, value }),
    pollIntervalMs: 10,
  });
  await new Promise((r) => setTimeout(r, 45));
  const settled = calls.length;
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(calls.length, settled, 'an unchanged state is not rewritten every tick');

  cable = 2_000;
  await new Promise((r) => setTimeout(r, 45));
  loop.stop();
  assert.ok(calls.length > settled, 'but a real change is');
});

test('a failed write is retried next tick rather than recorded as done', async () => {
  /* A real EACCES race on hardware: switching to the timer trigger recreates delay_on root-owned,
     and the udev rule that regrants access runs asynchronously off that same change. */
  let failing = true;
  const calls = [];
  const loop = startLedStatusLoop({
    cablePresentSince: () => 1_000,
    wifiMode: { isApUp: () => false },
    writeFn: (path, value) => {
      if (failing && path === DELAY_ON) throw new Error('EACCES');
      calls.push({ path, value });
    },
    pollIntervalMs: 10,
  });
  await new Promise((r) => setTimeout(r, 45));
  assert.ok(!calls.some((c) => c.path === DELAY_ON), 'nothing recorded while it fails');
  failing = false;
  await new Promise((r) => setTimeout(r, 45));
  loop.stop();
  assert.ok(calls.some((c) => c.path === DELAY_ON && c.value === '150'), 'it retried and landed');
});

test('a write that always fails does not throw', () => {
  assert.doesNotThrow(() => {
    const h = harness({ cable: 1_000, writeFn: () => { throw new Error('EACCES'); } });
    h.loop.stop();
  });
});
