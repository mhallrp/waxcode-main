import test from 'node:test';
import assert from 'node:assert/strict';
import { withWritableStick } from '../src/stick-writable.js';

function recorder({ failOn } = {}) {
  const calls = [];
  return {
    calls,
    execFileFn: async (cmd, args) => {
      // Recorded with the command, because invoking mount WITHOUT sudo is a real bug this caught:
      // it fails with "must be superuser to use mount" however the sudoers rule is written.
      calls.push(`${cmd} ${args.join(' ')}`);
      if (failOn && args.join(' ').includes(failOn)) throw new Error('mount: refused');
      return { stdout: '' };
    },
  };
}

test('makes the stick writable, runs the write, and puts it back', async () => {
  const { calls, execFileFn } = recorder();
  let ranWhileWritable = false;

  await withWritableStick('/media/pidvs/port-1', async () => {
    // The remount must already have happened by the time the write runs.
    assert.deepEqual(calls, ['sudo -n /usr/bin/mount -o remount,rw /media/pidvs/port-1']);
    ranWhileWritable = true;
    return true;
  }, { execFileFn });

  assert.equal(ranWhileWritable, true);
  assert.deepEqual(calls, ['sudo -n /usr/bin/mount -o remount,rw /media/pidvs/port-1', 'sudo -n /usr/bin/mount -o remount,ro /media/pidvs/port-1']);
});

test('returns the stick to read-only even when the write throws', async () => {
  const { calls, execFileFn } = recorder();

  await assert.rejects(withWritableStick('/media/pidvs/port-1', async () => {
    throw new Error('disk full');
  }, { execFileFn }));

  assert.equal(calls.at(-1), 'sudo -n /usr/bin/mount -o remount,ro /media/pidvs/port-1', 'a stick left writable is the state this exists to avoid');
});

test('does not attempt the write at all if it cannot be made writable', async () => {
  const { execFileFn } = recorder({ failOn: 'remount,rw' });
  let attempted = false;

  const result = await withWritableStick('/media/pidvs/port-1', async () => { attempted = true; return true; }, { execFileFn });

  assert.equal(attempted, false);
  assert.equal(result, false);
});

test('refuses a path outside /media/pidvs - this holds a root remount capability', async () => {
  const { calls, execFileFn } = recorder();
  assert.equal(await withWritableStick('/etc', async () => true, { execFileFn }), false);
  assert.equal(await withWritableStick(undefined, async () => true, { execFileFn }), false);
  assert.deepEqual(calls, [], 'nothing is invoked for a path it should not touch');
});
