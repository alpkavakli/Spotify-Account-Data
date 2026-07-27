"use strict";

// buildSongs turns three differently-shaped export files into one canonical list.
// Its whole job is the merge, so that is what these tests are about.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildSongs } = require("../src/ingest");
const { matchKey } = require("../src/matching");

const byKey = (songs) => new Map(songs.map((s) => [s.match_key, s]));

test.describe("buildSongs", () => {
  test.it("returns nothing for no input", () => {
    const { songs, stats } = buildSongs();
    assert.deepEqual(songs, []);
    assert.deepEqual(stats, { libraryTracks: 0, playlistLists: 0, playlistItems: 0, plays: 0 });
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
    assert.deepEqual(stats, { libraryTracks: 0, playlistLists: 2, playlistItems: 2, plays: 0 });
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
