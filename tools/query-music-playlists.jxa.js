// query-music-playlists.jxa.js
//
// Queries Music.app's own scripting bridge - the sanctioned way third-
// party tools read its library - for every real, non-empty user
// playlist and the local file path of each of its tracks. Never
// touches Music.app's internal database file directly; that format is
// undocumented and changes between macOS versions, while the
// scripting bridge is a stable, official API.
//
// Prints the result as JSON to stdout:
//   [{ "name": "Playlist Name", "paths": ["/Users/.../track.mp3", ...] }, ...]
//
// Run via: osascript -l JavaScript query-music-playlists.jxa.js
// (see export-playlists-to-folders.js, which calls this and does the
// actual folder/file copying in Node - JXA only for the one thing only
// JXA can do: talking to another app.)

function run() {
    const music = Application('Music');
    const playlists = music.playlists();
    const result = [];

    for (const playlist of playlists) {
        let name, specialKind;
        try {
            name = playlist.name();
            specialKind = playlist.specialKind();
        } catch (e) {
            continue;
        }

        // Only genuinely user-created playlists (regular or smart) -
        // specialKind is "none" for these; every built-in Music.app
        // playlist (the master Library, Purchased, Genius mixes, etc.)
        // reports something else. Folder-playlists (containers with no
        // tracks of their own, just nested sub-playlists) aren't
        // filtered here explicitly - they naturally produce zero
        // tracks below and get dropped by the paths.length check.
        if (specialKind !== 'none') {
            continue;
        }

        const tracks = playlist.tracks();
        const paths = [];

        for (const track of tracks) {
            let location;
            try {
                location = track.location();
            } catch (e) {
                // Cloud-only Apple Music track, not downloaded locally -
                // nothing to copy.
                location = null;
            }
            if (location) {
                paths.push(location.toString());
            }
        }

        if (paths.length > 0) {
            result.push({ name: name, paths: paths });
        }
    }

    return JSON.stringify(result);
}
