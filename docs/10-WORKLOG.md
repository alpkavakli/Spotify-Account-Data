# 10 — Worklog (append-only)

Running record of what we actually did. Newest entries at the bottom. See
`00-INDEX.md` for how these docs fit together.

---

## 2026-07-27 — Phase 0, Step 1: smoke-test the baseline ✅

**Why:** capture the current app's exact behavior *before* refactoring, so the
"no behavior change" claim can be verified by diffing after.

**Environment:** Node v24.14.0, npm 11.9.0. `Backend/node_modules` present.
Existing populated `Data/spotify.db` (7.9 MB). Server started with `node src/server.js`
on `http://127.0.0.1:3000` (Spotify creds not set → playlist creation disabled, as
expected; auth endpoints untested until Phase 2).

**What we did:** probed every read endpoint and saved full JSON responses as the
reference baseline (scratchpad `baseline/` + summarized here). Then stopped the server.

**Baseline reference values** (must match after the refactor):

| Endpoint | Key values |
|----------|-----------|
| `/status` | `tracks=4044, processed=4044, lyrics: ok=3714 instrumental=144 notfound=186` |
| `/stats` | `tracks=4044 artists=1692 plays=22013 hours=1035`; top song = The Strokes – Ode To The Mets (221 plays); top artist = No Clear Mind (24 songs, 648 plays) |
| `/topWords?limit=25` | `songsWithLyrics=3714`; first 5 = know(1198), like(1166), love(1033), now(971), time(902) |
| `/searchForWord?q=door` | `count=154`; r0 = The Strokes – Ode To The Mets (occ=1) |
| `/searchForWord?q=love` | `count=1125`; r0 = No Clear Mind – Big Thing (occ=3) |
| `/searchForWord?q=heart fire` | `count=45`; r0 = Iyeoka – Simply Falling (occ=13) |
| `/song/1` | Emile Pandolfi – Once Upon a December (playCount=11, 33 min) |
| `/me` | `configured=false, loggedIn=false` (no Spotify creds) |

**sha256 fingerprints (first 16 hex) of saved responses** — for exact-match diffing.
Ordering is deterministic on a fixed DB (search: `play_count DESC, artist, track`;
topWords: insertion-order Map), so these should reproduce byte-for-byte after the
refactor:

```
status.json          4b313502803f441c
stats.json           64b27b91a6620b0d
topWords.json        836d68b9328ac39d
search_door.json     5d38742adb0431a3
search_love.json     c17047d4f9dfe3c3
search_heart_fire.json 32605375ea474dd1
song_1.json          e754876ba104f758
me.json              30893b0e11628623
```

Baseline files saved at (scratchpad, ephemeral):
`.../scratchpad/baseline/*.json`

**Result:** ✅ Baseline captured. All read endpoints work against the real DB. Ready
for Step 2 (scaffold workspaces).

**Note for verification:** after the refactor, re-run the same requests and compare
sha256s. If ordering-sensitive files differ, diff the JSON to confirm the delta is
only ordering vs. a real behavior change.
