import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { computeKey } from '../src/key-detection.js';

function fakeSpawnReturning(stdout, { code = 0, stderr = '' } = {}) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      proc.stdout.emit('data', stdout);
      if (stderr) proc.stderr.emit('data', stderr);
      proc.emit('close', code);
    });
    return proc;
  };
}

test('computeKey resolves the trimmed key string from stdout', async () => {
  const spawnFn = fakeSpawnReturning('10A\n');
  const key = await computeKey('/fake/path.mp3', { spawnFn });
  assert.equal(key, '10A');
});

test('computeKey resolves null when no key was detected (empty stdout)', async () => {
  const spawnFn = fakeSpawnReturning('');
  const key = await computeKey('/fake/path.mp3', { spawnFn });
  assert.equal(key, null);
});

test('computeKey rejects when keyfinder-cli exits non-zero', async () => {
  const spawnFn = fakeSpawnReturning('', { code: 1, stderr: 'could not decode' });
  await assert.rejects(() => computeKey('/fake/path.mp3', { spawnFn }), /keyfinder-cli exited 1/);
});

test('computeKey rejects when the spawned process itself fails to start', async () => {
  const spawnFn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => proc.emit('error', new Error('ENOENT')));
    return proc;
  };
  await assert.rejects(() => computeKey('/fake/path.mp3', { spawnFn }));
});

test('computeKey requests Camelot notation and wraps with nice/ionice/taskset when priority is background', async () => {
  let seenCommand;
  let seenArgs;
  const spawnFn = (command, args) => {
    seenCommand = command;
    seenArgs = args;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      proc.stdout.emit('data', '5B\n');
      proc.emit('close', 0);
    });
    return proc;
  };
  await computeKey('/fake/path.mp3', { spawnFn, priority: 'background' });
  assert.equal(seenCommand, 'nice');
  assert.deepEqual(seenArgs, ['-n', '19', 'ionice', '-c', '3', 'taskset', '-c', '3', 'keyfinder-cli', '-n', 'camelot', '/fake/path.mp3']);
});

test('computeKey wraps with a lighter nice/ionice, no taskset, when priority is ondemand', async () => {
  let seenCommand;
  let seenArgs;
  const spawnFn = (command, args) => {
    seenCommand = command;
    seenArgs = args;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      proc.stdout.emit('data', '5B\n');
      proc.emit('close', 0);
    });
    return proc;
  };
  await computeKey('/fake/path.mp3', { spawnFn, priority: 'ondemand' });
  assert.equal(seenCommand, 'nice');
  assert.deepEqual(seenArgs, ['-n', '15', 'ionice', '-c', '2', '-n', '0', 'keyfinder-cli', '-n', 'camelot', '/fake/path.mp3']);
});

test('computeKey invokes keyfinder-cli directly (no wrapper) without lowPriority', async () => {
  let seenCommand;
  let seenArgs;
  const spawnFn = (command, args) => {
    seenCommand = command;
    seenArgs = args;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      proc.stdout.emit('data', '5B\n');
      proc.emit('close', 0);
    });
    return proc;
  };
  await computeKey('/fake/path.mp3', { spawnFn });
  assert.equal(seenCommand, 'keyfinder-cli');
  assert.deepEqual(seenArgs, ['-n', 'camelot', '/fake/path.mp3']);
});
