import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readlinkSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseManager } from '../release-manager.js';

function tempReleasesDir() {
  return mkdtempSync(join(tmpdir(), 'pidvs-releases-test-'));
}

/** A fake `fetch`-shaped function, for tests that don't need a real network call. Records every call's URL+options for tests that need to inspect what was actually sent (eg. auth headers). */
function fakeFetch(responsesByUrl) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const entry = responsesByUrl[url];
    if (!entry) throw new Error(`unexpected fetch: ${url}`);
    if (entry.status && entry.status !== 200) return { ok: false, status: entry.status };
    return {
      ok: true,
      json: async () => entry.json,
      arrayBuffer: async () => entry.buffer,
    };
  };
  fn.calls = calls;
  return fn;
}

test('currentVersion() is null when no release has ever been activated', () => {
  const manager = createReleaseManager({ releasesDir: tempReleasesDir() });
  assert.equal(manager.currentVersion(), null);
});

test('listStagedVersions() is empty in a fresh releases directory', () => {
  const manager = createReleaseManager({ releasesDir: tempReleasesDir() });
  assert.deepEqual(manager.listStagedVersions(), []);
});

test('fetchManifest() returns the parsed manifest', async () => {
  const manifest = { latest: '0.1.3', releases: { '0.1.3': { file: 'x.tar.gz', checksum: 'abc' } } };
  const manager = createReleaseManager({
    releasesDir: tempReleasesDir(),
    fetchFn: fakeFetch({ 'http://update.test/api/updates/manifest': { json: manifest } }),
  });
  assert.deepEqual(await manager.fetchManifest('http://update.test'), manifest);
});

test('fetchManifest() sends an Authorization header when given an authToken, sends none without one', async () => {
  const fetchFn = fakeFetch({ 'http://update.test/api/updates/manifest': { json: {} } });
  const manager = createReleaseManager({ releasesDir: tempReleasesDir(), fetchFn });

  await manager.fetchManifest('http://update.test', { authToken: 'secret-token' });
  assert.deepEqual(fetchFn.calls[0].options, { headers: { Authorization: 'Bearer secret-token' } });

  await manager.fetchManifest('http://update.test');
  assert.deepEqual(fetchFn.calls[1].options, {});
});

test('fetchManifest() rejects on a non-OK response', async () => {
  const manager = createReleaseManager({
    releasesDir: tempReleasesDir(),
    fetchFn: fakeFetch({ 'http://update.test/api/updates/manifest': { status: 500 } }),
  });
  await assert.rejects(() => manager.fetchManifest('http://update.test'), /HTTP 500/);
});

test('downloadRelease() writes the response body to disk', async () => {
  const releasesDir = tempReleasesDir();
  const manager = createReleaseManager({
    releasesDir,
    fetchFn: fakeFetch({ 'http://update.test/api/updates/pidvs-server-v0.1.0.tar.gz': { buffer: Buffer.from('fake tarball bytes') } }),
  });
  const dest = join(releasesDir, 'v0.1.0.tar.gz');
  await manager.downloadRelease('http://update.test/api/updates/pidvs-server-v0.1.0.tar.gz', dest);
  assert.equal(readFileSync(dest, 'utf8'), 'fake tarball bytes');
});

test('downloadRelease() sends an Authorization header when given an authToken', async () => {
  const releasesDir = tempReleasesDir();
  const fetchFn = fakeFetch({ 'http://update.test/file.tar.gz': { buffer: Buffer.from('bytes') } });
  const manager = createReleaseManager({ releasesDir, fetchFn });

  await manager.downloadRelease('http://update.test/file.tar.gz', join(releasesDir, 'out.tar.gz'), { authToken: 'secret-token' });
  assert.deepEqual(fetchFn.calls[0].options, { headers: { Authorization: 'Bearer secret-token' } });
});

test('verifyChecksum() is true for a matching sha256 and false for a mismatch', () => {
  const releasesDir = tempReleasesDir();
  const filePath = join(releasesDir, 'file.bin');
  writeFileSync(filePath, 'some content');
  const realChecksum = createHash('sha256').update('some content').digest('hex');

  const manager = createReleaseManager({ releasesDir });
  assert.equal(manager.verifyChecksum(filePath, realChecksum), true);
  assert.equal(manager.verifyChecksum(filePath, 'not-the-real-checksum'), false);
});

