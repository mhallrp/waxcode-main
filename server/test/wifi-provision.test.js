import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWifiProvisioning } from '../src/wifi-provision.js';

/** A provisioning dir standing in for the real one, so tests never read the shipped files. */
function fakeProvisioning() {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-prov-'));
  writeFileSync(join(dir, 'pidvs-network.sh'), '#!/bin/sh\necho helper\n');
  writeFileSync(join(dir, 'pidvs-network.sudoers'), '__BOX_USER__ ALL=(root) NOPASSWD: /usr/local/bin/pidvs-network status\n');
  return dir;
}

/**
 * `bootstrapped` decides whether `sudo -n pidvs-network ...` works, which is exactly what tells the
 * real code whether the grant is in place.
 */
function harness({ bootstrapped = false, joinFails = null, sudoFails = null } = {}) {
  const calls = { sudoRun: [], execFile: [] };
  let installed = bootstrapped;

  const execFileFn = async (cmd, argv) => {
    calls.execFile.push([cmd, ...argv]);
    const verb = argv[2];
    if (!installed) throw Object.assign(new Error('sudo: a password is required'), { stderr: 'sudo: a password is required' });
    if (verb === 'status') return { stdout: 'connection=Home Wi-Fi\nip=192.168.1.87/24\nap=no\n' };
    return { stdout: '' };
  };

  /* The join goes through here, not execFile, because the PSK travels on STDIN - sudo logs the
   * whole command line and /proc/<pid>/cmdline is world-readable, so an argument would publish it
   * twice over. A real PSK reached a real diagnostics bundle that way (2026-09-26). */
  const runWithInputFn = async (cmd, argv, input) => {
    calls.execFile.push([cmd, ...argv]);
    calls.joinInput = input;
    if (joinFails) throw Object.assign(new Error('failed'), { stderr: joinFails });
    return '';
  };

  const sudoRun = async (password, command) => {
    calls.sudoRun.push({ password, command });
    if (sudoFails) throw Object.assign(new Error('sudo exited 1'), { stderr: sudoFails });
    installed = true;
    return '';
  };

  return {
    calls,
    provisioning: createWifiProvisioning({
      execFileFn, sudoRun, runWithInputFn, provisioningDir: fakeProvisioning(), boxUser: 'waxcode',
    }),
  };
}

test('a box that already has the grant never asks for a password', async () => {
  const { calls, provisioning } = harness({ bootstrapped: true });
  const result = await provisioning.join({ ssid: 'Home', psk: 'secret', adminPassword: 'should-not-be-used' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.sudoRun, [], 'the password path must not be touched once bootstrapped');
});

test('an un-bootstrapped box uses the password only to bootstrap, never to join', async () => {
  const { calls, provisioning } = harness({ bootstrapped: false });
  const result = await provisioning.join({ ssid: 'Home', psk: 'secret', adminPassword: 'pw' });
  assert.equal(result.ok, true);

  /* Two root invocations during bootstrap and no more: one to CHECK the password on its own (see
   * join's note - so a wrong one is reported as exactly that, rather than inferred from an install
   * that failed for some other reason), one to install. The property worth pinning is not the
   * count but that nothing AFTER bootstrap touches the password path. */
  assert.equal(calls.sudoRun.length, 2, 'check, then install - not one root call per file');
  assert.ok(calls.execFile.some((c) => c.includes('join')), 'the join itself goes through the grant');
  assert.ok(!calls.execFile.flat().includes('secret'), 'the PSK must never appear as an argument');
  assert.match(calls.joinInput, /^secret\n$/, 'it goes on stdin instead');
});

test('the sudoers file is validated BEFORE it is installed', async () => {
  const { calls, provisioning } = harness({ bootstrapped: false });
  await provisioning.join({ ssid: 'Home', psk: 'secret', adminPassword: 'pw' });
  const command = calls.sudoRun.at(-1).command;
  const validateAt = command.indexOf('visudo -cf');
  const installAt = command.indexOf('/etc/sudoers.d/pidvs-network');
  assert.ok(validateAt > -1, 'visudo must run');
  assert.ok(validateAt < installAt, 'a malformed sudoers file locks the box out of sudo entirely');
  assert.ok(command.includes('&&'), 'each step must gate the next');
});

test('the box account name comes from the running process, never a guess', async () => {
  const dir = fakeProvisioning();
  let staged = '';
  const provisioning = createWifiProvisioning({
    execFileFn: async () => { throw new Error('not bootstrapped'); },
    sudoRun: async (_pw, command) => {
      // The password check runs first and touches no files; only the install names the sudoers.
      const named = command.match(/'([^']*\.sudoers)'/);
      if (named) staged = readFileSync(named[1], 'utf8');
      return '';
    },
    provisioningDir: dir,
    boxUser: 'someoneelse',
  });
  await provisioning.join({ ssid: 'Home', psk: 'x', adminPassword: 'pw' }).catch(() => {});
  assert.match(staged, /^someoneelse ALL=/m, 'the placeholder must be replaced with the real account');
  assert.doesNotMatch(staged, /__BOX_USER__/, 'the placeholder must not survive into the installed file');
});

