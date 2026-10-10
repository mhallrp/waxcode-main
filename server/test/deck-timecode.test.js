import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeckTimecode, SERATO_SIDE_A, SERATO_SIDE_B } from '../src/deck-timecode.js';

function tempDataDir() {
  return mkdtempSync(join(tmpdir(), 'pidvs-deck-timecode-test-'));
}

test('defaults to side A for a deck with no env file yet', () => {
  const deckTimecode = createDeckTimecode({ dataDir: tempDataDir() });
  assert.equal(deckTimecode.get(1), SERATO_SIDE_A);
});

test('set() changes the side and get() reflects it immediately', () => {
  const deckTimecode = createDeckTimecode({ dataDir: tempDataDir() });
  deckTimecode.set(1, SERATO_SIDE_B);
  assert.equal(deckTimecode.get(1), SERATO_SIDE_B);
});

test('each deck is independent', () => {
  const deckTimecode = createDeckTimecode({ dataDir: tempDataDir() });
  deckTimecode.set(1, SERATO_SIDE_B);
  assert.equal(deckTimecode.get(2), SERATO_SIDE_A);
});

test('set() rejects an unknown side', () => {
  const deckTimecode = createDeckTimecode({ dataDir: tempDataDir() });
  assert.throws(() => deckTimecode.set(1, 'serato_cd'));
});

test('a side persists across a fresh instance pointed at the same data dir', () => {
  const dataDir = tempDataDir();
  const first = createDeckTimecode({ dataDir });
  first.set(2, SERATO_SIDE_B);

  const second = createDeckTimecode({ dataDir });
  assert.equal(second.get(2), SERATO_SIDE_B);
});

test('writes plain KEY=VALUE format, matching what systemd EnvironmentFile= expects', () => {
  const dataDir = tempDataDir();
  const deckTimecode = createDeckTimecode({ dataDir });
  deckTimecode.set(1, SERATO_SIDE_B);
  const contents = readFileSync(join(dataDir, 'deck1-timecode.env'), 'utf8');
  assert.equal(contents, 'PIDVS_TIMECODE=serato_2b\n');
});

test('a corrupt or malformed env file falls back to side A rather than crashing', () => {
  const dataDir = tempDataDir();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'deck1-timecode.env'), 'not a valid env file at all');
  const deckTimecode = createDeckTimecode({ dataDir });
  assert.equal(deckTimecode.get(1), SERATO_SIDE_A);
});

test('an env file with an unrecognized side value falls back to side A', () => {
  const dataDir = tempDataDir();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'deck1-timecode.env'), 'PIDVS_TIMECODE=serato_cd\n');
  const deckTimecode = createDeckTimecode({ dataDir });
  assert.equal(deckTimecode.get(1), SERATO_SIDE_A);
});

test('a saved env file never leaves a stray .tmp file behind', () => {
  const dataDir = tempDataDir();
  const deckTimecode = createDeckTimecode({ dataDir });
  deckTimecode.set(1, SERATO_SIDE_B);
  assert.equal(existsSync(join(dataDir, 'deck1-timecode.env.tmp')), false);
});
