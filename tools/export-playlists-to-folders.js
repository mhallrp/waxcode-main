#!/usr/bin/env node
//
// export-playlists-to-folders.js - copies every local Apple Music
// playlist into its own folder of the actual audio files, ready to
// drop onto a Pi DVS USB stick (the box just walks whatever folder
// structure it finds - see server/src/library-scan.js).
//
// Usage:
//   node tools/export-playlists-to-folders.js <destination-folder>
//
// The actual playlist/track data comes from Music.app's own scripting
// bridge (see query-music-playlists.jxa.js) - never the app's internal
// database file directly.
//
// Physically copies every track into each playlist's folder, even if a
// track appears in more than one - exFAT (the format a Pi DVS stick
// should be) doesn't support symlinks, so there's no way to avoid that
// duplication if the destination is headed straight onto a stick.
// Cloud-only Apple Music tracks that haven't been downloaded locally
// have no file to copy and are skipped.
//
// Safe to re-run: existing files are just overwritten with the same
// content, and mkdir is idempotent.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const destRoot = process.argv[2];
if (!destRoot) {
    console.error('Usage: node export-playlists-to-folders.js <destination-folder>');
    process.exit(1);
}

const queryScript = join(__dirname, 'query-music-playlists.jxa.js');
const output = execFileSync('osascript', ['-l', 'JavaScript', queryScript], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
});
const playlists = JSON.parse(output);

mkdirSync(destRoot, { recursive: true });

let playlistCount = 0;
let copiedCount = 0;
let skippedCount = 0;

for (const playlist of playlists) {
    const safeName = sanitizeFolderName(playlist.name);
    const playlistDir = join(destRoot, safeName);
    mkdirSync(playlistDir, { recursive: true });

    for (const sourcePath of playlist.paths) {
        const destPath = join(playlistDir, basename(sourcePath));
        try {
            copyFileSync(sourcePath, destPath);
            copiedCount++;
        } catch (err) {
            console.error(`Skipping ${sourcePath}: ${err.message}`);
            skippedCount++;
        }
    }

    playlistCount++;
}

console.log(`Copied ${copiedCount} tracks across ${playlistCount} playlists to ${destRoot}`);
if (skippedCount > 0) {
    console.log(`Skipped ${skippedCount} tracks that couldn't be copied`);
}

function sanitizeFolderName(name) {
    // Strips characters that are unsafe/reserved on the exFAT/FAT32
    // destination this is ultimately headed for.
    return name.replace(/[/\\:*?"<>|]/g, '_').trim();
}