test('stageRelease() extracts a real tarball into releasesDir/v<version>/', async () => {
  const releasesDir = tempReleasesDir();
  const sourceDir = mkdtempSync(join(tmpdir(), 'pidvs-source-'));
  mkdirSync(join(sourceDir, 'src'), { recursive: true });
  writeFileSync(join(sourceDir, 'src', 'index.js'), 'console.log("hello")');
  writeFileSync(join(sourceDir, 'package.json'), '{}');

  const tarballPath = join(releasesDir, 'pidvs-server-v0.1.5.tar.gz');
  // Real tar, matching tools/package-release.js's own `-C server.`
  // convention - contents at the archive root, not a nested folder.
  execFileSync('tar', ['-czf', tarballPath, '-C', sourceDir, '.']);

  const manager = createReleaseManager({ releasesDir });
  const versionDir = await manager.stageRelease(tarballPath, '0.1.5');

  assert.equal(versionDir, join(releasesDir, 'v0.1.5'));
  assert.equal(readFileSync(join(versionDir, 'src', 'index.js'), 'utf8'), 'console.log("hello")');
  assert.ok(existsSync(join(versionDir, 'package.json')));
});

test('stageRelease() overwrites a previously-staged version at the same number', async () => {
  const releasesDir = tempReleasesDir();
  const sourceDir = mkdtempSync(join(tmpdir(), 'pidvs-source-'));
  writeFileSync(join(sourceDir, 'marker.txt'), 'second');
  const tarballPath = join(releasesDir, 'v.tar.gz');
  execFileSync('tar', ['-czf', tarballPath, '-C', sourceDir, '.']);

  const manager = createReleaseManager({ releasesDir });
  mkdirSync(join(releasesDir, 'v0.9.0'), { recursive: true });
  writeFileSync(join(releasesDir, 'v0.9.0', 'marker.txt'), 'first');
  writeFileSync(join(releasesDir, 'v0.9.0', 'stale-file-from-before.txt'), 'should be gone after restaging');

  await manager.stageRelease(tarballPath, '0.9.0');
  assert.equal(readFileSync(join(releasesDir, 'v0.9.0', 'marker.txt'), 'utf8'), 'second');
  assert.equal(existsSync(join(releasesDir, 'v0.9.0', 'stale-file-from-before.txt')), false);
});

test('stageRelease() replaces any packaged data/ with a symlink to the shared, persistent data directory', async () => {
  // Regression coverage for a real bug caught on real hardware
  // (2026-07-29): a release's own bundled data/ (whatever happened to
  // be on the packaging machine) used to silently overwrite the box's
  // real persisted state (box name, favourites, deck settings) on
  // every activation.
  const releasesDir = tempReleasesDir();
  const sharedDataDir = join(releasesDir, '..', 'shared-data-for-test');
  const sourceDir = mkdtempSync(join(tmpdir(), 'pidvs-source-'));
  mkdirSync(join(sourceDir, 'data'), { recursive: true });
  writeFileSync(join(sourceDir, 'data', 'box-name.json'), 'this must never end up on the real box');
  const tarballPath = join(releasesDir, 'v.tar.gz');
  execFileSync('tar', ['-czf', tarballPath, '-C', sourceDir, '.']);

  mkdirSync(sharedDataDir, { recursive: true });
  writeFileSync(join(sharedDataDir, 'box-name.json'), '{"name":"the real box name"}');

  const manager = createReleaseManager({ releasesDir, sharedDataDir });
  const versionDir = await manager.stageRelease(tarballPath, '0.1.4');

  assert.equal(readlinkSync(join(versionDir, 'data')), sharedDataDir);
  assert.equal(readFileSync(join(versionDir, 'data', 'box-name.json'), 'utf8'), '{"name":"the real box name"}');
});

