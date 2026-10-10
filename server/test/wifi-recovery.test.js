import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWifiRecovery, isRecoveryMarker, mediumAsksForRecovery, MARKER_BASE } from '../src/wifi-recovery.js';

/** A box whose stick contents and flush outcome a test can move independently. */
function harness({ entries = [], forgetAll } = {}) {
  const state = { entries, flushes: 0, log: [] };
  const recovery = createWifiRecovery({
    wifiProvisioning: {
      async forgetAll() {
        state.flushes += 1;
        return forgetAll ? forgetAll() : { ok: true, remaining: 0 };
      },
    },
    readdirFn: async () => state.entries,
    log: (m) => state.log.push(m),
  });
  return { recovery, state };
}

test('the marker is recognised', () => {
  assert.ok(isRecoveryMarker(MARKER_BASE));
});

/*
 * Windows and macOS both hide known extensions, so somebody told to make a text file called
 * waxcode_recovery very often ends up with waxcode_recovery.txt and cannot see the difference.
 * Not recognising it is the expensive failure: the owner is already locked out of the box.
 */
test('a .txt the owner cannot see is still the marker', () => {
  assert.ok(isRecoveryMarker('waxcode_recovery.txt'));
});

test('case is ignored, because FAT does not reliably keep it', () => {
  assert.ok(isRecoveryMarker('WAXCODE_RECOVERY'));
  assert.ok(isRecoveryMarker('Waxcode_Recovery.TXT'));
});

test('something merely similar is not the marker', () => {
  for (const name of ['waxcode', 'waxcode_recovery.mp3', 'my_waxcode_recovery', 'recovery']) {
    assert.equal(isRecoveryMarker(name), false, name);
  }
});

test('the marker counts only at the root of the medium', async () => {
  // readdir of the root is all that is read - a file one folder down never appears in it.
  assert.equal(await mediumAsksForRecovery('/media/pidvs/sda1', async () => ['Music', 'tracks.m3u']), false);
});

test('an unreadable medium is not a request', async () => {
  assert.equal(await mediumAsksForRecovery('/media/pidvs/sda1', async () => { throw new Error('EIO'); }), false);
});

test('a stick carrying the marker forgets every saved network', async () => {
  const h = harness({ entries: ['Music', MARKER_BASE] });
  const result = await h.recovery.mediaMounted('/media/pidvs/sda1');

  assert.deepEqual(result, { acted: true, ok: true });
  assert.equal(h.state.flushes, 1);
});

test('an ordinary stick full of music is left entirely alone', async () => {
  const h = harness({ entries: ['Music', 'Mixes'] });
  const result = await h.recovery.mediaMounted('/media/pidvs/sda1');

  assert.deepEqual(result, { acted: false, reason: 'no-marker' });
  assert.equal(h.state.flushes, 0, 'nothing was touched');
});

/*
 * The hazard this guards. A stick stays mounted, and a write to it triggers a rescan - so without
 * acting once per insert, the owner could join a network on the setup page with the stick still in
 * and have the next rescan throw that network straight back away.
 */
test('one insert means one flush, however many times the stick is rescanned', async () => {
  const h = harness({ entries: [MARKER_BASE] });
  await h.recovery.mediaMounted('/media/pidvs/sda1');
  await h.recovery.mediaMounted('/media/pidvs/sda1');
  await h.recovery.mediaMounted('/media/pidvs/sda1');

  assert.equal(h.state.flushes, 1);
});

test('taking the stick out and putting it back is a fresh request', async () => {
  const h = harness({ entries: [MARKER_BASE] });
  await h.recovery.mediaMounted('/media/pidvs/sda1');
  h.recovery.mediaRemoved('/media/pidvs/sda1');
  await h.recovery.mediaMounted('/media/pidvs/sda1');

  assert.equal(h.state.flushes, 2);
});

/* A flush that throws must not be retried on every rescan for as long as the stick is in. */
test('a flush that throws is reported, not retried in a loop', async () => {
  const state = { attempts: 0 };
  const recovery = createWifiRecovery({
    wifiProvisioning: { async forgetAll() { state.attempts += 1; throw new Error('nmcli gone'); } },
    readdirFn: async () => [MARKER_BASE],
    log: () => {},
  });

  assert.deepEqual(await recovery.mediaMounted('/media/pidvs/sda1'), { acted: true, ok: false, reason: 'threw' });
  await recovery.mediaMounted('/media/pidvs/sda1');
  assert.equal(state.attempts, 1);
});

/* An older box's helper has no forget-all and its sudoers does not grant it, so the fallback cannot
 * remove the final active network. Say so plainly rather than claiming success. */
test('a partial flush says how many are left, because the AP may not come up', async () => {
  const h = harness({
    entries: [MARKER_BASE],
    forgetAll: () => ({ ok: false, reason: 'partly-forgotten', remaining: 1, failed: 1 }),
  });

  const result = await h.recovery.mediaMounted('/media/pidvs/sda1');
  assert.equal(result.ok, false);
  assert.equal(result.remaining, 1);
  assert.ok(h.state.log.join(' ').includes('1 left'), 'and it is in the log');
});

test('no mount path is not a request', async () => {
  const h = harness({ entries: [MARKER_BASE] });
  assert.deepEqual(await h.recovery.mediaMounted(''), { acted: false, reason: 'already-handled' });
  assert.equal(h.state.flushes, 0);
});
