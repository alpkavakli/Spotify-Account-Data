"use strict";

// core/spotify.js is the one module that has never run against the real API —
// registering a Spotify app is Phase 2 work. These tests are what stands in for
// that until then: they pin the exact requests it builds and the exact way it
// handles every documented failure mode.

const test = require("node:test");
const assert = require("node:assert/strict");

const spotify = require("../src/spotify");
const { mockFetch, json, status, instantTimers } = require("./helpers/mock-fetch");

const CREDS = { clientId: "id123", clientSecret: "secret456" };

const track = (over = {}) => ({
  uri: "spotify:track:abc",
  name: "Open Door",
  artists: [{ name: "Aurora Vale" }],
  ...over,
});

test.describe("authorizeUrl", () => {
  test.it("builds the OAuth authorize URL with every required parameter", () => {
    const url = new URL(
      spotify.authorizeUrl({
        clientId: "id123",
        redirectUri: "http://127.0.0.1:3000/callback",
        scopes: ["playlist-modify-public", "playlist-modify-private"],
        state: "abc",
      })
    );

    assert.equal(url.origin + url.pathname, "https://accounts.spotify.com/authorize");
    assert.equal(url.searchParams.get("client_id"), "id123");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:3000/callback");
    assert.equal(
      url.searchParams.get("scope"),
      "playlist-modify-public playlist-modify-private",
      "Spotify wants scopes space-separated in one parameter"
    );
    assert.equal(url.searchParams.get("state"), "abc");
  });
});

test.describe("token requests", () => {
  test.it("exchanges a code using HTTP Basic auth and a form body", async (t) => {
    const { calls } = mockFetch(t, [json({ access_token: "at", expires_in: 3600 })]);
    const tok = await spotify.exchangeCode({
      ...CREDS,
      redirectUri: "http://127.0.0.1:3000/callback",
      code: "the-code",
    });

    assert.equal(tok.access_token, "at");
    assert.equal(calls[0].url, "https://accounts.spotify.com/api/token");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(
      calls[0].init.headers.Authorization,
      "Basic " + Buffer.from("id123:secret456").toString("base64")
    );
    assert.equal(
      calls[0].init.headers["Content-Type"],
      "application/x-www-form-urlencoded"
    );

    const body = new URLSearchParams(calls[0].init.body.toString());
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "the-code");
    assert.equal(body.get("redirect_uri"), "http://127.0.0.1:3000/callback");
  });

  test.it("refreshes a token with the refresh grant", async (t) => {
    const { calls } = mockFetch(t, [json({ access_token: "new" })]);
    await spotify.refreshAccessToken({ ...CREDS, refreshToken: "rt" });

    const body = new URLSearchParams(calls[0].init.body.toString());
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "rt");
  });

  test.it("surfaces Spotify's description when auth fails", async (t) => {
    mockFetch(t, [json({ error: "invalid_grant", error_description: "code expired" }, 400)]);
    await assert.rejects(
      () => spotify.exchangeCode({ ...CREDS, redirectUri: "x", code: "bad" }),
      /spotify auth 400: code expired/
    );
  });

  test.it("still throws usefully when the error body is not JSON", async (t) => {
    mockFetch(t, [new Response("<html>gateway</html>", { status: 502 })]);
    await assert.rejects(
      () => spotify.refreshAccessToken({ ...CREDS, refreshToken: "rt" }),
      /spotify auth 502: unknown/
    );
  });
});

