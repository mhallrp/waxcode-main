import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStickManifest } from '../src/stick-manifest.js';

function stickWith(tracks, { formatVersion = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pidvs-stick-'));
  mkdirSync(join(root, '.waxcode'), { recursive: true });

  const entries = tracks.map(({ relative, contents = 'audio bytes' }) => {
    const full = join(root, relative);
    mkdirSync(join(root, relative, '..'), { recursive: true });
    writeFileSync(full, contents);
    const stat = statSync(full);
    return {
      path: relative,
      size: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      title: `Title of ${relative}`,
      artist: 'An Artist',
      durationMs: 210_000,
      bpm: 128,
      key: '8A',
    };
  });

  writeFileSync(
    join(root, '.waxcode', 'library.json'),
    JSON.stringify({ formatVersion, generatedBy: 'test', mode: 'index', source: 'filesystem', tracks: entries, playlists: [] }),
  );
  return { root, entries };
}

test('a matching entry is returned without the file being parsed', () => {
  const { root } = stickWith([{ relative: 'a.mp3' }]);
  const manifest = readStickManifest(root);

  const track = manifest.lookup(join(root, 'a.mp3'), 'a.mp3');
  assert.equal(track.title, 'Title of a.mp3');
  assert.equal(track.artist, 'An Artist');
  assert.equal(track.duration, 210, 'durationMs is reported in seconds, as the scanner expects');
  assert.equal(track.bpm, 128);
  assert.equal(track.key, '8A');
});

test('a file whose size no longer matches is not trusted - it has been replaced since', () => {
  const { root } = stickWith([{ relative: 'a.mp3' }]);
  writeFileSync(join(root, 'a.mp3'), 'completely different, longer contents');
  const manifest = readStickManifest(root);
  assert.equal(manifest.lookup(join(root, 'a.mp3'), 'a.mp3'), null);
});

test('a file the manifest has never heard of returns nothing, so it gets read normally', () => {
  const { root } = stickWith([{ relative: 'a.mp3' }]);
  const manifest = readStickManifest(root);
  assert.equal(manifest.lookup(join(root, 'added-later.mp3'), 'added-later.mp3'), null);
});

test('a manifest from a newer tool is declined outright rather than half-understood', () => {
  const { root } = stickWith([{ relative: 'a.mp3' }], { formatVersion: 99 });
  assert.equal(readStickManifest(root), null);
});

test('a corrupt manifest is ignored rather than throwing - the scan just happens the slow way', () => {
  const { root } = stickWith([{ relative: 'a.mp3' }]);
  writeFileSync(join(root, '.waxcode', 'library.json'), '{ not json at all');
  assert.equal(readStickManifest(root), null);
});

test('no manifest at all is simply null', () => {
  const root = mkdtempSync(join(tmpdir(), 'pidvs-stick-'));
  assert.equal(readStickManifest(root), null);
});
