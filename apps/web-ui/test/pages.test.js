"use strict";

// The frontend, end to end: a real Next.js server, a real API process, a real
// Postgres, and assertions on the HTML that comes back.
//
// WHY THIS FILE EXISTS. Every other test in the repo calls the API directly.
// That left a whole layer unrun, and it bit us once already: the first
// next.config.mjs proxied `/api/*` but not `/auth/*`, so the link we email
// people would have 404'd in a browser while all 478 tests stayed green (see
// docs/10-WORKLOG.md, 2026-07-28). The bugs live in the seams — the rewrite
// table, the by-hand cookie forwarding in lib/api.js, the shape of the JSON a
// page destructures — and none of them are visible from either side alone.
//
// WHAT IT DOES NOT COVER: anything that needs a browser. The two client
// components (`signin/form.js`, `app/upload/form.js`) have their REQUESTS
// exercised here, byte for byte, but their React state — the disabled button,
// `router.refresh()`, the error branch — does not run. That needs Playwright,
// and adding it is a dependency decision this repo has not made. Do not read a
// green run here as "the upload form works in a browser".

const test = require("node:test");
const assert = require("node:assert/strict");

const { SONGS, seed } = require("@lyricsearch/core/testing/fixtures");
const { makeSpotifyExportZip } = require("@lyricsearch/core/testing/make-zip");
const { PostgresAdapter } = require("@lyricsearch/web/src/postgres-adapter");
const { skipWithoutPostgres, freshDatabase } = require("@lyricsearch/web/test/helpers/pg");
const { startApi, makeClient, cleanupBlobDirs } = require("@lyricsearch/web/test/helpers/api");
const { startNext } = require("./helpers/next");

const skip = skipWithoutPostgres();

