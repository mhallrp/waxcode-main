import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGridOffsets, GRID_OFFSET_LIMIT_SECONDS } from '../src/grid-offset.js';

const store = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-grid-'));
  return { dir, offsets: createGridOffsets({ storagePath: join(dir, 'grid-offsets.json') }) };
};

test('a track with no nudge reads as zero, not null', () => {
  const { dir, offsets } = store();
  try {
    // Every caller would turn null into 0 anyway, so it is 0 here and nowhere else has to think.
    assert.equal(offsets.get('vol-1', 'House/One.mp3'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nudge is kept per track and per stick', () => {
  const { dir, offsets } = store();
  try {
    offsets.set('vol-1', 'House/One.mp3', 0.012);
    offsets.set('vol-2', 'House/One.mp3', -0.004);

    assert.equal(offsets.get('vol-1', 'House/One.mp3'), 0.012);
    assert.equal(offsets.get('vol-2', 'House/One.mp3'), -0.004, 'same path, different stick');
    assert.equal(offsets.get('vol-1', 'House/Two.mp3'), 0, 'and nothing leaks between tracks');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* A beat at 200bpm is 300ms. Past half a second you are not nudging a grid, you are choosing a
 * different beat - and the real fault is the tempo, not the phase. */
test('a nudge is clamped, and the caller is told what was stored', () => {
  const { dir, offsets } = store();
  try {
    assert.equal(offsets.set('vol-1', 'a.mp3', 99), GRID_OFFSET_LIMIT_SECONDS);
    assert.equal(offsets.get('vol-1', 'a.mp3'), GRID_OFFSET_LIMIT_SECONDS);
    assert.equal(offsets.set('vol-1', 'a.mp3', -99), -GRID_OFFSET_LIMIT_SECONDS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Otherwise this file grows an entry for every track anybody has ever looked at. */
test('nudging back to zero leaves nothing behind', () => {
  const { dir, offsets } = store();
  const file = join(dir, 'grid-offsets.json');
  try {
    offsets.set('vol-1', 'a.mp3', 0.01);
    assert.match(readFileSync(file, 'utf8'), /a\.mp3/);

    offsets.set('vol-1', 'a.mp3', 0);
    assert.ok(!/a\.mp3/.test(readFileSync(file, 'utf8')), 'the entry is gone, not set to 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nudge survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-grid-'));
  const storagePath = join(dir, 'grid-offsets.json');
  try {
    createGridOffsets({ storagePath }).set('vol-1', 'a.mp3', 0.008);
    // A different instance, as a reboot would build.
    assert.equal(createGridOffsets({ storagePath }).get('vol-1', 'a.mp3'), 0.008);
    assert.ok(existsSync(storagePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
