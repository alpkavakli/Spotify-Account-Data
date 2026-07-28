"use strict";

// End-to-end tests for every HTTP route.
//
// These are integration tests, not unit tests: each one starts a real Express
// server on a random port, over a real (temporary) SQLite database seeded with
// fixture data, and makes real HTTP requests. Only the Spotify client is faked,
// because it is the one dependency that reaches the public internet.
//
// The assertions are on the HTTP contract the frontend depends on — status
// codes and the exact JSON shape — because that is what breaks users when the
// storage layer is swapped underneath.

const test = require("node:test");
const assert = require("node:assert/strict");

const { SONGS, seed } = require("@lyricsearch/core/testing/fixtures");
const { createApp } = require("../src/app");
const { startServer } = require("./helpers/http");
const { fakeSpotify } = require("./helpers/fake-spotify");
const { tempStore, cleanupTempStores } = require("./helpers/temp-store");

test.after(cleanupTempStores);

/**
 * Spin up a seeded app for one test. Returns the HTTP client plus the pieces a
 * test may want to assert against, and registers its own teardown.
 */
async function withApp(t, { spotify = fakeSpotify(), seeded = true } = {}) {
  const store = tempStore();
  const ids = seeded ? await seed(store) : new Map();
  const app = createApp({ store, spotify });
  const { client, close } = await startServer(app);

  t.after(async () => {
    await close();
    await store.close();
  });

  return { client, store, spotify, ids, id: (i) => ids.get(SONGS[i].match_key) };
}

// ── GET /searchForWord ────────────────────────────────────────────────────

test.describe("GET /searchForWord", () => {
  test.it("returns matching songs newest-listened first, with occurrence counts", async (t) => {
    const { client, id } = await withApp(t);
    const res = await client.get("/searchForWord?q=door");

    assert.equal(res.status, 200);
    assert.equal(res.body.query, "door");
    assert.equal(res.body.count, 2);
    assert.deepEqual(res.body.results[0], {
      id: id(0),
      artist: "Aurora Vale",
      track: "Open Door",
      album: "First Light",
      uri: "spotify:track:s1",
      playCount: 30,
      streamCount: 24,
      inLibrary: true,
      playlists: ["Morning"],
      snippet: res.body.results[0].snippet,
      occurrences: 2,
    });
    assert.match(res.body.results[0].snippet, /\[\[door\]\]/i);
  });

  test.it("counts stemmed matches too — 'door' finds the song that says 'doors'", async (t) => {
    const { client } = await withApp(t);
    const res = await client.get("/searchForWord?q=door");
    const plural = res.body.results.find((r) => r.track === "Two Doors Down");
    assert.ok(plural, "stemmed match missing");
    assert.equal(plural.occurrences, 2);
    assert.equal(plural.inLibrary, false);
    assert.deepEqual(plural.playlists, ["Morning", "Late Night"]);
  });

  test.it("returns an empty result set rather than a 404 when nothing matches", async (t) => {
    const { client } = await withApp(t);
    const res = await client.get("/searchForWord?q=xylophone");
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
    assert.deepEqual(res.body.results, []);
  });

  test.it("400s when q is missing or blank", async (t) => {
    const { client } = await withApp(t);
    for (const path of ["/searchForWord", "/searchForWord?q=", "/searchForWord?q=%20%20"]) {
      const res = await client.get(path);
      assert.equal(res.status, 400, path);
      assert.equal(res.body.error, "missing query parameter: q");
    }
  });

  test.it("400s when the query has no usable words", async (t) => {
    const { client } = await withApp(t);
    const res = await client.get('/searchForWord?q=%22%22');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "empty query");
  });

  test.it("400s (not 500s) when the store rejects the query", async (t) => {
    // The store is the thing that parses FTS syntax, so it is the thing that can
    // reject a query. The route must translate that into a client error.
    const store = tempStore();
    t.after(async () => store.close());
    store.searchByLyrics = () => {
      throw new Error("fts5: syntax error");
    };
    const app = createApp({ store, spotify: fakeSpotify() });
    const { client, close } = await startServer(app);
    t.after(close);

    const res = await client.get("/searchForWord?q=door");
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid query");
  });
});