/** A fake execFileFn for activate/rollbackTo tests - avoids touching a real systemctl/sudo. */
function fakeExecFile({ restartSucceeds = true, healthyAfterRestart = true } = {}) {
  let restarted = false;
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('restart')) {
      if (!restartSucceeds) throw new Error('systemctl restart failed');
      restarted = true;
      return { stdout: '' };
    }
    if (args.includes('is-active')) {
      if (restarted && healthyAfterRestart) return { stdout: 'active\n' };
      const err = new Error('inactive');
      throw err;
    }
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
  };
  fn.calls = calls;
  return fn;
}

/** Same as fakeExecFile, but delegates real `tar` calls to the real execFile - for tests exercising activateFromFile's full stageRelease+activate path, which needs both a real extraction and a faked systemctl. */
function fakeExecFileWithRealTar(options) {
  const execFileAsync = promisify(execFile);
  const systemctlFake = fakeExecFile(options);
  return async (cmd, args) => {
    if (cmd === 'tar') return execFileAsync(cmd, args);
    return systemctlFake(cmd, args);
  };
}

test('activate() points current at the new version and restarts the service when it becomes healthy', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  const manager = createReleaseManager({
    releasesDir,
    execFileFn: fakeExecFile({ healthyAfterRestart: true }),
    healthCheckIntervalMs: 5,
  });

  const result = await manager.activate('0.1.0');
  assert.deepEqual(result, { activated: '0.1.0', rolledBack: false });
  assert.equal(readlinkSync(join(releasesDir, 'current')), 'v0.1.0');
});

test('activate() rolls back to the previous version if the new one never becomes healthy', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  mkdirSync(join(releasesDir, 'v0.2.0'), { recursive: true });

  const manager = createReleaseManager({
    releasesDir,
    execFileFn: fakeExecFile({ healthyAfterRestart: true }),
    healthCheckIntervalMs: 5,
  });
  await manager.activate('0.1.0'); // establish v0.1.0 as the known-good "previous" version

  const brokenExecFile = fakeExecFile({ healthyAfterRestart: false });
  const brokenManager = createReleaseManager({ releasesDir, execFileFn: brokenExecFile, healthCheckTimeoutMs: 50, healthCheckIntervalMs: 5 });
  const result = await brokenManager.activate('0.2.0');

  assert.deepEqual(result, { activated: '0.1.0', rolledBack: true, failedVersion: '0.2.0' });
  // current ends up back on v0.1.0, not left on the broken v0.2.0.
  assert.equal(readlinkSync(join(releasesDir, 'current')), 'v0.1.0');
});

test('activate() rolls back if the restart itself throws, not just if it starts but stays unhealthy', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  mkdirSync(join(releasesDir, 'v0.2.0'), { recursive: true });

  const goodManager = createReleaseManager({ releasesDir, execFileFn: fakeExecFile(), healthCheckIntervalMs: 5 });
  await goodManager.activate('0.1.0');

  // A counting fake that fails exactly the first restart call (v0.2.0's
  // own activation attempt) but succeeds the second (the rollback
  // restart back to v0.1.0) - otherwise this test couldn't tell "rolled
  // back" apart from "everything just failed."
  let restartCalls = 0;
  const execFileFn = async (cmd, args) => {
    if (args.includes('restart')) {
      restartCalls += 1;
      if (restartCalls === 1) throw new Error('systemctl refused');
      return { stdout: '' };
    }
    if (args.includes('is-active')) return { stdout: 'active\n' };
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
  };

  const brokenManager = createReleaseManager({ releasesDir, execFileFn, healthCheckIntervalMs: 5 });
  const result = await brokenManager.activate('0.2.0');
  assert.deepEqual(result, { activated: '0.1.0', rolledBack: true, failedVersion: '0.2.0' });
  assert.equal(readlinkSync(join(releasesDir, 'current')), 'v0.1.0');
});

test('activate() leaves current unset (no previous) if the very first activation ever fails', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });

  const manager = createReleaseManager({
    releasesDir,
    execFileFn: fakeExecFile({ healthyAfterRestart: false }),
    healthCheckTimeoutMs: 50,
    healthCheckIntervalMs: 5,
  });
  const result = await manager.activate('0.1.0');
  assert.deepEqual(result, { activated: null, rolledBack: true, failedVersion: '0.1.0' });
  assert.equal(manager.currentVersion(), null);
});

