#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { put, get } from '@vercel/blob';
import { bumpVersion, isValidVersion } from '../updater/semver.js';

// Publishes one versioned release: builds a tarball from server/, then uploads both it and an
// updated manifest.json to Vercel Blob - the real public update server (see waxcode-web's
// app/api/updates/ routes, which proxy reads from this same Blob store, gated by a bearer
// token the app carries). Talks to Blob DIRECTLY via the SDK here - needs BLOB_READ_WRITE_TOKEN
// in the environment (Vercel dashboard -> waxcode-web project -> Storage tab), NOT the app's
// bearer token, which is a separate, unrelated credential for the read-only public API.
//
// Replaced the old bare-incrementing-integer scheme (v1, v2, ... v67 - one per dev-test run,
// see DEVLOG) with real semver: this now takes an explicit bump type, so a version number
// means something instead of being a side effect of how many times this got run.
//
// Usage: node tools/package-release.js [major|minor|patch]   (defaults to patch)
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SERVER_DIR = join(ROOT, 'server');
// The xwax fork, a sibling checkout - see provision.sh, which resolves it the same way.
const XWAX_DIR = process.env.XWAX_SRC ?? join(ROOT, '..', 'xwax');

// Either a bump type, or an explicit MAJOR.MINOR.PATCH.
//
// Explicit versions exist because the box's own release directory and this published feed drift
// apart on purpose: versions built and activated over SSH never get published, so the feed's idea
// of "latest" can sit several behind what the box is actually running. A bump then produces a
// number that is already taken on the box by entirely different code - which happened on
// 2026-08-23, publishing today's server as v0.1.11 when the box had run a different v0.1.11 for
// hours. Naming the version explicitly is the way out of that, so the tool has to allow it.
// --min-app <version> marks a release as needing at least that app version. Use it ONLY when a
// release genuinely cannot work with older apps - the protocol is additive and an old app normally
// just ignores what it does not recognise. The app refuses to INSTALL a release it is too old for
// (see ios UpdateView), which is what stops a box ever getting ahead of the app that has to talk to
// it. Gating the update rather than the connection keeps this to one field instead of a
// compatibility matrix.
const args = process.argv.slice(2).filter((a) => a !== '--min-app');
const minAppIndex = process.argv.indexOf('--min-app');
const minimumAppVersion = minAppIndex === -1 ? null : process.argv[minAppIndex + 1];
if (minAppIndex !== -1 && !isValidVersion(minimumAppVersion ?? '')) {
  console.error(`--min-app needs a version like 1.4.0 - got "${minimumAppVersion ?? '(nothing)'}".`);
  process.exit(1);
}

const requested = args.filter((a) => a !== minimumAppVersion)[0] ?? 'patch';
const isBumpType = ['major', 'minor', 'patch'].includes(requested);
if (!isBumpType && !isValidVersion(requested)) {
  console.error(`Expected "major", "minor", "patch", or an explicit version like 0.1.15 - got "${requested}".`);
  process.exit(1);
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set - grab it from the Vercel dashboard's Storage tab (waxcode-web project) and export it before running this.");
  process.exit(1);
}

async function loadManifest() {
  // get(), not list()+fetch(blob.url) - the store is private (2026-08-18), so a bare-URL fetch
  // gets rejected outright even though list() still happily returns one. This is the same bug
  // already fixed in waxcode-web's own manifest/[file] routes; it just hadn't been fixed here
  // too, so this only ever worked for the very first publish (nothing to read yet, so this path
  // was never actually exercised) - every publish attempt since would have failed right here,
  // before ever uploading anything.
  const manifestBlob = await get('manifest.json', { access: 'private' });
  if (!manifestBlob) return { latest: null, releases: {} };
  return new Response(manifestBlob.stream).json();
}

const manifest = await loadManifest();
const version = isBumpType ? bumpVersion(manifest.latest, requested) : requested;

// Refuse to overwrite a published version rather than silently replacing what someone may already
// have installed.
if (manifest.releases?.[version]) {
  console.error(`v${version} is already published. Unpublish it first, or pick another version.`);
  process.exit(1);
}
const fileName = `pidvs-server-v${version}.tar.gz`;
const tarballPath = join(mkdtempSync(join(tmpdir(), 'pidvs-release-')), fileName);

