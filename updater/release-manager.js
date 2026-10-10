import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  symlinkSync, renameSync, unlinkSync, readlinkSync, rmSync, readdirSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { isValidVersion, compareVersions } from './semver.js';

const execFileAsync = promisify(execFile);

// Absolute paths, not bare commands - same reasoning as server/src/xwax-lifecycle.js's own SYSTEMCTL_PATH: sudoers command matching
const SYSTEMCTL_PATH = '/usr/bin/systemctl';
const SUDO_PATH = '/usr/bin/sudo';

/** Deliberately lives in its own directory (updater/), entirely separate from server/ */
function defaultReleasesDir() {
  return join(process.env.PIDVS_HOME || homedir(), 'releases');
}

export function createReleaseManager({
  releasesDir = defaultReleasesDir(),
  // Deliberately separate from `current` - `current` is flipped optimistically, BEFORE the new version has proven itself
  lastKnownGoodPath = join(releasesDir, 'last-known-good'),
  // Coordinates the two entirely separate processes that can both stage/activate a release: the app-driven flow (the app
  updateLockPath = join(releasesDir, '.update-lock'),
  // How old a lock file must be before a new caller may treat it as abandoned.
  staleLockMs = 5 * 60 * 1000,
  // A sibling of releasesDir by default, OUTSIDE every versioned release directory
  sharedDataDir = join(dirname(releasesDir), 'data'),
  serviceName = 'pidvs-server.service',
  // Where xwax@N.service's ExecStart points.
  xwaxLinkPath = join(homedir(), 'bin', 'xwax'),
  // Decks to bounce after the engine changes underneath them.
  deckNumbers = [1, 2],
  execFileFn = execFileAsync,
  fetchFn = fetch,
  healthCheckTimeoutMs = 5000,
  healthCheckIntervalMs = 300,
} = {}) {
  /** The bare version string ("7", not "v7") currently live, or null if `current` doesn't exist yet (eg. before the very first activate). */
  function currentVersion() {
    const linkPath = join(releasesDir, 'current');
    if (!existsSync(linkPath)) return null;
    return readlinkSync(linkPath).replace(/^v/, '');
  }

  /** Every version currently staged on disk (bare strings, eg. "0.1.0"), ascending semver order. Includes the active one. */
  function listStagedVersions() {
    if (!existsSync(releasesDir)) return [];
    return readdirSync(releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('v') && isValidVersion(entry.name.slice(1)))
      .map((entry) => entry.name.slice(1))
      .sort(compareVersions);
  }

  // `/api/updates/...` matches waxcode-web's Next.js route handlers
  async function fetchManifest(updateServerUrl, { authToken } = {}) {
    const res = await fetchFn(`${updateServerUrl}/api/updates/manifest`, authHeaders(authToken));
    if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
    return res.json();
  }

  /** Downloads the whole release body into memory before writing - release tarballs are small enough (a few MB at most) that streaming isn't worth the complexity yet. */
  async function downloadRelease(url, destPath, { authToken } = {}) {
    const res = await fetchFn(url, authHeaders(authToken));
    if (!res.ok) throw new Error(`release download failed: HTTP ${res.status}`);
    writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
  }

  function verifyChecksum(filePath, expectedSha256) {
    const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    return actual === expectedSha256;
  }

  /** Extracts `tarballPath` into releasesDir/v<version>/ */
  async function stageRelease(tarballPath, version) {
    // Validated BEFORE it reaches a path: this version comes from the update feed's manifest or
    // from argv, and `v../../..` resolves to the box user's home, which the rmSync below would
    // then delete entirely.
    if (!isValidVersion(version)) throw new Error(`refusing to stage a malformed version: ${version}`);
    const versionDir = join(releasesDir, `v${version}`);
    if (existsSync(versionDir)) rmSync(versionDir, { recursive: true, force: true });
    mkdirSync(versionDir, { recursive: true });
    await execFileFn('tar', ['-xzf', tarballPath, '-C', versionDir]);

    mkdirSync(sharedDataDir, { recursive: true });
    const dataLinkPath = join(versionDir, 'data');
    if (existsSync(dataLinkPath)) rmSync(dataLinkPath, { recursive: true, force: true });
    symlinkSync(sharedDataDir, dataLinkPath);

    await buildXwax(versionDir);
    await buildQmtempo(versionDir);

    return versionDir;
  }

  /** Compile the release's beat-tracking helper, into the release's own directory. */
  async function buildQmtempo(versionDir) {
    const srcDir = join(versionDir, 'qmtempo-src');
    if (!existsSync(srcDir)) return null;

    try {
      await execFileFn('nice', ['-n', '19', 'make', '-C', srcDir, `PREFIX=${versionDir}/qmtempo`]);
      await execFileFn('make', ['-C', srcDir, `PREFIX=${versionDir}/qmtempo`, 'install']);
    } catch {
      return null;
    }

    const binary = join(versionDir, 'qmtempo', 'bin', 'qmtempo');
    return existsSync(binary) ? binary : null;
  }

  /** Compile the release's own xwax, into the release's own directory. */
  async function buildXwax(versionDir) {
    const srcDir = join(versionDir, 'xwax-src');
    if (!existsSync(srcDir)) return null;

    await execFileFn('nice', ['-n', '19', 'make', '-j4', 'ALSA=1', `PREFIX=${versionDir}/xwax`, '-C', srcDir]);
    await execFileFn('make', ['install', 'ALSA=1', `PREFIX=${versionDir}/xwax`, '-C', srcDir]);

    const binary = join(versionDir, 'xwax', 'bin', 'xwax');
    if (!existsSync(binary)) throw new Error(`xwax build reported success but produced no binary at ${binary}`);
    return binary;
  }

  /** Point the xwax symlink at a staged version's binary, write-temp-then-rename like pointCurrentAt, then bounce the decks so they exec it. */
  function linkXwaxTo(version) {
    const binary = join(releasesDir, `v${version}`, 'xwax', 'bin', 'xwax');
    if (!existsSync(binary)) return false;

    mkdirSync(dirname(xwaxLinkPath), { recursive: true });
    const tmpLink = `${xwaxLinkPath}.tmp`;
    if (existsSync(tmpLink)) unlinkSync(tmpLink);
    symlinkSync(binary, tmpLink);
    renameSync(tmpLink, xwaxLinkPath);
    return true;
  }

  async function pointXwaxAt(version) {
    if (!linkXwaxTo(version)) return false;

    for (const deck of deckNumbers) {
      // stop, not restart: the sudoers rule grants exactly that verb for xwax@*.service, and the
      // server starts decks on demand.
      try {
        await execFileFn(SUDO_PATH, [SYSTEMCTL_PATH, 'stop', `xwax@${deck}.service`]);
      } catch {
        // Already stopped is the normal case - decks are started on demand by the server.
      }
    }
    return true;
  }

  /** Write-temp-then-rename, same pattern as this file's own doc comment describes */
  function pointCurrentAt(version) {
    const versionDir = join(releasesDir, `v${version}`);
    if (!existsSync(versionDir)) {
      throw new Error(`no staged release at ${versionDir} - refusing to point current at a version that isn't on disk (staged: ${listStagedVersions().join(', ') || '(none)'})`);
    }
    const tmpLink = join(releasesDir, '.current.tmp');
    if (existsSync(tmpLink)) unlinkSync(tmpLink);
    symlinkSync(`v${version}`, tmpLink);
    renameSync(tmpLink, join(releasesDir, 'current'));
  }

  /** The bare version string last confirmed healthy, or null if none has ever been recorded (a fresh box, or one from before this existed). */
  function readLastKnownGood() {
    if (!existsSync(lastKnownGoodPath)) return null;
    return readFileSync(lastKnownGoodPath, 'utf8').trim() || null;
  }

  /** Write-temp-then-rename, same reasoning as pointCurrentAt - a torn write here would be just as capable of leaving this file in a confusing state on the next crash as an untorn symlink write would. */
  function writeLastKnownGood(version) {
    const tmpPath = `${lastKnownGoodPath}.tmp`;
    writeFileSync(tmpPath, version);
    renameSync(tmpPath, lastKnownGoodPath);
  }

  /** Throws if an update/rollback is already in progress (see withUpdateLock below for what this protects against) */
  function acquireLock() {
    try {
      writeFileSync(updateLockPath, String(process.pid), { flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const age = Date.now() - statSync(updateLockPath).mtimeMs;
      if (age < staleLockMs) {
        throw new Error('an update or rollback is already in progress');
      }
      unlinkSync(updateLockPath);
      writeFileSync(updateLockPath, String(process.pid), { flag: 'wx' });
    }
  }

  function releaseLock() {
    try {
      unlinkSync(updateLockPath);
    } catch {
      // Already gone, so there is nothing to clean up.
    }
  }

  /** Runs `fn` with the update lock held, releasing it whether `fn` succeeds or throws. */
  async function withUpdateLock(fn) {
    acquireLock();
    try {
      return await fn();
    } finally {
      releaseLock();
    }
  }

  async function restartService() {
    await execFileFn(SUDO_PATH, [SYSTEMCTL_PATH, 'restart', serviceName]);
  }

  async function isServiceHealthy() {
    try {
      const { stdout } = await execFileFn(SYSTEMCTL_PATH, ['is-active', serviceName]);
      return stdout.trim() === 'active';
    } catch {
      // `systemctl is-active` exits non-zero for any state other than "active".
      return false;
    }
  }

  async function waitForHealthy() {
    const deadline = Date.now() + healthCheckTimeoutMs;
    while (Date.now() < deadline) {
      if (await isServiceHealthy()) return true;
      await new Promise((resolve) => setTimeout(resolve, healthCheckIntervalMs));
    }
    return false;
  }

  /** Activates an already-staged `version` (see stageRelease) */
  async function activate(version) {
    const previous = currentVersion();
    pointCurrentAt(version);
    // The audio engine moves with the server, not separately.
    await pointXwaxAt(version);

    let healthy = false;
    try {
      await restartService();
      healthy = await waitForHealthy();
    } catch {
      healthy = false;
    }
    if (healthy) {
      writeLastKnownGood(version);
      return { activated: version, rolledBack: false };
    }

    if (previous) {
      try {
        pointCurrentAt(previous);
        await pointXwaxAt(previous);
        await restartService();
      } catch {
        // Best-effort - if even the previous, known-good version now fails to restart (or has vanished from disk entirely
      }
    } else {
      // No known-good version to fall back to (this was the very first activation ever)
      const currentLink = join(releasesDir, 'current');
      if (existsSync(currentLink)) unlinkSync(currentLink);
    }
    return { activated: previous, rolledBack: true, failedVersion: version };
  }

  /** Manual rollback to a specific already-staged version - no automatic re-rollback if THIS also turns out unhealthy, unlike activate; the caller asked for this version explicitly. */
  async function rollbackTo(version) {
    pointCurrentAt(version);
    await pointXwaxAt(version);
    await restartService();
    const healthy = await waitForHealthy();
    // A healthy manual rollback becomes the new baseline too
    if (healthy) writeLastKnownGood(version);
    return { activated: version, healthy };
  }

  /** Closes the one gap activate's own in-process health-check/rollback can't cover: a power loss between pointCurrentAt flipping `current` */
  function recoverFromUnconfirmedBoot() {
    const lastKnownGood = readLastKnownGood();
    if (lastKnownGood === null) return { recovered: false, reason: 'no-baseline' };
    if (currentVersion() === lastKnownGood) return { recovered: false, reason: 'confirmed' };

    const from = currentVersion();
    try {
      pointCurrentAt(lastKnownGood);
      // The engine goes back with the server - a power loss between the `current` flip and the health check would otherwise leave the box booting
      linkXwaxTo(lastKnownGood);
    } catch (err) {
      // The recorded good version is gone from disk
      return { recovered: false, reason: `baseline-missing: ${err.message}` };
    }
    return { recovered: true, from, to: lastKnownGood };
  }

  /** Verifies, stages, and activates a release from a tarball already sitting on disk */
  async function activateFromFile(tarballPath, version, expectedChecksum) {
    if (!verifyChecksum(tarballPath, expectedChecksum)) {
      throw new Error('checksum mismatch - refusing to stage a possibly-corrupt or tampered-with package');
    }
    await stageRelease(tarballPath, version);
    return activate(version);
  }

  return {
    currentVersion,
    listStagedVersions,
    fetchManifest,
    downloadRelease,
    verifyChecksum,
    stageRelease,
    buildXwax,
    buildQmtempo,
    pointXwaxAt,
    activate,
    rollbackTo,
    activateFromFile,
    isServiceHealthy,
    readLastKnownGood,
    recoverFromUnconfirmedBoot,
    withUpdateLock,
  };
}

/** {} when no token is given, so a caller pointed at a still-unauthenticated local dev server (eg. the default localhost:8081) doesn't need to pass anything. */
function authHeaders(authToken) {
  return authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {};
}
