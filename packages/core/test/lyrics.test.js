"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { searchLrclib, pickBest, fetchLyrics } = require("../src/lyrics");
const { mockFetch, json, status, instantTimers } = require("./helpers/mock-fetch");

const hit = (over = {}) => ({
  artistName: "Aurora Vale",
  trackName: "Open Door",
  plainLyrics: "I opened the door",
  instrumental: false,
  ...over,
});

test.describe("searchLrclib", () => {
  test.it("queries lrclib with the artist and title", async (t) => {
    const { calls } = mockFetch(t, [json([hit()])]);
    await searchLrclib("Aurora Vale", "Open Door");

    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, "https://lrclib.net/api/search");
    assert.equal(url.searchParams.get("artist_name"), "Aurora Vale");
    assert.equal(url.searchParams.get("track_name"), "Open Door");
    assert.match(calls[0].init.headers["User-Agent"], /spotify-lyrics-search/);
  });

  test.it("returns the parsed results", async (t) => {
    mockFetch(t, [json([hit()])]);
    const results = await searchLrclib("A", "B");
    assert.equal(results.length, 1);
    assert.equal(results[0].trackName, "Open Door");
  });

  test.it("treats 404 as 'no results', not an error", async (t) => {
    mockFetch(t, [status(404)]);
    assert.deepEqual(await searchLrclib("A", "B"), []);
  });

  test.it("retries a 429 instead of recording it as a permanent miss", async (t) => {
    // This is the bug that motivated the backoff: a first bulk run cached 3057
    // rate-limit responses as permanent errors.
    instantTimers(t);
    const { calls } = mockFetch(t, [status(429), status(429), json([hit()])]);

    const results = await searchLrclib("A", "B");
    assert.equal(results.length, 1);
    assert.equal(calls.length, 3);
  });

  test.it("retries a 503", async (t) => {
    instantTimers(t);
    const { calls } = mockFetch(t, [status(503), json([hit()])]);
    assert.equal((await searchLrclib("A", "B")).length, 1);
    assert.equal(calls.length, 2);
  });

  test.it("retries a network failure", async (t) => {
    instantTimers(t);
    const { calls } = mockFetch(t, [new TypeError("fetch failed"), json([hit()])]);
    assert.equal((await searchLrclib("A", "B")).length, 1);
    assert.equal(calls.length, 2);
  });

  test.it("gives up after 4 retries and says which status it saw", async (t) => {
    instantTimers(t);
    const { calls } = mockFetch(t, () => status(503));
    await assert.rejects(() => searchLrclib("A", "B"), /lrclib 503 after 4 retries/);
    assert.equal(calls.length, 5, "one initial attempt plus four retries");
  });

  test.it("fails fast on a client error — retrying will not help", async (t) => {
    instantTimers(t);
    const { calls } = mockFetch(t, [status(400)]);
    await assert.rejects(() => searchLrclib("A", "B"), /lrclib 400/);
    assert.equal(calls.length, 1, "a 400 must not be retried");
  });
});

