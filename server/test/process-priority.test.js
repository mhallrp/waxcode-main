import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prioritizedSpawn } from '../src/process-priority.js';

test('background priority wraps with nice 19 / ionice idle / taskset to one core', () => {
  let seenCommand, seenArgs, seenOptions;
  const spawnFn = (command, args, options) => { seenCommand = command; seenArgs = args; seenOptions = options; return 'proc'; };

  const result = prioritizedSpawn(spawnFn, 'ffmpeg', ['-i', 'track.mp3'], 'background', { signal: 'sig' });

  assert.equal(result, 'proc');
  assert.equal(seenCommand, 'nice');
  assert.deepEqual(seenArgs, ['-n', '19', 'ionice', '-c', '3', 'taskset', '-c', '3', 'ffmpeg', '-i', 'track.mp3']);
  assert.deepEqual(seenOptions, { signal: 'sig' });
});

test('ondemand priority wraps with a lighter nice/ionice and no core pinning', () => {
  let seenCommand, seenArgs;
  const spawnFn = (command, args) => { seenCommand = command; seenArgs = args; return 'proc'; };

  prioritizedSpawn(spawnFn, 'ffmpeg', ['-i', 'track.mp3'], 'ondemand', {});

  assert.equal(seenCommand, 'nice');
  assert.deepEqual(seenArgs, ['-n', '15', 'ionice', '-c', '2', '-n', '0', 'ffmpeg', '-i', 'track.mp3']);
  assert.ok(!seenArgs.includes('taskset'), 'ondemand must not pin to a single core - that was the actual bottleneck');
});

test('ondemand nice leaves a real margin under the audio path, not a token one', () => {
  let seenArgs;
  const spawnFn = (command, args) => { seenArgs = args; return 'proc'; };
  prioritizedSpawn(spawnFn, 'ffmpeg', [], 'ondemand', {});
  const niceValue = Number(seenArgs[seenArgs.indexOf('-n') + 1]);
  /*
   * Being merely ABOVE zero is not enough, which is what nice 2 taught. CFS weights nice 2 against
   * nice 0 as 655 to 1024, so a nice-2 job still takes about 39% of a contended core - and the dmix
   * keepers that every deck's audio flows through sat at nice 0. Two such jobs glitched both decks on
   * every track load (2026-10-07). A real margin, not a token one.
   */
  assert.ok(niceValue >= 10, `ondemand nice (${niceValue}) must leave a wide margin under the audio path`);
});

test('no priority (undefined) runs the command completely unwrapped', () => {
  let seenCommand, seenArgs;
  const spawnFn = (command, args) => { seenCommand = command; seenArgs = args; return 'proc'; };

  prioritizedSpawn(spawnFn, 'ffmpeg', ['-i', 'track.mp3'], undefined, {});

  assert.equal(seenCommand, 'ffmpeg');
  assert.deepEqual(seenArgs, ['-i', 'track.mp3']);
});

test('an unrecognized priority value also runs unwrapped, not silently treated as background', () => {
  let seenCommand;
  const spawnFn = (command) => { seenCommand = command; return 'proc'; };

  prioritizedSpawn(spawnFn, 'ffmpeg', [], 'not-a-real-priority', {});

  assert.equal(seenCommand, 'ffmpeg');
});

/*
 * `nice -n` ADDS to the caller's own value; it does not set it.
 *
 * The server runs at Nice=-10, so "ondemand" at `nice -n 2` was landing at -8 - eight levels ABOVE
 * xwax, the exact inversion this module's own reasoning says must never happen. Four ffmpegs at -8
 * were measured during one track load while arecord, the capture feeding both decks' timecode, sat
 * at 0 and lost.
 */
test('the nice value is absolute, whatever the server itself is running at', () => {
  const asked = [];
  const spy = (_cmd, args) => { asked.push(args); return {}; };

  // The real box: the unit file sets Nice=-10.
  const atMinusTen = () => -10;
  prioritizedSpawn(spy, 'ffmpeg', ['-i', 'x'], 'ondemand', undefined, atMinusTen);
  prioritizedSpawn(spy, 'ffmpeg', ['-i', 'x'], 'background', undefined, atMinusTen);

  assert.equal(asked[0][1], '25', 'ondemand: -10 + 25 lands on +15, well under the audio path');
  assert.equal(asked[1][1], '29', 'background: -10 + 29 lands on +19');
});

test('and is unchanged when the server is at the default', () => {
  const asked = [];
  const spy = (_cmd, args) => { asked.push(args); return {}; };
  prioritizedSpawn(spy, 'ffmpeg', [], 'ondemand', undefined, () => 0);
  assert.equal(asked[0][1], '15', 'an un-reniced caller asks for the target directly');
});
