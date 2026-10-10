import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createStickWriter, safeFolderName, safeUnder } from '../src/stick-writer.js';

const stick = () => mkdtempSync(join(tmpdir(), 'waxcode-stick-'));

/** A stick that is already writable, so the test exercises the writing rather than mount(8). */
const storage = { withWritableStick: async (_mount, body) => body() };

/*
 * A name arrives from the network and is about to become a filesystem path, on somebody's whole
 * music collection. Rejection is by RESOLUTION rather than by looking for ".." - a name can reach
 * outside in more ways than one string match covers, and where the path LANDED is the only
 * reliable question.
 */
test('a path that resolves outside the stick is refused', () => {
  const mount = '/media/pidvs/port-3';
  assert.equal(safeUnder(mount, 'House', 'track.mp3'), `${mount}/House/track.mp3`);
  assert.equal(safeUnder(mount, ''), mount, 'the root itself is inside it');

  assert.equal(safeUnder(mount, '..', 'etc'), null);
  assert.equal(safeUnder(mount, 'House', '..', '..', '..', 'etc', 'passwd'), null);
  assert.equal(safeUnder(mount, '/etc/passwd'), null, 'an absolute path does not escape either');
});

test('a folder name keeps what it can and refuses what it cannot', () => {
  assert.equal(safeFolderName('Filtered House'), 'Filtered House');
  assert.equal(safeFolderName('AC/DC'), 'AC-DC', 'a separator cannot survive as itself');
  assert.equal(safeFolderName('  ..hidden'), 'hidden');
  assert.equal(safeFolderName(''), null);
  assert.equal(safeFolderName('   '), null);
});

test('a folder is created inside the stick', async () => {
  const mount = stick();
  try {
    const writer = createStickWriter({ stickStorage: storage });
    await writer.makeFolder(mount, [], 'New Crate');
    assert.ok(existsSync(join(mount, 'New Crate')));

    await writer.makeFolder(mount, ['New Crate'], 'Deeper');
    assert.ok(existsSync(join(mount, 'New Crate', 'Deeper')));
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});

test('a track is written whole, under the name it was given', async () => {
  const mount = stick();
  try {
    const writer = createStickWriter({ stickStorage: storage });
    const bytes = Buffer.alloc(4096, 9);
    const added = await writer.addTrack(mount, [], 'Track.mp3', Readable.from([bytes]));

    assert.equal(added.bytes, 4096);
    assert.deepEqual(readFileSync(join(mount, 'Track.mp3')), bytes);
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});

/*
 * The scanner lists what is on the stick and a deck tries to play it. A truncated file is therefore
 * worse than no file: it is an entry in somebody's library that fails when they reach for it.
 */
test('a transfer that fails leaves nothing behind, not half a track', async () => {
  const mount = stick();
  try {
    const writer = createStickWriter({ stickStorage: storage });
    const dying = Readable.from((async function* chunks() {
      yield Buffer.alloc(1024, 1);
      throw new Error('the laptop went away');
    })());

    await assert.rejects(() => writer.addTrack(mount, [], 'Half.mp3', dying));
    assert.equal(existsSync(join(mount, 'Half.mp3')), false, 'no track');
    assert.equal(existsSync(join(mount, 'Half.mp3.waxcode-part')), false, 'and no leftover either');
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});

test('a file the box cannot play is refused before anything is written', async () => {
  const mount = stick();
  try {
    const writer = createStickWriter({ stickStorage: storage });
    await assert.rejects(
      () => writer.addTrack(mount, [], 'notes.txt', Readable.from([Buffer.alloc(16)])),
      (err) => err.status === 415,
    );
    assert.equal(existsSync(join(mount, 'notes.txt')), false);
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});

/* Writing into a folder that resolves off the stick must fail at the check, not at the filesystem. */
test('a track aimed outside the stick never opens a file', async () => {
  const mount = stick();
  try {
    const writer = createStickWriter({ stickStorage: storage });
    await assert.rejects(
      () => writer.addTrack(mount, ['..', '..'], 'Escape.mp3', Readable.from([Buffer.alloc(16)])),
      (err) => err.status === 400,
    );
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});

/* A delete that can be aimed off the mount is worse than a write that can: it needs no content to
 * do damage. Same resolution check, and the extension check as well - a stick holds somebody's
 * photos and documents too, and nothing here should be able to reach them. */
test('deleting is confined to tracks on the stick', async () => {
  const mount = stick();
  try {
    const writer = createStickWriter({ stickStorage: storage });
    writeFileSync(join(mount, 'Track.mp3'), Buffer.alloc(16));
    writeFileSync(join(mount, 'notes.txt'), Buffer.alloc(16));

    await assert.rejects(() => writer.removeTrack(mount, '../../etc/passwd'), (e) => e.status === 400);
    await assert.rejects(() => writer.removeTrack(mount, 'notes.txt'), (e) => e.status === 400);
    assert.ok(existsSync(join(mount, 'notes.txt')), 'a file that is not a track is untouched');

    await assert.rejects(() => writer.removeTrack(mount, 'Nothing.mp3'), (e) => e.status === 404);

    await writer.removeTrack(mount, 'Track.mp3');
    assert.equal(existsSync(join(mount, 'Track.mp3')), false);
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});

/* Not recursive, deliberately: deleting a crate is a different decision from deleting a track, and
 * one misplaced click should not take the crate with it. */
test('a folder is deleted only when it is empty', async () => {
  const mount = stick();
  try {
    const writer = createStickWriter({ stickStorage: storage });
    await writer.makeFolder(mount, [], 'Crate');
    writeFileSync(join(mount, 'Crate', 'Track.mp3'), Buffer.alloc(16));

    await assert.rejects(() => writer.removeFolder(mount, 'Crate'), (e) => e.status === 409);
    assert.ok(existsSync(join(mount, 'Crate', 'Track.mp3')), 'and its contents survive the refusal');

    await writer.removeTrack(mount, 'Crate/Track.mp3');
    await writer.removeFolder(mount, 'Crate');
    assert.equal(existsSync(join(mount, 'Crate')), false);
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});
