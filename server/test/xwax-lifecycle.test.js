import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDeckRunning, stopDeckService, restartDeckService } from '../src/xwax-lifecycle.js';

test('ensureDeckRunning does nothing (no systemctl call) if the deck is already ready', async () => {
  const calls = [];
  const execFileFn = async (cmd, args) => { calls.push([cmd, ...args]); };
  const isReady = async () => true;

  await ensureDeckRunning(1, { execFileFn, isReady });

  assert.deepEqual(calls, []);
});

test('ensureDeckRunning starts the service and waits for readiness if not already running', async () => {
  const calls = [];
  const execFileFn = async (cmd, args) => { calls.push([cmd, ...args]); };
  let readyCheckCount = 0;
  const isReady = async () => {
    readyCheckCount++;
    return readyCheckCount >= 3; // not ready for the first two checks, then ready
  };

  await ensureDeckRunning(2, { execFileFn, isReady, pollIntervalMs: 1 });

  assert.deepEqual(calls, [['/usr/bin/systemctl', 'start', 'xwax@2.service']]);
  assert.equal(readyCheckCount, 3);
});

test('ensureDeckRunning throws if the deck never becomes ready within the timeout', async () => {
  const execFileFn = async () => {};
  const isReady = async () => false;

  await assert.rejects(
    () => ensureDeckRunning(3, { execFileFn, isReady, timeoutMs: 30, pollIntervalMs: 5 }),
    /deck 3.*did not become ready/
  );
});

test('ensureDeckRunning propagates a failure from the systemctl call itself', async () => {
  const execFileFn = async () => { throw new Error('systemctl: unit not found'); };
  const isReady = async () => false;

  await assert.rejects(
    () => ensureDeckRunning(4, { execFileFn, isReady }),
    /unit not found/
  );
});

test('stopDeckService runs systemctl stop against the given deck', async () => {
  const calls = [];
  const execFileFn = async (cmd, args) => { calls.push([cmd, ...args]); };

  await stopDeckService(1, { execFileFn });

  assert.deepEqual(calls, [['/usr/bin/systemctl', 'stop', 'xwax@1.service']]);
});

test('stopDeckService propagates a failure from the systemctl call', async () => {
  const execFileFn = async () => { throw new Error('systemctl: permission denied'); };
  await assert.rejects(() => stopDeckService(1, { execFileFn }), /permission denied/);
});

test('restartDeckService stops the deck and waits for it to come back ready', async () => {
  const calls = [];
  let running = true;
  await restartDeckService(2, {
    execFileFn: async (_path, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'stop') running = false;
      if (args[0] === 'start') running = true;
    },
    isReady: async () => running,
  });
  // Must actually stop: without that, ensureDeckRunning sees a ready deck and returns immediately,
  // leaving ref_level exactly as it was - the restart would look successful and reset nothing.
  assert.deepEqual(calls, ['stop xwax@2.service', 'start xwax@2.service']);
});

test('ensureDeckRunning reapplies per-deck settings only when it actually started the deck', async () => {
  const started = [];
  let running = false;
  await ensureDeckRunning(1, {
    execFileFn: async () => { running = true; },
    isReady: async () => running,
    onStarted: (deckNumber) => { started.push(deckNumber); },
  });
  assert.deepEqual(started, [1]);

  // Already up: xwax has kept whatever it was told, so reapplying would be redundant at best and
  // could stamp on a change made since.
  const startedAgain = [];
  await ensureDeckRunning(1, {
    execFileFn: async () => { throw new Error('should not start an already-running deck'); },
    isReady: async () => true,
    onStarted: (deckNumber) => { startedAgain.push(deckNumber); },
  });
  assert.deepEqual(startedAgain, []);
});

test('restartDeckService reapplies settings, since xwax resets them on init', async () => {
  const started = [];
  let running = true;
  await restartDeckService(2, {
    execFileFn: async (_path, args) => { running = args[0] === 'start'; },
    isReady: async () => running,
    onStarted: (deckNumber) => { started.push(deckNumber); },
  });
  assert.deepEqual(started, [2]);
});
