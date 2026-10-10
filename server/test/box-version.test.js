import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serverVersion, xwaxRevision, boxVersion } from '../src/box-version.js';

/** A releases tree shaped like a real box's: versioned directories and a `current` symlink. */
function releases({ version = 'v0.10.6', revision = '9ccf28513b6235d20ac4d5a438e51033105b570b' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'releases-'));
  if (version !== null) {
    const target = join(dir, version);
    mkdirSync(join(target, 'xwax-src'), { recursive: true });
    if (revision !== null) writeFileSync(join(target, 'xwax-src', 'REVISION'), `${revision}\n`);
    symlinkSync(target, join(dir, 'current'));
  }
  return dir;
}

test('reads the version the service is actually running, from the symlink', () => {
  const releasesDir = releases();
  try {
    assert.equal(serverVersion({ releasesDir }), 'v0.10.6');
  } finally { rmSync(releasesDir, { recursive: true, force: true }); }
});

test('reads the xwax revision the release carries', () => {
  const releasesDir = releases();
  try {
    // Trimmed: the file has a trailing newline and a hash with one is not a hash.
    assert.equal(xwaxRevision({ releasesDir }), '9ccf28513b6235d20ac4d5a438e51033105b570b');
  } finally { rmSync(releasesDir, { recursive: true, force: true }); }
});

test('no `current` symlink reports null, not a crash or a guess', () => {
  const releasesDir = releases({ version: null });
  try {
    /* A box with no `current` is running from somewhere else - a hand-started server, a half-finished
     * install. Unknown is the honest answer, and a useful signal in a fleet listing. */
    assert.equal(serverVersion({ releasesDir }), null);
    assert.equal(xwaxRevision({ releasesDir }), null);
  } finally { rmSync(releasesDir, { recursive: true, force: true }); }
});

test('a release with no REVISION file still reports its version', () => {
  const releasesDir = releases({ revision: null });
  try {
    // Releases published before they carried xwax have no REVISION; the server version still counts.
    assert.equal(serverVersion({ releasesDir }), 'v0.10.6');
    assert.equal(xwaxRevision({ releasesDir }), null);
  } finally { rmSync(releasesDir, { recursive: true, force: true }); }
});

test('an empty REVISION file is null rather than an empty string', () => {
  const releasesDir = releases({ revision: '' });
  try {
    // An empty string in a fleet listing reads as "reported nothing", which is a different claim.
    assert.equal(xwaxRevision({ releasesDir }), null);
  } finally { rmSync(releasesDir, { recursive: true, force: true }); }
});

test('boxVersion reports both together, in the shape the heartbeat sends', () => {
  const releasesDir = releases();
  try {
    assert.deepEqual(boxVersion({ releasesDir }), {
      serverVersion: 'v0.10.6',
      xwaxRevision: '9ccf28513b6235d20ac4d5a438e51033105b570b',
    });
  } finally { rmSync(releasesDir, { recursive: true, force: true }); }
});

test('a missing releases directory altogether is survivable', () => {
  // Nothing here should throw: this runs inside a heartbeat that must not take the server down.
  assert.deepEqual(boxVersion({ releasesDir: '/nonexistent/releases' }),
    { serverVersion: null, xwaxRevision: null });
});
