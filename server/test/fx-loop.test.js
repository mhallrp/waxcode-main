import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createFxLoop, fxCommand, FX_CAPTURE, FX_RETURN } from '../src/fx-loop.js';
import { LINE, PHONO } from '../src/deck-input-mode.js';

/** A sox that can be made to exit, so the restart path is exercised rather than assumed. */
function fakeSox() {
  const spawned = [];
  const spawnFn = (command, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { proc.killed = true; };
    proc.killed = false;
    spawned.push({ command, args, proc });
    return proc;
  };
  return { spawnFn, spawned, get last() { return spawned[spawned.length - 1]; } };
}

const dataDir = () => mkdtempSync(join(tmpdir(), 'fx-loop-'));

test('the loop runs wet only - the mixer already has the dry signal', () => {
  const [command, args] = fxCommand('reverb');
  assert.equal(command, 'sox');
  assert.ok(args.includes('-w'), 'without wet-only the dry returns a second time, 43ms late');
  assert.ok(args.includes(FX_CAPTURE) && args.includes(FX_RETURN));
});

test('turning it on starts sox between the send and the return', () => {
  const sox = fakeSox();
  const fx = createFxLoop({ dataDir: dataDir(), spawnFn: sox.spawnFn, inputMode: () => LINE, log: () => {} });

  assert.equal(fx.setEnabled(true), true);
  assert.equal(sox.spawned.length, 1);
  assert.equal(fx.isRunning(), true);

  fx.setEnabled(false);
  assert.equal(fx.isRunning(), false);
  assert.equal(sox.last.proc.killed, true);
});

/* The rule the shared jack depends on: in Phono mode that output is carrying a real record at
 * cartridge level, and two things writing to one pair is not a thing ALSA will sort out. */
test('in Phono mode it refuses to run at all', () => {
  const sox = fakeSox();
  const fx = createFxLoop({ dataDir: dataDir(), spawnFn: sox.spawnFn, inputMode: () => PHONO, log: () => {} });

  assert.equal(fx.setEnabled(true), false);
  assert.equal(sox.spawned.length, 0, 'sox was started over deck 1\'s phono output');
  assert.equal(fx.available(), false);
  assert.equal(fx.status().available, false);
});

test('switching the box to Phono takes the output back', () => {
  const sox = fakeSox();
  let mode = LINE;
  const fx = createFxLoop({ dataDir: dataDir(), spawnFn: sox.spawnFn, inputMode: () => mode, log: () => {} });

  fx.setEnabled(true);
  assert.equal(fx.isRunning(), true);

  mode = PHONO;
  fx.inputModeChanged();
  assert.equal(fx.isRunning(), false, 'the FX loop kept writing to a jack carrying a record');
  assert.equal(fx.isEnabled(), true, 'but it is still what the owner asked for, for when Line comes back');

  mode = LINE;
  fx.inputModeChanged();
  assert.equal(fx.isRunning(), true, 'and it comes back on its own');
});

test('a crash is restarted, and a crash loop is not', async () => {
  const sox = fakeSox();
  const fx = createFxLoop({
    dataDir: dataDir(), spawnFn: sox.spawnFn, inputMode: () => LINE, log: () => {},
    restartDelayMs: 1, maxConsecutiveRestarts: 2, stableRunMs: 60_000,
  });

  fx.setEnabled(true);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  sox.last.proc.emit('exit', 1, null);
  await settle();
  assert.equal(sox.spawned.length, 2, 'a one-off crash should come back');

  sox.last.proc.emit('exit', 1, null);
  await settle();
  assert.equal(sox.spawned.length, 3);

  sox.last.proc.emit('exit', 1, null);
  await settle();
  assert.equal(sox.spawned.length, 3, 'a crash loop is given up on, not hammered');
  assert.equal(fx.isEnabled(), false, 'and it stops claiming to be on');
});

test('the setting survives a restart of the server', () => {
  const dir = dataDir();
  const first = fakeSox();
  createFxLoop({ dataDir: dir, spawnFn: first.spawnFn, inputMode: () => LINE, log: () => {} }).setEnabled(true);

  const second = fakeSox();
  const fx = createFxLoop({ dataDir: dir, spawnFn: second.spawnFn, inputMode: () => LINE, log: () => {} });
  assert.equal(fx.isEnabled(), true);
  assert.equal(second.spawned.length, 0, 'stored, but not started until restore()');

  fx.restore();
  assert.equal(fx.isRunning(), true);
});
