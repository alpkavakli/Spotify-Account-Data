# 04 — Testing

How this project is tested, how to run it, and how to add a test. Written to be
readable without prior testing experience — if something here is unclear, that is
a bug in this document.

## Running the tests

```bash
npm test                                   # everything, from the repo root
npm test --workspace @lyricsearch/core     # just the pure logic  (fast, no I/O)
npm test --workspace @lyricsearch/personal # adapter + HTTP routes
npm test --workspace @lyricsearch/web      # hosted API + Postgres  (needs docker)
npm test --workspace @lyricsearch/web-ui   # the frontend, server-rendered

cd apps/personal && node --test test/routes.test.js   # one file
cd apps/personal && node --test --test-name-pattern="404"  # one test by name
node --test --watch                        # re-run on save
```

The last two need a database:

```bash
npm run db:up --workspace @lyricsearch/web    # Postgres on :5433, via docker compose
```

Without it those two workspaces **skip with an explanation** rather than fail, so
`npm test` at the root stays green for someone who cloned the repo to work on the
Personal Edition and has no Docker.

No test framework is installed. Node 24 ships one (`node:test` + `node:assert`),
it is what `node --test` runs, and it does everything Jest/Mocha would do here.
Fewer dependencies is the same reason this project uses `node:sqlite` and the
built-in `fetch`.

## The layers

| Layer | Where | What it proves | Speed |
|-------|-------|----------------|-------|
| **Unit** | `packages/core/test/` | Pure logic: matching, query building, word counting, export merging (both Spotify export formats), and the two HTTP clients with `fetch` mocked. | ~150 ms |
| **Conformance** | `packages/core/testing/adapter-conformance.js` | Every storage backend behaves *identically*. Run by each adapter's own test file. | ~2 s |
| **Integration** | `apps/personal/test/routes.test.js` | Real Express server + real SQLite + real HTTP, end to end. | ~2.5 s |
| **Hosted service** | `apps/web/test/` | Real Express + real **Postgres** + real blob directory, with every route exercised twice: once as the owner, once as somebody else. | ~10 s |
| **Frontend** | `apps/web-ui/test/` | A real Next.js server in front of a real API, asserting on the HTML that comes back. | ~8 s |
| **Config** | `apps/web/test/mailer.test.js`, `apps/web-ui/test/deploy-routes.test.js` | That production is configured the way the tests assume: which mailer it gets, and that Caddy proxies what `next.config.mjs` proxies. No I/O at all. | ~200 ms |
| **Publishing** | `tools/publish.test.js` | That no commercial file, and no reference to one, can reach the public OSS repo — by path, by content, and by what the generated tree resolves against. See `09-PUBLISHING.md`. | ~300 ms |

559 tests: core 163, personal 114, web 227, web-ui 37, tools 18. The first three
run in about five seconds and are meant to be run constantly; the web ones need
Docker and take about twenty.

Layers 4 and 5 are described below in **Layer 4** and **Layer 5** — they arrived
with the hosted service and have techniques of their own.

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

## Layer 4 — the hosted service (`apps/web`)

Same factory technique as Layer 3, against a **real Postgres**. A mock of a
database proves the mock behaves the way you imagined; the whole point here is to
find out whether *Postgres* does — generated `tsvector` columns, cascade deletes,
check constraints, and the JavaScript types `node-postgres` hands back. None of
that can be faked usefully.

`test/helpers/pg.js` and `test/helpers/api.js` are the two seams:

```js
const pool = await freshDatabase("api");   // dropped, recreated, migrated
const api  = await startApi(pool);         // real server, random port, temp blobs
const client = await signIn(api, "someone@example.com");
```

Four things about it that are not obvious:

- **Every test file gets its own database.** `node --test` runs files in parallel
  processes, and these helpers *drop and recreate* their database — so two files
  sharing one name tear down each other's connections mid-test. The failures look
  exactly like schema bugs and are not. Pass a unique suffix to `freshDatabase()`.
- **Postgres is probed synchronously, in a child process.** `describe(..., {skip})`
  is evaluated before any hook can run, so the availability check has to be
  synchronous while connecting to Postgres is not. Spawning a child to answer it
  costs ~150 ms, once, and is the honest way to get a synchronous answer out of
  an asynchronous question.
- **The test client keeps cookies, like a browser.** Each `makeClient()` is a
  separate browser, which is how two signed-in users are put side by side to
  check that neither can see the other.
- **`NullQueue` records what would have been enqueued and runs nothing.** Route
  tests assert that work was *handed off*; the jobs themselves are tested
  directly in `jobs.test.js`, without a queue in the picture at all.

The emphasis is different from the Personal Edition's route tests. There, the
risk is "does this return the right JSON". Here it is **"can one signed-in user
reach another user's data"**, so almost every route is exercised twice.

## Layer 5 — the frontend (`apps/web-ui`)

`test/pages.test.js` boots a **real Next.js dev server** in its own process, with
the real API behind it, and asserts on the HTML that comes back.

### Why this layer exists

Every other test in the repo calls the API directly, which left the seams unrun —
and one of them bit us. The first `next.config.mjs` proxied `/api/*` but not
`/auth/*`, so the sign-in link we email people would have 404'd in a browser
**while all 478 tests stayed green** (`docs/10-WORKLOG.md`, 2026-07-28). The bugs
in a server-rendered app live in the joins: the rewrite table, the by-hand cookie
forwarding in `lib/api.js`, the shape of the JSON a page destructures. None of
them are visible from either side alone.