console.log(`Packaging server/ + xwax/ as v${version} (${isBumpType ? `${requested} bump from v${manifest.latest ?? '(none)'}` : 'explicit version'})...`);

// Staged in a temp dir rather than tarred straight from server/, because a release now carries
// two things: the Node server AND the xwax source.
//
// Server files stay at the ROOT of the tarball, exactly where they have always been. That is what
// keeps an older box able to install a newer release - its updater extracts everything, finds
// src/index.js where it expects, and simply ignores the xwax-src/ directory it knows nothing
// about. Moving the server under a server/ prefix would have been tidier and would have broken
// every box in the field.
// The UI bundle under server/web/ is committed, so it can fall behind the source it came from -
// and a release would then ship an old UI against a new server. Checked here rather than trusted.
try {
  execFileSync('./scripts/check-bundle-fresh.sh', { cwd: join(ROOT, 'web'), stdio: 'pipe' });
} catch (err) {
  console.error('server/web/ does not match web/src - rebuild and commit it before publishing.');
  console.error(String(err.stdout ?? '') + String(err.stderr ?? ''));
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), 'pidvs-stage-'));

// --exclude=./data - the box's own persisted runtime state (box name, favourites, deck
// settings) has no business shipping inside a release tarball built on a dev machine - see
// updater/release-manager.js's stageRelease() doc comment for the real bug this avoided.
// node_modules is deliberately NOT excluded: the box never runs npm install, so a release's
// dependencies reach it only by riding along inside the tarball. Leaving it out produces a release
// that stages cleanly and then fails to start.
// .DS_Store excluded too: macOS scatters them through any directory Finder has opened, and they
// were shipping inside releases to every box (spotted in v0.6.1). Harmless, but it is junk on
// someone else's hardware.
cpSync(SERVER_DIR, stage, {
  recursive: true,
  filter: (src) => !/(^|\/)data$/.test(src) && !src.endsWith('/.DS_Store'),
});

