import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeckKeyLock } from '../src/deck-key-lock.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'deck-key-lock-'));

test('defaults to off - the same state xwax itself starts in', () => {
  const store = createDeckKeyLock({ dataDir: tempDir() });
  assert.equal(store.get(1), false);
  assert.equal(store.get(2), false);
});

test('remembers a deck being turned on, and survives a reload', () => {
  const dataDir = tempDir();
  createDeckKeyLock({ dataDir }).set(1, true);

  // A fresh instance is what a server restart looks like.
  const reloaded = createDeckKeyLock({ dataDir });
  assert.equal(reloaded.get(1), true);
  assert.equal(reloaded.get(2), false, 'the other deck should be untouched');
});

test('turning it back off persists too, rather than only recording the on state', () => {
  const dataDir = tempDir();
  const store = createDeckKeyLock({ dataDir });
  store.set(1, true);
  store.set(1, false);
  assert.equal(createDeckKeyLock({ dataDir }).get(1), false);
});

test('anything that is not exactly true reads as off', () => {
  const store = createDeckKeyLock({ dataDir: tempDir() });
  for (const value of ['true', 1, {}, null, undefined]) {
    store.set(1, value);
    assert.equal(store.get(1), false, `${JSON.stringify(value)} should not enable key lock`);
  }
});

test('a corrupt file reads as off rather than throwing - a deck must still start', () => {
  const dataDir = tempDir();
  writeFileSync(join(dataDir, 'deck-key-lock.json'), '{ this is not json');
  assert.equal(createDeckKeyLock({ dataDir }).get(1), false);
});

test('all() reports every deck, for reapply-on-start', () => {
  const store = createDeckKeyLock({ dataDir: tempDir(), deckCount: 2 });
  store.set(2, true);
  assert.deepEqual(store.all(), { 1: false, 2: true });
});