test.describe("pickBest", () => {
  test.it("prefers an exact artist and title match", () => {
    const exact = hit();
    const other = hit({ artistName: "Someone Else", trackName: "Different" });
    assert.equal(pickBest([other, exact], "Aurora Vale", "Open Door"), exact);
  });

  test.it("accepts a partial match on both fields", () => {
    const partial = hit({ artistName: "Aurora Vale & Friends", trackName: "Open Door (Reprise)" });
    assert.equal(pickBest([partial], "Aurora Vale", "Open Door"), partial);
  });

  test.it("accepts an exact title even when the artist is wrong", () => {
    // Deliberately lenient, and NOT the same rule as spotify.pickMatch (which
    // demands a signal on both fields). fetchLyrics falls back to an
    // artist-less search when the first one misses, and in those results the
    // artist can never match — so requiring both fields would make that
    // fallback dead code. Lyrics are also the same text whoever recorded them,
    // so a wrong-artist hit is far less harmful here than it is when picking a
    // URI to drop into someone's playlist.
    const wrongArtist = hit({ artistName: "Completely Different Band" });
    assert.equal(pickBest([wrongArtist], "Aurora Vale", "Open Door"), wrongArtist);
  });

  test.it("accepts an exact artist even when the title is wrong", () => {
    const wrongTitle = hit({ trackName: "A Totally Other Song" });
    assert.equal(pickBest([wrongTitle], "Aurora Vale", "Open Door"), wrongTitle);
  });

  test.it("rejects a weak partial match on a single field", () => {
    // Partial-on-one scores 2 (+1 for having lyrics) and falls under the
    // threshold of 4 — this is the floor that stops arbitrary songs matching.
    const weak = hit({ artistName: "Nobody", trackName: "Open Door Policy Blues" });
    assert.equal(pickBest([weak], "Aurora Vale", "Doo"), null);
  });

  test.it("breaks a tie in favour of the result that actually has lyrics", () => {
    const empty = hit({ plainLyrics: null });
    const full = hit();
    assert.equal(pickBest([empty, full], "Aurora Vale", "Open Door"), full);
  });

  test.it("ignores case and accents when comparing", () => {
    const accented = hit({ artistName: "AURORA VÁLE", trackName: "open door" });
    assert.equal(pickBest([accented], "Aurora Vale", "Open Door"), accented);
  });

  test.it("returns null for no results", () => {
    assert.equal(pickBest([], "A", "B"), null);
  });
});

test.describe("fetchLyrics", () => {
  test.it("returns ok with the lyric body on a good match", async (t) => {
    mockFetch(t, [json([hit()])]);
    assert.deepEqual(await fetchLyrics("Aurora Vale", "Open Door"), {
      status: "ok",
      source: "lrclib",
      body: "I opened the door",
    });
  });

  test.it("searches with the cleaned title, not the raw one", async (t) => {
    // lrclib has never heard of "- 2020 Remaster".
    const { calls } = mockFetch(t, [json([hit()])]);
    await fetchLyrics("Aurora Vale", "Open Door - 2020 Remaster");
    assert.equal(new URL(calls[0].url).searchParams.get("track_name"), "Open Door");
  });

  test.it("retries with a title-only search when the artist spelling differs", async (t) => {
    const { calls } = mockFetch(t, [
      json([]), // artist+title finds nothing
      json([hit({ artistName: "Aurora Vale" })]),
    ]);
    const result = await fetchLyrics("Aurora  Vale", "Open Door");

    assert.equal(result.status, "ok");
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[1].url).searchParams.get("artist_name"), "");
  });

  test.it("reports notfound when neither search matches", async (t) => {
    mockFetch(t, [json([]), json([])]);
    assert.deepEqual(await fetchLyrics("A", "B"), {
      status: "notfound",
      source: null,
      body: null,
    });
  });

  test.it("reports notfound when results exist but none are the right song", async (t) => {
    const wrong = hit({ artistName: "Other", trackName: "Other" });
    mockFetch(t, [json([wrong]), json([wrong])]);
    assert.equal((await fetchLyrics("A", "B")).status, "notfound");
  });

  test.it("reports instrumental when lrclib flags the track", async (t) => {
    mockFetch(t, [json([hit({ instrumental: true, plainLyrics: null })])]);
    assert.deepEqual(await fetchLyrics("Aurora Vale", "Open Door"), {
      status: "instrumental",
      source: "lrclib",
      body: null,
    });
  });

  test.it("reports instrumental when the match has no plain lyrics", async (t) => {
    mockFetch(t, [json([hit({ plainLyrics: "" })])]);
    assert.equal((await fetchLyrics("Aurora Vale", "Open Door")).status, "instrumental");
  });

  test.it("throws on API failure — the host decides to record that as an error", async (t) => {
    instantTimers(t);
    mockFetch(t, [status(400)]);
    await assert.rejects(() => fetchLyrics("A", "B"), /lrclib 400/);
  });
});