test.describe("API requests", () => {
  test.it("sends the bearer token", async (t) => {
    const { calls } = mockFetch(t, [json({ id: "u1", display_name: "Alp" })]);
    const me = await spotify.getMe("token-abc");

    assert.equal(me.id, "u1");
    assert.equal(calls[0].url, "https://api.spotify.com/v1/me");
    assert.equal(calls[0].init.headers.Authorization, "Bearer token-abc");
  });

  test.it("tags a 401 with NO_AUTH so the host can ask for a fresh login", async (t) => {
    mockFetch(t, [status(401)]);
    await assert.rejects(() => spotify.getMe("expired"), (err) => {
      assert.equal(err.code, "NO_AUTH");
      assert.match(err.message, /log in again/);
      return true;
    });
  });

  test.it("honours Retry-After on a 429 and repeats the request", async (t) => {
    // Spotify asks callers to back off rather than fail; creating a 300-song
    // playlist reliably hits this.
    instantTimers(t);
    const { calls } = mockFetch(t, [
      status(429, { "retry-after": "1" }),
      json({ id: "u1" }),
    ]);

    assert.equal((await spotify.getMe("t")).id, "u1");
    assert.equal(calls.length, 2);
  });

  test.it("returns null for 204 No Content instead of failing to parse it", async (t) => {
    mockFetch(t, [new Response(null, { status: 204 })]);
    assert.equal(await spotify.getMe("t"), null);
  });

  test.it("surfaces Spotify's error message on other failures", async (t) => {
    mockFetch(t, [json({ error: { status: 404, message: "Non existing id" } }, 404)]);
    await assert.rejects(() => spotify.getMe("t"), /spotify 404: Non existing id/);
  });
});

test.describe("pickMatch", () => {
  test.it("takes an exact artist and title match", () => {
    const right = track();
    const wrong = track({ uri: "spotify:track:x", name: "Other", artists: [{ name: "Other" }] });
    assert.equal(spotify.pickMatch([wrong, right], "Aurora Vale", "Open Door"), right);
  });

  test.it("requires a real signal on both fields, not one strong one", () => {
    // Threshold 6 means exact-on-one + partial-on-the-other at minimum. A
    // perfect title match with an unrelated artist scores 4 and is refused —
    // otherwise a cover or a karaoke version lands in the user's playlist.
    const titleOnly = track({ artists: [{ name: "Karaoke Allstars" }] });
    assert.equal(spotify.pickMatch([titleOnly], "Aurora Vale", "Open Door"), null);

    const artistOnly = track({ name: "A Completely Other Song" });
    assert.equal(spotify.pickMatch([artistOnly], "Aurora Vale", "Open Door"), null);
  });

  test.it("accepts exact artist plus partial title", () => {
    const partial = track({ name: "Open Door (Radio Edit)" });
    assert.ok(spotify.pickMatch([partial], "Aurora Vale", "Open Door"));
  });

  test.it("matches any of a track's artists, not just the first", () => {
    const collab = track({ artists: [{ name: "Someone Else" }, { name: "Aurora Vale" }] });
    assert.equal(spotify.pickMatch([collab], "Aurora Vale", "Open Door"), collab);
  });

  test.it("skips entries with no URI — an unplayable result is useless", () => {
    const noUri = track({ uri: null });
    assert.equal(spotify.pickMatch([noUri], "Aurora Vale", "Open Door"), null);
  });

  test.it("tolerates nulls in the results array", () => {
    assert.equal(spotify.pickMatch([null, undefined], "A", "B"), null);
    assert.equal(spotify.pickMatch([], "A", "B"), null);
  });
});

