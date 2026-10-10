import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKeyLockFeature, DEFAULT_ENABLED } from '../src/key-lock-feature.js';
import { setKeyLock } from '../src/deck-control.js';

/*
 * Key lock ships as an experiment somebody opts into, because it degrades audio whichever way it is
 * configured and there is no setting that does not. Measured on real music at +8%: R3 stretches a
 * kick's attack from 5.79ms to 14.91ms; the configuration that fixes attacks warbles sustained tones
 * instead. The trade is structural - a phase reset both preserves a transient and perturbs a
 * sustained partial.
 */

const dir = () => mkdtempSync(join(tmpdir(), 'keylock-'));

test('it is OFF until somebody chooses otherwise', () => {
  const d = dir();
  try {
    assert.equal(DEFAULT_ENABLED, false);
    assert.equal(createKeyLockFeature({ dataDir: d, log: () => {} }).enabled(), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the choice survives a restart', () => {
  const d = dir();
  try {
    createKeyLockFeature({ dataDir: d, log: () => {} }).setEnabled(true);
    assert.equal(createKeyLockFeature({ dataDir: d, log: () => {} }).enabled(), true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an unreadable store reads as OFF, not as on', () => {
  const d = dir();
  try {
    writeFileSync(join(d, 'key-lock-feature.json'), 'not json');
    /* Failing towards the audio being untouched is the safe direction for a feature that degrades it. */
    assert.equal(createKeyLockFeature({ dataDir: d, log: () => {} }).enabled(), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('while disabled, a deck cannot be put into key lock', async () => {
  const d = dir();
  try {
    const feature = createKeyLockFeature({ dataDir: d, log: () => {} });
    let sent = null;
    const result = await setKeyLock(1, true, {
      keyLockFeature: feature,
      keyLockStore: { set: () => {} },
      sendCommandFn: (n, c) => { sent = c; },
    });

    /* Refused rather than silently ignored: a caller that has not noticed gets told. */
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'key-lock-disabled');
    assert.equal(sent, null, 'nothing should reach xwax');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('turning it OFF is always allowed, even while disabled', async () => {
  const d = dir();
  try {
    const feature = createKeyLockFeature({ dataDir: d, log: () => {} });
    /* The clearing path after switching the experiment off has to work, or a deck is left holding key
     * lock from before it was disabled. */
    const result = await setKeyLock(1, false, {
      keyLockFeature: feature,
      keyLockStore: { set: () => {} },
      sendCommandFn: () => {},
    }).catch((err) => err);
    assert.notEqual(result?.reason, 'key-lock-disabled');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
