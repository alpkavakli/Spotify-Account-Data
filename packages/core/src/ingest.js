"use strict";

// Export parsing + merge. Pure: given the already-parsed export JSON, produce
// one canonical song per identity, merging library + playlists + play counts.
// No file reads, no DB writes — the host does that.

const { matchKey } = require("./matching");

/**
 * Merge parsed Spotify export data into one row per song.
 *
 * @param {object}   input
 * @param {object}   [input.library]    parsed YourLibrary.json  ({ tracks: [...] })
 * @param {object}   [input.playlists]  parsed Playlist1.json    ({ playlists: [...] })
 * @param {object[]} [input.histories]  parsed StreamingHistory_music_*.json (array of arrays)
 * @returns {{ songs: object[], stats: object }}
 *   songs: [{ match_key, artist, track, album, uri, in_library, play_count, ms_played, playlists }]
 */
function buildSongs({ library, playlists, histories = [] } = {}) {
  // key -> { artist, track, album, uri, in_library, play_count, ms_played, playlists:Set }
  const songs = new Map();

  function upsert(artist, track, extra = {}) {
    if (!artist || !track) return null;
    const key = matchKey(artist, track);
    let row = songs.get(key);
    if (!row) {
      row = {
        artist,
        track,
        album: null,
        uri: null,
        in_library: 0,
        play_count: 0,
        ms_played: 0,
        playlists: new Set(),
      };
      songs.set(key, row);
    }
    if (extra.album && !row.album) row.album = extra.album;
    if (extra.uri && !row.uri) row.uri = extra.uri;
    if (extra.in_library) row.in_library = 1;
    if (extra.playlist) row.playlists.add(extra.playlist);
    if (extra.ms_played) {
      row.play_count += 1;
      row.ms_played += extra.ms_played;
    }
    return row;
  }

  const stats = { libraryTracks: 0, playlistLists: 0, playlistItems: 0, plays: 0 };

  // --- Library ---
  if (library?.tracks) {
    for (const t of library.tracks) {
      upsert(t.artist, t.track, { album: t.album, uri: t.uri, in_library: 1 });
    }
    stats.libraryTracks = library.tracks.length;
  }

  // --- Playlists ---
  if (playlists?.playlists) {
    for (const p of playlists.playlists) {
      for (const item of p.items || []) {
        const t = item.track;
        if (!t?.trackName) continue;
        stats.playlistItems++;
        upsert(t.artistName, t.trackName, {
          album: t.albumName,
          uri: t.trackUri,
          playlist: p.name,
        });
      }
    }
    stats.playlistLists = playlists.playlists.length;
  }

  // --- Streaming history ---
  for (const hist of histories) {
    for (const h of hist || []) {
      stats.plays++;
      upsert(h.artistName, h.trackName, { ms_played: h.msPlayed });
    }
  }

  const list = [...songs.values()].map((r) => ({
    match_key: matchKey(r.artist, r.track),
    artist: r.artist,
    track: r.track,
    album: r.album,
    uri: r.uri,
    in_library: r.in_library,
    play_count: r.play_count,
    ms_played: r.ms_played,
    playlists: [...r.playlists],
  }));

  return { songs: list, stats };
}

module.exports = { buildSongs };
