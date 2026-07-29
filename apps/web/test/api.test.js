"use strict";

// End-to-end tests for the hosted API: a real Express server on a random port,
// a real Postgres, a real blob directory. Only email is faked, and only because
// it leaves the machine.
//
// The emphasis is different from the Personal Edition's route tests. There, the
// risk is "does this return the right JSON". Here it is "can one signed-in user
// reach another user's data", so almost every route is exercised twice — once
// as the owner, once as somebody else.

const test = require("node:test");
const assert = require("node:assert/strict");

const { SONGS, seed } = require("@lyricsearch/core/testing/fixtures");
const { PostgresAdapter } = require("../src/postgres-adapter");
const { skipWithoutPostgres, freshDatabase } = require("./helpers/pg");
const { startApi, makeClient, signIn, cleanupBlobDirs } = require("./helpers/api");
const { SESSION_COOKIE, MAX_LINKS_PER_HOUR, hashToken } = require("../src/auth");

const skip = skipWithoutPostgres();

test.describe("hosted API", { skip }, () => {
  let pool;
  let api;

  test.before(async () => {
    pool = await freshDatabase("api");
    api = await startApi(pool);
  });

  test.after(async () => {
    await api?.close();
    await pool?.end();
    cleanupBlobDirs();
  });

  test.beforeEach(async () => {
    await pool.query("TRUNCATE users, songs, login_tokens RESTART IDENTITY CASCADE");
    api.mailer.sent.length = 0;
  });

  const anon = () => makeClient(api.baseUrl);

  /** The user id behind a signed-in client, so tests can seed their library. */
  async function userIdOf(email) {
    const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    return rows[0].id;
  }

  // ── health ──────────────────────────────────────────────────────────────

  test.describe("GET /health", () => {
    test.it("reports the database is reachable", async () => {
      assert.deepEqual((await anon().get("/health")).body, { ok: true });
    });
  });

  // ── sign-in ─────────────────────────────────────────────────────────────

  test.describe("passwordless sign-in", () => {
    test.it("emails a working sign-in link", async () => {
      const client = anon();
      const res = await client.post("/auth/request-link", { email: "new@example.com" });
      assert.equal(res.status, 200);

      const mail = api.mailer.lastTo("new@example.com");
      assert.ok(mail, "no email was sent");
      assert.match(mail.text, /\/auth\/callback\?token=/);
    });

    test.it("creates the account the first time the link is used", async () => {
      const client = await signIn(api, "first@example.com");
      const me = await client.get("/me");
      assert.equal(me.body.signedIn, true);
      assert.equal(me.body.email, "first@example.com");
    });

    test.it("signs an existing user back in rather than duplicating them", async () => {
      await signIn(api, "again@example.com");
      await signIn(api, "again@example.com");
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM users WHERE email = $1",
        ["again@example.com"]
      );
      assert.equal(rows[0].n, 1);
    });

    test.it("treats the address case-insensitively", async () => {
      await signIn(api, "case@example.com");
      await signIn(api, "CASE@example.com");
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
      assert.equal(rows[0].n, 1, "differently-cased emails must be one account");
    });

    test.it("answers identically for known and unknown addresses", async () => {
      // Otherwise this endpoint answers "does this person have an account here?"
      await signIn(api, "known@example.com");
      const known = await anon().post("/auth/request-link", { email: "known@example.com" });
      const unknown = await anon().post("/auth/request-link", { email: "nobody@example.com" });
      assert.equal(known.status, unknown.status);
      assert.deepEqual(known.body, unknown.body);
    });

    test.it("never stores the raw token", async () => {
      // A database dump must not be a set of working login links.
      const client = anon();
      await client.post("/auth/request-link", { email: "hash@example.com" });
      const token = new URL(
        api.mailer.lastTo("hash@example.com").text.match(/https?:\/\/\S+/)[0]
      ).searchParams.get("token");

      const { rows } = await pool.query("SELECT token_hash FROM login_tokens");
      assert.equal(rows.length, 1);
      assert.ok(Buffer.isBuffer(rows[0].token_hash));
      assert.ok(!rows[0].token_hash.toString("utf8").includes(token));
      assert.deepEqual(rows[0].token_hash, hashToken(token));
    });

    test.it("makes a link single-use", async () => {
      const client = anon();
      await client.post("/auth/request-link", { email: "once@example.com" });
      const token = new URL(
        api.mailer.lastTo("once@example.com").text.match(/https?:\/\/\S+/)[0]
      ).searchParams.get("token");

      assert.equal((await client.get(`/auth/callback?token=${token}`)).status, 200);
      const second = await anon().get(`/auth/callback?token=${token}`);
      assert.equal(second.status, 400);
      assert.match(second.body.error, /invalid, expired, or already used/);
    });

    test.it("rejects an expired link", async () => {
      const client = anon();
      await client.post("/auth/request-link", { email: "stale@example.com" });
      await pool.query("UPDATE login_tokens SET expires_at = now() - interval '1 minute'");
      const token = new URL(
        api.mailer.lastTo("stale@example.com").text.match(/https?:\/\/\S+/)[0]
      ).searchParams.get("token");

      assert.equal((await client.get(`/auth/callback?token=${token}`)).status, 400);
    });

    test.it("rejects a forged or missing token", async () => {
      assert.equal((await anon().get("/auth/callback?token=made-up")).status, 400);
      assert.equal((await anon().get("/auth/callback")).status, 400);
    });

    test.it("rejects an address that is not an address", async () => {
      for (const email of ["", "  ", "nope", "a@b", "@example.com", null, 42]) {
        const res = await anon().post("/auth/request-link", { email });
        assert.equal(res.status, 400, JSON.stringify(email));
      }
    });

    test.it("rate-limits links per address", async () => {
      // Without this, anyone can use our mail server to flood an inbox.
      const client = anon();
      for (let i = 0; i < MAX_LINKS_PER_HOUR + 3; i++) {
        await client.post("/auth/request-link", { email: "flood@example.com" });
      }
      assert.equal(api.mailer.sent.length, MAX_LINKS_PER_HOUR);
    });

    test.it("rate-limits one address without affecting another", async () => {
      const client = anon();
      for (let i = 0; i < MAX_LINKS_PER_HOUR + 2; i++) {
        await client.post("/auth/request-link", { email: "noisy@example.com" });
      }
      await client.post("/auth/request-link", { email: "quiet@example.com" });
      assert.ok(api.mailer.lastTo("quiet@example.com"));
    });
  });

  // ── clicking the link in a browser ──────────────────────────────────────

  // The one route a person reaches by hand, from their inbox, rather than
  // through our own JavaScript. It answers a browser with a redirect and an API
  // client with JSON, told apart by the literal `text/html` that browsers put in
  // Accept and `fetch` (Accept: */*) does not. Everything else in this file
  // speaks as an API client, so without these tests that whole branch is unrun.
  test.describe("GET /auth/callback from a browser", () => {
    // What a browser actually sends. The `text/html` is the entire signal.
    const BROWSER = {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    /** Ask for a link and pull the token back out of the email. */
    async function linkToken(client, email) {
      await client.post("/auth/request-link", { email });
      const message = api.mailer.lastTo(email);
      return new URL(message.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
    }

    test.it("redirects to the app instead of showing a page of JSON", async () => {
      const client = anon();
      const token = await linkToken(client, "browser@example.com");

      const res = await client.get(`/auth/callback?token=${token}`, { headers: BROWSER });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/app");
    });

    test.it("signs the browser in on the way past", async () => {
      // The bug this exists for: a redirect that forgets to set the cookie
      // still looks right — 302 to /app — and then bounces the user straight
      // back to /signin, because the page they land on sees no session.
      const client = anon();
      const token = await linkToken(client, "landing@example.com");

      const res = await client.get(`/auth/callback?token=${token}`, { headers: BROWSER });
      assert.match(res.headers.getSetCookie().join("; "), new RegExp(SESSION_COOKIE));

      const me = await client.get("/me");
      assert.equal(me.body.signedIn, true);
      assert.equal(me.body.email, "landing@example.com");
    });

    test.it("sends a dead link back to sign-in with a reason to show", async () => {
      // A browser must never be shown `{"error":…}`. The message travels in the
      // query string because there is no session yet to hang a flash message on.
      const res = await anon().get("/auth/callback?token=made-up", { headers: BROWSER });
      assert.equal(res.status, 302);

      const location = new URL(res.headers.get("location"), api.baseUrl);
      assert.equal(location.pathname, "/signin");
      assert.match(location.searchParams.get("error"), /invalid, expired, or already used/);
    });

    test.it("redirects a browser that reuses a link rather than 400ing at it", async () => {
      const client = anon();
      const token = await linkToken(client, "reuse@example.com");
      await client.get(`/auth/callback?token=${token}`, { headers: BROWSER });

      const second = await anon().get(`/auth/callback?token=${token}`, { headers: BROWSER });
      assert.equal(second.status, 302);
      assert.match(second.headers.get("location"), /^\/signin\?error=/);
    });

    test.it("still answers an API client with JSON", async () => {
      // The redirect was added after the JSON contract existed. This is the
      // guard that adding it did not quietly break every non-browser caller.
      const client = anon();
      const token = await linkToken(client, "api-client@example.com");

      const res = await client.get(`/auth/callback?token=${token}`, {
        headers: { Accept: "*/*" },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, isNewUser: true });
    });

    test.it("still answers an API client with a 400 on a dead link", async () => {
      const res = await anon().get("/auth/callback?token=made-up", {
        headers: { Accept: "application/json" },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /invalid, expired, or already used/);
    });
  });

  // ── sessions ────────────────────────────────────────────────────────────

  test.describe("sessions", () => {
    test.it("sets an httpOnly, sameSite cookie", async () => {
      // httpOnly is what stops any XSS from becoming account takeover.
      const client = anon();
      await client.post("/auth/request-link", { email: "cookie@example.com" });
      const token = new URL(
        api.mailer.lastTo("cookie@example.com").text.match(/https?:\/\/\S+/)[0]
      ).searchParams.get("token");
      const res = await client.get(`/auth/callback?token=${token}`);

      const setCookie = res.headers.getSetCookie().join("; ");
      assert.match(setCookie, new RegExp(SESSION_COOKIE));
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
    });

    test.it("stores only a hash of the session token", async () => {
      const client = await signIn(api, "sess@example.com");
      const raw = client.cookies().get(SESSION_COOKIE);
      const { rows } = await pool.query("SELECT token_hash FROM sessions");
      assert.deepEqual(rows[0].token_hash, hashToken(raw));
    });

    test.it("reports signed out with no cookie", async () => {
      assert.deepEqual((await anon().get("/me")).body, { signedIn: false });
    });

    test.it("ignores a forged session cookie", async () => {
      const client = anon();
      const res = await client.get("/me", { headers: { Cookie: `${SESSION_COOKIE}=forged` } });
      assert.equal(res.body.signedIn, false);
    });

    test.it("ignores an expired session", async () => {
      const client = await signIn(api, "expired@example.com");
      await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
      assert.equal((await client.get("/me")).body.signedIn, false);
    });

    test.it("logs out, and the old cookie stops working", async () => {
      const client = await signIn(api, "out@example.com");
      const stale = client.cookies().get(SESSION_COOKIE);

      assert.equal((await client.post("/auth/logout")).status, 200);
      assert.equal((await client.get("/me")).body.signedIn, false);

      // Replaying the token the browser used to hold must also fail — logout
      // has to delete the session server-side, not just clear the cookie.
      const replay = await anon().get("/me", {
        headers: { Cookie: `${SESSION_COOKIE}=${stale}` },
      });
      assert.equal(replay.body.signedIn, false);
    });

    test.it("logging out twice is not an error", async () => {
      const client = await signIn(api, "twice@example.com");
      await client.post("/auth/logout");
      assert.equal((await client.post("/auth/logout")).status, 200);
    });
  });

  // ── everything private requires a session ───────────────────────────────

  test.describe("authentication is required", () => {
    const PRIVATE = [
      ["GET", "/searchForWord?q=door"],
      ["GET", "/song/1"],
      ["GET", "/topWords"],
      ["GET", "/stats"],
      ["GET", "/status"],
      ["GET", "/uploads"],
      ["POST", "/uploads"],
      ["DELETE", "/me"],
    ];

    test.it("401s every private route when signed out", async () => {
      const client = anon();
      for (const [method, path] of PRIVATE) {
        const res =
          method === "GET"
            ? await client.get(path)
            : method === "DELETE"
              ? await client.delete(path)
              : await client.post(path, {});
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.equal(res.body.error, "not signed in");
      }
    });

    test.it("404s an unknown path rather than leaking a stack trace", async () => {
      const res = await anon().get("/nope");
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: "not found" });
    });
  });

  // ── uploads ─────────────────────────────────────────────────────────────

  test.describe("uploads", () => {
    const zip = () => Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

    test.it("accepts a file and queues it for the worker", async () => {
      const client = await signIn(api, "up@example.com");
      const res = await client.upload("/uploads?filename=my_spotify_data.zip", zip());

      // 202, not 200: parsing happens in the worker, not in the request.
      assert.equal(res.status, 202);
      assert.equal(res.body.upload.status, "pending");
      assert.equal(res.body.upload.bytes, 8);
      assert.equal(res.body.upload.filename, "my_spotify_data.zip");
    });

    test.it("stores the bytes in the blob store, unchanged", async () => {
      const client = await signIn(api, "bytes@example.com");
      await client.upload("/uploads", zip());

      const { rows } = await pool.query("SELECT blob_key FROM uploads");
      assert.deepEqual(await api.blobStore.get(rows[0].blob_key), zip());
    });

    test.it("does not let the filename influence where the blob lands", async () => {
      // The filename is display metadata. If it reached the path, this is a
      // write to /etc.
      const client = await signIn(api, "traversal@example.com");
      await client.upload("/uploads?filename=" + encodeURIComponent("../../evil.zip"), zip());

      const { rows } = await pool.query("SELECT blob_key, filename FROM uploads");
      assert.equal(rows[0].filename, "../../evil.zip", "kept verbatim as metadata");
      assert.match(rows[0].blob_key, /^\d{4}-\d{2}\/[0-9a-f]{32}$/);
    });

    test.it("hands the upload to the worker", async () => {
      // The request only stores the file; parsing a 20k-row export belongs in
      // the worker, which is why the response is 202 and not 200.
      const client = await signIn(api, "queued@example.com");
      api.queue.parseUploads.length = 0;

      const res = await client.upload("/uploads", zip());
      assert.deepEqual(api.queue.parseUploads, [res.body.upload.id]);
    });

    test.it("does not enqueue anything when the upload is rejected", async () => {
      const client = await signIn(api, "notqueued@example.com");
      api.queue.parseUploads.length = 0;

      await client.upload("/uploads", Buffer.alloc(0));
      assert.deepEqual(api.queue.parseUploads, []);
    });

    test.it("rejects an empty body", async () => {
      const client = await signIn(api, "empty@example.com");
      const res = await client.upload("/uploads", Buffer.alloc(0));
      assert.equal(res.status, 400);
    });

    test.it("lists only your own uploads", async () => {
      const alice = await signIn(api, "alice.up@example.com");
      const bob = await signIn(api, "bob.up@example.com");

      await alice.upload("/uploads?filename=alice.zip", zip());
      await bob.upload("/uploads?filename=bob.zip", zip());

      const mine = await alice.get("/uploads");
      assert.equal(mine.body.uploads.length, 1);
      assert.equal(mine.body.uploads[0].filename, "alice.zip");
    });

    test.it("deleting the account removes its uploads", async () => {
      const client = await signIn(api, "gone@example.com");
      await client.upload("/uploads", zip());
      await client.delete("/me");

      const { rows } = await pool.query("SELECT count(*)::int AS n FROM uploads");
      assert.equal(rows[0].n, 0);
    });
  });

  // ── the read routes, on a seeded library ────────────────────────────────

  test.describe("search and stats", () => {
    let alice;
    let bob;
    let aliceIds;

    test.beforeEach(async () => {
      alice = await signIn(api, "reader@example.com");
      bob = await signIn(api, "other@example.com");
      // Seed alice's library directly through the adapter — uploads are not
      // processed until the worker exists (Step 6).
      const store = new PostgresAdapter(pool, { userId: await userIdOf("reader@example.com") });
      aliceIds = await seed(store);
    });

    test.it("finds songs by a word in their lyrics", async () => {
      const res = await alice.get("/searchForWord?q=door");
      assert.equal(res.status, 200);
      assert.equal(res.body.count, 2);
      assert.equal(res.body.results[0].track, "Open Door");
      assert.equal(res.body.results[0].playCount, 30);
      assert.equal(res.body.results[0].streamCount, 24);
      assert.deepEqual(res.body.results[0].playlists, ["Morning"]);
      assert.equal(res.body.results[0].occurrences, 2);
      assert.match(res.body.results[0].snippet, /\[\[door\]\]/i);
    });

    test.it("returns nothing for another user with the same query", async () => {
      const res = await bob.get("/searchForWord?q=door");
      assert.equal(res.status, 200);
      assert.equal(res.body.count, 0);
    });

    test.it("400s on a missing or unusable query", async () => {
      assert.equal((await alice.get("/searchForWord")).status, 400);
      assert.equal((await alice.get("/searchForWord?q=%20")).status, 400);
      assert.equal((await alice.get("/searchForWord?q=%22%22")).status, 400);
    });

    test.it("treats a search operator as a word, not a syntax error", async () => {
      for (const q of ["&", "|", "!", "(", ":*"]) {
        const res = await alice.get(`/searchForWord?q=${encodeURIComponent(q)}`);
        assert.equal(res.status, 200, `q=${q}`);
      }
    });

    test.it("returns one of your songs", async () => {
      const id = aliceIds.get(SONGS[0].match_key);
      const res = await alice.get(`/song/${id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.track, "Open Door");
      assert.equal(res.body.minutesPlayed, 90);
      assert.equal(res.body.lyricsStatus, "ok");
    });

    test.it("never returns the full lyric body", async () => {
      // The hosted service shows match + snippet only. Serving whole lyrics is
      // the single largest copyright exposure this product has — PROJECT_PLAN §3.
      const id = aliceIds.get(SONGS[0].match_key);
      const res = await alice.get(`/song/${id}`);
      assert.equal(res.body.hasLyrics, true);
      assert.ok(!("lyrics" in res.body), "the full body must not be in the response");
      assert.ok(!res.text.includes("stepped into the light"));
    });

    test.it("404s another user's song id", async () => {
      // Indistinguishable from a song that does not exist, which is the correct
      // amount to reveal.
      const id = aliceIds.get(SONGS[0].match_key);
      assert.equal((await bob.get(`/song/${id}`)).status, 404);
      assert.equal((await alice.get("/song/99999999")).status, 404);
    });

    test.it("400s a non-numeric song id", async () => {
      assert.equal((await alice.get("/song/abc")).status, 400);
    });

    test.it("reports stats for your library only", async () => {
      const mine = await alice.get("/stats");
      assert.equal(mine.body.tracks, 6);
      assert.equal(mine.body.plays, 57);
      assert.equal(mine.body.streams, 44);
      assert.equal(mine.body.topSongs[0].track, "Open Door");

      const theirs = await bob.get("/stats");
      assert.equal(theirs.body.tracks, 0);
      assert.deepEqual(theirs.body.topSongs, []);
    });

    test.it("reports the coverage window once ingest records it", async () => {
      const store = new PostgresAdapter(pool, { userId: await userIdOf("reader@example.com") });
      await store.setMeta({
        history_from: "2025-04-16",
        history_to: "2026-04-17",
        history_source: "account-data",
        skip_threshold_ms: 30000,
      });
      const res = await alice.get("/stats");
      assert.equal(res.body.coverage.from, "2025-04-16");
      assert.equal(res.body.coverage.skipThresholdSeconds, 30);
      // ...and it stays that user's own.
      assert.equal((await bob.get("/stats")).body.coverage.from, null);
    });

    test.it("reports ingest progress", async () => {
      assert.deepEqual((await alice.get("/status")).body, {
        tracks: 6,
        processed: 5,
        lyrics: { ok: 3, instrumental: 1, notfound: 1 },
      });
      assert.deepEqual((await bob.get("/status")).body, {
        tracks: 0,
        processed: 0,
        lyrics: {},
      });
    });

    test.it("builds a top-words report from your songs", async () => {
      const res = await alice.get("/topWords?limit=5");
      assert.equal(res.body.songsWithLyrics, 3);
      assert.equal(res.body.words.length, 5);
      assert.deepEqual((await bob.get("/topWords")).body, {
        songsWithLyrics: 0,
        words: [],
      });
    });

    test.it("does not serve one user's cached top-words to another", async () => {
      // The Personal Edition's cache was a module-level global. In a
      // multi-tenant process that is a cross-tenant data leak, so the cache is
      // keyed by user — this is the test that says so.
      await alice.get("/topWords");
      const theirs = await bob.get("/topWords");
      assert.deepEqual(theirs.body.words, []);
    });
  });

  // ── account deletion ────────────────────────────────────────────────────

  test.describe("DELETE /me", () => {
    test.it("erases the account and signs you out", async () => {
      const client = await signIn(api, "erase@example.com");
      const store = new PostgresAdapter(pool, { userId: await userIdOf("erase@example.com") });
      await seed(store);

      const res = await client.delete("/me");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, deleted: true });

      assert.equal((await client.get("/me")).body.signedIn, false);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM user_songs");
      assert.equal(rows[0].n, 0);
    });

    test.it("leaves the shared catalogue for everyone else", async () => {
      const client = await signIn(api, "erase2@example.com");
      const store = new PostgresAdapter(pool, { userId: await userIdOf("erase2@example.com") });
      await seed(store);
      await client.delete("/me");

      const { rows } = await pool.query("SELECT count(*)::int AS n FROM songs");
      assert.ok(rows[0].n > 0, "global songs must survive an account deletion");
    });
  });
});