test('each failure is named, because "it did not work" is not actionable from a friend', async () => {
  const wrongAdmin = harness({ bootstrapped: false, sudoFails: 'Sorry, try again.' });
  assert.equal((await wrongAdmin.provisioning.join({ ssid: 'H', psk: 'p', adminPassword: 'bad' })).reason,
    'wrong-admin-password');

  const noNetwork = harness({ bootstrapped: true, joinFails: 'Error: No network with SSID "Nope" found.' });
  assert.equal((await noNetwork.provisioning.join({ ssid: 'Nope', psk: 'p' })).reason, 'no-such-network');

  const wrongPsk = harness({ bootstrapped: true, joinFails: 'Error: Secrets were required, but not provided.' });
  assert.equal((await wrongPsk.provisioning.join({ ssid: 'H', psk: 'bad' })).reason, 'wrong-wifi-password');

  const noPassword = harness({ bootstrapped: false });
  assert.equal((await noPassword.provisioning.join({ ssid: 'H', psk: 'p' })).reason, 'needs-admin-password');
});

/*
 * saved()/forget()/apUp()/apDown() - what the AP portal and the cable watcher are built out of.
 *
 * A separate harness because these need nmcli answered on its own (saved() deliberately does NOT go
 * through the grant) and need the helper to be able to FAIL in specific, distinguishable ways.
 */
function opsHarness({ bootstrapped = true, nmcli = '', helperFails = {} } = {}) {
  const calls = [];
  const execFileFn = async (cmd, argv) => {
    calls.push([cmd, ...argv]);
    if (cmd === 'nmcli') {
      if (nmcli === null) throw new Error('nmcli missing');
      return { stdout: nmcli };
    }
    if (!bootstrapped) throw Object.assign(new Error('sudo: a password is required'), { stderr: 'sudo: a password is required' });
    const verb = argv[2];
    if (helperFails[verb]) throw Object.assign(new Error('failed'), { stderr: helperFails[verb] });
    if (verb === 'status') return { stdout: 'ap=no\n' };
    return { stdout: '' };
  };
  const runWithInputFn = async (cmd, argv, input) => {
    calls.push([cmd, ...argv]);
    calls.stdin = input;
    if (!bootstrapped) throw Object.assign(new Error('sudo: a password is required'), { stderr: 'sudo: a password is required' });
    if (helperFails[argv[2]]) throw Object.assign(new Error('failed'), { stderr: helperFails[argv[2]] });
    return '';
  };
  return {
    calls,
    provisioning: createWifiProvisioning({
      execFileFn, runWithInputFn, provisioningDir: fakeProvisioning(), boxUser: 'waxcode',
    }),
  };
}

test('saved() lists wireless profiles and ignores every other connection type', async () => {
  const { provisioning } = opsHarness({
    nmcli: 'Home Wi-Fi:802-11-wireless:yes\nWired connection 1:802-3-ethernet:no\nlo:loopback:yes\n',
  });
  assert.deepEqual(await provisioning.saved(), [{ ssid: 'Home Wi-Fi', active: true }]);
});

