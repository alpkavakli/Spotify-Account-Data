"use strict";

// buildSongs turns three differently-shaped export files into one canonical list.
// Its whole job is the merge, so that is what these tests are about.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSongs, normalizePlay } = require("../src/ingest");
const { matchKey } = require("../src/matching");

const byKey = (songs) => new Map(songs.map((s) => [s.match_key, s]));

test.describe("buildSongs", () => {
  test.it("returns nothing for no input", () => {
    const { songs, stats } = buildSongs();
    assert.deepEqual(songs, []);
    assert.equal(stats.plays, 0);
    assert.equal(stats.streams, 0);
    assert.equal(stats.historyRows, 0);
    assert.equal(stats.historyFrom, null);
  });

  test.it("reads library tracks and flags them as in-library", () => {
    const { songs } = buildSongs({
      library: {
        tracks: [
          { artist: "A", track: "One", album: "Alb", uri: "spotify:track:1" },
        ],
      },
    });
    assert.equal(songs.length, 1);
    assert.deepEqual(songs[0], {
      match_key: matchKey("A", "One"),
      artist: "A",
      track: "One",
      album: "Alb",
      uri: "spotify:track:1",
      in_library: 1,
      play_count: 0,
      stream_count: 0,
      ms_played: 0,
      playlists: [],
    });
  });

  test.it("reads playlist items and records which playlists a song is in", () => {
    const { songs, stats } = buildSongs({
      playlists: {
        playlists: [
          {
            name: "Morning",
            items: [{ track: { artistName: "A", trackName: "One", albumName: "Alb" } }],
          },
          {
            name: "Evening",
            items: [{ track: { artistName: "A", trackName: "One" } }],
          },
        ],
      },
    });
    assert.equal(songs.length, 1);
    assert.deepEqual(songs[0].playlists, ["Morning", "Evening"]);
    assert.equal(songs[0].in_library, 0);
    assert.equal(stats.playlistLists, 2);
    assert.equal(stats.playlistItems, 2);
    assert.equal(stats.plays, 0);
  });

  test.it("counts a play per streaming-history row and sums the milliseconds", () => {
    const { songs, stats } = buildSongs({
      histories: [
        [
          { artistName: "A", trackName: "One", msPlayed: 1000 },
          { artistName: "A", trackName: "One", msPlayed: 2000 },
        ],
      ],
    });
    assert.equal(songs[0].play_count, 2);
    assert.equal(songs[0].ms_played, 3000);
    assert.equal(stats.plays, 2);
  });

  test.it("does NOT count a 0 ms row as a play", () => {
    // A 0 ms row means the track was queued and never started. Counting it
    // inflates play counts with things you never heard. This used to happen by
    // accident (`if (extra.ms_played)` is falsy on 0); it is now deliberate and
    // reported, so the number of ignored rows is visible instead of silent.
    const { songs, stats } = buildSongs({
      histories: [
        [
          { artistName: "A", trackName: "One", msPlayed: 0 },
          { artistName: "A", trackName: "One", msPlayed: 60000 },
        ],
      ],
    });
    assert.equal(songs[0].play_count, 1);
    assert.equal(songs[0].ms_played, 60000);
    assert.equal(stats.plays, 1);
    assert.equal(stats.zeroMsRows, 1);
    assert.equal(stats.historyRows, 2, "ignored rows are still counted as seen");
  });

  test.it("still records a song whose only rows are 0 ms, with no plays", () => {
    // It appeared in your history, so it stays searchable — it just has nothing
    // to count. Dropping it would silently shrink the library.
    const { songs } = buildSongs({
      histories: [[{ artistName: "A", trackName: "One", msPlayed: 0 }]],
    });
    assert.equal(songs.length, 1);
    assert.equal(songs[0].play_count, 0);
    assert.equal(songs[0].stream_count, 0);
    assert.equal(songs[0].ms_played, 0);
  });

  test.it("merges the same song across all three sources into one row", () => {
    // The point of the whole module: a song in your library, on a playlist, and
    // in your history is ONE song with all three facts attached.
    const { songs } = buildSongs({
      library: { tracks: [{ artist: "The Doors", track: "Riders", album: "Alb" }] },
      playlists: {
        playlists: [
          { name: "Rock", items: [{ track: { artistName: "The Doors", trackName: "Riders" } }] },
        ],
      },
      histories: [[{ artistName: "The Doors", trackName: "Riders", msPlayed: 500 }]],
    });

    assert.equal(songs.length, 1);
    assert.deepEqual(songs[0], {
      match_key: matchKey("The Doors", "Riders"),
      artist: "The Doors",
      track: "Riders",
      album: "Alb",
      uri: null,
      in_library: 1,
      play_count: 1,
      stream_count: 0,
      ms_played: 500,
      playlists: ["Rock"],
    });
  });

  test.it("merges spelling variants of the same song via match_key", () => {
    const { songs } = buildSongs({
      library: { tracks: [{ artist: "The Doors", track: "Riders - 2020 Remaster" }] },
      histories: [[{ artistName: "the doors", trackName: "Riders", msPlayed: 100 }]],
    });
    assert.equal(songs.length, 1, "remaster suffix should not create a second row");
    assert.equal(songs[0].play_count, 1);
    assert.equal(songs[0].in_library, 1);
  });

  test.it("keeps the first album and uri it sees rather than overwriting them", () => {
    const { songs } = buildSongs({
      library: { tracks: [{ artist: "A", track: "One", album: "First", uri: "uri:first" }] },
      playlists: {
        playlists: [
          {
            name: "P",
            items: [
              {
                track: {
                  artistName: "A",
                  trackName: "One",
                  albumName: "Second",
                  trackUri: "uri:second",
                },
              },
            ],
          },
        ],
      },
    });
    assert.equal(songs[0].album, "First");
    assert.equal(songs[0].uri, "uri:first");
  });

  test.it("fills in an album or uri that the earlier source lacked", () => {
    const { songs } = buildSongs({
      library: { tracks: [{ artist: "A", track: "One" }] },
      playlists: {
        playlists: [
          {
            name: "P",
            items: [
              { track: { artistName: "A", trackName: "One", albumName: "Found", trackUri: "uri:found" } },
            ],
          },
        ],
      },
    });
    assert.equal(songs[0].album, "Found");
    assert.equal(songs[0].uri, "uri:found");
  });

  test.it("lists a song in a playlist only once even if added twice", () => {
    const { songs } = buildSongs({
      playlists: {
        playlists: [
          {
            name: "P",
            items: [
              { track: { artistName: "A", trackName: "One" } },
              { track: { artistName: "A", trackName: "One" } },
            ],
          },
        ],
      },
    });
    assert.deepEqual(songs[0].playlists, ["P"]);
  });

  test.it("does not count a playlist or library entry as a play", () => {
    const { songs } = buildSongs({
      library: { tracks: [{ artist: "A", track: "One" }] },
      playlists: {
        playlists: [{ name: "P", items: [{ track: { artistName: "A", trackName: "One" } }] }],
      },
    });
    assert.equal(songs[0].play_count, 0);
    assert.equal(songs[0].ms_played, 0);
  });

  test.it("reads every streaming-history file", () => {
    // The export splits history across StreamingHistory_music_0, _1, _2...
    const { songs, stats } = buildSongs({
      histories: [
        [{ artistName: "A", trackName: "One", msPlayed: 100 }],
        [{ artistName: "A", trackName: "One", msPlayed: 200 }],
        [{ artistName: "B", trackName: "Two", msPlayed: 300 }],
      ],
    });
    assert.equal(songs.length, 2);
    assert.equal(byKey(songs).get(matchKey("A", "One")).play_count, 2);
    assert.equal(stats.plays, 3);
  });

  test.it("skips rows missing an artist or a track name", () => {
    const { songs } = buildSongs({
      library: {
        tracks: [
          { artist: "A", track: "One" },
          { artist: "", track: "No Artist" },
          { artist: "B", track: "" },
          { artist: null, track: null },
        ],
      },
    });
    assert.deepEqual(songs.map((s) => s.track), ["One"]);
  });

  test.it("skips playlist entries with no track name", () => {
    const { songs, stats } = buildSongs({
      playlists: {
        playlists: [
          {
            name: "P",
            items: [
              { track: { artistName: "A", trackName: "One" } },
              { track: {} },
              {},
              { track: null },
            ],
          },
        ],
      },
    });
    assert.equal(songs.length, 1);
    assert.equal(stats.playlistItems, 1, "unusable rows must not be counted as items");
  });

  test.it("tolerates a playlist with no items array", () => {
    const { songs } = buildSongs({ playlists: { playlists: [{ name: "Empty" }] } });
    assert.deepEqual(songs, []);
  });

  test.it("tolerates a null entry in the histories array", () => {
    const { songs } = buildSongs({ histories: [null, [{ artistName: "A", trackName: "One", msPlayed: 1 }]] });
    assert.equal(songs.length, 1);
  });

  test.it("gives every song a match_key consistent with matchKey()", () => {
    const { songs } = buildSongs({
      library: { tracks: [{ artist: "The Doors", track: "Riders - Live" }] },
    });
    assert.equal(songs[0].match_key, matchKey("The Doors", "Riders - Live"));
  });
});