test('rollbackTo() points current at the given version and reports its health', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.3'), { recursive: true });

  const manager = createReleaseManager({ releasesDir, execFileFn: fakeExecFile(), healthCheckIntervalMs: 5 });
  const result = await manager.rollbackTo('0.1.3');
  assert.deepEqual(result, { activated: '0.1.3', healthy: true });
  assert.equal(readlinkSync(join(releasesDir, 'current')), 'v0.1.3');
});

test('activate() records the new version as last-known-good once it is confirmed healthy', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  const manager = createReleaseManager({ releasesDir, execFileFn: fakeExecFile({ healthyAfterRestart: true }), healthCheckIntervalMs: 5 });

  await manager.activate('0.1.0');
  assert.equal(manager.readLastKnownGood(), '0.1.0');
});

test('activate() does not touch last-known-good when the new version never becomes healthy', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  mkdirSync(join(releasesDir, 'v0.2.0'), { recursive: true });

  const goodManager = createReleaseManager({ releasesDir, execFileFn: fakeExecFile({ healthyAfterRestart: true }), healthCheckIntervalMs: 5 });
  await goodManager.activate('0.1.0'); // establishes 0.1.0 as last-known-good

  const brokenManager = createReleaseManager({
    releasesDir,
    execFileFn: fakeExecFile({ healthyAfterRestart: false }),
    healthCheckTimeoutMs: 50,
    healthCheckIntervalMs: 5,
  });
  await brokenManager.activate('0.2.0'); // fails its health check, auto-rolls back

  assert.equal(goodManager.readLastKnownGood(), '0.1.0'); // still 0.1.0, never overwritten with the broken 0.2.0
});

test('rollbackTo() records the target version as last-known-good once healthy, so a fresh boot would not later "recover" away from a deliberate manual rollback', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.3'), { recursive: true });

  const manager = createReleaseManager({ releasesDir, execFileFn: fakeExecFile(), healthCheckIntervalMs: 5 });
  await manager.rollbackTo('0.1.3');
  assert.equal(manager.readLastKnownGood(), '0.1.3');
});

test('rollbackTo() does not record last-known-good if the target does not come up healthy', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.3'), { recursive: true });

  const manager = createReleaseManager({
    releasesDir,
    execFileFn: fakeExecFile({ healthyAfterRestart: false }),
    healthCheckTimeoutMs: 50,
    healthCheckIntervalMs: 5,
  });
  await manager.rollbackTo('0.1.3');
  assert.equal(manager.readLastKnownGood(), null);
});

test('recoverFromUnconfirmedBoot() is a no-op on a fresh box with no last-known-good recorded yet', () => {
  const manager = createReleaseManager({ releasesDir: tempReleasesDir() });
  assert.deepEqual(manager.recoverFromUnconfirmedBoot(), { recovered: false, reason: 'no-baseline' });
});

test('recoverFromUnconfirmedBoot() is a no-op when current already matches last-known-good', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  const manager = createReleaseManager({ releasesDir, execFileFn: fakeExecFile(), healthCheckIntervalMs: 5 });
  await manager.activate('0.1.0');

  assert.deepEqual(manager.recoverFromUnconfirmedBoot(), { recovered: false, reason: 'confirmed' });
  assert.equal(readlinkSync(join(releasesDir, 'current')), 'v0.1.0'); // untouched
});

test('withUpdateLock() rejects a concurrent call while the first is still running - the real BLE-vs-manual-SSH collision this exists for', async () => {
  const manager = createReleaseManager({ releasesDir: tempReleasesDir() });

  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  const firstCall = manager.withUpdateLock(() => firstHeld);

  // Give the first call a tick to actually acquire the lock before the second one tries.
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    () => manager.withUpdateLock(async () => {}),
    /an update or rollback is already in progress/,
  );

  releaseFirst();
  await firstCall;
});

