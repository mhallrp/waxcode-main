import { test, assert } from 'vitest';
import { childrenOf, searchTracks, sortTracks, applyTrackOrder } from './library';
import type { Device, Track } from '../types';

const track = (path: string, title = 'T', artist = 'A', bpm = 120): Track =>
  ({ path, title, artist, bpm });

const device: Device = {
  id: 'port-4', name: 'USB', root: '/media/pidvs/port-4', volumeId: 'v1', scanning: false,
  tracks: [
    track('/media/pidvs/port-4/01 Root.mp3', 'Root'),
    track('/media/pidvs/port-4/Crate/02 Deep.mp3', 'Deep'),
    track('/media/pidvs/port-4/Crate/Sub/03 Deeper.mp3', 'Deeper'),
    track('/media/pidvs/port-4/Crate 10/04 Ten.mp3', 'Ten'),
  ],
};

test('the root lists its own tracks and its immediate folders only', () => {
  const { folders, tracks } = childrenOf(device, []);
  assert.deepEqual(folders, ['Crate', 'Crate 10']);
  assert.deepEqual(tracks.map((t) => t.title), ['Root'], 'a track two levels down is not a child');
});

test('descending into a folder shows that folder\'s children', () => {
  const { folders, tracks } = childrenOf(device, ['Crate']);
  assert.deepEqual(folders, ['Sub']);
  assert.deepEqual(tracks.map((t) => t.title), ['Deep']);
});

/* "Crate 10" must not sort before "Crate 2" - numeric collation, the way a person reads them. */
test('folders sort numerically, not by character code', () => {
  const many: Device = {
    ...device,
    tracks: [2, 10, 1].map((n) => track(`/media/pidvs/port-4/Crate ${n}/x.mp3`)),
  };
  assert.deepEqual(childrenOf(many, []).folders, ['Crate 1', 'Crate 2', 'Crate 10']);
});

test('a prefix that only partly matches a folder name is not a match', () => {
  // "/Crate 10/..." must not be read as a child of "/Crate".
  const { tracks } = childrenOf(device, ['Crate']);
  assert.ok(!tracks.some((t) => t.path.includes('Crate 10')));
});

test('search is scoped to the folder in view', () => {
  assert.deepEqual(searchTracks(device, [], 'dee').map((t) => t.title), ['Deep', 'Deeper']);
  assert.deepEqual(searchTracks(device, ['Crate', 'Sub'], 'dee').map((t) => t.title), ['Deeper']);
});

test('an empty search returns nothing rather than everything', () => {
  assert.deepEqual(searchTracks(device, [], '   '), []);
});

test('sorting reverses on demand and is stable across fields', () => {
  const list = [track('/a', 'Beta', 'Z', 100), track('/b', 'alpha', 'A', 130)];
  assert.deepEqual(sortTracks(list, 'title', true).map((t) => t.title), ['alpha', 'Beta']);
  assert.deepEqual(sortTracks(list, 'title', false).map((t) => t.title), ['Beta', 'alpha']);
  assert.deepEqual(sortTracks(list, 'bpm', true).map((t) => t.bpm), [100, 130]);
});

/* The sort menu's direction used to move the tracks and leave the folders where they were, so "Z to
 * A" reordered half the list and read as a bug in the sort rather than a gap in it. */
test('folders come back in numeric collation, so a reverse is a true Z to A', () => {
  const device = {
    id: 'a', name: 'Stick', root: '/media/pidvs/port-1', volumeId: 'v', scanning: false,
    tracks: [
      { path: '/media/pidvs/port-1/Track 10/a.mp3', title: 'a', artist: '' },
      { path: '/media/pidvs/port-1/Track 2/b.mp3', title: 'b', artist: '' },
      { path: '/media/pidvs/port-1/Acid/c.mp3', title: 'c', artist: '' },
    ],
  } as unknown as Device;

  const { folders } = childrenOf(device, []);
  assert.deepEqual(folders, ['Acid', 'Track 2', 'Track 10'], 'Track 2 before Track 10, not after');
  assert.deepEqual([...folders].reverse(), ['Track 10', 'Track 2', 'Acid']);
});

/*
 * A chosen order for a folder, kept on the stick. PARTIAL on purpose: it names only what somebody
 * placed, so filling a stick up on a laptop never invalidates an arrangement.
 */
const t = (path: string) => ({ path, title: path, artist: '', bpm: null, duration: null } as never);

test('a custom order puts the placed tracks first and leaves the rest alone', () => {
  const tracks = [t('/m/a.mp3'), t('/m/b.mp3'), t('/m/c.mp3')];
  assert.deepEqual(
    applyTrackOrder(tracks, ['c.mp3', 'a.mp3']).map((x) => x.path),
    ['/m/c.mp3', '/m/a.mp3', '/m/b.mp3'],
  );
});

test('a name no longer on the stick is skipped rather than leaving a hole', () => {
  const tracks = [t('/m/a.mp3'), t('/m/b.mp3')];
  assert.deepEqual(
    applyTrackOrder(tracks, ['gone.mp3', 'b.mp3']).map((x) => x.path),
    ['/m/b.mp3', '/m/a.mp3'],
  );
});

test('no order changes nothing', () => {
  const tracks = [t('/m/b.mp3'), t('/m/a.mp3')];
  assert.deepEqual(applyTrackOrder(tracks, []), tracks);
});

/* An arrangement is not a sort, so it is not in SortField at all - the screen represents it as no
 * sort, and applyTrackOrder is what puts the rows in that order. */
test('the folders own order is what applyTrackOrder produces, not a sort field', () => {
  const tracks = [t('/m/b.mp3'), t('/m/a.mp3')];
  assert.deepEqual(applyTrackOrder(tracks, ['a.mp3']).map((x) => x.path), ['/m/a.mp3', '/m/b.mp3']);
  assert.deepEqual(sortTracks(tracks, 'title', true).map((x) => x.path), ['/m/a.mp3', '/m/b.mp3']);
});

/*
 * A folder with nothing in it yet cannot be derived from a track path - and one that cannot be seen
 * cannot be filled. That was invisible until folders could be created from the app: make one,
 * nothing appears, and there is nowhere to put the tracks that would have made it appear.
 */
test('an empty folder the box reports is listed, not only ones with tracks in', () => {
  const device = {
    id: 'port-3', name: 'Stick', root: '/m', volumeId: 'V', scanning: false, error: null,
    playlists: [], tracks: [t('/m/House/a.mp3')], folders: ['House', 'Empty Crate'],
  } as never as Device;

  assert.deepEqual(childrenOf(device, []).folders, ['Empty Crate', 'House']);
});

test('reported folders nest the same way tracks do', () => {
  const device = {
    id: 'port-3', name: 'Stick', root: '/m', volumeId: 'V', scanning: false, error: null,
    playlists: [], tracks: [], folders: ['House', 'House/Deeper', 'House/Deeper/Still'],
  } as never as Device;

  assert.deepEqual(childrenOf(device, []).folders, ['House'], 'only the level in view');
  assert.deepEqual(childrenOf(device, ['House']).folders, ['Deeper']);
  assert.deepEqual(childrenOf(device, ['House', 'Deeper']).folders, ['Still']);
});

/* An older box does not report folders at all, and must keep behaving exactly as it did. */
test('a box that reports no folders still lists the ones tracks imply', () => {
  const device = {
    id: 'port-3', name: 'Stick', root: '/m', volumeId: 'V', scanning: false, error: null,
    playlists: [], tracks: [t('/m/House/a.mp3')],
  } as never as Device;

  assert.deepEqual(childrenOf(device, []).folders, ['House']);
});
