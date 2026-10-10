import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseConfirmer } from '../src/confirm-release.js';

/** A releases/ directory shaped the way a real box's is. */
function releases({ current, baseline }) {
  const dir = mkdtempSync(join(tmpdir(), 'confirm-release-'));
  if (current) {
    mkdirSync(join(dir, current));
    symlinkSync(current, join(dir, 'current'));
  }
  if (baseline !== undefined) writeFileSync(join(dir, 'last-known-good'), baseline);
  return dir;
}

const read = (dir) => readFileSync(join(dir, 'last-known-good'), 'utf8').trim();

test('a release that is running but unconfirmed becomes the new baseline', () => {
  const dir = releases({ current: 'v0.13.0', baseline: '0.11.0' });
  const result = createReleaseConfirmer({ releasesDir: dir, log: () => {} }).confirmNow();

  assert.equal(result.confirmed, true);
  assert.equal(result.version, '0.13.0');
  assert.equal(read(dir), '0.13.0', 'written without the v, the way the updater stores it');
});

test('a box already on its baseline is left alone', () => {
  const dir = releases({ current: 'v0.11.0', baseline: '0.11.0' });
  const result = createReleaseConfirmer({ releasesDir: dir, log: () => {} }).confirmNow();

  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'already-confirmed');
});

test('a box that has never had a baseline does not get given one', () => {
  // recover-boot reads a missing baseline as "nothing to compare against" and never reverts.
  // Writing one here would switch reverting on for a box that was deliberately without it.
  const dir = releases({ current: 'v0.13.0' });
  const result = createReleaseConfirmer({ releasesDir: dir, log: () => {} }).confirmNow();

  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'no-baseline');
});

test('no current symlink means nothing is confirmed', () => {
  const dir = releases({ baseline: '0.11.0' });
  const result = createReleaseConfirmer({ releasesDir: dir, log: () => {} }).confirmNow();

  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'no-current');
  assert.equal(read(dir), '0.11.0', 'the existing baseline is untouched');
});

test('confirmation is delayed, so a release that dies at once cannot confirm itself', () => {
  const dir = releases({ current: 'v0.13.0', baseline: '0.11.0' });
  let scheduledDelay = null;
  const confirmer = createReleaseConfirmer({
    releasesDir: dir,
    log: () => {},
    delayMs: 90_000,
    setTimeoutFn: (fn, ms) => { scheduledDelay = ms; return { unref() {} }; },
  });

  confirmer.schedule();
  assert.equal(scheduledDelay, 90_000, 'armed on a timer, not run inline');
  assert.equal(read(dir), '0.11.0', 'nothing is written until that timer fires');
});

test('an unwritable baseline is reported, not thrown, so startup is never broken by it', () => {
  const dir = releases({ current: 'v0.13.0', baseline: '0.11.0' });
  const confirmer = createReleaseConfirmer({
    releasesDir: dir,
    log: () => {},
    runningVersion: () => { throw new Error('unreadable'); },
  });

  assert.doesNotThrow(() => confirmer.confirmNow());
});