test('withUpdateLock() releases the lock once fn resolves, so a later call can acquire it fresh', async () => {
  const manager = createReleaseManager({ releasesDir: tempReleasesDir() });

  await manager.withUpdateLock(async () => {});

  let ranSecond = false;
  await manager.withUpdateLock(async () => { ranSecond = true; });
  assert.equal(ranSecond, true);
});

test('withUpdateLock() releases the lock even if fn throws, so a failed attempt does not block every future one', async () => {
  const manager = createReleaseManager({ releasesDir: tempReleasesDir() });

  await assert.rejects(() => manager.withUpdateLock(async () => { throw new Error('boom'); }), /boom/);

  let ranAfterFailure = false;
  await manager.withUpdateLock(async () => { ranAfterFailure = true; });
  assert.equal(ranAfterFailure, true);
});

test('withUpdateLock() takes over a stale lock left behind by a killed process (eg. a power loss mid-update) instead of blocking forever', async () => {
  const releasesDir = tempReleasesDir();
  const manager = createReleaseManager({ releasesDir, staleLockMs: 20 });

  // Simulates an abandoned lock - written directly, never released by anyone.
  writeFileSync(join(releasesDir, '.update-lock'), '12345');
  await new Promise((resolve) => setTimeout(resolve, 30)); // now older than staleLockMs

  let ran = false;
  await manager.withUpdateLock(async () => { ran = true; });
  assert.equal(ran, true);
});

test('withUpdateLock() does NOT take over a fresh lock just because staleLockMs is short - only once it is actually older than that', async () => {
  const releasesDir = tempReleasesDir();
  const manager = createReleaseManager({ releasesDir, staleLockMs: 10_000 });

  writeFileSync(join(releasesDir, '.update-lock'), '12345');

  await assert.rejects(
    () => manager.withUpdateLock(async () => {}),
    /an update or rollback is already in progress/,
  );
});

test('recoverFromUnconfirmedBoot() reverts current to last-known-good when they disagree - the exact power-loss-mid-activation scenario', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  mkdirSync(join(releasesDir, 'v0.2.0'), { recursive: true });
  const manager = createReleaseManager({ releasesDir, execFileFn: fakeExecFile(), healthCheckIntervalMs: 5 });
  await manager.activate('0.1.0'); // confirmed-good baseline

  // Simulates pointCurrentAt('0.2.0') having run, then power being lost before the health check
  // (and last-known-good) could ever be updated - a plain filesystem operation standing in for
  // what release-manager.js itself does, so this doesn't depend on activate's own atomicity.
  const tmpLink = join(releasesDir, '.current.tmp');
  symlinkSync('v0.2.0', tmpLink);
  renameSync(tmpLink, join(releasesDir, 'current'));

  const result = manager.recoverFromUnconfirmedBoot();
  assert.deepEqual(result, { recovered: true, from: '0.2.0', to: '0.1.0' });
  assert.equal(readlinkSync(join(releasesDir, 'current')), 'v0.1.0');
});

test('listStagedVersions() lists every staged version, ascending semver order, current or not', () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.2.0'), { recursive: true });
  mkdirSync(join(releasesDir, 'v0.10.0'), { recursive: true });
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  writeFileSync(join(releasesDir, 'not-a-version.txt'), ''); // should be ignored, not crash

  const manager = createReleaseManager({ releasesDir });
  // Real semver sort, not lexical - "0.10.0" must come after "0.2.0", not before it.
  assert.deepEqual(manager.listStagedVersions(), ['0.1.0', '0.2.0', '0.10.0']);
});

test('listStagedVersions() ignores a directory that looks version-ish but is not valid semver (eg. the old bare-integer scheme)', () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  mkdirSync(join(releasesDir, 'v67'), { recursive: true }); // old scheme - should not resurrect as a "staged version"

  const manager = createReleaseManager({ releasesDir });
  assert.deepEqual(manager.listStagedVersions(), ['0.1.0']);
});

