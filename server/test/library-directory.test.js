import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listDirectory, relativeTrackPath } from '../src/library-directory.js';

const ROOT = '/media/pidvs/sda2';

test('relativeTrackPath strips the device root and any leading slash', () => {
  assert.equal(relativeTrackPath(`${ROOT}/Artist/Track.mp3`, ROOT), 'Artist/Track.mp3');
});

test('relativeTrackPath at the device root itself returns an empty string', () => {
  assert.equal(relativeTrackPath(`${ROOT}/Track.mp3`, ROOT), 'Track.mp3');
});

test('relativeTrackPath returns the path unchanged if it does not actually start with root', () => {
  assert.equal(relativeTrackPath('/some/other/path/Track.mp3', ROOT), '/some/other/path/Track.mp3');
});

test('relativeTrackPath with no root at all returns the path unchanged', () => {
  assert.equal(relativeTrackPath('/media/pidvs/sda2/Track.mp3', ''), '/media/pidvs/sda2/Track.mp3');
});

function track(path, title = 'Untitled', artist = '') {
  return { path: `${ROOT}${path}`, artist, title };
}

test('root level: direct tracks and immediate subfolders only, no deeper nesting', () => {
  const tracks = [
    track('/Track A.mp3', 'Track A'),
    track('/Artist/Album/Track B.mp3', 'Track B'),
    track('/Artist/Track C.mp3', 'Track C'),
  ];
  const result = listDirectory({ tracks, root: ROOT, path: '' });
  assert.deepEqual(result.subfolders, ['Artist']);
  assert.deepEqual(result.tracks.map((t) => t.title), ['Track A']);
});

test('one level down: only tracks/folders directly under the requested path', () => {
  const tracks = [
    track('/Artist/Album/Track B.mp3', 'Track B'),
    track('/Artist/Track C.mp3', 'Track C'),
    track('/Other/Track D.mp3', 'Track D'),
  ];
  const result = listDirectory({ tracks, root: ROOT, path: 'Artist' });
  assert.deepEqual(result.subfolders, ['Album']);
  assert.deepEqual(result.tracks.map((t) => t.title), ['Track C']);
});

test('two levels down: reaches a deeply nested folder correctly', () => {
  const tracks = [
    track('/Artist/Album/Track B.mp3', 'Track B'),
    track('/Artist/Album/Deeper/Track E.mp3', 'Track E'),
  ];
  const result = listDirectory({ tracks, root: ROOT, path: 'Artist/Album' });
  assert.deepEqual(result.subfolders, ['Deeper']);
  assert.deepEqual(result.tracks.map((t) => t.title), ['Track B']);
});

test('a path with no matching tracks returns empty, not an error', () => {
  const tracks = [track('/Artist/Track C.mp3', 'Track C')];
  const result = listDirectory({ tracks, root: ROOT, path: 'Nonexistent' });
  assert.deepEqual(result, { subfolders: [], tracks: [] });
});

test('subfolders are sorted naturally (numeric-aware), tracks sorted by title', () => {
  const tracks = [
    track('/10 Second Folder/Track.mp3'),
    track('/2 First Folder/Track.mp3'),
    track('/Charlie.mp3', 'Charlie'),
    track('/alpha.mp3', 'alpha'),
    track('/Bravo.mp3', 'Bravo'),
  ];
  const result = listDirectory({ tracks, root: ROOT, path: '' });
  assert.deepEqual(result.subfolders, ['2 First Folder', '10 Second Folder']);
  assert.deepEqual(result.tracks.map((t) => t.title), ['alpha', 'Bravo', 'Charlie']);
});

test('works without a root prefix (root undefined/null) by treating the whole path as relative', () => {
  const tracks = [{ path: 'Artist/Track.mp3', artist: '', title: 'Track' }];
  const result = listDirectory({ tracks, root: null, path: 'Artist' });
  assert.deepEqual(result.tracks.map((t) => t.title), ['Track']);
});

const playlistFixture = [
  { id: 'p1', name: 'Friday Warmup', parentId: null, paths: ['Tracks/B/2.mp3', 'Tracks/A/1.mp3'] },
  { id: 'p2', name: 'Digging', parentId: null, paths: ['Tracks/A/1.mp3'] },
];
const playlistTracks = [
  { path: `${ROOT}/Tracks/A/1.mp3`, title: 'One' },
  { path: `${ROOT}/Tracks/B/2.mp3`, title: 'Two' },
];


test('the root offers Playlists first, without hiding the real folder tree', () => {
  const listing = listDirectory({ tracks: playlistTracks, root: ROOT, path: '', playlists: playlistFixture });
  assert.deepEqual(listing.subfolders, ['Playlists', 'Tracks']);
});

test('a stick with no playlists looks exactly as it always did', () => {
  const listing = listDirectory({ tracks: playlistTracks, root: ROOT, path: '', playlists: [] });
  assert.deepEqual(listing.subfolders, ['Tracks']);
});

test('the Playlists folder lists the crates', () => {
  const listing = listDirectory({ tracks: playlistTracks, root: ROOT, path: 'Playlists', playlists: playlistFixture });
  assert.deepEqual(listing.subfolders, ['Digging', 'Friday Warmup']);
  assert.deepEqual(listing.tracks, []);
});

test('a playlist returns its tracks in the DJ\'s own order, not alphabetically', () => {
  const listing = listDirectory({
    tracks: playlistTracks, root: ROOT, path: 'Playlists/Friday Warmup', playlists: playlistFixture,
  });
  // The manifest lists 2.mp3 first. A real folder could only ever sort these the other way, which
  // is exactly why playlists are worth carrying at all.
  assert.deepEqual(listing.tracks.map((t) => t.title), ['Two', 'One']);
});

test('a playlist naming a track no longer on the stick lists what remains rather than offering a dead entry', () => {
  const withGhost = [{ id: 'p3', name: 'Ghosts', parentId: null, paths: ['Tracks/A/1.mp3', 'Tracks/gone.mp3'] }];
  const listing = listDirectory({ tracks: playlistTracks, root: ROOT, path: 'Playlists/Ghosts', playlists: withGhost });
  assert.deepEqual(listing.tracks.map((t) => t.title), ['One']);
});

test('an unknown playlist name is empty rather than an error', () => {
  const listing = listDirectory({ tracks: playlistTracks, root: ROOT, path: 'Playlists/Nope', playlists: playlistFixture });
  assert.deepEqual(listing, { subfolders: [], tracks: [] });
});

test('a playlist whose name contains a slash still resolves - names are not path components', () => {
  // Real crate names from the owner's library: "House (Slow/Balearic)" reported itself as having
  // no supported audio files, because the name was being split into path components.
  const awkward = [
    { id: 'p1', name: 'House (Slow/Balearic)', parentId: null, paths: ['Tracks/A/1.mp3'] },
    { id: 'p2', name: 'Downtempo Electronics:Intros:FX', parentId: null, paths: ['Tracks/B/2.mp3'] },
  ];

  const balearic = listDirectory({
    tracks: playlistTracks, root: ROOT, path: 'Playlists/House (Slow/Balearic)', playlists: awkward,
  });
  assert.deepEqual(balearic.tracks.map((t) => t.title), ['One']);

  const colons = listDirectory({
    tracks: playlistTracks, root: ROOT, path: 'Playlists/Downtempo Electronics:Intros:FX', playlists: awkward,
  });
  assert.deepEqual(colons.tracks.map((t) => t.title), ['Two']);
});
