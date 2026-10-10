#!/usr/bin/env node
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReleaseManager } from './release-manager.js';

// Phase 1 (owner's call, 2026-07-29): triggered manually over SSH for now
const UPDATE_SERVER_URL = process.env.PIDVS_UPDATE_SERVER ?? 'http://localhost:8081';
const UPDATE_SERVER_TOKEN = process.env.PIDVS_UPDATE_TOKEN;

const manager = createReleaseManager();

async function cmdCheck() {
  const manifest = await manager.fetchManifest(UPDATE_SERVER_URL, { authToken: UPDATE_SERVER_TOKEN });
  const current = manager.currentVersion();
  console.log(`Current version: ${current ?? '(none)'}`);
  console.log(`Latest available: ${manifest.latest}`);
  console.log(current === manifest.latest ? 'Already up to date.' : `Update available: v${current ?? '(none)'} -> v${manifest.latest}`);
}

async function cmdUpdate() {
  const manifest = await manager.fetchManifest(UPDATE_SERVER_URL, { authToken: UPDATE_SERVER_TOKEN });
  const release = manifest.releases[manifest.latest];
  if (!release) throw new Error(`manifest has no entry for its own latest version (${manifest.latest})`);

  if (manager.currentVersion() === manifest.latest) {
    console.log(`Already on v${manifest.latest} - nothing to do.`);
    return;
  }

  // basename: release.file comes from the update feed, and a path in it would otherwise choose
  // where on the box this writes.
  const tarballPath = join(tmpdir(), basename(release.file));
  console.log(`Downloading ${release.file}...`);
  await manager.downloadRelease(`${UPDATE_SERVER_URL}/api/updates/${release.file}`, tarballPath, { authToken: UPDATE_SERVER_TOKEN });

  console.log('Verifying checksum...');
  if (!manager.verifyChecksum(tarballPath, release.checksum)) {
    throw new Error('checksum mismatch - download may be corrupt or tampered with, aborting without staging it');
  }

  // Locked from staging through activation
  const result = await manager.withUpdateLock(async () => {
    console.log(`Staging v${manifest.latest}...`);
    await manager.stageRelease(tarballPath, manifest.latest);
    console.log('Activating (will auto-rollback if the new version fails its health check)...');
    return manager.activate(manifest.latest);
  });
  if (result.rolledBack) {
    console.error(`v${result.failedVersion} did not become healthy - rolled back to v${result.activated ?? '(none)'}`);
    process.exitCode = 1;
  } else {
    console.log(`Now running v${result.activated}.`);
  }
}

async function cmdRollback(explicitVersion) {
  const staged = manager.listStagedVersions();
  const current = manager.currentVersion();
  const target = explicitVersion ?? [...staged].reverse().find((v) => v !== current);
  if (!target) throw new Error(`no other staged version to roll back to (staged: ${staged.join(', ') || '(none)'})`);

  // Wants a BARE version ("0.1.6"), not a v-prefixed one
  if (explicitVersion && !staged.includes(explicitVersion)) {
    const hint = /^v/.test(explicitVersion) ? ` - this wants a bare version, drop the "v" and pass "${explicitVersion.slice(1)}"` : '';
    throw new Error(`"${explicitVersion}" isn't staged on this box${hint} (staged: ${staged.join(', ') || '(none)'})`);
  }

  console.log(`Rolling back to v${target}...`);
  const result = await manager.withUpdateLock(() => manager.rollbackTo(target));
  if (result.healthy) {
    console.log(`Now running v${target}.`);
  } else {
    console.error(`WARNING: v${target} did not report healthy after restart - it's active, but may not actually be working.`);
    process.exitCode = 1;
  }
}

function cmdStatus() {
  console.log(`Current version: ${manager.currentVersion() ?? '(none)'}`);
  console.log(`Staged versions: ${manager.listStagedVersions().join(', ') || '(none)'}`);
}

/** Prints ONLY the bare current version, or "none" - for a caller shelling out to it. */
function cmdCurrentVersion() {
  console.log(manager.currentVersion() ?? 'none');
}

/** Prints every staged version as a comma-separated list (or the literal string "none"). */
function cmdStagedVersions() {
  const staged = manager.listStagedVersions();
  console.log(staged.length ? staged.join(',') : 'none');
}

/** Verifies, stages, and activates a tarball ALREADY on disk */
async function cmdActivateFile(version, tarballPath, checksum) {
  if (!version || !tarballPath || !checksum) {
    throw new Error('usage: cli.js activate-file <version> <tarballPath> <checksum>');
  }
  // Same lock as cmdUpdate/cmdRollback below
  const result = await manager.withUpdateLock(() => manager.activateFromFile(tarballPath, version, checksum));
  console.log(JSON.stringify(result));
  if (result.rolledBack) process.exitCode = 1;
}

/** Run once per real boot by pi/pidvs-boot-recovery.service, ordered before pidvs-server.service ever starts */
function cmdRecoverBoot() {
  try {
    const result = manager.recoverFromUnconfirmedBoot();
    if (result.recovered) {
      console.log(`[recover-boot] v${result.from ?? '(none)'} was never confirmed healthy - reverted to last known good v${result.to}`);
    } else {
      console.log(`[recover-boot] nothing to recover (${result.reason})`);
    }
  } catch (err) {
    console.log(`[recover-boot] check itself failed, leaving current as-is: ${err.message}`);
  }
}

const [, , command, ...args] = process.argv;

try {
  switch (command) {
    case 'check': await cmdCheck(); break;
    case 'update': await cmdUpdate(); break;
    case 'rollback': await cmdRollback(args[0]); break;
    case 'status': cmdStatus(); break;
    case 'activate-file': await cmdActivateFile(args[0], args[1], args[2]); break;
    case 'current-version': cmdCurrentVersion(); break;
    case 'staged-versions': cmdStagedVersions(); break;
    case 'recover-boot': cmdRecoverBoot(); break;
    default:
      console.error('Usage: cli.js <check|update|rollback [version]|status|activate-file <version> <path> <checksum>|current-version|staged-versions|recover-boot>');
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
