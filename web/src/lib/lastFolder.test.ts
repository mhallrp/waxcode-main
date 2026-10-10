import { test, assert } from 'vitest';
import { recallFolder, rememberFolder } from './lastFolder';

/* Per deck, because the two are usually fed from different places - a shared location would have
 * each deck dragging the other back and forth. */
test('each deck keeps its own location', () => {
  rememberFolder(1, { deviceId: 'port-3', path: ['Filtered House'] });
  rememberFolder(2, { deviceId: 'port-1', path: ['Disco', 'Edits'] });

  assert.deepEqual(recallFolder(1), { deviceId: 'port-3', path: ['Filtered House'] });
  assert.deepEqual(recallFolder(2), { deviceId: 'port-1', path: ['Disco', 'Edits'] });
});

test('a deck nobody has browsed has nothing to restore', () => {
  assert.equal(recallFolder(3 as 1), null);
});

test('the latest location replaces the one before it', () => {
  rememberFolder(1, { deviceId: 'port-3', path: ['A'] });
  rememberFolder(1, { deviceId: 'port-3', path: ['A', 'B'] });
  assert.deepEqual(recallFolder(1), { deviceId: 'port-3', path: ['A', 'B'] });
});
