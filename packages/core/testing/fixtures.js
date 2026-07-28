"use strict";

// Deterministic test data, shared by every edition's tests.
//
// Six songs chosen to exercise each branch the code actually has:
//   s1  ok lyrics, in library, most-played, has a URI, one playlist
//   s2  ok lyrics, PLURAL "doors" only — proves stemming (search "door" finds it)
//   s3  ok lyrics with no "door" anywhere — proves search excludes non-matches
//   s4  instrumental (a lyric row with a null body)
//   s5  notfound (a lyric row recording the miss)
//   s6  NO lyric row at all — the "pending" case getSongsNeedingLyrics must return
//
// play_count vs stream_count: every song here has some skipped plays, so the two
// numbers are never equal. A backend that confuses them fails loudly instead of
// looking right by coincidence.
//
// The lyric bodies are invented for this repo, not real song lyrics: the whole
// product is careful about lyric copyright, and test fixtures are no exception.

const { matchKey } = require("../src/matching");

function song(artist, track, extra) {
  return {
    match_key: matchKey(artist, track),
    artist,
    track,
    album: null,
    uri: null,
    in_library: 0,
    play_count: 0,
    stream_count: 0,
    ms_played: 0,
    playlists: [],
    ...extra,
  };
}

const SONGS = [
  song("Aurora Vale", "Open Door", {
    album: "First Light",
    uri: "spotify:track:s1",
    in_library: 1,
    play_count: 30,
    stream_count: 24,
    ms_played: 5_400_000,
    playlists: ["Morning"],
  }),
  song("Kestrel Line", "Two Doors Down", {
    play_count: 12,
    stream_count: 9,
    ms_played: 1_800_000,
    playlists: ["Morning", "Late Night"],
  }),
  song("Marble Hound", "Silent Field", {
    album: "Quiet",
    in_library: 1,
    play_count: 5,
    stream_count: 4,
    ms_played: 900_000,
  }),
  song("Aurora Vale", "Instrumental Interlude", { album: "First Light" }),
  song("Nine Volt", "Missing Words", {
    play_count: 3,
    stream_count: 2,
    ms_played: 200_000,
    playlists: ["Late Night"],
  }),
  song("Nine Volt", "No Lyrics Yet", {
    play_count: 7,
    stream_count: 5,
    ms_played: 400_000,
  }),
];

// Keyed by match_key so seeding does not depend on the ids the store assigns.
const LYRICS = new Map([
  [
    SONGS[0].match_key,
    {
      status: "ok",
      source: "lrclib",
      body: "I opened the door and stepped into the light\nThe door was never locked at all",
    },
  ],
  [
    SONGS[1].match_key,
    {
      status: "ok",
      source: "lrclib",
      body: "Two doors down the hallway waits\nDoors and windows open wide",
    },
  ],
  [
    SONGS[2].match_key,
    {
      status: "ok",
      source: "lrclib",
      body: "A window in the quiet field\nThe river carried every sound away",
    },
  ],
  [SONGS[3].match_key, { status: "instrumental", source: "lrclib", body: null }],
  [SONGS[4].match_key, { status: "notfound", source: null, body: null }],
  // SONGS[5] deliberately has no lyric row.
]);

/**
 * Load SONGS + LYRICS into any StorageAdapter.
 * @param {import("../src/storage").StorageAdapter} store
 * @returns {Promise<Map<string, number>>} match_key -> assigned song id
 */
async function seed(store) {
  await store.upsertSongs(SONGS);

  const ids = new Map();
  // getSongsNeedingLyrics is the only contract method that hands back ids before
  // any lyrics exist, so it is how we learn what ids the store chose.
  for (const row of await store.getSongsNeedingLyrics({})) {
    ids.set(matchKey(row.artist, row.track), row.id);
  }

  for (const [key, result] of LYRICS) {
    await store.saveLyrics(ids.get(key), result);
  }
  return ids;
}

module.exports = { SONGS, LYRICS, seed };
