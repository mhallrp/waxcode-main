import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { decodeSharedPair } from '../src/shared-decode.js';

function fakeFfmpeg({ wide = Buffer.alloc(8), narrow = Buffer.alloc(4), autoClose = true } = {}) {
  const spawned = [];
  const spawnFn = (cmd, args, options) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdio = [null, proc.stdout, proc.stderr, new EventEmitter()];
    spawned.push({ args, options, proc });
    if (autoClose) {
      queueMicrotask(() => {
        proc.stdout.emit('data', wide);
        proc.stdio[3].emit('data', narrow);
        proc.emit('close', 0);
      });
    }
    return proc;
  };
  return { spawnFn, spawned };
}

test('two consumers of the same track share ONE decode - the whole point of this module', async () => {
  const { spawnFn, spawned } = fakeFfmpeg();
  const [a, b] = await Promise.all([
    decodeSharedPair('/fake/same.mp3', { spawnFn }),
    decodeSharedPair('/fake/same.mp3', { spawnFn }),
  ]);
  assert.equal(spawned.length, 1, 'ffmpeg ran once, not once per consumer');
  assert.deepEqual(a.pcm16, b.pcm16);
  assert.deepEqual(a.pcm8, b.pcm8);
});

test('asks ffmpeg for both rates from a single decode, 16kHz on stdout and 8kHz on fd 3', async () => {
  const { spawnFn, spawned } = fakeFfmpeg({ wide: Buffer.from([1, 2]), narrow: Buffer.from([3, 4]) });
  const { pcm16, pcm8 } = await decodeSharedPair('/fake/rates.mp3', { spawnFn });

  const args = spawned[0].args.join(' ');
  assert.match(args, /-ar 16000 .*pipe:1/);
  assert.match(args, /-ar 8000 .*pipe:3/);
  assert.equal(spawned[0].options.stdio[3], 'pipe');
  assert.deepEqual(pcm16, Buffer.from([1, 2]));
  assert.deepEqual(pcm8, Buffer.from([3, 4]));
});

test('different tracks do not share a decode', async () => {
  const { spawnFn, spawned } = fakeFfmpeg();
  await Promise.all([
    decodeSharedPair('/fake/one.mp3', { spawnFn }),
    decodeSharedPair('/fake/two.mp3', { spawnFn }),
  ]);
  assert.equal(spawned.length, 2);
});

test('one consumer giving up does not kill a decode the other is still waiting on', async () => {
  const { spawnFn, spawned } = fakeFfmpeg({ autoClose: false });
  const quitter = new AbortController();

  const abandoned = decodeSharedPair('/fake/shared.mp3', { spawnFn, signal: quitter.signal });
  abandoned.catch(() => {});
  const stayer = decodeSharedPair('/fake/shared.mp3', { spawnFn });


  quitter.abort();
  assert.equal(spawned[0].options.signal.aborted, false, 'ffmpeg survives while a consumer remains');

  const { proc } = spawned[0];
  proc.stdout.emit('data', Buffer.alloc(8));
  proc.stdio[3].emit('data', Buffer.alloc(4));
  proc.emit('close', 0);

  const result = await stayer;
  assert.equal(result.pcm16.length, 8);
});

test('the last consumer leaving does abort the decode', async () => {
  const { spawnFn, spawned } = fakeFfmpeg({ autoClose: false });
  const only = new AbortController();
  const pending = decodeSharedPair('/fake/lonely.mp3', { spawnFn, signal: only.signal });
  pending.catch(() => {});


  only.abort();
  assert.equal(spawned[0].options.signal.aborted, true);
});

test('a failing decode rejects both consumers and is not left cached for the next caller', async () => {
  const { spawnFn, spawned } = fakeFfmpeg({ autoClose: false });
  const first = decodeSharedPair('/fake/broken.mp3', { spawnFn });
  const second = decodeSharedPair('/fake/broken.mp3', { spawnFn });


  spawned[0].proc.stderr.emit('data', Buffer.from('could not decode'));
  spawned[0].proc.emit('close', 1);

  await assert.rejects(first, /ffmpeg exited 1/);
  await assert.rejects(second, /ffmpeg exited 1/);

  // In-flight only: a later caller must get a fresh attempt, not a remembered failure.
  const { spawnFn: retryFn, spawned: retried } = fakeFfmpeg();
  await decodeSharedPair('/fake/broken.mp3', { spawnFn: retryFn });
  assert.equal(retried.length, 1);
});