// ── GET /song/:id ─────────────────────────────────────────────────────────

test.describe("GET /song/:id", () => {
  test.it("returns the song with its lyrics", async (t) => {
    const { client, id } = await withApp(t);
    const res = await client.get(`/song/${id(0)}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.artist, "Aurora Vale");
    assert.equal(res.body.track, "Open Door");
    assert.equal(res.body.album, "First Light");
    assert.equal(res.body.playCount, 30);
    assert.equal(res.body.streamCount, 24);
    assert.equal(res.body.minutesPlayed, 90);
    assert.equal(res.body.inLibrary, true);
    assert.deepEqual(res.body.playlists, ["Morning"]);
    assert.equal(res.body.lyricsStatus, "ok");
    assert.match(res.body.lyrics, /opened the door/);
  });

  test.it("reports 'pending' for a song whose lyrics were never fetched", async (t) => {
    const { client, id } = await withApp(t);
    const res = await client.get(`/song/${id(5)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.lyricsStatus, "pending");
    assert.equal(res.body.lyrics, null);
  });

  test.it("reports instrumental with no lyric body", async (t) => {
    const { client, id } = await withApp(t);
    const res = await client.get(`/song/${id(3)}`);
    assert.equal(res.body.lyricsStatus, "instrumental");
    assert.equal(res.body.lyrics, null);
  });

  test.it("404s for an unknown id", async (t) => {
    const { client } = await withApp(t);
    const res = await client.get("/song/999999");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "not found" });
  });
});

// ── GET /topWords ─────────────────────────────────────────────────────────

test.describe("GET /topWords", () => {
  test.it("aggregates words across songs that have lyrics", async (t) => {
    const { client } = await withApp(t);
    const res = await client.get("/topWords");

    assert.equal(res.status, 200);
    assert.equal(res.body.songsWithLyrics, 3);

    const byWord = Object.fromEntries(res.body.words.map((w) => [w.word, w]));
    assert.deepEqual(byWord.door, { word: "door", songs: 1, plays: 30 });
    assert.deepEqual(byWord.window, { word: "window", songs: 1, plays: 5 });
  });

  test.it("does not stem — 'door' and 'doors' are counted as different words", async (t) => {
    // Deliberate: the search index stems so you find songs, but the word report
    // shows what people actually sing.
    const { client } = await withApp(t);
    const { words } = (await client.get("/topWords")).body;
    const found = words.map((w) => w.word);
    assert.ok(found.includes("door"));
    assert.ok(found.includes("doors"));
  });

  test.it("drops stopwords", async (t) => {
    const { client } = await withApp(t);
    const { words } = (await client.get("/topWords")).body;
    const found = words.map((w) => w.word);
    for (const stop of ["the", "and", "was", "into", "down", "all"]) {
      assert.ok(!found.includes(stop), `stopword "${stop}" leaked into the report`);
    }
  });

  test.it("honours ?limit and caps it at 300", async (t) => {
    const { client } = await withApp(t);
    assert.equal((await client.get("/topWords?limit=3")).body.words.length, 3);
    assert.ok((await client.get("/topWords?limit=99999")).body.words.length <= 300);
  });

  test.it("serves a cached report until the lyric count changes", async (t) => {
    const { client, store, id } = await withApp(t);
    const before = (await client.get("/topWords")).body;

    await store.saveLyrics(id(5), {
      status: "ok",
      source: "lrclib",
      body: "brand new vocabulary appears",
    });

    const after = (await client.get("/topWords")).body;
    assert.equal(before.songsWithLyrics, 3);
    assert.equal(after.songsWithLyrics, 4, "cache did not invalidate when a lyric was added");
    assert.ok(after.words.some((w) => w.word === "vocabulary"));
  });
});

// ── GET /stats ────────────────────────────────────────────────────────────