test.describe("searchTrackUri", () => {
  test.it("searches field-scoped first and returns the matched URI", async (t) => {
    const { calls } = mockFetch(t, [json({ tracks: { items: [track()] } })]);
    const uri = await spotify.searchTrackUri("t", {
      artist: "Aurora Vale",
      track: "Open Door",
    });

    assert.equal(uri, "spotify:track:abc");
    const q = new URL(calls[0].url).searchParams.get("q");
    assert.equal(q, "track:Open Door artist:Aurora Vale");
    assert.match(calls[0].url, /type=track/);
  });

  test.it("searches with the cleaned title", async (t) => {
    const { calls } = mockFetch(t, [json({ tracks: { items: [track()] } })]);
    await spotify.searchTrackUri("t", {
      artist: "Aurora Vale",
      track: "Open Door - 2020 Remaster",
    });
    assert.match(new URL(calls[0].url).searchParams.get("q"), /^track:Open Door /);
  });

  test.it("falls back to a free-text search when the scoped one finds nothing", async (t) => {
    // Field-scoped search is strict; plenty of real titles only match loosely.
    const { calls } = mockFetch(t, [
      json({ tracks: { items: [] } }),
      json({ tracks: { items: [track()] } }),
    ]);
    const uri = await spotify.searchTrackUri("t", {
      artist: "Aurora Vale",
      track: "Open Door",
    });

    assert.equal(uri, "spotify:track:abc");
    assert.equal(calls.length, 2);
    assert.equal(
      new URL(calls[1].url).searchParams.get("q"),
      "Open Door Aurora Vale"
    );
  });

  test.it("returns null when nothing matches well enough", async (t) => {
    const bad = json({ tracks: { items: [track({ artists: [{ name: "Nope" }] })] } });
    mockFetch(t, [bad, json({ tracks: { items: [] } })]);
    assert.equal(
      await spotify.searchTrackUri("t", { artist: "Aurora Vale", track: "Open Door" }),
      null
    );
  });

  test.it("swallows a search failure as 'not found' — one bad lookup must not kill the playlist", async (t) => {
    mockFetch(t, [json({ error: { message: "boom" } }, 500)]);
    assert.equal(await spotify.searchTrackUri("t", { artist: "A", track: "B" }), null);
  });

  test.it("but rethrows NO_AUTH, because every later lookup would fail too", async (t) => {
    mockFetch(t, [status(401)]);
    await assert.rejects(
      () => spotify.searchTrackUri("expired", { artist: "A", track: "B" }),
      (err) => err.code === "NO_AUTH"
    );
  });
});

test.describe("createPlaylist", () => {
  test.it("posts to the user's playlists endpoint", async (t) => {
    const { calls } = mockFetch(t, [json({ id: "p1", name: "Doors" })]);
    const playlist = await spotify.createPlaylist("t", "u1", {
      name: "Doors",
      isPublic: true,
      description: "songs about doors",
    });

    assert.equal(playlist.id, "p1");
    assert.equal(calls[0].url, "https://api.spotify.com/v1/users/u1/playlists");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      name: "Doors",
      public: true,
      description: "songs about doors",
    });
  });

  test.it("url-encodes a user id with unusual characters", async (t) => {
    const { calls } = mockFetch(t, [json({ id: "p1" })]);
    await spotify.createPlaylist("t", "user name/x", { name: "N" });
    assert.match(calls[0].url, /\/users\/user%20name%2Fx\/playlists$/);
  });

  test.it("defaults to a private playlist with an empty description", async (t) => {
    const { calls } = mockFetch(t, [json({ id: "p1" })]);
    await spotify.createPlaylist("t", "u1", { name: "N" });
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      name: "N",
      public: false,
      description: "",
    });
  });
});

test.describe("addTracks", () => {
  test.it("adds the tracks in one request when they fit", async (t) => {
    const { calls } = mockFetch(t, [json({ snapshot_id: "s" })]);
    await spotify.addTracks("t", "p1", ["spotify:track:a", "spotify:track:b"]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.spotify.com/v1/playlists/p1/tracks");
    assert.deepEqual(JSON.parse(calls[0].init.body).uris, [
      "spotify:track:a",
      "spotify:track:b",
    ]);
  });

  test.it("splits into batches of 100, which is Spotify's hard cap", async (t) => {
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:${i}`);
    const { calls } = mockFetch(t, () => json({ snapshot_id: "s" }));
    await spotify.addTracks("t", "p1", uris);

    assert.equal(calls.length, 3);
    const sent = calls.map((c) => JSON.parse(c.init.body).uris);
    assert.deepEqual(sent.map((b) => b.length), [100, 100, 50]);
    assert.deepEqual(sent.flat(), uris, "every uri must be sent, in order, exactly once");
  });

  test.it("does nothing when there is nothing to add", async (t) => {
    const { calls } = mockFetch(t, []);
    await spotify.addTracks("t", "p1", []);
    assert.equal(calls.length, 0);
  });
});
