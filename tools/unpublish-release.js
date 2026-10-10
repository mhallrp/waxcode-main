#!/usr/bin/env node
import { put, get, del, list } from '@vercel/blob';
import { highestVersion, isValidVersion } from '../updater/semver.js';

// Removes one already-published release from the update feed - the counterpart to
// package-release.js, for a version that shipped and then got pulled (see DEVLOG 2026-08-19:
// v0.1.7's progressive waveform loading was reverted on visual grounds after publishing).
// Same BLOB_READ_WRITE_TOKEN as package-release.js.
//
// Deliberately updates the MANIFEST FIRST, then deletes the tarball. That order matters: dying
// in between leaves an orphaned tarball nothing references (harmless, deletable later), whereas
// the reverse order leaves the manifest advertising a file that no longer exists - which a box
// would accept as an update and then fail to download. Never leave the feed pointing at
// something that isn't there.
//
// Usage: node tools/unpublish-release.js <version>   (bare version, eg. 0.1.7 - not v0.1.7)
const version = process.argv[2];

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN is not set - grab it from the Vercel dashboard's Storage tab (waxcode-web project) and export it before running this.");
  process.exit(1);
}
if (!version || !isValidVersion(version)) {
  console.error(`Usage: node tools/unpublish-release.js <version>\nExpected a bare MAJOR.MINOR.PATCH version (eg. 0.1.7), got "${version ?? '(nothing)'}".`);
  process.exit(1);
}

const manifestBlob = await get('manifest.json', { access: 'private' });
if (!manifestBlob) {
  console.error('No manifest published yet - nothing to unpublish.');
  process.exit(1);
}
const manifest = await new Response(manifestBlob.stream).json();

const entry = manifest.releases[version];
if (!entry) {
  console.error(`v${version} isn't in the manifest (published: ${Object.keys(manifest.releases).join(', ') || '(none)'}).`);
  process.exit(1);
}

const remaining = Object.keys(manifest.releases).filter((v) => v !== version);
if (remaining.length === 0) {
  console.error(`v${version} is the only published release - refusing to leave the feed with no releases at all.`);
  process.exit(1);
}

delete manifest.releases[version];
const previousLatest = manifest.latest;
// Only recompute `latest` if the version being pulled WAS latest - unpublishing some older
// release shouldn't quietly move what everyone's being offered.
if (previousLatest === version) manifest.latest = highestVersion(remaining);

console.log(`Removing v${version} from the manifest (latest: ${previousLatest} -> ${manifest.latest})...`);
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

// Resolve the real blob URL via list() rather than assuming one - del() takes a URL, and the
// store is private, so the pathname alone isn't enough to address it.
const { blobs } = await list();
const tarball = blobs.find((b) => b.pathname === entry.file);
if (tarball) {
  console.log(`Deleting ${entry.file}...`);
  await del(tarball.url);
} else {
  console.log(`(${entry.file} wasn't in the store - manifest entry removed anyway.)`);
}

console.log(`Unpublished v${version}. The update feed now offers v${manifest.latest}.`);
