# Data folder

This folder is intentionally **empty** in the repository. It holds your personal
Spotify export, which is private and must never be committed (the root
`.gitignore` ignores everything in here except this file and `.gitkeep`).

---

## Which export do you want?

Spotify offers **two different downloads**, and the difference matters more than
the page suggests. Both are on the same screen:
<https://www.spotify.com/account/privacy/> (Account → Privacy settings).

| | **Account data** | **Extended streaming history** |
|---|---|---|
| Wait | a few days | **up to 30 days** |
| Streaming history | ⚠️ **last 12 months only** | **everything, since you signed up** |
| Liked songs | ✅ `YourLibrary.json` | ❌ not included |
| Playlists | ✅ `Playlist1.json` | ❌ not included |
| Track URIs in history | ❌ none | ✅ every row |
| History filenames | `StreamingHistory_music_0.json` | `Streaming_History_Audio_2019-2020_0.json` |

### The 12-month cap is the thing to know

**"Account data" contains only the last 12 months of streaming history.** Not a
sample, not a summary — songs you played 800 times three years ago are simply
absent, and no amount of processing can recover them. If your top-songs list
looks wrong, this is almost always why.

The app tells you the real window on the stats page and when you run
`npm run ingest`, e.g. `covers 2025-04-16 → 2026-04-17`.

### Recommended: request both

They contain different things, so ask for **both at once** — the small one
arrives in a few days and you can start using the app immediately, and the big
one lands a few weeks later. This app reads both formats and merges them, so
when the second package arrives you just drop the files in here and re-run
`npm run ingest`.

---

## Setting it up

1. Request your data at <https://www.spotify.com/account/privacy/>.
2. Spotify emails a `.zip` when it is ready. Unzip it.
3. Copy the JSON files into **this folder** (`apps/personal/Data/`):

   | File | From | Used for |
   |------|------|----------|
   | `YourLibrary.json` | Account data | your liked/saved songs |
   | `Playlist1.json` | Account data | songs in your playlists |
   | `StreamingHistory_music_0.json`, `_1.json`, … | Account data | play counts & listening time (12 months) |
   | `Streaming_History_Audio_*.json` | Extended history | play counts & listening time (all time) |

   Everything else in the export (inferences, payments, …) is ignored.
   `Streaming_History_Video_*.json` is podcast/video history and is skipped on
   purpose.

4. Build the local database. From the **repo root**:

   ```bash
   npm install
   npm run ingest    # reads the JSON above into Data/spotify.db  (seconds)
   npm run lyrics    # fetches lyrics for every song               (~10-15 min)
   npm start         # open http://127.0.0.1:3000
   ```

`spotify.db` is created here in `Data/` and is git-ignored — it is built from
your personal data, so it never leaves your machine.

---

## Plays vs listens

Two numbers are recorded for every song, because they answer different questions:

- **plays** — every time the track started, skips included.
- **listens** — only the plays that lasted past the skip threshold, **30 seconds
  by default**. This is Spotify's own rule: what Wrapped counts as a stream, and
  what earns the artist a royalty.

Skipping through a playlist can easily account for a fifth of your history, so a
raw play count flatters songs you keep skipping past. The rankings are ordered by
*time listened*, which is immune to both.

Set `SKIP_THRESHOLD_SECONDS` in `.env` to change the threshold (see
`.env.example`), then re-run `npm run ingest`. Re-ingesting is cheap and safe:
song ids are stable, so lyrics you already fetched are kept.

A row with `0 ms` played — queued but never actually started — is never counted
as a play. `npm run ingest` reports how many it ignored.
