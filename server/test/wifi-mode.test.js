import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWifiMode, DISABLE_WIFI_MANAGEMENT_FLAG } from '../src/wifi-mode.js';

/**
 * A box whose cable, saved networks and AP state can all be moved independently, because the whole
 * point of the watcher is what it does when those three disagree.
 */
function harness({ cable = false, saved = [], apUp = false, connection, nowFn } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pidvs-wifi-mode-'));
  const state = { cable, saved, apUp, insert: cable ? 1000 : null, calls: [] };

  const wifiProvisioning = {
    async saved() { return state.saved; },
    /* Unprivileged, and that is the point: polling through sudo writes three journal lines per tick,
     * which at five seconds buries the 300 lines a diagnostics bundle carries. */
    async activeWifi() {
      if (state.apKnown === false) return { connection: null, ap: null };
      // `connection: null` in the options means a box that is on NOTHING - see the stranded tests.
      if (connection !== undefined && !state.apUp) return { connection, ap: false };
      return { connection: state.apUp ? 'pidvs-setup' : 'Home Wi-Fi', ap: state.apUp };
    },
    async apUp(password) {
      state.calls.push('ap-up');
      state.apUpPassword = password;
      if (state.apUpFails) return { ok: false, reason: state.apUpFails };
      state.apUp = true;
      return { ok: true };
    },
    async apDown() { state.calls.push('ap-down'); state.apUp = false; return { ok: true }; },
  };

  state.log = [];
  const mode = createWifiMode({
    wifiProvisioning,
    apPassword: { get: () => state.apPassword ?? null },
    dataDir,
    isCablePresentFn: () => state.cable,
    cableInsertIdFn: () => state.insert,
    log: (m) => state.log.push(m),
    ...(nowFn ? { nowFn } : {}),
  });

  return {
    mode,
    state,
    dataDir,
    /** A fresh insert gets a NEW mtime, which is what tells one management session from the next. */
    plugIn() { state.cable = true; state.insert = (state.insert ?? 1000) + 1000; },
    unplug() { state.cable = false; state.insert = null; },
  };
}

test('a cable in the box raises the setup network, unconditionally', async () => {
  const h = harness({ cable: true, saved: [{ ssid: 'Home Wi-Fi', active: true }] });
  assert.deepEqual(await h.mode.desiredState(), { ap: true, reason: 'cable' });
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, ['ap-up']);
});

test('pulling the cable takes it back down', async () => {
  const h = harness({ cable: true, saved: [{ ssid: 'Home Wi-Fi', active: true }] });
  await h.mode.reconcile();
  h.unplug();
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, ['ap-up', 'ap-down']);
});

test('a box with no saved network offers the AP with no cable in it at all', async () => {
  const h = harness({ cable: false, saved: [] });
  assert.deepEqual(await h.mode.desiredState(), { ap: true, reason: 'no-saved-networks' });
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, ['ap-up']);
});

test('a box with a saved network and no cable stays in station mode', async () => {
  const h = harness({ cable: false, saved: [{ ssid: 'Home Wi-Fi', active: true }] });
  assert.deepEqual(await h.mode.desiredState(), { ap: false, reason: 'station' });
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, []);
});

test('it re-asserts: an AP that goes down underneath it while the cable is still in comes back', async () => {
  const h = harness({ cable: true, saved: [{ ssid: 'Home Wi-Fi', active: true }] });
  await h.mode.reconcile();
  h.state.apUp = false; // a revert fired, or someone at a terminal
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, ['ap-up', 'ap-up']);
});

test('nothing happens on a poll where reality already matches the decision', async () => {
  const h = harness({ cable: true, saved: [], apUp: true });
  await h.mode.reconcile();
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, []);
});

/*
 * The one place the cable rule is not taken literally, and why: without this the AP comes straight
 * back up the moment a join completes, the box leaves the network it just joined, and the portal
 * reports success from a box that is no longer where it says it is.
 */
test('a successful join ends the management session even with the cable still in', async () => {
  const h = harness({ cable: true, saved: [] });
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, ['ap-up']);

  h.state.saved = [{ ssid: 'Home Wi-Fi', active: true }];
  h.mode.noteJoinSucceeded();
  await h.mode.reconcile();

  assert.deepEqual(await h.mode.desiredState(), { ap: false, reason: 'joined-during-this-insert' });
  assert.deepEqual(h.state.calls, ['ap-up', 'ap-down']);
});