// What a browser puts in Accept. The literal `text/html` is the entire signal
// the API uses to tell a person clicking a link from a program calling a route,
// so a test that leaves it off is not testing the browser path.
const BROWSER = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// Booting a Next dev server and compiling six routes on demand is slower than
// anything else in the repo. Still an order of magnitude cheaper than a browser.
test.describe("frontend (server-rendered)", { skip, timeout: 300_000 }, () => {
  let pool;
  let api;
  let ui;

  /** The signed-in client whose library holds the shared fixtures. */
  let owner;
  /** Signed in, and deliberately owns nothing. */
  let stranger;

  test.before(async () => {
    pool = await freshDatabase("webui");
    api = await startApi(pool);
    ui = await startNext({ apiOrigin: api.baseUrl });

    owner = (await signInViaBrowser("owner@example.com")).browser;
    stranger = (await signInViaBrowser("stranger@example.com")).browser;

    // seed() is called ONCE per database on purpose: it learns song ids from
    // getSongsNeedingLyrics, and lyrics are global here, so a second caller
    // would get an empty id map. See packages/core/testing/fixtures.js.
    await seed(await libraryOf("owner@example.com"));
    await setCoverage("account-data");
  });

  test.after(async () => {
    await ui?.close();
    await api?.close();
    await pool?.end();
    cleanupBlobDirs();
  });

  // ── helpers ─────────────────────────────────────────────────────────────

  /** An unauthenticated browser pointed at the frontend. */
  const anon = () => makeClient(ui.origin);

  /**
   * GET a page the way a browser does, with React's separator comments removed.
   *
   * React writes an empty `<!-- -->` between two interpolated values so it can
   * find the boundary again when it hydrates. It is invisible on the page and
   * it is not content — but it lands in the middle of every sentence built from
   * data (`6<!-- --> songs · lyrics found for <!-- -->3`), and without stripping
   * it every assertion below would have to be written against React's internals
   * instead of against the sentence a person reads.
   */
  async function page(client, path) {
    const res = await client.get(path, { headers: BROWSER });
    return { ...res, text: res.text.replace(/<!-- -->/g, "") };
  }

  /**
   * Sign in the way a person does: ask for a link on the frontend, then open
   * the link that arrived.
   *
   * The link is taken out of the email and its PATH is used verbatim. Only the
   * origin is swapped, because here the API listens on its own random port
   * while in a real deployment BASE_URL is the frontend and the two are the
   * same host. The path is the part worth testing — that whatever we email is
   * something the frontend actually routes.
   */
  async function signInViaBrowser(email) {
    const browser = makeClient(ui.origin);
    const requested = await browser.post("/api/auth/request-link", { email });

    const mail = api.mailer.lastTo(email);
    assert.ok(mail, `no sign-in email was sent to ${email}`);
    const emailed = new URL(mail.text.match(/https?:\/\/\S+/)[0]);

    const landed = await page(browser, emailed.pathname + emailed.search);
    return { browser, requested, emailed, landed };
  }

  /** A store scoped to a user, for putting data in behind the API's back. */
  async function libraryOf(email) {
    const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    return new PostgresAdapter(pool, { userId: rows[0].id });
  }

  /** Set the ingest metadata the stats page reads its coverage note from. */
  async function setCoverage(source) {
    await (await libraryOf("owner@example.com")).setMeta({
      history_from: "2025-04-16",
      history_to: "2026-04-17",
      history_source: source,
      skip_threshold_ms: 30_000,
    });
  }

  // ── the public page ─────────────────────────────────────────────────────

  test.describe("the landing page", () => {
    test.it("is real HTML in the response body, not an empty root div", async () => {
      // The whole reason docs/01-DECISIONS.md picked SSR over an SPA: the
      // service is ad-supported, so a crawler that runs no JavaScript has to be
      // able to read the page. This asserts that from the crawler's position —
      // the raw bytes, before any hydration.
      const res = await page(anon(), "/");

      assert.equal(res.status, 200);
      assert.match(res.text, /<title>Lyric Search — find your songs by the words in them<\/title>/);
      assert.match(res.text, /<meta name="description"/);
      assert.match(res.text, /Search your music by the words in it\./);
    });

    test.it("warns about the 12-month export where a new user will read it", async () => {
      // Asking for the wrong download costs a user up to 30 days, so this
      // warning is on the landing page and not only after they have uploaded.
      const res = await page(anon(), "/");
      assert.match(res.text, /last 12 months/);
      assert.match(res.text, /Extended streaming history/i);
    });

    test.it("offers sign-in to a stranger and the library to a signed-in user", async () => {
      const out = await page(anon(), "/");
      assert.match(out.text, /Get started/);
      assert.doesNotMatch(out.text, /Go to your library/);

      const inn = await page(owner, "/");
      assert.match(inn.text, /Go to your library/);
    });

    test.it("shows the right navigation for who is asking", async () => {
      // The header is rendered in the root layout from /me. If Next ever cached
      // this page across requests, one user's nav would be served to another —
      // which is why every route sets `dynamic = "force-dynamic"`.
      const out = await page(anon(), "/");
      assert.doesNotMatch(out.text, /sign out/);

      const inn = await page(owner, "/");
      assert.match(inn.text, /sign out/);
      assert.match(inn.text, /href="\/app\/stats"/);
    });
  });

  // ── the proxy ───────────────────────────────────────────────────────────

  test.describe("the API proxy", () => {
    test.it("passes /api/* through to the API process", async () => {
      const res = await anon().get("/api/health");
      assert.deepEqual(res.body, { ok: true });
    });

    test.it("passes /auth/* through under its own name", async () => {
      // Not /api/auth/callback. The link goes in an email, people look at links
      // before clicking them, and one that reads like an API call is one more
      // reason not to. This is the rewrite that was missing the first time.
      const res = await page(anon(), "/auth/callback?token=nonsense");
      assert.equal(res.status, 302);
      assert.match(res.headers.get("location"), /^\/signin\?error=/);
    });
  });

  // ── signing in, as a person actually does it ────────────────────────────

  test.describe("signing in", () => {
    test.it("takes a new user from the form to their library", async () => {
      const { requested, emailed, landed, browser } = await signInViaBrowser("newbie@example.com");

      // 1. what signin/form.js posts
      assert.equal(requested.status, 200);
      assert.deepEqual(requested.body, { ok: true });

      // 2. what we emailed them is a path this frontend serves
      assert.equal(emailed.pathname, "/auth/callback");

      // 3. opening it lands them in the app, signed in
      assert.equal(landed.status, 302);
      assert.equal(landed.headers.get("location"), "/app");
      assert.match(landed.headers.getSetCookie().join("; "), /ls_session=/);

      // 4. and the session survives the hop, which is the part that is easy to
      //    get wrong: a redirect that forgets the cookie looks correct and
      //    bounces the user straight back to /signin.
      const app = await page(browser, "/app");
      assert.equal(app.status, 200);
      assert.match(app.text, /Search your lyrics/);
    });

    test.it("renders the reason a dead link failed, on the page it lands on", async () => {
      const bounced = await page(anon(), "/auth/callback?token=made-up");
      const location = bounced.headers.get("location");

      // Follow it exactly as a browser would, to the page the user sees.
      const signin = await page(anon(), location);
      assert.equal(signin.status, 200);
      assert.match(signin.text, /invalid, expired, or already used/);
    });

    test.it("signs out through the proxy and forgets the session", async () => {
      const { browser } = await signInViaBrowser("leaving@example.com");

      // What the sign-out form in the layout submits.
      const res = await browser.post("/api/auth/logout");
      assert.deepEqual(res.body, { ok: true });

      const after = await page(browser, "/app");
      assert.equal(after.status, 307);
    });
  });

  // ── the gate ────────────────────────────────────────────────────────────

  test.describe("pages that need an account", () => {
    for (const path of ["/app", "/app/stats", "/app/upload"]) {
      test.it(`sends a signed-out visitor from ${path} to sign-in`, async () => {
        const res = await page(anon(), path);
        assert.equal(res.status, 307);
        assert.equal(new URL(res.headers.get("location"), ui.origin).pathname, "/signin");
      });
    }

    test.it("does not serve one user's page to an anonymous visitor", async () => {
      // Deliberately after the owner has rendered /app several times: if Next
      // were caching these routes, this is where the previous render would leak.
      await page(owner, "/app?q=door");
      const res = await page(anon(), "/app?q=door");

      assert.equal(res.status, 307);
      assert.doesNotMatch(res.text, /Open Door/);
    });
  });

  // ── search ──────────────────────────────────────────────────────────────

  test.describe("the search page", () => {
    test.it("renders matches, with the matched word marked up", async () => {
      const res = await page(owner, "/app?q=door");
      assert.equal(res.status, 200);

      assert.match(res.text, /2 songs mentioning/);
      assert.match(res.text, /Open Door/);
      assert.match(res.text, /Aurora Vale/);
      // The snippet arrives with [[ ]] markers — the form both storage adapters
      // agree on — and the page turns them into <mark>. Getting this wrong is
      // invisible in an API test and glaring on the page.
      assert.match(res.text, /<mark>door<\/mark>/);
    });

    test.it("shows the stemmed match as the lyric actually spells it", async () => {
      // "door" finds "Two Doors Down" through Postgres FTS stemming. The
      // highlight has to say `doors`, the word that is really in the line — a
      // page that echoed the query back would be lying about the lyric.
      const res = await page(owner, "/app?q=door");
      assert.match(res.text, /Two Doors Down/);
      assert.match(res.text, /<mark>[Dd]oors<\/mark>/);
    });

    test.it("leaves out songs that do not mention the word", async () => {
      const res = await page(owner, "/app?q=door");
      assert.doesNotMatch(res.text, /Silent Field/);
    });

    test.it("reports plays and listens separately", async () => {
      // play_count and stream_count are different numbers on every fixture on
      // purpose. A page that printed one for the other would look plausible.
      const res = await page(owner, "/app?q=door");
      assert.match(res.text, /played 30× \(24 listens\)/);
    });

    test.it("says how much of the library is searchable yet", async () => {
      // Six songs, three with lyrics, one still never looked up. Without this
      // line "no matches" is indistinguishable from "we have not fetched it".
      const res = await page(owner, "/app?q=door");
      assert.match(res.text, /6 songs · lyrics found for 3/);
      assert.match(res.text, /1 still being looked up/);
    });

    test.it("explains an empty result instead of showing nothing", async () => {
      const res = await page(owner, "/app?q=zzzznotaword");
      assert.equal(res.status, 200);
      assert.match(res.text, /0 songs mentioning/);
      assert.match(res.text, /Only songs whose lyrics we found are searchable/);
    });

    test.it("shows the form and no results when nothing was asked", async () => {
      const res = await page(owner, "/app");
      assert.match(res.text, /name="q"/);
      assert.doesNotMatch(res.text, /songs mentioning/);
    });

    test.it("escapes lyrics and titles rather than rendering them as markup", async () => {
      // Song titles come from a file a stranger uploaded and lyric bodies come
      // from a third-party API. Neither is ours, and the snippet is the one
      // place in the app where the obvious implementation is
      // dangerouslySetInnerHTML.
      const { browser } = await signInViaBrowser("xss@example.com");
      const store = await libraryOf("xss@example.com");

      await store.upsertSongs([
        {
          match_key: "nine volt|corridor script",
          artist: "Nine Volt",
          track: 'Corridor <script>alert("track")</script>',
          album: null,
          uri: null,
          in_library: 0,
          play_count: 1,
          stream_count: 1,
          ms_played: 1000,
          playlists: [],
        },
      ]);
      const [pending] = await store.getSongsNeedingLyrics({});
      await store.saveLyrics(pending.id, {
        status: "ok",
        source: "lrclib",
        body: 'A long corridor and <script>alert("body")</script> at the end',
      });

      const res = await page(browser, "/app?q=corridor");
      assert.equal(res.status, 200);
      assert.match(res.text, /<mark>corridor<\/mark>/);
      assert.doesNotMatch(res.text, /<script>alert\("track"\)<\/script>/);
      assert.doesNotMatch(res.text, /<script>alert\("body"\)<\/script>/);
      assert.match(res.text, /&lt;script&gt;alert\(&quot;track&quot;\)/);
    });
  });

  // ── stats ───────────────────────────────────────────────────────────────

  test.describe("the stats page", () => {
    test.it("renders the totals", async () => {
      const res = await page(owner, "/app/stats");
      assert.equal(res.status, 200);
      assert.match(res.text, /57 plays · 44 listens · 2 hours · 6 songs · 4 artists/);
    });

    test.it("renders both tables with numbers that agree with search", async () => {
      const res = await page(owner, "/app/stats");
      assert.match(res.text, /Most listened songs/);
      assert.match(res.text, /Most listened artists/);
      // Open Door: 30 plays, 24 listens, 5,400,000 ms → 90 minutes. The same
      // 30/24 the search page prints, so the two pages cannot silently disagree.
      assert.match(res.text, /<td>Open Door<\/td>[\s\S]*?>30<[\s\S]*?>24<[\s\S]*?>90</);
      assert.match(res.text, /Aurora Vale/);
    });

    test.it("links its top words back into a search", async () => {
      const res = await page(owner, "/app/stats");
      assert.match(res.text, /Your most-sung words/);
      assert.match(res.text, /href="\/app\?q=door"/);
    });

    test.it("warns that a 12-month export is not the whole story", async (t) => {
      // The failure this prevents is silent: a top-songs list that reads as
      // all-time while missing everything played over a year ago.
      await setCoverage("account-data");
      t.after(() => setCoverage("account-data"));

      const res = await page(owner, "/app/stats");
      assert.match(res.text, /Counts cover/);
      assert.match(res.text, /2025-04-16/);
      assert.match(res.text, /2026-04-17/);
      assert.match(res.text, /A play counts as a listen from 30s/);
      assert.match(res.text, /only\s+includes the last 12 months/);
      assert.match(res.text, /class="notice warn"/);
    });

    test.it("drops the warning once the export covers everything", async (t) => {
      await setCoverage("extended");
      t.after(() => setCoverage("account-data"));

      const res = await page(owner, "/app/stats");
      assert.match(res.text, /Counts cover/);
      assert.doesNotMatch(res.text, /only\s+includes the last 12 months/);
      assert.doesNotMatch(res.text, /class="notice warn"/);
    });
  });

  // ── uploads ─────────────────────────────────────────────────────────────

  test.describe("the upload page", () => {
    test.it("accepts an export through the proxy and lists it", async () => {
      const { browser } = await signInViaBrowser("uploader@example.com");
      const zip = makeSpotifyExportZip();

      // Byte for byte what app/upload/form.js sends: the raw file as the body,
      // the name in the query string. Binary through a rewrite is exactly the
      // kind of thing that works in curl and not in the proxy.
      const res = await browser.upload("/api/uploads?filename=export.zip", zip);
      assert.equal(res.status, 202);
      assert.equal(res.body.upload.bytes, zip.length);

      const listed = await page(browser, "/app/upload");
      assert.equal(listed.status, 200);
      assert.match(listed.text, /export\.zip/);
      // The test API runs a NullQueue, so nothing picks the job up — which is
      // the state a real user sees for the first few seconds, and the one the
      // page has to describe honestly rather than showing an empty table.
      assert.match(listed.text, /waiting to be processed/);
    });

    test.it("tells a new user which download to ask Spotify for", async () => {
      const res = await page(stranger, "/app/upload");
      assert.match(res.text, /Which download do I need\?/);
      assert.match(res.text, /Extended streaming history/i);
    });
  });

  // ── tenancy ─────────────────────────────────────────────────────────────

  test.describe("one user's data stays theirs", () => {
    // The API's own isolation tests cover the routes. This covers the path
    // where lib/api.js forwards the caller's cookie BY HAND from a server
    // component — a server component has no browser attached, so forgetting it
    // is a one-line mistake that would render either everyone's data or the
    // wrong person's.
    test.it("shows a stranger the empty search page, not the owner's songs", async () => {
      const res = await page(stranger, "/app?q=door");
      assert.equal(res.status, 200);
      assert.match(res.text, /Nothing to search yet/);
      assert.doesNotMatch(res.text, /Open Door/);
    });

    test.it("shows a stranger the empty stats page, not the owner's totals", async () => {
      const res = await page(stranger, "/app/stats");
      assert.equal(res.status, 200);
      assert.match(res.text, /Nothing here yet/);
      assert.doesNotMatch(res.text, /57 plays/);
    });
  });
});

// Referenced so the fixture set cannot be reduced without this file noticing:
// the counts asserted above (6 songs, 3 with lyrics, 4 artists) are derived
// from it.
assert.equal(SONGS.length, 6);