test.describe("GET /stats", () => {
  test.it("returns totals and top lists in the shape the UI renders", async (t) => {
    const { client, id } = await withApp(t);
    const res = await client.get("/stats");

    assert.equal(res.status, 200);
    assert.equal(res.body.tracks, 6);
    assert.equal(res.body.artists, 4);
    assert.equal(res.body.plays, 57);
    assert.equal(res.body.streams, 44);
    assert.equal(res.body.hours, 2); // 8,700,000 ms → 2.42 h → rounded

    assert.deepEqual(res.body.topSongs[0], {
      id: id(0),
      artist: "Aurora Vale",
      track: "Open Door",
      plays: 30,
      streams: 24,
      minutes: 90,
    });
    assert.deepEqual(res.body.topArtists[0], {
      artist: "Aurora Vale",
      songs: 2,
      plays: 30,
      streams: 24,
      hours: 1.5,
    });
  });

  test.it("survives an empty database without dividing by null", async (t) => {
    const { client } = await withApp(t, { seeded: false });
    const res = await client.get("/stats");
    assert.equal(res.status, 200);
    assert.equal(res.body.tracks, 0);
    assert.deepEqual(res.body.topSongs, []);
    assert.deepEqual(res.body.topArtists, []);
  });

  test.it("reports the window the numbers cover, once ingest has recorded it", async (t) => {
    // Spotify's standard export holds only the last 12 months. A stats page
    // that does not say so reads as all-time and is simply wrong, so the
    // coverage window ships with the numbers it qualifies.
    const { client, store } = await withApp(t);
    await store.setMeta({
      history_from: "2025-04-16",
      history_to: "2026-04-17",
      history_source: "account-data",
      skip_threshold_ms: 30000,
      ingested_at: "2026-07-27T10:00:00.000Z",
    });

    assert.deepEqual((await client.get("/stats")).body.coverage, {
      from: "2025-04-16",
      to: "2026-04-17",
      source: "account-data",
      skipThresholdSeconds: 30,
      ingestedAt: "2026-07-27T10:00:00.000Z",
    });
  });

  test.it("reports nulls rather than guessing when nothing has been ingested", async (t) => {
    const { client } = await withApp(t, { seeded: false });
    assert.deepEqual((await client.get("/stats")).body.coverage, {
      from: null,
      to: null,
      source: null,
      skipThresholdSeconds: null,
      ingestedAt: null,
    });
  });

  test.it("reports a custom skip threshold in seconds", async (t) => {
    const { client, store } = await withApp(t);
    await store.setMeta({ skip_threshold_ms: 10000 });
    assert.equal((await client.get("/stats")).body.coverage.skipThresholdSeconds, 10);
  });

  test.it("counts streams separately from plays", async (t) => {
    const { client } = await withApp(t);
    const res = await client.get("/stats");
    assert.ok(
      res.body.streams < res.body.plays,
      "the fixture has skipped plays, so streams must be lower"
    );
    assert.equal(res.body.plays - res.body.streams, 13);
  });
});

// ── GET /status ───────────────────────────────────────────────────────────

test.describe("GET /status", () => {
  test.it("reports ingest and lyric-fetch progress", async (t) => {
    const { client } = await withApp(t);
    const res = await client.get("/status");

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      tracks: 6,
      processed: 5,
      lyrics: { ok: 3, instrumental: 1, notfound: 1 },
    });
  });

  test.it("reports zero progress on a fresh database", async (t) => {
    const { client } = await withApp(t, { seeded: false });
    assert.deepEqual((await client.get("/status")).body, {
      tracks: 0,
      processed: 0,
      lyrics: {},
    });
  });
});

// ── Spotify auth routes ───────────────────────────────────────────────────

test.describe("GET /login", () => {
  test.it("redirects to Spotify with a state parameter", async (t) => {
    const { client } = await withApp(t);
    const res = await client.get("/login");

    assert.equal(res.status, 302);
    assert.match(res.location, /^https:\/\/accounts\.spotify\.com\/authorize\?state=[0-9a-f]{32}$/);
  });

  test.it("issues a different state each time (states are single-use)", async (t) => {
    const { client } = await withApp(t);
    const a = (await client.get("/login")).location;
    const b = (await client.get("/login")).location;
    assert.notEqual(a, b);
  });

  test.it("503s when Spotify credentials are not configured", async (t) => {
    const { client } = await withApp(t, { spotify: fakeSpotify({ configured: false }) });
    const res = await client.get("/login");
    assert.equal(res.status, 503);
    assert.match(res.text, /credentials missing/);
  });
});