/* Counting the box's own hotspot would mean a box with nothing saved but its own AP decides it has
 * somewhere to be - and stops offering the only network anyone could reach it on. */
test('saved() leaves out the box\'s own setup AP, which is a profile like any other', async () => {
  const { provisioning } = opsHarness({ nmcli: 'pidvs-setup:802-11-wireless:yes\n' });
  assert.deepEqual(await provisioning.saved(), []);
});

test('saved() survives an SSID with a colon in it', async () => {
  const { provisioning } = opsHarness({ nmcli: 'Flat\\:2 WiFi:802-11-wireless:no\n' });
  assert.deepEqual(await provisioning.saved(), [{ ssid: 'Flat:2 WiFi', active: false }]);
});

test('saved() needs no grant - a box that never bootstrapped can still list its networks', async () => {
  const { calls, provisioning } = opsHarness({
    bootstrapped: false,
    nmcli: 'Home Wi-Fi:802-11-wireless:yes\n',
  });
  assert.deepEqual(await provisioning.saved(), [{ ssid: 'Home Wi-Fi', active: true }]);
  assert.ok(!calls.some((c) => c[0] === 'sudo'), 'listing profiles must not go through sudo');
});

test('saved() reports nothing rather than throwing when nmcli is unavailable', async () => {
  const { provisioning } = opsHarness({ nmcli: null });
  assert.deepEqual(await provisioning.saved(), []);
});

test('forget() relays the helper\'s refusal to remove the only reachable network', async () => {
  const { provisioning } = opsHarness({
    helperFails: { forget: 'refusing to forget the only network this box can reach' },
  });
  assert.deepEqual(await provisioning.forget('Home Wi-Fi'), { ok: false, reason: 'last-network', field: 'ssid' });
});

test('forget() refuses to be pointed at the box\'s own AP', async () => {
  const { calls, provisioning } = opsHarness();
  const result = await provisioning.forget('pidvs-setup');
  assert.equal(result.reason, 'not-a-saved-network');
  assert.deepEqual(calls, [], 'and does not reach the helper to find out');
});

test('forget() removes a saved network', async () => {
  const { calls, provisioning } = opsHarness();
  assert.deepEqual(await provisioning.forget('Old Flat'), { ok: true });
  assert.deepEqual(calls, [['sudo', '-n', '/usr/local/bin/pidvs-network', 'forget', 'Old Flat']]);
});

test('apUp()/apDown() go through the grant', async () => {
  const { calls, provisioning } = opsHarness();
  assert.deepEqual(await provisioning.apUp('waxcodesetup'), { ok: true });
  assert.deepEqual(await provisioning.apDown(), { ok: true });
  assert.deepEqual(calls.map((c) => c[3]), ['ap-up', 'ap-down']);
});

/*
 * The AP password goes on STDIN, never argv, for two independent reasons: the sudoers grant names
 * `ap-up` with no wildcard and a bootstrapped box can never be granted one, and sudo writes its
 * command line to the journal, which is uploaded in diagnostics bundles. A real PSK leaked that way on
 * 2026-09-26.
 */
test('the AP password travels on stdin, never as an argument', async () => {
  const { calls, provisioning } = opsHarness();
  await provisioning.apUp('mybooth2026');
  assert.equal(calls.stdin, 'mybooth2026\n');
  assert.ok(!calls.flat().includes('mybooth2026'), 'the password must not appear in argv');
});

/* The gap worth naming precisely: a box with no grant cannot raise an AP, and "ap-up-failed" would
 * send whoever reads it looking at the radio instead of at the one thing that fixes it. */
test('apUp() on a box that never bootstrapped says so, rather than blaming the radio', async () => {
  const { provisioning } = opsHarness({ bootstrapped: false });
  assert.deepEqual(await provisioning.apUp(), { ok: false, reason: 'not-bootstrapped' });
});

/* activeWifi() is what the watcher polls with. It must never touch sudo: three journal lines per
 * poll, every five seconds, would bury the 300 lines a diagnostics bundle carries. */