test.describe("skip threshold (plays vs streams)", () => {
  const history = (...msPlayed) => [
    msPlayed.map((ms) => ({ artistName: "A", trackName: "One", msPlayed: ms })),
  ];

  test.it("counts a play at or over the threshold as a stream", () => {
    const { songs, stats } = buildSongs({ histories: history(30_000, 120_000) });
    assert.equal(songs[0].play_count, 2);
    assert.equal(songs[0].stream_count, 2, "exactly 30s counts - the boundary is inclusive");
    assert.equal(stats.streams, 2);
    assert.equal(stats.skips, 0);
  });

  test.it("counts a shorter play as a skip: still a play, not a stream", () => {
    const { songs, stats } = buildSongs({ histories: history(29_999, 5_000) });
    assert.equal(songs[0].play_count, 2, "skips are still plays");
    assert.equal(songs[0].stream_count, 0);
    assert.equal(stats.plays, 2);
    assert.equal(stats.streams, 0);
    assert.equal(stats.skips, 2);
  });

  test.it("defaults to Spotify's own 30-second rule", () => {
    const { stats } = buildSongs({ histories: history(31_000, 29_000) });
    assert.equal(stats.skipThresholdMs, 30_000);
    assert.equal(stats.streams, 1);
    assert.equal(stats.skips, 1);
  });

  test.it("honours a custom threshold", () => {
    // "10 seconds is enough for me to say I listened" is a legitimate position,
    // so the threshold is the caller's to choose.
    const { songs, stats } = buildSongs({
      histories: history(12_000, 8_000),
      skipThresholdMs: 10_000,
    });
    assert.equal(songs[0].stream_count, 1);
    assert.equal(stats.skipThresholdMs, 10_000);
    assert.equal(stats.streams, 1);
    assert.equal(stats.skips, 1);
  });

  test.it("counts every non-zero play as a stream when the threshold is 0", () => {
    const { songs, stats } = buildSongs({
      histories: history(0, 1, 500_000),
      skipThresholdMs: 0,
    });
    assert.equal(songs[0].play_count, 2, "a 0 ms row is never a play, whatever the threshold");
    assert.equal(songs[0].stream_count, 2);
    assert.equal(stats.zeroMsRows, 1);
    assert.equal(stats.plays, 2);
  });

  test.it("keeps plays and streams separate per song", () => {
    const { songs } = buildSongs({
      histories: [
        [
          { artistName: "A", trackName: "One", msPlayed: 200_000 },
          { artistName: "A", trackName: "One", msPlayed: 1_000 },
          { artistName: "B", trackName: "Two", msPlayed: 1_000 },
        ],
      ],
    });
    const byTrack = Object.fromEntries(songs.map((s) => [s.track, s]));
    assert.deepEqual([byTrack.One.play_count, byTrack.One.stream_count], [2, 1]);
    assert.deepEqual([byTrack.Two.play_count, byTrack.Two.stream_count], [1, 0]);
  });
});

