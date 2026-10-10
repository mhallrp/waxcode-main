import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createFavourites } from '../src/favourites.js';

function tempStorePath() {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-favourites-test-'));
  return join(dir, 'favourites.json');
}

test('starts empty when no store exists yet', () => {
  const favourites = createFavourites({ storagePath: tempStorePath() });
  assert.deepEqual(favourites.list(), []);
});

test('add() adds a favourite', () => {
  const favourites = createFavourites({ storagePath: tempStorePath() });
  favourites.add('ABCD-1234', 'House Deeper');
  assert.deepEqual(favourites.list(), [{ volumeId: 'ABCD-1234', path: 'House Deeper' }]);
});

test('add() is a no-op if already favourited, not a duplicate entry', () => {
  const favourites = createFavourites({ storagePath: tempStorePath() });
  favourites.add('ABCD-1234', 'House Deeper');
  favourites.add('ABCD-1234', 'House Deeper');
  assert.deepEqual(favourites.list(), [{ volumeId: 'ABCD-1234', path: 'House Deeper' }]);
});

test('remove() removes a favourite', () => {
  const favourites = createFavourites({ storagePath: tempStorePath() });
  favourites.add('ABCD-1234', 'House Deeper');
  favourites.remove('ABCD-1234', 'House Deeper');
  assert.deepEqual(favourites.list(), []);
});

test('remove() is a harmless no-op if not favourited', () => {
  const favourites = createFavourites({ storagePath: tempStorePath() });
  favourites.remove('ABCD-1234', 'House Deeper');
  assert.deepEqual(favourites.list(), []);
});

test('remove() only removes the matching (volumeId, path) pair, not others', () => {
  const favourites = createFavourites({ storagePath: tempStorePath() });
  favourites.add('AAAA-1111', 'Techno');
  favourites.add('ABCD-1234', 'House Deeper');
  favourites.remove('AAAA-1111', 'Techno');
  assert.deepEqual(favourites.list(), [{ volumeId: 'ABCD-1234', path: 'House Deeper' }]);
});

test('the same path on a different stick is a distinct favourite', () => {
  const favourites = createFavourites({ storagePath: tempStorePath() });
  favourites.add('AAAA-1111', 'House Deeper');
  favourites.add('ABCD-1234', 'House Deeper');
  assert.deepEqual(favourites.list(), [
    { volumeId: 'AAAA-1111', path: 'House Deeper' },
    { volumeId: 'ABCD-1234', path: 'House Deeper' },
  ]);
});

test('isFavourite() reflects current state', () => {
  const favourites = createFavourites({ storagePath: tempStorePath() });
  assert.equal(favourites.isFavourite('ABCD-1234', 'House Deeper'), false);
  favourites.add('ABCD-1234', 'House Deeper');
  assert.equal(favourites.isFavourite('ABCD-1234', 'House Deeper'), true);
});

test('favourites persist across a fresh instance pointed at the same store', () => {
  const storagePath = tempStorePath();
  const first = createFavourites({ storagePath });
  first.add('ABCD-1234', 'House Deeper');

  const second = createFavourites({ storagePath });
  assert.deepEqual(second.list(), [{ volumeId: 'ABCD-1234', path: 'House Deeper' }]);
});

test('a removal persists across a fresh instance pointed at the same store', () => {
  const storagePath = tempStorePath();
  const first = createFavourites({ storagePath });
  first.add('ABCD-1234', 'House Deeper');
  first.remove('ABCD-1234', 'House Deeper');

  const second = createFavourites({ storagePath });
  assert.deepEqual(second.list(), []);
});

test('a favourite resolves the same way regardless of which port the stick is plugged into - the whole point of keying by volumeId, not port', () => {
  // No port concept even appears here - that's deliberate, see
  // favourites.js's own doc comment. A caller matches a favourite's
  // volumeId against whatever's currently attached (see
  // ble-library.js's DevicesRequestCharacteristic) regardless of which
  // port entry it shows up under this time.
  const storagePath = tempStorePath();
  const favourites = createFavourites({ storagePath });
  favourites.add('ABCD-1234', 'House Deeper');
  assert.equal(favourites.isFavourite('ABCD-1234', 'House Deeper'), true);
});

test('a corrupt store falls back to empty rather than crashing', () => {
  const storagePath = tempStorePath();
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(storagePath, 'not valid json{{{');

  const favourites = createFavourites({ storagePath });
  assert.deepEqual(favourites.list(), []);
});

test('a store that is not a JSON array falls back to empty rather than crashing', () => {
  const storagePath = tempStorePath();
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(storagePath, JSON.stringify({ volumeId: 'ABCD-1234', path: 'House Deeper' }));

  const favourites = createFavourites({ storagePath });
  assert.deepEqual(favourites.list(), []);
});

test('malformed entries in an otherwise valid array are filtered out, not kept as-is', () => {
  const storagePath = tempStorePath();
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(storagePath, JSON.stringify([{ volumeId: 'ABCD-1234', path: 'House Deeper' }, { volumeId: 'AAAA-1111' }, 'garbage']));

  const favourites = createFavourites({ storagePath });
  assert.deepEqual(favourites.list(), [{ volumeId: 'ABCD-1234', path: 'House Deeper' }]);
});

test('a saved store never leaves a stray .tmp file behind', () => {
  const storagePath = tempStorePath();
  const favourites = createFavourites({ storagePath });
  favourites.add('ABCD-1234', 'House Deeper');
  assert.equal(existsSync(`${storagePath}.tmp`), false);
});