test.describe("GET /callback", () => {
  /** Drive /login to obtain a state the server will accept. */
  async function login(client) {
    const res = await client.get("/login");
    return new URL(res.location).searchParams.get("state");
  }

  test.it("exchanges the code and redirects home", async (t) => {
    const { client, spotify } = await withApp(t);
    const state = await login(client);

    const res = await client.get(`/callback?code=abc123&state=${state}`);
    assert.equal(res.status, 302);
    assert.equal(res.location, "/");
    assert.deepEqual(spotify.calls.exchangeCode, ["abc123"]);
  });

  test.it("rejects a state it never issued", async (t) => {
    const { client, spotify } = await withApp(t);
    const res = await client.get("/callback?code=abc&state=forged");
    assert.equal(res.status, 400);
    assert.match(res.text, /Invalid or expired login state/);
    assert.deepEqual(spotify.calls.exchangeCode, [], "code must not be exchanged");
  });

  test.it("rejects a replayed state (CSRF protection is single-use)", async (t) => {
    const { client } = await withApp(t);
    const state = await login(client);

    assert.equal((await client.get(`/callback?code=a&state=${state}`)).status, 302);
    assert.equal((await client.get(`/callback?code=a&state=${state}`)).status, 400);
  });

  test.it("rejects a callback with no state at all", async (t) => {
    const { client } = await withApp(t);
    assert.equal((await client.get("/callback?code=abc")).status, 400);
  });

  test.it("surfaces a denial from Spotify", async (t) => {
    const { client } = await withApp(t);
    const res = await client.get("/callback?error=access_denied");
    assert.equal(res.status, 400);
    assert.match(res.text, /Spotify denied the request: access_denied/);
  });

  test.it("500s when the token exchange fails", async (t) => {
    const spotify = fakeSpotify({
      async exchangeCode() {
        throw new Error("spotify auth 400: invalid_grant");
      },
    });
    const { client } = await withApp(t, { spotify });
    const state = await login(client);

    const res = await client.get(`/callback?code=bad&state=${state}`);
    assert.equal(res.status, 500);
    assert.match(res.text, /Login failed: spotify auth 400: invalid_grant/);
  });
});

test.describe("GET /me", () => {
  test.it("reports a logged-out session", async (t) => {
    const { client } = await withApp(t);
    assert.deepEqual((await client.get("/me")).body, {
      configured: true,
      loggedIn: false,
      displayName: null,
      redirectUri: "http://127.0.0.1:3000/callback",
    });
  });

  test.it("reports the display name once logged in", async (t) => {
    const { client } = await withApp(t, { spotify: fakeSpotify().loggedIn() });
    const res = await client.get("/me");
    assert.equal(res.body.loggedIn, true);
    assert.equal(res.body.displayName, "Test User");
  });

  test.it("reports missing credentials so the UI can hide the login button", async (t) => {
    const { client } = await withApp(t, { spotify: fakeSpotify({ configured: false }) });
    assert.equal((await client.get("/me")).body.configured, false);
  });
});

test.describe("POST /logout", () => {
  test.it("clears the session", async (t) => {
    const spotify = fakeSpotify().loggedIn();
    const { client } = await withApp(t, { spotify });

    assert.deepEqual((await client.post("/logout")).body, { ok: true });
    assert.equal(spotify.calls.logout, 1);
    assert.equal((await client.get("/me")).body.loggedIn, false);
  });
});

// ── POST /createPlaylist ──────────────────────────────────────────────────

