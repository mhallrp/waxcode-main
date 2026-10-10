import { test, assert, beforeEach } from 'vitest';
import {
  STALL_MS, fractionOf, resumeWatching, stageOf, startWatching, stopWatching,
} from './updateProgress';

/*
 * Named.dom.test because the module persists its watch in localStorage - vitest only gives jsdom to
 * that pattern, and the pure stage logic is cheap enough not to be worth splitting out for speed.
 *
 * The flow this replaces reloaded the page as soon as /version answered - which it did immediately,
 * because POST /update responds before applying anything. The page reloaded before the update began,
 * lost its state, and offered the same update again.
 */

beforeEach(() => localStorage.clear());

const watch = { target: 'v0.10.15', startedAt: 1_000_000 };

test('still answering the OLD version means it has not started yet, not that it finished', () => {
  /* The exact mistake: /version answers for several seconds after the POST. Treating any answer as
   * success is what caused the loop. */
  assert.equal(stageOf(watch, 'v0.10.14', 1_000_000 + 2_000), 'preparing');
});

test('not answering at all is the restart, which is the good sign', () => {
  assert.equal(stageOf(watch, null, 1_000_000 + 30_000), 'restarting');
});

test('done ONLY when it reports the version we asked for', () => {
  assert.equal(stageOf(watch, 'v0.10.15', 1_000_000 + 40_000), 'done');
  /* A leading v is inconsistent across the API, and treating them as different versions would leave
   * the screen up forever on a successful update. */
  assert.equal(stageOf(watch, '0.10.15', 1_000_000 + 40_000), 'done');
});

test('too long on the old version is a stall, not silence', () => {
  assert.equal(stageOf(watch, 'v0.10.14', 1_000_000 + STALL_MS + 1), 'stalled');
});

test('the watch survives a reload, because the page gets reloaded mid-update', () => {
  startWatching('v0.10.15', 1_000_000);
  const resumed = resumeWatching(1_000_000 + 5_000);
  assert.deepEqual(resumed, { target: 'v0.10.15', startedAt: 1_000_000 });
});

test('but an abandoned watch is forgotten, not shown forever', () => {
  startWatching('v0.10.15', 1_000_000);
  /* A box switched off mid-update would otherwise greet somebody with a progress bar every visit. */
  assert.equal(resumeWatching(1_000_000 + STALL_MS * 3 + 1), null);
});

test('stopping clears it', () => {
  startWatching('v0.10.15');
  stopWatching();
  assert.equal(resumeWatching(), null);
});

test('the bar only ever moves forwards, and does not claim to be finished', () => {
  const early = fractionOf('preparing', watch, 1_000_000 + 10_000);
  const later = fractionOf('preparing', watch, 1_000_000 + 60_000);
  assert.ok(later > early);
  assert.ok(later < 0.9, 'never reaches the end while still working');
  assert.equal(fractionOf('done', watch), 1);
  assert.ok(fractionOf('restarting', watch, 1_000_000 + 10_000) >= 0.9, 'restart is nearly there');
});
