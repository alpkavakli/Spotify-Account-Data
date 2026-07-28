"use strict";

// Export parsing + merge. Pure: given the already-parsed export JSON, produce
// one canonical song per identity, merging library + playlists + play counts.
// No file reads, no DB writes — the host does that.

const { matchKey } = require("./matching");

// A play shorter than this counts as a skip: it happened, but you did not
// listen to the song. 30s is Spotify's own threshold (what Wrapped counts as a
// stream, and what triggers a royalty payment), so it is the default — but the
// host can pass any value, because "did I actually listen to this" is a
// personal judgement, not a fact.
const DEFAULT_SKIP_THRESHOLD_MS = 30_000;

/**
 * Spotify ships streaming history in two different shapes, and which one you
 * have depends on which package you requested:
 *
 *   "Account data"                StreamingHistory_music_N.json
 *     { endTime, artistName, trackName, msPlayed }
 *     Only the LAST 12 MONTHS. Arrives in a few days.
 *
 *   "Extended streaming history"  Streaming_History_Audio_YYYY-YYYY_N.json
 *     { ts, ms_played, master_metadata_track_name,
 *       master_metadata_album_artist_name, master_metadata_album_album_name,
 *       spotify_track_uri, ... }
 *     EVERYTHING since the account was created. Takes up to ~30 days.
 *
 * Normalising here means the rest of the pipeline never has to care, and a user
 * can drop in either package — or both.
 *
 * @returns {{artist: string, track: string, ms: number, at: string,
 *            album: string|null, uri: string|null}|null}
 */
function normalizePlay(row) {
  if (!row || typeof row !== "object") return null;

  // Extended-history rows carry ms_played; account-data rows carry msPlayed.
  if ("ms_played" in row) {
    return {
      // Podcast and audiobook rows sit in the same file with every
      // master_metadata_* field null; they fall out below for want of a title.
      artist: row.master_metadata_album_artist_name,
      track: row.master_metadata_track_name,
      album: row.master_metadata_album_album_name || null,
      // A real win of this format: every row carries the track URI, where the
      // account-data export carries none at all.
      uri: row.spotify_track_uri || null,
      ms: Number(row.ms_played) || 0,
      at: row.ts,
    };
  }

  return {
    artist: row.artistName,
    track: row.trackName,
    album: null,
    uri: null,
    ms: Number(row.msPlayed) || 0,
    at: row.endTime,
  };
}

/** "2025-04-16 17:48" and "2020-01-01T00:00:00Z" both become "2025-04-16". */
function toDay(at) {
  if (!at) return null;
  const d = new Date(String(at).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Merge parsed Spotify export data into one row per song.
 *
 * @param {object}   input
 * @param {object}   [input.library]    parsed YourLibrary.json  ({ tracks: [...] })
 * @param {object}   [input.playlists]  parsed Playlist1.json    ({ playlists: [...] })
 * @param {object[]} [input.histories]  parsed streaming-history files (array of arrays),
 *                                      in either export format (see normalizePlay)
 * @param {number}   [input.skipThresholdMs=30000]  a play shorter than this is a skip
 * @returns {{ songs: object[], stats: object }}
 *   songs: [{ match_key, artist, track, album, uri, in_library,
 *             play_count, stream_count, ms_played, playlists }]
 */
function buildSongs({
  library,
  playlists,
  histories = [],
  skipThresholdMs = DEFAULT_SKIP_THRESHOLD_MS,
} = {}) {
  // key -> { artist, track, album, uri, in_library, play_count, stream_count,
  //          ms_played, playlists:Set }
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
        stream_count: 0,
        ms_played: 0,
        playlists: new Set(),
      };
      songs.set(key, row);
    }
    if (extra.album && !row.album) row.album = extra.album;
    if (extra.uri && !row.uri) row.uri = extra.uri;
    if (extra.in_library) row.in_library = 1;
    if (extra.playlist) row.playlists.add(extra.playlist);
    if (extra.play) {
      row.play_count += 1;
      row.ms_played += extra.play.ms;
      if (extra.play.ms >= skipThresholdMs) row.stream_count += 1;
    }
    return row;
  }

  const stats = {
    libraryTracks: 0,
    playlistLists: 0,
    playlistItems: 0,
    historyRows: 0,
    plays: 0,
    streams: 0,
    skips: 0,
    zeroMsRows: 0,
    unusableRows: 0,
    skipThresholdMs,
    historyFrom: null,
    historyTo: null,
  };

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
    for (const raw of hist || []) {
      stats.historyRows++;
      const play = normalizePlay(raw);

      if (!play || !play.artist || !play.track) {
        // Podcast/audiobook rows and malformed entries. Counted rather than
        // silently dropped, so the CLI can report what it ignored.
        stats.unusableRows++;
        continue;
      }

      // 0 ms means the track was queued but never actually started — not a
      // play. This exclusion is DELIBERATE and explicit; the previous code did
      // the same thing by accident, because `if (extra.ms_played)` is falsy
      // on 0, which silently lost the row from every counter at once.
      //
      // The song itself is still recorded: it appeared in your history and is
      // searchable, it just has nothing to count. Dropping the song outright
      // would quietly shrink the library.
      const counted = play.ms > 0;
      if (!counted) stats.zeroMsRows++;

      if (counted) {
        const day = toDay(play.at);
        if (day) {
          if (!stats.historyFrom || day < stats.historyFrom) stats.historyFrom = day;
          if (!stats.historyTo || day > stats.historyTo) stats.historyTo = day;
        }

        stats.plays++;
        if (play.ms >= skipThresholdMs) stats.streams++;
      }

      upsert(play.artist, play.track, {
        album: play.album,
        uri: play.uri,
        play: counted ? play : null,
      });
    }
  }

  stats.skips = stats.plays - stats.streams;

  const list = [...songs.values()].map((r) => ({
    match_key: matchKey(r.artist, r.track),
    artist: r.artist,
    track: r.track,
    album: r.album,
    uri: r.uri,
    in_library: r.in_library,
    play_count: r.play_count,
    stream_count: r.stream_count,
    ms_played: r.ms_played,
    playlists: [...r.playlists],
  }));

  return { songs: list, stats };
}

module.exports = { buildSongs, normalizePlay, DEFAULT_SKIP_THRESHOLD_MS };