test.describe("POST /createPlaylist", () => {
  async function loggedInApp(t, overrides) {
    return withApp(t, { spotify: fakeSpotify(overrides).loggedIn() });
  }

  test.it("creates the playlist and adds every resolved track", async (t) => {
    const { client, spotify, id } = await loggedInApp(t);
    const res = await client.post("/createPlaylist", {
      name: "  Doors  ",
      isPublic: true,
      trackIds: [id(0), id(1)],
      query: "door",
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.added, 2);
    assert.equal(res.body.requested, 2);
    assert.deepEqual(res.body.missing, []);
    assert.equal(res.body.playlistUrl, "https://open.spotify.com/playlist/playlist-1");

    assert.deepEqual(spotify.calls.createPlaylist, [
      { name: "Doors", isPublic: true, description: 'Songs mentioning "door"' },
    ]);
    assert.equal(spotify.calls.addTracks.length, 1);
    assert.deepEqual(spotify.calls.addTracks[0].uris, [
      "spotify:track:s1",
      `spotify:track:resolved-${id(1)}`,
    ]);
  });

  test.it("prefers an explicit description over the generated one", async (t) => {
    const { client, spotify, id } = await loggedInApp(t);
    await client.post("/createPlaylist", {
      name: "Mine",
      trackIds: [id(0)],
      description: "hand written",
    });
    assert.equal(spotify.calls.createPlaylist[0].description, "hand written");
  });

  test.it("lists the songs it could not find, but still creates the playlist", async (t) => {
    const { client, id } = await loggedInApp(t, {
      async resolveUri(track) {
        return track.track === "Open Door" ? "spotify:track:s1" : null;
      },
    });
    const res = await client.post("/createPlaylist", {
      name: "Partial",
      trackIds: [id(0), id(1)],
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.added, 1);
    assert.equal(res.body.requested, 2);
    assert.deepEqual(res.body.missing, ["Kestrel Line — Two Doors Down"]);
  });

  test.it("422s without creating anything when nothing resolves", async (t) => {
    const { client, spotify, id } = await loggedInApp(t, {
      async resolveUri() {
        return null;
      },
    });
    const res = await client.post("/createPlaylist", {
      name: "Empty",
      trackIds: [id(0), id(1)],
    });

    assert.equal(res.status, 422);
    assert.match(res.body.error, /none of the selected songs/);
    assert.equal(res.body.missing.length, 2);
    assert.deepEqual(spotify.calls.createPlaylist, [], "no empty playlist should be created");
  });

  test.it("401s when not logged in", async (t) => {
    const { client, id } = await withApp(t);
    const res = await client.post("/createPlaylist", { name: "X", trackIds: [id(0)] });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "not logged in" });
  });

  test.it("401s when Spotify rejects the token mid-flight", async (t) => {
    const { client, id } = await loggedInApp(t, {
      async resolveUri() {
        const err = new Error("spotify rejected the token, log in again");
        err.code = "NO_AUTH";
        throw err;
      },
    });
    const res = await client.post("/createPlaylist", { name: "X", trackIds: [id(0)] });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /rejected the token/);
  });

  test.it("502s when Spotify fails for any other reason", async (t) => {
    const { client, id } = await loggedInApp(t, {
      async createPlaylist() {
        throw new Error("spotify 500: request failed");
      },
    });
    const res = await client.post("/createPlaylist", { name: "X", trackIds: [id(0)] });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /spotify 500/);
  });

  test.it("400s on a missing or blank name", async (t) => {
    const { client, id } = await loggedInApp(t);
    for (const name of [undefined, "", "   "]) {
      const res = await client.post("/createPlaylist", { name, trackIds: [id(0)] });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "playlist name is required");
    }
  });

  test.it("400s when no songs were selected", async (t) => {
    const { client } = await loggedInApp(t);
    for (const trackIds of [undefined, [], "not-an-array"]) {
      const res = await client.post("/createPlaylist", { name: "X", trackIds });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "no songs selected");
    }
  });

  test.it("400s on an empty body", async (t) => {
    const { client } = await loggedInApp(t);
    const res = await client.post("/createPlaylist", {});
    assert.equal(res.status, 400);
  });
});

// ── static frontend ───────────────────────────────────────────────────────

test.describe("static frontend", () => {
  test.it("serves index.html at /", async (t) => {
    const { client } = await withApp(t);
    const res = await client.get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(res.text, /<html/i);
  });

  test.it("404s an unknown path", async (t) => {
    const { client } = await withApp(t);
    assert.equal((await client.get("/nope")).status, 404);
  });
});
