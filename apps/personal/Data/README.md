# Data folder

This folder is intentionally **empty** in the repository. It holds your personal
Spotify export, which is private and must never be committed (the root
`.gitignore` ignores everything in here except this file and `.gitkeep`).

## How to get your Spotify data

1. Go to <https://www.spotify.com/account/privacy/> (Account → Privacy settings).
2. Under **Download your data**, request the **Account data** package.
   - This is the smaller, faster package (usually delivered within a few days).
   - The larger "Extended streaming history" also works and gives richer play
     counts, but takes longer to arrive.
3. Spotify emails you a `.zip` when it's ready. Unzip it.
4. Copy the JSON files into **this folder** (`Data/`). The app looks for:

   | File | Used for |
   |------|----------|
   | `YourLibrary.json` | your liked/saved songs |
   | `Playlist1.json` | songs in your playlists |
   | `StreamingHistory_music_0.json`, `_1.json`, … | play counts & listening time |

   Other files in the export (inferences, payments, etc.) are ignored.

## Then build the local database

From the `Backend/` folder:

```bash
npm install
npm run ingest    # reads the JSON above into Data/spotify.db  (seconds)
npm run lyrics    # fetches lyrics for every song               (~10-15 min)
npm start         # open http://127.0.0.1:3000
```

`spotify.db` is created here in `Data/` and is also git-ignored — it is built
from your personal data, so it stays on your machine.