/** A stick that accepts writes, backed by an in-memory store. */
function fakeStick({ writable = true, initial = {} } = {}) {
  const files = { ...initial };
  return {
    read: (root, name) => files[`${root}/${name}`] ?? null,
    write: async (root, name, data) => {
      if (!writable) return false;
      files[`${root}/${name}`] = data;
      return true;
    },
    files,
  };
}

test('list() reports only sticks that are actually attached - an absent stick has nowhere to resolve to', () => {
  const storagePath = tempStorePath();
  const stickStorage = fakeStick({ initial: { '/media/pidvs/port-1/favourites.json': [{ path: 'House' }] } });
  const favourites = createFavourites({
    storagePath,
    stickStorage,
    resolveMounted: () => [{ volumeId: 'VOL-A', root: '/media/pidvs/port-1' }],
  });

  assert.deepEqual(favourites.list(), [{ volumeId: 'VOL-A', path: 'House' }]);
});

test('add() writes to the stick and stops this box keeping its own copy', async () => {
  const storagePath = tempStorePath();
  const stickStorage = fakeStick();
  const favourites = createFavourites({
    storagePath,
    stickStorage,
    resolveMounted: () => [{ volumeId: 'VOL-A', root: '/media/pidvs/port-1' }],
  });

  await favourites.add('VOL-A', 'Techno');
  assert.deepEqual(stickStorage.files['/media/pidvs/port-1/favourites.json'], [{ path: 'Techno' }]);
  assert.deepEqual(favourites.localList(), [], 'nothing should be left on the box to disagree later');
  assert.equal(favourites.isFavourite('VOL-A', 'Techno'), true);
});

test('a stick that will not accept writes falls back to local storage rather than losing the favourite', async () => {
  const storagePath = tempStorePath();
  const stickStorage = fakeStick({ writable: false });
  const favourites = createFavourites({
    storagePath,
    stickStorage,
    resolveMounted: () => [{ volumeId: 'VOL-A', root: '/media/pidvs/port-1' }],
  });

  await favourites.add('VOL-A', 'Disco');
  assert.deepEqual(favourites.localList(), [{ volumeId: 'VOL-A', path: 'Disco' }]);
  assert.equal(favourites.isFavourite('VOL-A', 'Disco'), true);
});

test('migrateToStick moves leftovers from the box onto the stick, but never overrules a stick that already knows its own', async () => {
  const storagePath = tempStorePath();
  const stickStorage = fakeStick();
  const favourites = createFavourites({
    storagePath,
    stickStorage,
    resolveMounted: () => [{ volumeId: 'VOL-A', root: '/media/pidvs/port-1' }],
  });

  await favourites.add('VOL-A', 'FromBox');
  // Simulate the pre-migration world: the entry sitting on the box, stick file gone.
  delete stickStorage.files['/media/pidvs/port-1/favourites.json'];

  const withLeftovers = createFavourites({
    storagePath,
    stickStorage,
    resolveMounted: () => [{ volumeId: 'VOL-B', root: '/media/pidvs/port-2' }],
  });
  await withLeftovers.migrateToStick('VOL-B', '/media/pidvs/port-2');

  stickStorage.files['/media/pidvs/port-3/favourites.json'] = [{ path: 'StickWins' }];
  const authoritative = createFavourites({
    storagePath,
    stickStorage,
    resolveMounted: () => [{ volumeId: 'VOL-C', root: '/media/pidvs/port-3' }],
  });
  await authoritative.migrateToStick('VOL-C', '/media/pidvs/port-3');
  assert.deepEqual(
    stickStorage.files['/media/pidvs/port-3/favourites.json'],
    [{ path: 'StickWins' }],
    'a stick that already has favourites is the authority, not the box',
  );
});

/*
 * The bug this exists to stop: favourites live ON the stick and `list()` reads them from there,
 * while writing one briefly remounts the volume. A caller that fires add() without awaiting it and
 * then lists is reporting the state from BEFORE its own write - so the UI shows the change, then
 * the answer arrives and takes it away again, and only a second tap sticks (owner-reported,
 * 2026-09-25). Both the HTTP route and the BLE characteristic did exactly that.
 *
 * Modelled with a write that takes a turn of the event loop, which is the least a remount can cost.
 */
test('list() after an AWAITED add reflects it, even when the stick write is slow', async () => {
  const stickStorage = fakeStick();
  const slowWrite = stickStorage.write;
  stickStorage.write = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return slowWrite(...args);
  };
  const favourites = createFavourites({
    storagePath: tempStorePath(),
    stickStorage,
    resolveMounted: () => [{ volumeId: 'VOL-A', root: '/media/pidvs/port-1' }],
  });

  await favourites.add('VOL-A', 'Techno');
  assert.deepEqual(favourites.list(), [{ volumeId: 'VOL-A', path: 'Techno' }]);

  await favourites.remove('VOL-A', 'Techno');
  assert.deepEqual(favourites.list(), []);
});

test('NOT awaiting the write is what makes list() report the previous state', async () => {
  const stickStorage = fakeStick();
  const slowWrite = stickStorage.write;
  stickStorage.write = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return slowWrite(...args);
  };
  const favourites = createFavourites({
    storagePath: tempStorePath(),
    stickStorage,
    resolveMounted: () => [{ volumeId: 'VOL-A', root: '/media/pidvs/port-1' }],
  });

  const pending = favourites.add('VOL-A', 'Techno');
  // This is precisely what the callers used to do, and precisely what it returned.
  assert.deepEqual(favourites.list(), [], 'the stick has not been written yet, so it cannot say otherwise');
  await pending;
  assert.deepEqual(favourites.list(), [{ volumeId: 'VOL-A', path: 'Techno' }]);
});
