import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKeyLockNotice } from '../src/key-lock-notice.js';
import { setKeyLock } from '../src/deck-control.js';

/*
 * Key lock degrades audio whichever way it is configured, and there is no setting that does not.
 * Measured on real music at +8%: R3 stretches a kick's attack from 5.79ms to 14.91ms; the
 * configuration that fixes attacks warbles sustained tones instead. The trade is structural - a
 * phase reset both preserves a transient and perturbs a sustained partial.
 *
 * It used to be an opt-in switch in Settings because of that. It is an ordinary deck control now
 * (2026-10-11), and all that survives is telling the owner ONCE what they are choosing.
 */

const dir = () => mkdtempSync(join(tmpdir(), 'keylock-'));

test('the notice has not been shown until it has', () => {
  const d = dir();
  try {
    assert.equal(createKeyLockNotice({ dataDir: d, log: () => {} }).acknowledged(), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('once acknowledged it stays acknowledged across a restart', () => {
  const d = dir();
  try {
    createKeyLockNotice({ dataDir: d, log: () => {} }).acknowledge();
    /* A second instance is the restart: the point of keeping this on the box rather than in a
     * browser is that it survives both the tab and the power cable. */
    assert.equal(createKeyLockNotice({ dataDir: d, log: () => {} }).acknowledged(), true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an unreadable store reads as NOT shown, so the notice is shown again', () => {
  const d = dir();
  try {
    writeFileSync(join(d, 'key-lock-notice.json'), 'not json');
    /* Failing towards showing it costs one dialog. Failing the other way means somebody is never
     * told what key lock does to their drums. */
    assert.equal(createKeyLockNotice({ dataDir: d, log: () => {} }).acknowledged(), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

/*
 * The press is persisted BEFORE it is sent, which is what makes the owner's choice survive the
 * power cable: reapplyDeckSettings reads this store on every deck start - see deck-key-lock.js.
 *
 * `isReady` is ensureDeckRunning's own dependency, not an invention of this test: without it the
 * call reaches for systemctl, which a Mac does not have. Nothing is listening on deck 2's socket,
 * so the send then fails - and that is the case worth covering, because a deck mid-restart is
 * exactly when this ordering matters.
 */
test('the choice is persisted before it is sent, so a deck mid-restart still comes back holding it', async () => {
  const written = [];
  await setKeyLock(2, true, {
    keyLockStore: { set: (deck, on) => written.push([deck, on]) },
    isReady: () => true,
  }).catch(() => { /* no xwax on deck 2 here, which is the point */ });
  assert.deepEqual(written, [[2, true]]);
});

/* That key lock REACHES xwax with no opt-in anywhere is covered against a real socket in
 * deck-control.test.js ("KEYLOCK still reaches a deck that is NOT in passthrough"). It is not
 * repeated here with a stub: the old suite asserted on a `sendCommandFn` that deck-control has
 * never taken, and passed only because the opt-in gate returned before reaching it. */
