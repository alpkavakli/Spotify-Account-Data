# @lyricsearch/web-ui — hosted service frontend

Next.js (App Router), server-rendered. SSR rather than an SPA because the
service is ad-supported, so organic search traffic is the business model
(`docs/01-DECISIONS.md`).

**Status: Phase 1, step 7 — done, verified end to end, and covered by tests.**

## Tests

```bash
npm run db:up --workspace @lyricsearch/web   # Postgres, or the tests skip
npm test      --workspace @lyricsearch/web-ui
```

37 tests, in two files.

`test/pages.test.js` (31) boots a real Next dev server on a random port with a
real API behind it and asserts on the HTML — no browser engine. How it works and
why is in `docs/04-TESTING.md` §Layer 5.

`test/deploy-routes.test.js` (6) needs nothing running. The rewrites below have
a production twin in `deploy/Caddyfile`, and this holds the two together: one
routing table written in two files is a table that drifts, and the drift is
invisible until nobody can sign in.

**What it does not cover:** the two client components' React state. Their
*requests* are exercised byte for byte, but the disabled button,
`router.refresh()` and the error branch never run. The upload form has still
never executed in a real browser.

## Running it

Three processes:

```bash
npm run db:up  --workspace @lyricsearch/web    # Postgres
npm start      --workspace @lyricsearch/web    # API      :3001
npm run worker --workspace @lyricsearch/web    # worker
npm run dev    --workspace @lyricsearch/web-ui # frontend :3000
```

Then open <http://127.0.0.1:3000>. Sign-in links are printed in the **API**
terminal.

## One origin

The browser only ever talks to `:3000`. `next.config.mjs` rewrites both
`/api/*` and `/auth/*` to the API process, so there is no CORS to configure and
the session cookie is an ordinary same-origin cookie rather than a third-party
one that browsers increasingly refuse. In production Caddy does the same in
front of both processes.

`/auth/*` is proxied under its own name so the emailed link reads
`https://host/auth/callback?token=…` rather than `…/api/auth/…`.

## Pages

| Route | Rendering | Notes |
|---|---|---|
| `/` | SSR | The landing page — the only page a search engine sees |
| `/signin` | SSR + a client form | Email in, link out |
| `/app` | SSR | Search; reads `?q=` server-side |
| `/app/stats` | SSR | Totals, top songs/artists, top words, coverage window |
| `/app/upload` | SSR + a client form | Raw-body upload, then the upload list |

Only `signin/form.js` and `app/upload/form.js` are client components.

## Notes

- **Snippets are rendered as React elements, never `dangerouslySetInnerHTML`.**
  The `[[ ]]` markers are split and mapped to `<mark>`; lyric text is
  third-party content and must not be interpreted as markup.
- `lib/api.js` forwards the caller's cookie when a server component calls the
  API, because a server component has no browser attached to it.
- Every authenticated page is `force-dynamic`. A cached page would be both stale
  and, if shared, someone else's library.