test('activeWifi() reads the active connection with no sudo at all', async () => {
  const { calls, provisioning } = opsHarness({
    nmcli: 'lo:loopback:lo\nHome Wi-Fi:802-11-wireless:wlan0\n',
  });
  assert.deepEqual(await provisioning.activeWifi(), { connection: 'Home Wi-Fi', ap: false });
  assert.ok(!calls.some((c) => c[0] === 'sudo'), 'the watcher\'s poll must not go through sudo');
});

test('activeWifi() recognises the box\'s own setup AP', async () => {
  const { provisioning } = opsHarness({ nmcli: 'pidvs-setup:802-11-wireless:wlan0\n' });
  assert.deepEqual(await provisioning.activeWifi(), { connection: 'pidvs-setup', ap: true });
});

test('activeWifi() reports no connection when the radio is on nothing', async () => {
  const { provisioning } = opsHarness({ nmcli: 'Wired connection 1:802-3-ethernet:eth0\n' });
  assert.deepEqual(await provisioning.activeWifi(), { connection: null, ap: false });
});

/* `null`, not `false`. "I could not find out" and "there is no AP" call for opposite actions. */
test('activeWifi() reports ap:null when nmcli cannot be reached at all', async () => {
  const { provisioning } = opsHarness({ nmcli: null });
  assert.deepEqual(await provisioning.activeWifi(), { connection: null, ap: null });
});

/*
 * One radio: while the box hosts its own network it cannot look around, so every scan comes back
 * with its own SSID and nothing else. Letting that overwrite the cache leaves the setup portal -
 * the one place a list of networks is genuinely needed - offering a single useless entry, which
 * reads as a broken scan rather than a busy radio (2026-09-29).
 */
test('a scan taken while hosting does not wipe out what the box last saw', async () => {
  let output = 'Home Wi-Fi:90:WPA2\nSKYH2QQY:70:WPA2\n';
  const execFileFn = async () => ({ stdout: output });
  // No cache, so the second scan genuinely re-runs - otherwise this passes without ever reaching
  // the case it exists to test.
  const wifi = createWifiProvisioning({ execFileFn, scanCacheMs: 0 });

  const before = await wifi.scan();
  assert.deepEqual(before.map((n) => n.ssid), ['Home Wi-Fi', 'SKYH2QQY']);

  // The AP goes up, and now the radio can only see the box itself.
  output = 'Waxcode Setup 46D4:99:\n';

  const during = await wifi.scan();
  assert.deepEqual(
    during.map((n) => n.ssid),
    ['Home Wi-Fi', 'SKYH2QQY'],
    'the neighbourhood it last saw, not the one entry it can see now',
  );
});

/*
 * A hotspot that is asleep is the network somebody most needs to save, and the one least likely to
 * be broadcasting while they type its password. The helper now keeps the profile and lets
 * NetworkManager join it whenever it appears, reporting exit 2 for "saved but not joined" - which
 * is an outcome, not a failure (owner's point, 2026-09-30).
 */
test('a network that is not broadcasting yet is saved, not treated as a failure', async () => {
  const provisioning = createWifiProvisioning({
    execFileFn: async (_cmd, args) => {
      if (args?.includes('status')) return { stdout: 'interface=wlan0\nap=no\n' };
      return { stdout: '' };
    },
    runWithInputFn: async () => {
      const err = new Error('Command failed');
      err.code = 2;
      err.stderr = 'saved myPhone\n';
      throw err;
    },
  });

  const result = await provisioning.join({ ssid: 'myPhone', psk: 'hunter2' });
  assert.equal(result.ok, true, 'saving the credentials IS the useful outcome');
  assert.equal(result.joined, false, 'and it is honest that it has not joined yet');
});

/* A password the network actively refused is different: that profile can never work, and keeping it
 * would mean retrying it at every boot forever. */
test('a refused password is still reported as a failure', async () => {
  const provisioning = createWifiProvisioning({
    execFileFn: async () => ({ stdout: 'interface=wlan0\n' }),
    runWithInputFn: async () => {
      const err = new Error('Command failed');
      err.code = 1;
      err.stderr = 'could not join myPhone: password refused\n';
      throw err;
    },
  });

  const result = await provisioning.join({ ssid: 'myPhone', psk: 'wrong' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong-wifi-password');
  assert.equal(result.field, 'password');
});
