import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeckRelativeMode } from '../src/deck-relative-mode.js';

function tempStoragePath() {
  return join(mkdtempSync(join(tmpdir(), 'pidvs-deck-relative-mode-test-')), 'deck-relative-mode.json');
}

test('defaults to off (Absolute) for a deck with no store file yet', () => {
  const deckRelativeMode = createDeckRelativeMode({ storagePath: tempStoragePath() });
  assert.equal(deckRelativeMode.get(1), false);
});

test('set() changes the choice and get() reflects it immediately', () => {
  const deckRelativeMode = createDeckRelativeMode({ storagePath: tempStoragePath() });
  deckRelativeMode.set(1, true);
  assert.equal(deckRelativeMode.get(1), true);
});

test('each deck is independent', () => {
  const deckRelativeMode = createDeckRelativeMode({ storagePath: tempStoragePath() });
  deckRelativeMode.set(1, true);
  assert.equal(deckRelativeMode.get(2), false);
});

test('a choice persists across a fresh instance pointed at the same storage path', () => {
  const storagePath = tempStoragePath();
  const first = createDeckRelativeMode({ storagePath });
  first.set(2, true);

  const second = createDeckRelativeMode({ storagePath });
  assert.equal(second.get(2), true);
});

test('set(deckNumber, false) persists as off, overriding a previous on', () => {
  const storagePath = tempStoragePath();
  const first = createDeckRelativeMode({ storagePath });
  first.set(1, true);
  first.set(1, false);

  const second = createDeckRelativeMode({ storagePath });
  assert.equal(second.get(1), false);
});

test('a corrupt store file falls back to off for every deck rather than crashing', () => {
  const storagePath = tempStoragePath();
  mkdirSync(join(storagePath, '..'), { recursive: true });
  writeFileSync(storagePath, 'not valid JSON at all');
  const deckRelativeMode = createDeckRelativeMode({ storagePath });
  assert.equal(deckRelativeMode.get(1), false);
});

test('a saved store never leaves a stray .tmp file behind', () => {
  const storagePath = tempStoragePath();
  const deckRelativeMode = createDeckRelativeMode({ storagePath });
  deckRelativeMode.set(1, true);
  assert.equal(existsSync(`${storagePath}.tmp`), false);
});
