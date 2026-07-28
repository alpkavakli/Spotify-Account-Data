# 04 — Testing

How this project is tested, how to run it, and how to add a test. Written to be
readable without prior testing experience — if something here is unclear, that is
a bug in this document.

## Running the tests

```bash
npm test                                   # everything, from the repo root
npm test --workspace @lyricsearch/core     # just the pure logic  (fast, no I/O)
npm test --workspace @lyricsearch/personal # adapter + HTTP routes

cd apps/personal && node --test test/routes.test.js   # one file
cd apps/personal && node --test --test-name-pattern="404"  # one test by name
node --test --watch                        # re-run on save
```

No test framework is installed. Node 24 ships one (`node:test` + `node:assert`),
it is what `node --test` runs, and it does everything Jest/Mocha would do here.
Fewer dependencies is the same reason this project uses `node:sqlite` and the
built-in `fetch`.

## The three layers

| Layer | Where | What it proves | Speed |
|-------|-------|----------------|-------|
| **Unit** | `packages/core/test/` | Pure logic: matching, query building, word counting, export merging (both Spotify export formats), and the two HTTP clients with `fetch` mocked. | ~150 ms |
| **Conformance** | `packages/core/testing/adapter-conformance.js` | Every storage backend behaves *identically*. Run by each adapter's own test file. | ~2 s |
| **Integration** | `apps/personal/test/routes.test.js` | Real Express server + real SQLite + real HTTP, end to end. | ~2.5 s |

Roughly 244 tests, whole suite under 5 seconds. It is meant to be run constantly.

## Layer 1 — unit tests

Nothing to explain: import a function, call it, assert on what comes back.
`packages/core` is pure by design (no DB, no HTTP server, no filesystem), which
is exactly what makes it trivial to test. That purity is the payoff from Phase 0.

The only trick is in `test/helpers/mock-fetch.js`. `core/lyrics.js` and
`core/spotify.js` call the **global** `fetch` rather than importing an HTTP
client, so a test can replace it:

```js
const { mockFetch, json, status } = require("./helpers/mock-fetch");

test.it("retries a 429", async (t) => {
  mockFetch(t, [status(429), json([{ trackName: "..." }])]);  // queue of responses
  ...
});
```

`t.mock.*` restores the original automatically when the test ends. This is how
the suite covers rate limits, 5xx backoff, expired tokens and malformed error
bodies — failures that are impossible to trigger against the real API on demand,
and are precisely where the bugs are.

Backoff sleeps are made instant with `instantTimers(t)` (a fake `setTimeout`),
otherwise the retry tests alone would take 7.5 seconds.

## Layer 2 — the adapter conformance suite

**The most important file in the test suite.**

`docs/01-DECISIONS.md` commits to Liskov substitution: `SqliteAdapter` and the
future `PostgresAdapter` must be interchangeable behind `StorageAdapter`, so that
`core` and the routes never learn which one they are holding. A written interface
cannot enforce that. An executable one can.

`packages/core/testing/adapter-conformance.js` exports a single function:

```js
describeStorageAdapter({ name: "SqliteAdapter", createAdapter: () => tempStore() });
```

That one line runs ~55 tests covering the whole contract: merge semantics,
transaction atomicity, search ordering and stemming, snippet markers, index
cleanup when lyrics stop being `ok`, plays-vs-streams, dataset metadata, return
types, auth lifecycle. When `PostgresAdapter` is written it gets the same
one-line call, and any place it diverges fails immediately instead of silently
in production.

Rules for editing it:

- **Contract only.** No SQL, no table names, no engine quirks. Backend-specific
  behavior goes in that adapter's own test file (`test/sqlite-adapter.test.js`
  holds the WAL-mode, FTS-syntax and file-layout tests).
- **Assert types, not just values.** `assert.equal(typeof totals.plays, "number")`
  looks pedantic until you learn that `node-postgres` returns `COUNT(*)` as a
  *string* by default — and the route does `Math.round(totals.ms / 3600000)` on it.
  That is a real bug this suite will catch before it ships.
- **`await` every call**, even against the synchronous SQLite adapter. `await 5`
  is just `5`, so the same suite works before and after the contract goes async.

Shared fixtures live in `packages/core/testing/fixtures.js`: six songs chosen so
that every branch has a case (ok / instrumental / notfound / never-fetched, a
plural-only lyric body to prove stemming, a song with no "door" to prove
exclusion), and every song has some skipped plays so `play_count` and
`stream_count` are never equal — a backend that confuses the two fails instead of
looking right by coincidence. The lyric bodies are **invented for this repo** — a
project this careful about lyric copyright does not paste real lyrics into
fixtures.

## Layer 3 — testing Express routes

This is the part with an actual technique to it.

### Why the routes were untestable before

`server.js` used to do everything at import time:

```js
const store = require("./store");     // opens the real Data/spotify.db
const app = express();
app.get("/searchForWord", ...)
app.listen(PORT);                     // and starts listening
```