test.describe("extended streaming history format", () => {
  // Spotify's "Extended streaming history" package (the one that actually
  // contains your whole listening record) uses different filenames AND
  // different field names from the standard "Account data" package.
  const extended = (over = {}) => ({
    ts: "2020-06-01T12:00:00Z",
    ms_played: 200_000,
    master_metadata_track_name: "One",
    master_metadata_album_artist_name: "A",
    master_metadata_album_album_name: "Alb",
    spotify_track_uri: "spotify:track:xyz",
    ...over,
  });

  test.it("reads extended rows", () => {
    const { songs, stats } = buildSongs({ histories: [[extended()]] });
    assert.equal(songs.length, 1);
    assert.equal(songs[0].artist, "A");
    assert.equal(songs[0].track, "One");
    assert.equal(songs[0].play_count, 1);
    assert.equal(songs[0].stream_count, 1);
    assert.equal(songs[0].ms_played, 200_000);
    assert.equal(stats.plays, 1);
  });

  test.it("takes the album and track URI the extended format carries", () => {
    // A real gain: the account-data export has NO track URIs at all, which is
    // why playlist creation has to look every song up on Spotify by name.
    const { songs } = buildSongs({ histories: [[extended()]] });
    assert.equal(songs[0].album, "Alb");
    assert.equal(songs[0].uri, "spotify:track:xyz");
  });

  test.it("skips podcast and audiobook rows, which share the same file", () => {
    const { songs, stats } = buildSongs({
      histories: [
        [
          extended(),
          extended({
            master_metadata_track_name: null,
            master_metadata_album_artist_name: null,
            spotify_track_uri: null,
          }),
        ],
      ],
    });
    assert.equal(songs.length, 1);
    assert.equal(stats.unusableRows, 1);
    assert.equal(stats.historyRows, 2);
  });

  test.it("applies the same 0 ms and threshold rules", () => {
    const { songs, stats } = buildSongs({
      histories: [[extended({ ms_played: 0 }), extended({ ms_played: 5_000 })]],
    });
    assert.equal(songs[0].play_count, 1);
    assert.equal(songs[0].stream_count, 0);
    assert.equal(stats.zeroMsRows, 1);
  });

  test.it("merges both export formats into one song", () => {
    // Someone who requested the small package, then the big one, can drop both
    // in - the same song must not land twice.
    const { songs } = buildSongs({
      histories: [
        [{ artistName: "A", trackName: "One", msPlayed: 100_000 }],
        [extended({ ms_played: 100_000 })],
      ],
    });
    assert.equal(songs.length, 1);
    assert.equal(songs[0].play_count, 2);
    assert.equal(songs[0].stream_count, 2);
    assert.equal(songs[0].uri, "spotify:track:xyz", "the URI comes from the extended row");
  });
});