test('activateFromFile() verifies, stages, and activates a tarball already on disk', async () => {
  const releasesDir = tempReleasesDir();
  const sourceDir = mkdtempSync(join(tmpdir(), 'pidvs-source-'));
  writeFileSync(join(sourceDir, 'marker.txt'), 'from BLE push');
  const tarballPath = join(releasesDir, 'incoming.tar.gz');
  execFileSync('tar', ['-czf', tarballPath, '-C', sourceDir, '.']);
  const checksum = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');

  const manager = createReleaseManager({ releasesDir, execFileFn: fakeExecFileWithRealTar(), healthCheckIntervalMs: 5 });
  const result = await manager.activateFromFile(tarballPath, '0.1.6', checksum);

  assert.deepEqual(result, { activated: '0.1.6', rolledBack: false });
  assert.equal(readFileSync(join(releasesDir, 'v0.1.6', 'marker.txt'), 'utf8'), 'from BLE push');
  assert.equal(readlinkSync(join(releasesDir, 'current')), 'v0.1.6');
});

test('activateFromFile() refuses to stage anything if the checksum does not match', async () => {
  const releasesDir = tempReleasesDir();
  const tarballPath = join(releasesDir, 'incoming.tar.gz');
  writeFileSync(tarballPath, 'not actually a valid tarball, and the checksum will not match either way');

  const manager = createReleaseManager({ releasesDir, execFileFn: fakeExecFile() });
  await assert.rejects(() => manager.activateFromFile(tarballPath, '0.1.6', 'wrong-checksum'), /checksum mismatch/);
  assert.equal(existsSync(join(releasesDir, 'v0.1.6')), false);
  assert.equal(manager.currentVersion(), null);
});

test('rollbackTo() refuses a version that is not staged, leaving current pointing where it was - the "v0.1.6" typo that crash-looped the box', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.6'), { recursive: true });
  const execFileFn = fakeExecFile();
  const manager = createReleaseManager({ releasesDir, execFileFn, healthCheckIntervalMs: 5 });
  await manager.activate('0.1.6');

  const restartsBefore = execFileFn.calls.filter((c) => c.includes('restart')).length;
  // The real mistake: a v-prefixed version, which used to resolve to releases/vv0.1.6.
  await assert.rejects(() => manager.rollbackTo('v0.1.6'), /no staged release at .*vv0\.1\.6/);

  assert.equal(readlinkSync(join(releasesDir, 'current')), 'v0.1.6', 'current must be untouched');
  assert.equal(existsSync(join(releasesDir, 'vv0.1.6')), false);
  assert.equal(
    execFileFn.calls.filter((c) => c.includes('restart')).length,
    restartsBefore,
    'must fail before restarting the service, not after taking it down',
  );
});

test('activate() still returns a result, rather than throwing, when the version it would roll back to vanishes mid-activation', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  mkdirSync(join(releasesDir, 'v0.2.0'), { recursive: true });

  const goodManager = createReleaseManager({ releasesDir, execFileFn: fakeExecFile(), healthCheckIntervalMs: 5 });
  await goodManager.activate('0.1.0'); // confirmed-good baseline, so previous resolves to 0.1.0

  // Deletes the fallback DURING activation, after previous has already been read - the only way
  // the rollback path can meet a missing directory (delete it beforehand and `current` is left
  // dangling, which existsSync follows, so currentVersion reads null and this path is never
  // reached at all). Contrived, but it's the branch pointCurrentAt's throw now passes through.
  const unhealthy = fakeExecFile({ healthyAfterRestart: false });
  const execFileFn = async (cmd, args) => {
    if (args.includes('restart')) rmSync(join(releasesDir, 'v0.1.0'), { recursive: true, force: true });
    return unhealthy(cmd, args);
  };

  const manager = createReleaseManager({ releasesDir, execFileFn, healthCheckIntervalMs: 5, healthCheckTimeoutMs: 50 });
  const result = await manager.activate('0.2.0');
  assert.deepEqual(result, { activated: '0.1.0', rolledBack: true, failedVersion: '0.2.0' });
  // The rollback couldn't happen, so current stays on the failed-but-real version - a service on
  // the wrong code still beats a symlink to nothing, which won't start at all.
  assert.equal(readlinkSync(join(releasesDir, 'current')), 'v0.2.0');
  assert.equal(existsSync(join(releasesDir, 'v0.2.0')), true);
});

