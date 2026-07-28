# @lyricsearch/web-ui — hosted service frontend

Next.js (App Router), server-rendered. SSR rather than an SPA because the
service is ad-supported, so organic search traffic is the business model
(`docs/01-DECISIONS.md`).

**Status: Phase 1, step 7 — mostly done, NOT yet verified end to end.**
See `docs/10-WORKLOG.md` for exactly what was and was not checked.

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
