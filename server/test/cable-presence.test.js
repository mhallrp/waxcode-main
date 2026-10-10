import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cablePresentSince } from '../src/cable-presence.js';

function tempFlagPath() {
  return join(mkdtempSync(join(tmpdir(), 'pidvs-cable-test-')), 'cable-present');
}

/** Backdates a file's mtime by `ageMs` - simulates "touched a while
 * ago" without a test actually having to wait that long. */
function backdate(flagPath, ageMs) {
  const past = new Date(Date.now() - ageMs);
  utimesSync(flagPath, past, past);
}

test('reports false when the flag file does not exist', () => {
  assert.equal(cablePresentSince(tempFlagPath()) !== null, false);
});

test('reports true when the flag file was touched just now', () => {
  const flagPath = tempFlagPath();
  writeFileSync(flagPath, '');
  assert.equal(cablePresentSince(flagPath) !== null, true);
});

test('reports false once the flag file is older than the window', () => {
  const flagPath = tempFlagPath();
  writeFileSync(flagPath, '');
  backdate(flagPath, 61_000);
  assert.equal(cablePresentSince(flagPath) !== null, false);
});

test('reports true for a file just inside the window', () => {
  const flagPath = tempFlagPath();
  writeFileSync(flagPath, '');
  backdate(flagPath, 59_000);
  assert.equal(cablePresentSince(flagPath) !== null, true);
});

test('reflects removal of the flag file immediately, not just window expiry', () => {
  const flagPath = tempFlagPath();
  writeFileSync(flagPath, '');
  assert.equal(cablePresentSince(flagPath) !== null, true);

  rmSync(flagPath);
  assert.equal(cablePresentSince(flagPath) !== null, false);
});

test('a fresh re-insert (re-touch) restarts the window after it would otherwise have expired', () => {
  const flagPath = tempFlagPath();
  writeFileSync(flagPath, '');
  backdate(flagPath, 61_000);
  assert.equal(cablePresentSince(flagPath) !== null, false);

  writeFileSync(flagPath, ''); // fresh touch, as a real re-insert would do
  assert.equal(cablePresentSince(flagPath) !== null, true);
});

test('cablePresentSince returns null when the flag file does not exist', () => {
  assert.equal(cablePresentSince(tempFlagPath()), null);
});

test('cablePresentSince returns the flag file’s mtime when within the window', () => {
  const flagPath = tempFlagPath();
  writeFileSync(flagPath, '');
  const since = cablePresentSince(flagPath);
  // A loose bound, not an exact match - filesystem mtime precision/
  // rounding can land a hair on either side of Date.now(), which isn't
  // what this test is actually checking (that's cablePresentSince's
  // own window-math tests below). Just confirm it's a real, recent
  // timestamp, not null and not something wildly off.
  assert.ok(since !== null);
  assert.ok(Math.abs(Date.now() - since) < 2000, `expected a recent timestamp, got ${since}`);
});

test('cablePresentSince returns null once the flag file is older than the window', () => {
  const flagPath = tempFlagPath();
  writeFileSync(flagPath, '');
  backdate(flagPath, 61_000);
  assert.equal(cablePresentSince(flagPath), null);
});