test('recoverFromUnconfirmedBoot() leaves current alone when last-known-good is no longer on disk, rather than pointing it at nothing', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.1.0'), { recursive: true });
  mkdirSync(join(releasesDir, 'v0.2.0'), { recursive: true });
  const manager = createReleaseManager({ releasesDir, execFileFn: fakeExecFile(), healthCheckIntervalMs: 5 });
  await manager.activate('0.1.0');

  const tmpLink = join(releasesDir, '.current.tmp');
  symlinkSync('v0.2.0', tmpLink);
  renameSync(tmpLink, join(releasesDir, 'current'));
  rmSync(join(releasesDir, 'v0.1.0'), { recursive: true, force: true });

  const result = manager.recoverFromUnconfirmedBoot();
  assert.equal(result.recovered, false);
  assert.match(result.reason, /^baseline-missing:/);
  assert.equal(readlinkSync(join(releasesDir, 'current')), 'v0.2.0');
});

// ---------------------------------------------------------------- xwax ---
// A release carries the audio engine's source and the box compiles it (see buildXwax). These
// cover the two things that must never happen: a failed build reaching a working box, and the
// server and engine ending up on different versions.

/** Fake exec that runs `tar` for real, fakes systemctl, and "builds" xwax by creating the binary `make install` would have produced. */
function fakeExecFileWithBuild({ buildSucceeds = true, healthyAfterRestart = true } = {}) {
  const execFileAsync = promisify(execFile);
  const systemctlFake = fakeExecFile({ healthyAfterRestart });
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tar') return execFileAsync(cmd, args);
    if (cmd === 'nice' || cmd === 'make') {
      if (!buildSucceeds) throw new Error('make: *** [xwax] Error 1');
      const prefix = [cmd, ...args].find((a) => a.startsWith('PREFIX='))?.slice('PREFIX='.length);
      if (args.includes('install') && prefix) {
        mkdirSync(join(prefix, 'bin'), { recursive: true });
        writeFileSync(join(prefix, 'bin', 'xwax'), '#!/bin/sh\n');
      }
      return { stdout: '' };
    }
    if (args.includes('stop')) return { stdout: '' };
    return systemctlFake(cmd, args);
  };
  fn.calls = calls;
  return fn;
}

/** A release tarball shaped like the real one: server files at the root, xwax source under xwax-src/. */
function makeTarball(releasesDir, version, { withXwax = true } = {}) {
  const sourceDir = mkdtempSync(join(tmpdir(), 'pidvs-source-'));
  mkdirSync(join(sourceDir, 'src'), { recursive: true });
  writeFileSync(join(sourceDir, 'src', 'index.js'), 'console.log("server")');
  if (withXwax) {
    mkdirSync(join(sourceDir, 'xwax-src'), { recursive: true });
    writeFileSync(join(sourceDir, 'xwax-src', 'Makefile'), 'all:\n\ttrue\n');
  }
  const tarballPath = join(releasesDir, `pidvs-server-v${version}.tar.gz`);
  execFileSync('tar', ['-czf', tarballPath, '-C', sourceDir, '.']);
  return tarballPath;
}

test('stageRelease() compiles the release\'s own xwax into the release directory', async () => {
  const releasesDir = tempReleasesDir();
  const execFileFn = fakeExecFileWithBuild();
  const manager = createReleaseManager({ releasesDir, execFileFn });

  const versionDir = await manager.stageRelease(makeTarball(releasesDir, '0.3.0'), '0.3.0');

  assert.ok(existsSync(join(versionDir, 'xwax', 'bin', 'xwax')), 'binary should exist in the version dir');
  // PREFIX is the version dir, so EXECDIR (baked into the binary at compile time) cannot point at
  // another release's importer.
  const buildCall = execFileFn.calls.find((c) => c.includes('ALSA=1'));
  assert.ok(buildCall.some((a) => a === `PREFIX=${versionDir}/xwax`), 'PREFIX should be this version dir');
  assert.ok(buildCall.includes('-n') && buildCall.includes('19'), 'build should be nice\'d - a deck may be playing');
});

