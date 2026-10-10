import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { passthroughDeviceNames, PassthroughManager } from '../src/passthrough.js';

// Fakes node:child_process's spawn() just enough for PassthroughManager - an EventEmitter with kill()/stdout/stderr, tracking every call.
function fakeSpawn() {
  const calls = [];
  const children = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = (signal) => { child.killedWith = signal; };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    children.push(child);
    return child;
  };
  return { spawnFn, calls, children };
}

test('passthroughDeviceNames maps deck number to the asound.conf route PCM names', () => {
  // A line-level record shares the jack digital already uses; there is no reason to spend a second
  // one on it.
  assert.deepEqual(passthroughDeviceNames(1), { capture: 'dvs_deck1_capture', playback: 'dvs_deck1_line' });
  assert.deepEqual(passthroughDeviceNames(2), { capture: 'dvs_deck2_capture', playback: 'dvs_deck2_line' });

  // A phono-level record has to reach the mixer's phono stage, so it leaves by its own pair.
  assert.deepEqual(passthroughDeviceNames(1, { phono: true }), { capture: 'dvs_deck1_capture', playback: 'dvs_deck1_phono' });
  assert.deepEqual(passthroughDeviceNames(2, { phono: true }), { capture: 'dvs_deck2_capture', playback: 'dvs_deck2_phono' });
});

test('start() spawns alsaloop with this deck\'s capture/playback devices', () => {
  const { spawnFn, calls } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });

  manager.start(1);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'alsaloop');
  assert.deepEqual(calls[0].args, ['-C', 'dvs_deck1_capture', '-P', 'dvs_deck1_line', '-l', '2048']);
});

test('start() is idempotent: a second start() while already running does not spawn again', () => {
  const { spawnFn, calls } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });

  manager.start(1);
  manager.start(1);

  assert.equal(calls.length, 1);
});

test('start() on a different deck spawns a second, independent process', () => {
  const { spawnFn, calls } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });

  manager.start(1);
  manager.start(2);

  assert.equal(calls.length, 2);
  assert.ok(manager.isActive(1));
  assert.ok(manager.isActive(2));
});

test('isActive reflects whether a deck has a running passthrough loop', () => {
  const { spawnFn } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });

  assert.equal(manager.isActive(1), false);
  manager.start(1);
  assert.equal(manager.isActive(1), true);
});

test('stop() kills the tracked process and clears isActive', () => {
  const { spawnFn, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });

  manager.start(1);
  manager.stop(1);

  assert.equal(children[0].killedWith, 'SIGTERM');
  assert.equal(manager.isActive(1), false);
});

test('stop() on a deck with no running loop is a no-op', () => {
  const { spawnFn } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });

  assert.doesNotThrow(() => manager.stop(1));
});

test('a process exiting on its own (eg. alsaloop crashing) clears isActive', () => {
  const { spawnFn, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });

  manager.start(1);
  children[0].emit('exit', 1, null);

  assert.equal(manager.isActive(1), false);
});

test('stopAll() stops every running deck', () => {
  const { spawnFn, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });

  manager.start(1);
  manager.start(2);
  manager.stopAll();

  assert.equal(manager.isActive(1), false);
  assert.equal(manager.isActive(2), false);
  assert.equal(children[0].killedWith, 'SIGTERM');
  assert.equal(children[1].killedWith, 'SIGTERM');
});

test('restarting a deck after it stops spawns a fresh process', () => {
  const { spawnFn, calls } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });

  manager.start(1);
  manager.stop(1);
  manager.start(1);

  assert.equal(calls.length, 2);
  assert.ok(manager.isActive(1));
});

test('a complete stderr line is logged with the deck number and stream name', () => {
  const { spawnFn, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });
  const logged = [];
  const originalLog = console.log;
  console.log = (line) => logged.push(line);

  try {
    manager.start(1);
    children[0].stderr.emit('data', Buffer.from('Poll FD initialization failed.\n'));
  } finally {
    console.log = originalLog;
  }

  assert.ok(logged.some((line) => line === '[passthrough] deck 1 alsaloop (stderr): Poll FD initialization failed.'));
});

