import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, createTrackOrder } from '../src/track-order.js';

const name = (track) => track.name;

/*
 * The order is PARTIAL on purpose: it names only what somebody placed, and anything else sorts
 * after. That is what lets a stick be filled up on a laptop without the order having to be rebuilt,
 * and it is the whole reason this never has to be right about files it has never seen.
 */
test('placed tracks come first, in the order given', () => {
  const tracks = [{ name: 'a.mp3' }, { name: 'b.mp3' }, { name: 'c.mp3' }];
  assert.deepEqual(
    applyOrder(tracks, ['c.mp3', 'a.mp3'], name).map(name),
    ['c.mp3', 'a.mp3', 'b.mp3'],
    'the two placed ones lead; the unplaced one follows',
  );
});

test('a name that is no longer on the stick is skipped, not a hole', () => {
  const tracks = [{ name: 'a.mp3' }, { name: 'b.mp3' }];
  assert.deepEqual(
    applyOrder(tracks, ['deleted.mp3', 'b.mp3'], name).map(name),
    ['b.mp3', 'a.mp3'],
  );
});

test('no order means the tracks are left exactly as they came', () => {
  const tracks = [{ name: 'b.mp3' }, { name: 'a.mp3' }];
  assert.deepEqual(applyOrder(tracks, [], name), tracks);
  assert.deepEqual(applyOrder(tracks, null, name), tracks);
});

/* Two files of the same name in one listing should both survive, or ordering a folder would
 * silently drop one of them. */
test('duplicate names are both kept', () => {
  const tracks = [{ name: 'a.mp3', id: 1 }, { name: 'a.mp3', id: 2 }, { name: 'b.mp3', id: 3 }];
  assert.deepEqual(applyOrder(tracks, ['a.mp3'], name).map((t) => t.id), [1, 2, 3]);
});

/** A stick that answers reads and accepts writes, standing in for the mounted volume. */
function fakeStick(initial = null) {
  let stored = initial;
  return {
    read: () => stored,
    write: async (_root, _name, value) => { stored = value; return true; },
    stored: () => stored,
  };
}

test('an order is stored per folder, leaving the others alone', async () => {
  const stick = fakeStick();
  const order = createTrackOrder({ stickStorage: stick });

  await order.set('/media/stick', 'House', ['b.mp3', 'a.mp3']);
  await order.set('/media/stick', 'Techno', ['x.mp3']);

  assert.deepEqual(order.get('/media/stick', 'House'), ['b.mp3', 'a.mp3']);
  assert.deepEqual(order.get('/media/stick', 'Techno'), ['x.mp3'], 'the second did not replace the first');
});

/* Clearing is how somebody goes back to sorting, so an empty list REMOVES the entry rather than
 * storing an empty one - otherwise the file would accumulate a key per folder ever touched. */
test('an empty order removes the folder rather than storing nothing', async () => {
  const stick = fakeStick();
  const order = createTrackOrder({ stickStorage: stick });

  await order.set('/media/stick', 'House', ['a.mp3']);
  await order.set('/media/stick', 'House', []);

  assert.deepEqual(order.get('/media/stick', 'House'), []);
  assert.deepEqual(stick.stored(), {}, 'and the key is gone, not left empty');
});

test('a file written by something else is treated as no order, not as a crash', () => {
  for (const nonsense of [null, [], 'nope', 42]) {
    const order = createTrackOrder({ stickStorage: { read: () => nonsense, write: async () => true } });
    assert.deepEqual(order.get('/media/stick', 'House'), [], `${JSON.stringify(nonsense)}`);
  }
});

/* A path would let one folder's order reach into another, and the names are bare by design. */
test('a name containing a path separator is refused', async () => {
  const stick = fakeStick();
  const order = createTrackOrder({ stickStorage: stick });
  await order.set('/media/stick', 'House', ['ok.mp3', '../elsewhere/evil.mp3']);
  assert.deepEqual(order.get('/media/stick', 'House'), ['ok.mp3']);
});