### No browser engine, on purpose

What this layer covers is the **server** half of server-rendered pages — did the
page fetch the right thing, forward the session, and put the data in the HTML —
and all of that is in the bytes Next sends back. Adding Playwright would buy the
client half at the cost of a browser download and a second runtime in CI, which
`docs/01-DECISIONS.md` has repeatedly declined. **See "What the suite does not
cover" — this gap is real and is not to be papered over.**

### The one trick that makes it work

`next dev` reads `next.config.mjs` at **boot**, so the rewrites pick up
`API_ORIGIN` from the environment. That is what lets a test start the API on a
random port and point a dev server at it:

```js
api = await startApi(pool);                       // random port
ui  = await startNext({ apiOrigin: api.baseUrl }); // random port, proxies to it
```

With `next build && next start` the rewrite destination is baked into the routes
manifest, and a random port would need a rebuild on every run. The test server
also gets its own `distDir` (`.next-test`, via `NEXT_DIST_DIR`), so running the
tests while `npm run dev` is open does not have two servers writing one build
directory.

### Reading the HTML

Two helpers do all the work:

```js
const res = await page(owner, "/app?q=door");   // GET with a browser's Accept header
assert.match(res.text, /<mark>door<\/mark>/);
```

- **`page()` strips React's `<!-- -->` separators.** React writes an empty comment
  between two interpolated values so it can find the boundary again when it
  hydrates. It is invisible on the page and it is not content — but it lands in
  the middle of every sentence built from data (`6<!-- --> songs · lyrics found
  for <!-- -->3`). Without stripping it, every assertion would be written against
  React's internals instead of the sentence a person reads.
- **`signInViaBrowser()` uses the emailed link's path verbatim.** It asks for a
  link on the frontend, pulls the URL out of the mailer, and re-issues the
  **pathname and query** against the frontend origin. Only the origin is swapped,
  because in a real deployment `BASE_URL` *is* the frontend while here the API is
  on its own random port. The path is the part worth testing: that whatever we
  email is something the frontend actually routes.

The `Accept: text/html` header is not decoration. It is the entire signal the API
uses to tell a person clicking a link from a program calling a route, so a test
that leaves it off is not testing the browser path.

### Running the API for real, from a test

`BASE_URL` matters and defaults wrong for anything involving a browser. The API
defaults to `http://127.0.0.1:3001`, which is itself — so an emailed link points
at the API and never reaches the frontend's `/auth/*` rewrite. When running the
three processes by hand:

```bash
BASE_URL=http://127.0.0.1:3000 npm start --workspace @lyricsearch/web
```

## Writing a new test

1. **Pure function?** → `packages/core/test/<module>.test.js`.
2. **New `StorageAdapter` method?** → add it to the conformance suite **first**.
   Every adapter, present and future, then has to implement it correctly.
3. **New route?** → `apps/personal/test/routes.test.js`, using `withApp`.
4. **New hosted route?** → `apps/web/test/api.test.js`. Write it twice: once as
   the owner, once as another signed-in user who must not see the data.
5. **New page, or a change to what one renders?** → `apps/web-ui/test/pages.test.js`.
6. **New path proxied to the API?** → add it to `next.config.mjs` *and*
   `deploy/Caddyfile`, and `deploy-routes.test.js` will hold them together.
7. Anything backend-specific → that adapter's own test file, not the shared suite.

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
- The Personal Edition's frontend (`frontend/index.html`). Static, no build step,
  no framework.
- **Anything in the hosted frontend that needs a browser.** The two client
  components (`signin/form.js`, `app/upload/form.js`) have their *requests*
  exercised byte for byte by Layer 5, but their React state does not run: the
  disabled button, `router.refresh()`, the error branch. **The upload form has
  never executed in a real browser.** Closing this needs Playwright — a
  dependency decision the project has not made. Do not read a green Layer 5 run
  as "the upload form works".
- **Sending real mail.** `SmtpMailer` is tested through nodemailer's
  `jsonTransport`, which builds the real MIME message and hands it back instead
  of opening a socket — so the envelope, the headers and the fact that a
  sign-in link survives intact are all asserted against what would go on the
  wire. What is *not* tested is that a message leaves the box and arrives:
  credentials, SPF, DKIM, and whether a provider decides it is spam. Nothing
  local can test that. `server.js` calls `transport.verify()` at boot in
  production so a wrong credential is a failed deploy rather than a failed
  login, and the rest is a thing you check by signing in as yourself once.
- **That the deployed containers work.** `deploy-routes.test.js` proves Caddy
  and `next.config.mjs` agree about *routes*; it never starts a container. The
  images, the volumes and the boot order are checked by running the stack — see
  `08-DEPLOYMENT.md` §"Trying it without a domain".
- **What you actually commit to the public repo.** `tools/publish.test.js`
  checks the tree the publish script *generates*. What becomes public is what
  you `git add` in the target directory, which is why `09-PUBLISHING.md` says to
  read `git status` before every publish commit. No test can stand in for that.
- Performance and load. Not meaningful until the SaaS has real traffic.