test('a stdout/stderr line split across multiple data chunks is only logged once complete', () => {
  const { spawnFn, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });
  const logged = [];
  const originalLog = console.log;
  console.log = (line) => logged.push(line);

  try {
    manager.start(1);
    logged.length = 0; // discard start()'s own "started" log line - not what this test checks
    children[0].stderr.emit('data', Buffer.from('underrun for '));
    assert.equal(logged.length, 0); // no newline yet - nothing logged
    children[0].stderr.emit('data', Buffer.from('playback dvs_deck1_line\n'));
  } finally {
    console.log = originalLog;
  }

  assert.ok(logged.some((line) => line === '[passthrough] deck 1 alsaloop (stderr): underrun for playback dvs_deck1_line'));
});

test('an unexpected exit auto-restarts alsaloop after the configured delay', async () => {
  const { spawnFn, calls, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn, restartDelayMs: 5 });

  manager.start(1);
  children[0].emit('exit', 1, null);
  assert.equal(manager.isActive(1), false); // not yet - restart is delayed, not immediate

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls.length, 2);
  assert.equal(manager.isActive(1), true);
});

test('a deliberate stop() does not trigger an auto-restart', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn, restartDelayMs: 5 });

  manager.start(1);
  manager.stop(1);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls.length, 1);
  assert.equal(manager.isActive(1), false);
});

test('stop() during the restart backoff window cancels the pending restart', async () => {
  const { spawnFn, calls, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn, restartDelayMs: 20 });

  manager.start(1);
  children[0].emit('exit', 1, null); // schedules a restart in 20ms
  manager.stop(1); // must cancel it before it fires

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(calls.length, 1);
  assert.equal(manager.isActive(1), false);
});

test('a fast crash loop gives up after the consecutive-restart cap', async () => {
  const { spawnFn, calls, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn, restartDelayMs: 5, maxConsecutiveRestarts: 2, stableRunMs: 10000 });

  manager.start(1);
  for (let i = 0; i < 4; i += 1) {
    children[calls.length - 1].emit('exit', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  // 1 initial start + 2 allowed restarts = 3 spawns, then it gives up
  assert.equal(calls.length, 3);
  assert.equal(manager.isActive(1), false);
});

test('a stable run resets the consecutive-restart counter', async () => {
  const { spawnFn, calls, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn, restartDelayMs: 5, maxConsecutiveRestarts: 1, stableRunMs: 15 });

  manager.start(1);
  children[0].emit('exit', 1, null); // 1st crash, immediate - uses up the only allowed restart
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.isActive(1), true); // restarted once, within the cap

  // Let this restarted run outlive stableRunMs before crashing again.
  await new Promise((resolve) => setTimeout(resolve, 20));
  children[calls.length - 1].emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The prior crash happened after a stable run, so this counts as a
  // fresh attempt 1/1 rather than exceeding the cap.
  assert.equal(manager.isActive(1), true);
  assert.equal(calls.length, 3);
});

test('a second deck\'s restart is independent of the first deck\'s crash-loop state', async () => {
  const { spawnFn, calls, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn, restartDelayMs: 5, maxConsecutiveRestarts: 1, stableRunMs: 10000 });

  manager.start(1);
  manager.start(2);
  children[0].emit('exit', 1, null);
  children[1].emit('exit', 1, null);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(manager.isActive(1), true);
  assert.equal(manager.isActive(2), true);
});

test('blank lines are not logged', () => {
  const { spawnFn, children } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });
  const logged = [];
  const originalLog = console.log;
  console.log = (line) => logged.push(line);

  try {
    manager.start(1);
    logged.length = 0; // discard start()'s own "started" log line - not what this test checks
    children[0].stdout.emit('data', Buffer.from('\n\n'));
  } finally {
    console.log = originalLog;
  }

  assert.equal(logged.length, 0);
});

// --- Phono correction: the filtered engine must apply to phono decks and ONLY to phono decks. ---

const fakeInputMode = (mode) => ({ get: () => mode });

test('a line deck still gets plain alsaloop, with no filtering', () => {
  const { spawnFn, calls } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn, deckInputMode: fakeInputMode('line') });

  manager.start(1);

  assert.equal(calls[0].command, 'alsaloop');
  assert.deepEqual(calls[0].args, ['-C', 'dvs_deck1_capture', '-P', 'dvs_deck1_line', '-l', '2048']);
  assert.ok(!calls[0].args.includes('equalizer'), 'a line-level deck needs no correction and must not be given one');
});

