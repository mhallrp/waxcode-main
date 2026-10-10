import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { beginPriorityWork, endPriorityWork, isPriorityActive, waitUntilIdle, _resetForTests } from '../src/on-demand-priority.js';

beforeEach(() => _resetForTests());

test('isPriorityActive is false with nothing active', () => {
  assert.equal(isPriorityActive(), false);
});

test('isPriorityActive is true while a job is in flight', () => {
  beginPriorityWork();
  assert.equal(isPriorityActive(), true);
  endPriorityWork();
  assert.equal(isPriorityActive(), false);
});

test('stays active while any of several concurrent jobs (eg. both decks) are still running', () => {
  beginPriorityWork();
  beginPriorityWork();
  endPriorityWork();
  assert.equal(isPriorityActive(), true, 'one job is still active');
  endPriorityWork();
  assert.equal(isPriorityActive(), false);
});

test('waitUntilIdle resolves immediately when nothing is active', async () => {
  let resolved = false;
  await waitUntilIdle().then(() => { resolved = true; });
  assert.equal(resolved, true);
});

test('waitUntilIdle only resolves once the last active job ends', async () => {
  beginPriorityWork();
  let resolved = false;
  const promise = waitUntilIdle().then(() => { resolved = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, 'should not resolve while still active');

  endPriorityWork();
  await promise;
  assert.equal(resolved, true);
});

test('multiple waiters all resolve once idle', async () => {
  beginPriorityWork();
  const results = [];
  const p1 = waitUntilIdle().then(() => results.push('a'));
  const p2 = waitUntilIdle().then(() => results.push('b'));

  endPriorityWork();
  await Promise.all([p1, p2]);
  assert.deepEqual(results.sort(), ['a', 'b']);
});
