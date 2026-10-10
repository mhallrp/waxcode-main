import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStickManifest, buildStickManifest } from '../src/stick-manifest.js';

// The production caller only makes the stick writable when `changed` is true - see http-api.js.
function writeStickManifest(root, tracks, options) {
  const manifest = buildStickManifest(root, tracks, options);
  return manifest.changed ? manifest.commit() : false;
}

function stick() {
  const root = mkdtempSync(join(tmpdir(), 'stick-'));
  mkdirSync(join(root, 'Tracks'), { recursive: true });
  return root;
}

function track(root, relativePath, contents = 'audio') {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents);
  return { path: absolute, relativePath, artist: 'A', title: 'T', duration: 61.5, bpm: 128, key: '8A' };
}

test('writes a manifest a fresh read can use, sparing the tag read', () => {
  const root = stick();
  const one = track(root, 'Tracks/one.mp3');

  assert.equal(writeStickManifest(root, [one]), true);

  const manifest = readStickManifest(root);
  const known = manifest.lookup(one.path, 'Tracks/one.mp3');
  assert.equal(known.title, 'T');
  assert.equal(known.bpm, 128);
  assert.equal(known.duration, 61.5, 'durationMs round-trips back to seconds');
});

test('a file changed since the write is not trusted - the whole point of the size/mtime check', () => {
  const root = stick();
  const one = track(root, 'Tracks/one.mp3');
  writeStickManifest(root, [one]);

  writeFileSync(one.path, 'a different, longer recording');

  assert.equal(readStickManifest(root).lookup(one.path, 'Tracks/one.mp3'), null);
});

test('preserves playlists and track ids, which the box cannot regenerate', () => {
  const root = stick();
  const one = track(root, 'Tracks/one.mp3');
  mkdirSync(join(root, '.waxcode'), { recursive: true });
  writeFileSync(join(root, '.waxcode/library.json'), JSON.stringify({
    formatVersion: 1,
    generatedBy: 'waxcode-prep',
    tracks: [{ id: 'prep-id-1', path: 'Tracks/one.mp3', size: 5, mtime: new Date().toISOString() }],
    playlists: [{ id: 'p1', name: 'House', trackIds: ['prep-id-1'] }],
  }));

  writeStickManifest(root, [one]);

  const written = JSON.parse(readFileSync(join(root, '.waxcode/library.json'), 'utf8'));
  assert.equal(written.tracks[0].id, 'prep-id-1', 'an existing id is kept, or playlists would orphan');
  assert.deepEqual(written.playlists, [{ id: 'p1', name: 'House', trackIds: ['prep-id-1'] }]);
});

test('ids for new tracks are derived from the path, so two boxes agree', () => {
  const a = stick();
  const b = stick();
  writeStickManifest(a, [track(a, 'Tracks/same.mp3')]);
  writeStickManifest(b, [track(b, 'Tracks/same.mp3')]);

  const idA = JSON.parse(readFileSync(join(a, '.waxcode/library.json'), 'utf8')).tracks[0].id;
  const idB = JSON.parse(readFileSync(join(b, '.waxcode/library.json'), 'utf8')).tracks[0].id;
  assert.equal(idA, idB);
});

test('does not rewrite an unchanged manifest - every write is wear on someone stick', () => {
  const root = stick();
  const one = track(root, 'Tracks/one.mp3');
  assert.equal(writeStickManifest(root, [one]), true);
  assert.equal(writeStickManifest(root, [one]), false, 'second write is a no-op');
});

test('a read-only stick is not fatal - it just means the next insert scans', () => {
  const root = stick();
  const one = track(root, 'Tracks/one.mp3');
  mkdirSync(join(root, '.waxcode'), { recursive: true });
  chmodSync(join(root, '.waxcode'), 0o500);

  assert.equal(writeStickManifest(root, [one]), false, 'reports failure rather than throwing');
  chmodSync(join(root, '.waxcode'), 0o700);
});

test('leaves no temp file behind on success', () => {
  const root = stick();
  writeStickManifest(root, [track(root, 'Tracks/one.mp3')]);
  assert.equal(existsSync(join(root, '.waxcode/library.json.tmp')), false);
});

test('carries forward bpm and key the box cannot know - it reads tags only', () => {
  const root = stick();
  const one = track(root, 'Tracks/one.mp3');
  const stat = statSync(one.path);
  mkdirSync(join(root, '.waxcode'), { recursive: true });
  writeFileSync(join(root, '.waxcode/library.json'), JSON.stringify({
    formatVersion: 1,
    generatedBy: 'waxcode-prep',
    // Computed by the prep tool - this file has no BPM or key tag at all.
    tracks: [{ id: 'p1', path: 'Tracks/one.mp3', size: stat.size, mtime: new Date(stat.mtimeMs).toISOString(), bpm: 127.98634812286689, key: '11A' }],
  }));

  writeStickManifest(root, [{ ...one, bpm: null, key: null }]);

  const written = JSON.parse(readFileSync(join(root, '.waxcode/library.json'), 'utf8')).tracks[0];
  assert.equal(written.bpm, 127.98634812286689, 'a computed bpm must survive a box scan');
  assert.equal(written.key, '11A');
});

test('does NOT carry analysis forward for a file that has changed since', () => {
  const root = stick();
  const one = track(root, 'Tracks/one.mp3');
  mkdirSync(join(root, '.waxcode'), { recursive: true });
  writeFileSync(join(root, '.waxcode/library.json'), JSON.stringify({
    formatVersion: 1,
    tracks: [{ id: 'p1', path: 'Tracks/one.mp3', size: 999999, mtime: new Date(0).toISOString(), bpm: 127.9, key: '11A' }],
  }));

  writeStickManifest(root, [{ ...one, bpm: null, key: null }]);

  const written = JSON.parse(readFileSync(join(root, '.waxcode/library.json'), 'utf8')).tracks[0];
  assert.equal(written.bpm, null, 'a re-encoded track keeps none of its old analysis');
  assert.equal(written.key, null);
});

test("the box's own tag value wins over a carried one", () => {
  const root = stick();
  const one = track(root, 'Tracks/one.mp3');
  const stat = statSync(one.path);
  mkdirSync(join(root, '.waxcode'), { recursive: true });
  writeFileSync(join(root, '.waxcode/library.json'), JSON.stringify({
    formatVersion: 1,
    tracks: [{ id: 'p1', path: 'Tracks/one.mp3', size: stat.size, mtime: new Date(stat.mtimeMs).toISOString(), bpm: 100, key: '1A' }],
  }));

  writeStickManifest(root, [{ ...one, bpm: 128, key: '8A' }]);

  const written = JSON.parse(readFileSync(join(root, '.waxcode/library.json'), 'utf8')).tracks[0];
  assert.equal(written.bpm, 128);
  assert.equal(written.key, '8A');
});

test('reports no change without needing the stick writable - the window must not open for nothing', () => {
  const root = stick();
  const one = track(root, 'Tracks/one.mp3');
  buildStickManifest(root, [one]).commit();

  // Deciding this is what lets the caller skip the remount entirely on an unchanged library, which
  // is every restart of a settled box.
  assert.equal(buildStickManifest(root, [one]).changed, false);
});