You cannot `require` that file from a test. Merely importing it opens your real
database and binds port 3000. There is no seam to insert test data through and no
way to substitute the Spotify client.

### The fix: a factory

`src/app.js` exports `createApp({ store, spotify })` and builds nothing at import
time. `src/server.js` is now only composition:

```js
const app = createApp({ store, spotify });   // real adapter, real Spotify glue
app.listen(PORT);
```

Same Dependency-Inversion move as `StorageAdapter`, one level up: the routes
depend on *a* store and *a* Spotify client, not on those particular ones. A test
passes a temp SQLite file and a fake Spotify. Later, `apps/web` can pass a
`PostgresAdapter` — the routes do not change.

(This also fixed a latent bug: the `/topWords` cache was a module-level `let`.
Two apps in one process shared it. Single-user today; a tenant-data leak the
moment there is more than one user. It now lives inside the closure.)

### Starting a real server in a test

An Express `app` is just a request handler. `app.listen(0)` binds it to a
**random free port**, so a test can start a real server, make real HTTP requests,
and shut it down — no mocking of `req`/`res`, and the assertions cover routing,
JSON parsing, status codes and headers exactly as a browser would hit them. Port
`0` matters: tests never collide with your dev server on 3000, or with each other.

`test/helpers/http.js` is that, in about 40 lines:

```js
const { client, close } = await startServer(app);
const res = await client.get("/searchForWord?q=door");
assert.equal(res.status, 200);
assert.equal(res.body.count, 2);
await close();
```

This is what `supertest` does. Node 24's built-in `fetch` makes it small enough
not to be worth a dependency.

One detail that matters: the client uses `redirect: "manual"`. `/login` responds
`302` to `accounts.spotify.com`, and a following client would fire a real request
at Spotify from your test suite. We want to assert on the redirect anyway.

### The shape of a route test

```js
async function withApp(t, { spotify = fakeSpotify(), seeded = true } = {}) {
  const store = tempStore();                 // fresh temp SQLite, never your real DB
  const ids = seeded ? await seed(store) : new Map();
  const { client, close } = await startServer(createApp({ store, spotify }));
  t.after(async () => { await close(); await store.close(); });   // auto-teardown
  return { client, store, spotify, id: (i) => ids.get(SONGS[i].match_key) };
}
```

`t.after()` registers cleanup with the test context, so it runs even if the test
throws. Every test gets its own database and its own port; nothing leaks between
them and they can run in any order.

### Faking Spotify

`test/helpers/fake-spotify.js` stands in for `src/spotify.js` — the one
dependency that reaches the public internet and needs credentials the project
does not have yet. It records the calls it received, so tests assert on what the
route *did*, not only on what it replied:

```js
assert.deepEqual(spotify.calls.createPlaylist, [
  { name: "Doors", isPublic: true, description: 'Songs mentioning "door"' },
]);
```

Override any method to drive a failure path:

```js
fakeSpotify({ async resolveUri() { return null; } })          // nothing found  → 422
fakeSpotify({ async createPlaylist() { throw noAuthError; } }) // token expired → 401
```

That is how `/createPlaylist` gets all seven of its outcomes covered
(200 / 200-with-missing / 400 ×3 / 401 ×2 / 422 / 502) without a Spotify account.

**The one thing still untested is the real OAuth network flow** — it needs
registered credentials, which is Phase 2. Everything on this side of the network
call is covered.

## Writing a new test

1. **Pure function?** → `packages/core/test/<module>.test.js`.
2. **New `StorageAdapter` method?** → add it to the conformance suite **first**.
   Every adapter, present and future, then has to implement it correctly.
3. **New route?** → `apps/personal/test/routes.test.js`, using `withApp`.
4. Anything backend-specific → that adapter's own test file, not the shared suite.

Conventions worth keeping:

- **Test names read as sentences about behavior.** "404s for an unknown id", not
  "test getSong 2". The suite output should be a readable spec.
- **Comment the *why* on any non-obvious assertion.** Several tests here explain
  a design decision (why `play_count` is replaced rather than added; why
  `pickBest` is more lenient than `pickMatch`). That is the point — a test is the
  only documentation that fails when it goes stale.
- **Never touch `apps/personal/Data/`.** Use `tempStore()`. Every helper is built
  so that the real database cannot be opened by accident.

## What the suite does not cover

- The Spotify OAuth network round-trip (no credentials — Phase 2).
- The two CLIs (`src/ingest.js`, `src/lyrics.js`) as scripts. Their logic is
  covered — `core.ingest.buildSongs`, `core.lyrics.fetchLyrics` and the adapter
  methods they call are all tested — but the top-level file I/O and the
  concurrency loop are not.
- The frontend (`frontend/index.html`). Static, no build step, no framework.
- Performance and load. Not meaningful until the SaaS has real traffic.