test('re-inserting the cable starts a fresh session, so the AP comes back', async () => {
  const h = harness({ cable: true, saved: [{ ssid: 'Home Wi-Fi', active: true }] });
  h.mode.noteJoinSucceeded();
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, []);

  h.unplug();
  h.plugIn();
  assert.deepEqual(await h.mode.desiredState(), { ap: true, reason: 'cable' });
});

test('a FAILED join does not latch - the AP stays up so the password can be retried', async () => {
  const h = harness({ cable: true, saved: [] });
  await h.mode.reconcile();
  // noteJoinSucceeded is deliberately not called.
  assert.deepEqual(await h.mode.desiredState(), { ap: true, reason: 'cable' });
});

test('the disable flag stops it touching the radio at all', async () => {
  const h = harness({ cable: true, saved: [] });
  writeFileSync(join(h.dataDir, DISABLE_WIFI_MANAGEMENT_FLAG), '');
  assert.deepEqual(await h.mode.desiredState(), { ap: false, reason: 'disabled' });
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, []);
});

test('the disable flag lowers an AP it finds already up, rather than leaving it stranded', async () => {
  const h = harness({ cable: true, saved: [], apUp: true });
  writeFileSync(join(h.dataDir, DISABLE_WIFI_MANAGEMENT_FLAG), '');
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, ['ap-down']);
});

test('a reconcile that throws does not wedge the watcher for every later poll', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pidvs-wifi-mode-'));
  const calls = [];
  let statusBroken = true;
  const mode = createWifiMode({
    wifiProvisioning: {
      async saved() { return []; },
      async activeWifi() {
        if (statusBroken) { statusBroken = false; throw new Error('nmcli gone'); }
        return { connection: null, ap: false };
      },
      async apUp() { calls.push('ap-up'); return { ok: true }; },
      async apDown() { calls.push('ap-down'); return { ok: true }; },
    },
    dataDir,
    isCablePresentFn: () => true,
    cableInsertIdFn: () => 1000,
    log: () => {},
  });

  await mode.reconcile();
  assert.deepEqual(calls, [], 'the throwing poll does nothing');
  await mode.reconcile();
  assert.deepEqual(calls, ['ap-up'], 'and the next one still works');
});

/*
 * nmcli failing is not the same as "no AP is up". Treating it as false would have the watcher try to
 * raise an AP that may already be running, once every poll, for as long as nmcli stays unreachable.
 */
test('an unreadable AP state is left alone, not read as "no AP"', async () => {
  const h = harness({ cable: true, saved: [] });
  h.state.apKnown = false;
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, []);
  h.state.apKnown = true;
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, ['ap-up'], 'and it acts as soon as nmcli answers again');
});

/*
 * The field-box bug. A unit that has never bootstrapped and has no saved network wants the AP up,
 * `ap-up` answers `not-bootstrapped`, and nothing about that changes on its own. Without a backoff
 * the watcher retries every five seconds forever - two log lines and one failed sudo attempt each
 * time, about 35,000 lines a day, on the two machines that cannot be reached to clear them.
 */
test('a permanently failing ap-up backs off instead of retrying every poll', async () => {
  const h = harness({ cable: true, saved: [] });
  h.state.apUpFails = 'not-bootstrapped';

  for (let i = 0; i < 12; i += 1) await h.mode.reconcile();

  assert.deepEqual(h.state.calls, ['ap-up'], 'twelve polls must not mean twelve attempts');
});

test('a stuck box reports the reason once, not once per attempt', async () => {
  const h = harness({ cable: true, saved: [] });
  h.state.apUpFails = 'not-bootstrapped';
  for (let i = 0; i < 12; i += 1) await h.mode.reconcile();

  const complaints = h.state.log.filter((m) => m.includes('not-bootstrapped'));
  assert.equal(complaints.length, 1, `said it ${complaints.length} times: ${JSON.stringify(h.state.log)}`);
});