test('stageRelease() throws when the xwax build fails, leaving current untouched - a broken compile must never reach a working box', async () => {
  const releasesDir = tempReleasesDir();
  mkdirSync(join(releasesDir, 'v0.2.0'), { recursive: true });
  const manager = createReleaseManager({ releasesDir, execFileFn: fakeExecFileWithBuild({ buildSucceeds: false }) });
  symlinkSync('v0.2.0', join(releasesDir, 'current'));

  await assert.rejects(() => manager.stageRelease(makeTarball(releasesDir, '0.3.0'), '0.3.0'));
  assert.equal(manager.currentVersion(), '0.2.0', 'current should still point at the working version');
});

test('activate() moves the xwax symlink with the server, so the box never runs half a release', async () => {
  const releasesDir = tempReleasesDir();
  const xwaxLinkPath = join(tempReleasesDir(), 'bin', 'xwax');
  const manager = createReleaseManager({
    releasesDir, xwaxLinkPath, execFileFn: fakeExecFileWithBuild(),
  });

  await manager.activateFromFile(
    makeTarball(releasesDir, '0.3.0'), '0.3.0',
    createHash('sha256').update(readFileSync(join(releasesDir, 'pidvs-server-v0.3.0.tar.gz'))).digest('hex'),
  );

  assert.equal(manager.currentVersion(), '0.3.0');
  assert.equal(readlinkSync(xwaxLinkPath), join(releasesDir, 'v0.3.0', 'xwax', 'bin', 'xwax'));
});

test('activate() leaves the xwax link alone for a release that carries no engine - what makes rolling back to a pre-xwax release safe', async () => {
  const releasesDir = tempReleasesDir();
  const xwaxLinkPath = join(tempReleasesDir(), 'bin', 'xwax');
  mkdirSync(join(releasesDir, 'v0.3.0', 'xwax', 'bin'), { recursive: true });
  writeFileSync(join(releasesDir, 'v0.3.0', 'xwax', 'bin', 'xwax'), '#!/bin/sh\n');
  const manager = createReleaseManager({ releasesDir, xwaxLinkPath, execFileFn: fakeExecFileWithBuild() });

  await manager.pointXwaxAt('0.3.0');
  assert.equal(readlinkSync(xwaxLinkPath), join(releasesDir, 'v0.3.0', 'xwax', 'bin', 'xwax'));

  // An older release, published before releases carried xwax at all.
  mkdirSync(join(releasesDir, 'v0.2.0'), { recursive: true });
  assert.equal(await manager.pointXwaxAt('0.2.0'), false);
  assert.equal(readlinkSync(xwaxLinkPath), join(releasesDir, 'v0.3.0', 'xwax', 'bin', 'xwax'),
    'a working engine should survive a rollback to a release that has none of its own');
});

test('recoverFromUnconfirmedBoot() takes the engine back with the server after a power loss mid-update', () => {
  const releasesDir = tempReleasesDir();
  const xwaxLinkPath = join(tempReleasesDir(), 'bin', 'xwax');
  for (const v of ['0.3.0', '0.4.0']) {
    mkdirSync(join(releasesDir, `v${v}`, 'xwax', 'bin'), { recursive: true });
    writeFileSync(join(releasesDir, `v${v}`, 'xwax', 'bin', 'xwax'), '#!/bin/sh\n');
  }
  const manager = createReleaseManager({ releasesDir, xwaxLinkPath, execFileFn: fakeExecFileWithBuild() });

  // current flipped to 0.4.0, then the power went before the health check confirmed it.
  symlinkSync('v0.4.0', join(releasesDir, 'current'));
  writeFileSync(join(releasesDir, 'last-known-good'), '0.3.0');
  mkdirSync(join(xwaxLinkPath, '..'), { recursive: true });
  symlinkSync(join(releasesDir, 'v0.4.0', 'xwax', 'bin', 'xwax'), xwaxLinkPath);

  const result = manager.recoverFromUnconfirmedBoot();

  assert.equal(result.recovered, true);
  assert.equal(manager.currentVersion(), '0.3.0');
  assert.equal(readlinkSync(xwaxLinkPath), join(releasesDir, 'v0.3.0', 'xwax', 'bin', 'xwax'),
    'engine must go back with the server, not stay on the unconfirmed version');
});