test('a phono deck gets the correction, and leaves by the phono pair', () => {
  const { spawnFn, calls } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn, deckInputMode: fakeInputMode('phono') });

  manager.start(1);

  assert.equal(calls[0].command, 'sox');
  assert.ok(calls[0].args.includes('dvs_deck1_capture'), 'must read the deck it was started for');
  assert.ok(calls[0].args.includes('dvs_deck1_phono'), 'a phono-level record must reach the phono pair');
  assert.equal(calls[0].args.filter((arg) => arg === 'equalizer').length, 4, 'the fitted correction is four peaking biquads');
});

test('the corrected engine is pinned to the same buffer size as alsaloop', () => {
  const { spawnFn, calls } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn, deckInputMode: fakeInputMode('phono') });

  manager.start(1);

  // 2048 frames is matched against asound.conf and xwax@.service; sox counts bytes, at 32-bit stereo.
  const buffer = calls[0].args[calls[0].args.indexOf('--buffer') + 1];
  assert.equal(buffer, String(2048 * 2 * 4));
});

test('the setting is box-wide, so both decks get the same engine', () => {
  const { spawnFn, calls } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn, deckInputMode: fakeInputMode('phono') });

  manager.start(1);
  manager.start(2);

  assert.equal(calls[0].command, 'sox');
  assert.equal(calls[1].command, 'sox');
  assert.ok(calls[1].args.includes('dvs_deck2_capture'), 'still wired to its own deck');
});

test('a mode change between runs switches engine, because the mode is read at spawn time', () => {
  const { spawnFn, calls } = fakeSpawn();
  let mode = 'line';
  const manager = new PassthroughManager({ spawnFn, deckInputMode: { get: () => mode } });

  manager.start(1);
  manager.stop(1);
  mode = 'phono';
  manager.start(1);

  assert.equal(calls[0].command, 'alsaloop');
  assert.equal(calls[1].command, 'sox');
});

test('with no input mode wired in at all, behaviour is unchanged', () => {
  const { spawnFn, calls } = fakeSpawn();
  const manager = new PassthroughManager({ spawnFn });

  manager.start(1);

  assert.equal(calls[0].command, 'alsaloop');
});

test('an idle deck is running alsaloop but not "in passthrough"', () => {
  // The distinction the app's toggle depends on: alsaloop starts on every deck at boot so a
  // record plays without opening the app, and that must not read as passthrough being switched on.
  const manager = new PassthroughManager({ spawnFn: fakeSpawn().spawnFn });
  manager.start(1);
  assert.equal(manager.isActive(1), true, 'alsaloop is genuinely running');
  assert.equal(manager.isRequested(1), false, 'but nobody asked for passthrough');
});

test('a deliberate request reads as passthrough, and clearing it does not stop the audio', () => {
  const manager = new PassthroughManager({ spawnFn: fakeSpawn().spawnFn });
  manager.start(1);
  manager.setRequested(1, true);
  assert.equal(manager.isRequested(1), true);

  // Turning the switch off returns the deck to transparent, not silent - a deck with no track and
  // no alsaloop outputs nothing, which is not what "passthrough off" means.
  manager.setRequested(1, false);
  assert.equal(manager.isRequested(1), false);
  assert.equal(manager.isActive(1), true, 'the record should still play through');
});

test('a requested deck stops reading as passthrough if alsaloop goes away', () => {
  const manager = new PassthroughManager({ spawnFn: fakeSpawn().spawnFn });
  manager.start(1);
  manager.setRequested(1, true);
  manager.stop(1);
  assert.equal(manager.isRequested(1), false, 'requested but not running is not passthrough');
});

test('intent is per deck', () => {
  const manager = new PassthroughManager({ spawnFn: fakeSpawn().spawnFn });
  manager.start(1);
  manager.start(2);
  manager.setRequested(2, true);
  assert.equal(manager.isRequested(1), false);
  assert.equal(manager.isRequested(2), true);
});
