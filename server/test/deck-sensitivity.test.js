import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeckSensitivity, MAX_SENSITIVITY } from '../src/deck-sensitivity.js';

function withStore(run) {
  const dataDir = mkdtempSync(join(tmpdir(), 'sensitivity-'));
  try {
    return run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('defaults to the calibrated threshold', () => {
  withStore((dataDir) => {
    const store = createDeckSensitivity({ dataDir });
    assert.equal(store.get(1), 0);
    assert.equal(store.get(2), 0);
  });
});

test('remembers a level across a restart of the server', () => {
  withStore((dataDir) => {
    createDeckSensitivity({ dataDir }).set(2, 3);
    // A fresh store, as a restarted process would build.
    assert.equal(createDeckSensitivity({ dataDir }).get(2), 3);
    assert.equal(createDeckSensitivity({ dataDir }).get(1), 0);
  });
});

test('clamps out-of-range levels and reports what it settled on', () => {
  withStore((dataDir) => {
    const store = createDeckSensitivity({ dataDir });
    // Past the cap a healthy cartridge's own signal starts being rejected, so this must not be
    // possible to ask for - and the caller needs to know what it actually got, since that value
    // is what gets sent to xwax.
    assert.equal(store.set(1, 99), MAX_SENSITIVITY);
    assert.equal(store.get(1), MAX_SENSITIVITY);
    assert.equal(store.set(1, -5), 0);
    assert.equal(store.set(1, 'nonsense'), 0);
  });
});

test('one deck\'s level does not disturb the other', () => {
  withStore((dataDir) => {
    const store = createDeckSensitivity({ dataDir });
    store.set(1, 2);
    assert.deepEqual(store.all(), { 1: 2, 2: 0 });
  });
});