test.describe("normalizePlay", () => {
  test.it("recognises an account-data row", () => {
    assert.deepEqual(
      normalizePlay({ endTime: "2025-04-16 17:48", artistName: "A", trackName: "One", msPlayed: 5 }),
      { artist: "A", track: "One", album: null, uri: null, ms: 5, at: "2025-04-16 17:48" }
    );
  });

  test.it("recognises an extended row by its ms_played field", () => {
    const row = normalizePlay({
      ts: "2020-01-01T00:00:00Z",
      ms_played: 7,
      master_metadata_track_name: "One",
      master_metadata_album_artist_name: "A",
      master_metadata_album_album_name: null,
      spotify_track_uri: null,
    });
    assert.equal(row.ms, 7);
    assert.equal(row.at, "2020-01-01T00:00:00Z");
    assert.equal(row.album, null);
    assert.equal(row.uri, null);
  });

  test.it("coerces a missing or malformed duration to 0 rather than NaN", () => {
    assert.equal(normalizePlay({ artistName: "A", trackName: "B" }).ms, 0);
    assert.equal(normalizePlay({ artistName: "A", trackName: "B", msPlayed: "oops" }).ms, 0);
  });

  test.it("returns null for a non-object", () => {
    assert.equal(normalizePlay(null), null);
    assert.equal(normalizePlay("nope"), null);
  });
});

test.describe("history coverage window", () => {
  test.it("reports the first and last day the history actually covers", () => {
    // This is what lets the UI say "these numbers cover Apr 2025 - Apr 2026"
    // instead of silently implying they cover all time.
    const { stats } = buildSongs({
      histories: [
        [
          { artistName: "A", trackName: "One", msPlayed: 1000, endTime: "2025-04-16 17:48" },
          { artistName: "A", trackName: "One", msPlayed: 1000, endTime: "2026-04-17 23:10" },
          { artistName: "A", trackName: "One", msPlayed: 1000, endTime: "2025-12-01 09:00" },
        ],
      ],
    });
    assert.equal(stats.historyFrom, "2025-04-16");
    assert.equal(stats.historyTo, "2026-04-17");
  });

  test.it("spans both export formats and both timestamp styles", () => {
    const { stats } = buildSongs({
      histories: [
        [{ artistName: "A", trackName: "One", msPlayed: 1000, endTime: "2025-04-16 17:48" }],
        [
          {
            ts: "2019-03-04T08:00:00Z",
            ms_played: 1000,
            master_metadata_track_name: "One",
            master_metadata_album_artist_name: "A",
          },
        ],
      ],
    });
    assert.equal(stats.historyFrom, "2019-03-04");
    assert.equal(stats.historyTo, "2025-04-16");
  });

  test.it("ignores rows that never counted as a play", () => {
    const { stats } = buildSongs({
      histories: [
        [
          { artistName: "A", trackName: "One", msPlayed: 0, endTime: "2001-01-01 00:00" },
          { artistName: "A", trackName: "One", msPlayed: 1000, endTime: "2025-04-16 17:48" },
        ],
      ],
    });
    assert.equal(stats.historyFrom, "2025-04-16", "a 0 ms row must not widen the window");
  });

  test.it("is null when there is no history", () => {
    const { stats } = buildSongs({ library: { tracks: [{ artist: "A", track: "One" }] } });
    assert.equal(stats.historyFrom, null);
    assert.equal(stats.historyTo, null);
  });

  test.it("survives an unparseable timestamp", () => {
    const { stats } = buildSongs({
      histories: [[{ artistName: "A", trackName: "One", msPlayed: 1000, endTime: "not a date" }]],
    });
    assert.equal(stats.plays, 1);
    assert.equal(stats.historyFrom, null);
  });
});