// `git archive`, not a copy: it takes the COMMITTED tree, so a release can never contain a
// half-finished local edit, and the tarball has no .o files or stale binary in it. It also means
// the published version corresponds to a real commit somebody can check out.
if (!existsSync(XWAX_DIR)) {
  console.error(`No xwax checkout at ${XWAX_DIR} - set XWAX_SRC, or clone the fork alongside this repo.`);
  process.exit(1);
}
const xwaxDirty = execFileSync('git', ['-C', XWAX_DIR, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
if (xwaxDirty) {
  console.error(`xwax has uncommitted changes - commit them first, or the release will not match the source it claims to be:\n${xwaxDirty}`);
  process.exit(1);
}
const xwaxRev = execFileSync('git', ['-C', XWAX_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
// The beat-tracking helper's source rides along too, and is compiled on the box like xwax - see
// release-manager.js's buildHelpers(). Vendored qm-dsp, so it comes from this repo, not a sibling.
const QMTEMPO_DIR = join(ROOT, 'qmtempo');
if (existsSync(QMTEMPO_DIR)) {
  // Filtered on the path RELATIVE to the source root, not the absolute one. The root is itself
  // named qmtempo/, so an absolute `endsWith('/qmtempo')` test excludes the very directory being
  // copied and silently produces an empty release - which is exactly what shipped in v0.5.0.
  cpSync(QMTEMPO_DIR, join(stage, 'qmtempo-src'), {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(QMTEMPO_DIR.length);
      return rel !== '/qmtempo' && !rel.split('/').includes('.build');
    },
  });
}

const xwaxStage = join(stage, 'xwax-src');
mkdirSync(xwaxStage, { recursive: true });
execFileSync('sh', ['-c', `git -C '${XWAX_DIR}' archive --format=tar HEAD | tar -xf - -C '${xwaxStage}'`], { stdio: 'inherit' });
// Recorded so a box (and anyone reading a bug report from one) can say exactly which xwax commit
// it is running, without needing the fork checked out to work it out.
writeFileSync(join(xwaxStage, 'REVISION'), `${xwaxRev}\n`);
console.log(`  xwax @ ${xwaxRev.slice(0, 7)}`);

// Stamp the version into the STAGED package.json before tarring.
//
// This used to happen only to the repo's own copy, and only after the tarball had already been
// built - so every release ever published carried the PREVIOUS version inside it (checked on a
// real box 2026-09-15: v0.3.0 said 0.2.1, v0.2.0 and v0.1.17 both still said 0.1.0). Nothing
// load-bearing read it, because the box reports its version from the `current` symlink, but it is
// exactly the sort of quietly-wrong number that cost a day when provision.sh started trusting it.
const stagedPkgPath = join(stage, 'package.json');
const stagedPkg = JSON.parse(readFileSync(stagedPkgPath, 'utf8'));
stagedPkg.version = version;
writeFileSync(stagedPkgPath, JSON.stringify(stagedPkg, null, 2) + '\n');

/*
 * --no-mac-metadata when packaging on macOS.
 *
 * macOS tar stores extended attributes as PAX headers, and GNU tar on the Pi writes those back out
 * as AppleDouble `._name` files beside every real source. macOS `tar -t` folds them away again, so
 * the archive looks clean from here and only misbehaves on the box - which is how v0.5.1 shipped a
 * helper whose build then failed on the Pi. Unsupported elsewhere, hence the platform check.
 */
const tarFlags = process.platform === 'darwin' ? ['--no-mac-metadata'] : [];
execFileSync('tar', [...tarFlags, '-czf', tarballPath, '-C', stage, '.'], { stdio: 'inherit' });

const tarballBuffer = readFileSync(tarballPath);
const checksum = createHash('sha256').update(tarballBuffer).digest('hex');

console.log(`Uploading ${fileName} (${(tarballBuffer.length / 1024 / 1024).toFixed(1)} MB)...`);
// allowOverwrite: true - safe to retry after a failed run (eg. the tarball uploaded but the
// manifest update below didn't) without needing a fresh version number for the retry itself.
// access: 'private', not 'public' - a public blob's URL has no auth of its own once known, which
// is exactly the leak waxcode-web's app/api/updates/ routes were already designed to guard
// against by proxying reads instead of exposing raw Blob URLs to the client (see those routes'
// own comments). Private makes that the actual storage-level default too, not just an app-layer
// convention - also just required outright: confirmed on real hardware (2026-08-18) that a store
// created under Vercel's current default is private, and a public put() against it is rejected.
await put(fileName, tarballBuffer, { access: 'private', addRandomSuffix: false, allowOverwrite: true });

manifest.releases[version] = {
  file: fileName,
  checksum,
  createdAt: new Date().toISOString(),
  // Omitted entirely unless asked for, so the manifest stays quiet about the common case.
  ...(minimumAppVersion ? { minimumAppVersion } : {}),
};
if (minimumAppVersion) console.log(`  requires app >= ${minimumAppVersion}`);
manifest.latest = version;

console.log('Updating manifest...');
await put('manifest.json', JSON.stringify(manifest, null, 2), {
  access: 'private',
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: 'application/json',
  // The manifest is mutable state read back before every publish, so it must not be cached.
  // Blob's default TTL is long, and get() served a stale copy for hours: a publish then read a
  // manifest still listing a release that had been unpublished, and wrote it straight back.
  // Observed twice on 2026-08-23 - v0.1.7 reappeared after being deleted, and v0.1.11 came back
  // as a dangling entry pointing at a tarball that no longer existed.
  cacheControlMaxAge: 0,
});

// Write the published version back into server/package.json.
//
// provision.sh stamps a freshly built box with whatever this file says. Left un-bumped it said
// 0.1.0 from the server's very first commit, so every new card claimed to be older than anything
// published and the app immediately offered an "update" - which on 2026-09-14 installed the
// published 0.1.17 over a card carrying far newer code, moving the number forwards and the
// behaviour back three weeks. The version had no relationship to what was in the tree.
//
// Keeping it in step here is what makes provision.sh's default correct by construction: a card
// built from this repo now claims exactly the version last published from it.
//
// COMMIT THIS - the number is only true once it is in the tree.
const pkgPath = join(SERVER_DIR, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Set server/package.json to ${version} - commit it.`);
}

console.log(`Published v${version} (${fileName}, sha256:${checksum.slice(0, 12)}...)`);