/* A failure that CHANGES is telling you something new, and must not be swallowed by the first one. */
test('a different failure reason is reported even while backing off', async () => {
  const h = harness({ cable: true, saved: [] });
  h.state.apUpFails = 'not-bootstrapped';
  await h.mode.reconcile();
  h.state.apUpFails = 'ap-up-failed';
  // Past the first backoff window.
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    await h.mode.reconcile();
  } finally {
    Date.now = realNow;
  }
  assert.ok(h.state.log.some((m) => m.includes('ap-up-failed')), JSON.stringify(h.state.log));
});

test('once it succeeds, the backoff resets so the next real change is immediate', async () => {
  const h = harness({ cable: true, saved: [] });
  h.state.apUpFails = 'not-bootstrapped';
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, ['ap-up']);

  // The grant arrives (a BLE bootstrap), and the backoff window passes.
  h.state.apUpFails = null;
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    await h.mode.reconcile();
    assert.deepEqual(h.state.calls, ['ap-up', 'ap-up'], 'it should try again once backed off');
    // Now pull the cable: the AP must come down at the very next poll, not after a stale backoff.
    h.unplug();
    h.state.saved = [{ ssid: 'Home Wi-Fi', active: true }];
    await h.mode.reconcile();
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(h.state.calls, ['ap-up', 'ap-up', 'ap-down']);
});

test('describe() surfaces a stuck reason, so a diagnostics bundle says why', async () => {
  const h = harness({ cable: true, saved: [] });
  h.state.apUpFails = 'not-bootstrapped';
  await h.mode.reconcile();
  assert.equal(h.mode.describe().lastFailure, 'not-bootstrapped');
});

/* The AP's password has to reach the radio, or the helper falls back to its own default and the person
 * who changed it is told one thing while the box offers another. */
test('raising the AP passes the configured password through', async () => {
  const h = harness({ cable: true, saved: [] });
  h.state.apPassword = 'mybooth2026';
  await h.mode.reconcile();
  assert.equal(h.state.apUpPassword, 'mybooth2026');
});

/* A fresh box has none, and the network must come up OPEN rather than not at all - that is the only
 * way somebody holding nothing can reach the portal that then closes it. */
test('a box with no password set raises an open network, not no network', async () => {
  const h = harness({ cable: true, saved: [] });
  await h.mode.reconcile();
  assert.deepEqual(h.state.calls, ['ap-up']);
  assert.equal(h.state.apUpPassword, null);
});

/*
 * A box that knows a network it cannot reach used to sit silent for ever: no AP, nothing to connect
 * to, and no way back except a cable inside the enclosure. Someone moves house, changes router, or
 * keeps the box on a phone hotspot that sleeps whenever nothing is connected to it - which on a box
 * that IS the only client is always (owner's friend, 2026-09-30).
 */
test('a box stranded off every network raises its AP, but not instantly', async () => {
  let clock = 0;
  const h = harness({ saved: [{ ssid: 'myPhone' }], connection: null, nowFn: () => clock });

  // Briefly disconnected is an ordinary reconnect, not a reason to flap the AP.
  assert.deepEqual(await h.mode.desiredState(), { ap: false, reason: 'reconnecting' });

  clock += 120_000;
  assert.deepEqual(await h.mode.desiredState(), { ap: true, reason: 'stranded' });
});

/* One radio: an AP that never comes down means autoconnect never gets the chance to find the saved
 * network again, and the box can only be rescued by hand. */
test('a stranded AP steps aside periodically so the saved network can be found', async () => {
  let clock = 0;
  const h = harness({ saved: [{ ssid: 'myPhone' }], connection: null, nowFn: () => clock });

  await h.mode.desiredState();                 // starts the stranded clock
  clock += 120_000;
  assert.equal((await h.mode.desiredState()).reason, 'stranded');

  clock += 3 * 60_000;
  assert.deepEqual(await h.mode.desiredState(), { ap: false, reason: 'standing-aside' });
});

/* And a box that IS on a network is left alone, which is every ordinary box. */
test('a box on a saved network stays in station mode', async () => {
  const h = harness({ saved: [{ ssid: 'Home Wi-Fi', active: true }] });
  assert.deepEqual(await h.mode.desiredState(), { ap: false, reason: 'station' });
});
