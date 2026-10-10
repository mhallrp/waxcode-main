import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStickWaveforms } from '../src/stick-waveforms.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A real file produced by waxcode-prep's Swift WaveformStore, not one this test synthesised.
 * That's the point: the two sides agree on a binary layout defined in two languages, and only a
 * genuine artefact from the other side can catch them drifting apart.
 */
function stickWithRealStore() {
  const root = mkdtempSync(join(tmpdir(), 'pidvs-wf-'));
  mkdirSync(join(root, '.waxcode', 'analysis'), { recursive: true });
  copyFileSync(join(here, 'fixtures', 'stick-waveforms.bin'),
               join(root, '.waxcode', 'analysis', 'waveforms.bin'));
  return root;
}

test('reads a store written by the real Swift prep tool', () => {
  const store = openStickWaveforms(stickWithRealStore(), { formatVersion: 7 });
  assert.ok(store, 'the store should open');
  assert.equal(store.size, 1);

  const blob = store.read('track.mp3');
  assert.ok(blob, 'the known track should be present');
  // Exactly one of this box's own cache files: 13-byte header then the encoded peaks.
  assert.equal(blob.readUInt8(0), 7, 'FORMAT_VERSION');
  assert.equal(blob.readUInt32LE(9), 6899624, 'the source file size it was computed from');
  assert.equal(blob.length, 13 + 21557, 'header plus encodeWaveformPeaks output');
});

test('a track the store has never heard of returns null rather than throwing', () => {
  const store = openStickWaveforms(stickWithRealStore(), { formatVersion: 7 });
  assert.equal(store.read('not-on-this-stick.mp3'), null);
});

test('a store written for a different waveform format is declined whole, not entry by entry', () => {
  // Every entry would be stale, so saying so once is clearer than failing thousands of times.
  assert.equal(openStickWaveforms(stickWithRealStore(), { formatVersion: 8 }), null);
});

test('a corrupt or truncated store is ignored rather than throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pidvs-wf-'));
  mkdirSync(join(root, '.waxcode', 'analysis'), { recursive: true });
  writeFileSync(join(root, '.waxcode', 'analysis', 'waveforms.bin'), 'not a container at all');
  assert.equal(openStickWaveforms(root, { formatVersion: 7 }), null);
});

test('no store at all is simply null', () => {
  assert.equal(openStickWaveforms(mkdtempSync(join(tmpdir(), 'pidvs-wf-')), { formatVersion: 7 }), null);
});
