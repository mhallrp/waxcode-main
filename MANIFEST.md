# USB library manifest

What the box reads off a stick instead of re-reading every tag, and writes back after a scan that
learned something. One file, one schema, whether a stick was organised deliberately or not at all.

Lives at **`.waxcode/library.json`** on the stick root.

## Why it exists

Two independent wins, either of which would justify it on its own:

1. **The Pi stops reading tags.** `parseFile()` per track is the heaviest CPU work the box
   ever does, it runs at USB insert-time, and it's what caused the 2026-08-19 waveform-jitter
   incident that `library-scan.js` now yields and priority-defers around. A
   manifest carrying the tags turns a multi-minute contended scan into one JSON parse.
2. **Playlist order.** Directories can only ever sort alphabetically. A DJ's crate order is
   the whole point of the crate, and no filesystem layout can express it.

Nothing a writer does to the stick is destructive: the worst case is "delete `.waxcode/` and you
are exactly where you started".

## The manifest is ADVISORY, never authoritative

The Pi must not trust it blindly. The directory walk is fast; only tag-reading is slow (which
is why `scanLibrary()`'s `onFilesFound` already fires long before its tag loop). So:

1. Walk the tree (fast) — this is the truth about what files exist.
2. Diff that against the manifest's `tracks[].path`.
3. Tag-read **only** files the manifest doesn't know about, or whose `size`/`mtime` disagree.

A manifest treated as truth would show phantom tracks for files since deleted, and hide files
since added. Treated as a cache, a stale manifest degrades to "scans the twenty new tracks",
which is exactly right. Nobody has to remember to re-run anything.

## Schema

```json
{
  "formatVersion": 1,
  "generatedAt": "2026-08-22T10:00:00Z",
  "generatedBy": "waxcode 0.10.5",
  "source": "filesystem",

  "tracks": [
    {
      "id": "t1",
      "path": "Tracks/Dan Curtin/2007/01 Title.mp3",
      "size": 10485760,
      "mtime": "2026-08-01T12:00:00Z",
      "title": "Title",
      "artist": "Dan Curtin",
      "albumArtist": "Dan Curtin",
      "album": "Album",
      "genre": "Techno",
      "year": 2007,
      "durationMs": 372000,
      "bpm": 127.0,
      "key": "Am"
    }
  ],

  "playlists": [
    {
      "id": "p1",
      "name": "Friday Warmup",
      "parentId": null,
      "trackIds": ["t1", "t5", "t2"]
    }
  ]
}
```

### Field notes

- **`path`** is relative to the stick root, matching `relativeTrackPath()`'s format exactly, so
  it round-trips through the existing browsing code untouched and stays correct regardless of
  which port the stick is mounted at.
- **`id`** need only be unique *within this file* — it's a join key, not a durable identity.
  Deduplication upstream should key on the Music.app persistent ID, which is stable and free;
  don't content-hash thousands of files to catch the rare true duplicate.
- **`trackIds` order IS the playlist order.** No separate position field — an ordered array
  already says it, and a position field could contradict the array.
- **`parentId`** carries playlist folders; `null` for
  top level.
- **`size`/`mtime`** exist purely for the staleness check above.
- **`bpm`/`key`** are optional and worth carrying when the source knows them. A supplied BPM lets
  the Pi skip its own beat-grid analysis, which is more expensive than the tag read this file
  already eliminates.
- **`source`** records what produced it - `filesystem` for a scan of an existing stick.
- **`formatVersion`** so the Pi can decline a manifest from a newer tool cleanly rather than
  misreading it — same reasoning as the waveform/beat-grid caches' own `FORMAT_VERSION`.

## Naming files on a stick

- **Derive the path from something immutable, not from tag text.** The waveform and beat-grid
  caches are keyed by volume ID + relative path, and analysis costs seconds per track. If fixing
  a typo in a tag renames the file, every cached waveform for it is orphaned and gets recomputed.
- Keep names human-readable and the tree browsable: someone will plug this stick into a laptop,
  and a pool of hashed filenames is useless to them.
- Sanitise for exFAT: `: / \ * ? " < > |` are all illegal and all appear routinely in real track
  titles, and names are capped at 255 bytes. This bites on real data immediately.

## How the Pi presents it

One browsing engine, two indexes — `listDirectory()`'s output shape and the folder view are
unchanged. Only where the index comes from differs: classic browsing
filters the flat track list by path prefix and sorts alphabetically; playlist browsing filters by
playlist membership and sorts by stored order.

With a manifest present the device root gains one level:

```
USB stick
├── Playlists      <- from the manifest, in the DJ's own order
│   ├── Friday Warmup
│   └── Digging
└── Folders        <- the real directories, exactly as today
```

Without one, the root shows the folder tree directly, precisely as it does now. A stick that has
never met this tool must keep working unchanged — that is the normal path, not a degraded one.

The two views coexist deliberately: even on a fully synced stick the physical folders remain
browsable, so nothing is hidden and the stick still makes sense on a laptop.


## Who writes it

**The box writes it**, after any scan that learned something new (`buildStickManifest`, called
when a device scan completes).

Without that, a stick pays the full tag-reading scan on every boot forever - 6232 files took
minutes and ran the box warm. Written back, it is paid once, and any other box that sees the same
stick benefits too.

The box **merges**, never regenerates:

- **Track ids are preserved per path.** Playlists reference them, so minting new ones would orphan
  every playlist. A track the box has never seen gets an id derived from its path, so two boxes
  scanning the same stick independently agree.
- **Playlists and unknown top-level fields are carried through untouched.** The box cannot rebuild
  playlists, and a manifest from a newer prep tool may carry fields this version knows nothing about.
- **`generatedBy` becomes `waxcode-box`**, so it is clear which side wrote it last.

Written to a temp file and renamed, so a stick pulled mid-write leaves either the old file or the new
one, never a half-written one. Never throws: a read-only or full stick just means the next insert
scans, which is the behaviour that existed before any of this.

An unchanged manifest is not rewritten - every write is wear on someone's stick.
