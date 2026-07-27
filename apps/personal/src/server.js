const path = require("node:path");
const crypto = require("node:crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const store = require("./store");
const spotify = require("./spotify");
const {
  toFtsQuery,
  countOccurrences,
  aggregateTopWords,
} = require("@lyricsearch/core/search");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// The UI lives in the sibling frontend/ folder, served as static files.
app.use(express.static(path.join(__dirname, "..", "frontend")));

app.get("/searchForWord", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "missing query parameter: q" });

  const ftsQuery = toFtsQuery(q);
  if (!ftsQuery) return res.status(400).json({ error: "empty query" });

  let rows;
  try {
    rows = store.searchByLyrics(ftsQuery);
  } catch (err) {
    return res.status(400).json({ error: "invalid query" });
  }

  res.json({
    query: q,
    count: rows.length,
    results: rows.map((r) => ({
      id: r.id,
      artist: r.artist,
      track: r.track,
      album: r.album,
      uri: r.uri,
      playCount: r.play_count,
      inLibrary: !!r.in_library,
      playlists: JSON.parse(r.playlists),
      snippet: r.snippet,
      occurrences: countOccurrences(r.body, q),
    })),
  });
});

app.get("/song/:id", (req, res) => {
  const row = store.getSong(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({
    id: row.id,
    artist: row.artist,
    track: row.track,
    album: row.album,
    uri: row.uri,
    playCount: row.play_count,
    minutesPlayed: Math.round(row.ms_played / 60000),
    inLibrary: !!row.in_library,
    playlists: JSON.parse(row.playlists),
    lyricsStatus: row.status || "pending",
    lyrics: row.body || null,
  });
});

// --- Top words across all lyrics ---

let wordCache = null;

function topWords() {
  const okCount = store.getOkLyricCount();
  if (wordCache && wordCache.okCount === okCount) return wordCache;

  const list = aggregateTopWords(store.getOkLyricBodies(), 300);

  wordCache = { okCount, list };
  return wordCache;
}

app.get("/topWords", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const cache = topWords();
  res.json({ songsWithLyrics: cache.okCount, words: cache.list.slice(0, limit) });
});

// --- Listening stats ---

app.get("/stats", (req, res) => {
  const { totals, topSongs, topArtists } = store.getStats();
  res.json({
    tracks: totals.tracks,
    artists: totals.artists,
    plays: totals.plays,
    hours: Math.round(totals.ms / 3600000),
    topSongs: topSongs.map((s) => ({
      id: s.id,
      artist: s.artist,
      track: s.track,
      plays: s.play_count,
      minutes: Math.round(s.ms_played / 60000),
    })),
    topArtists: topArtists.map((a) => ({
      artist: a.artist,
      songs: a.songs,
      plays: a.plays,
      hours: +(a.ms / 3600000).toFixed(1),
    })),
  });
});

app.get("/status", (req, res) => {
  const { tracks, statuses } = store.getStatus();
  const lyrics = Object.fromEntries(statuses.map((r) => [r.status, r.count]));
  res.json({
    tracks,
    processed: statuses.reduce((s, r) => s + r.count, 0),
    lyrics,
  });
});

// --- Spotify auth ---

// OAuth state values, held only between /login and /callback.
const pendingStates = new Set();

app.get("/login", (req, res) => {
  if (!spotify.isConfigured()) {
    return res
      .status(503)
      .send("Spotify credentials missing — see apps/personal/.env.example");
  }
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60_000).unref();
  res.redirect(spotify.authorizeUrl(state));
});

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Spotify denied the request: ${error}`);
  if (!state || !pendingStates.has(state)) {
    return res.status(400).send("Invalid or expired login state — try again.");
  }
  pendingStates.delete(state);

  try {
    await spotify.exchangeCode(String(code));
    res.redirect("/");
  } catch (err) {
    res.status(500).send(`Login failed: ${err.message}`);
  }
});

app.post("/logout", (req, res) => {
  spotify.logout();
  res.json({ ok: true });
});

app.get("/me", (req, res) => {
  const s = spotify.session();
  res.json({
    configured: spotify.isConfigured(),
    loggedIn: !!(s && s.access_token),
    displayName: s ? s.display_name : null,
    redirectUri: spotify.REDIRECT_URI,
  });
});

// --- Playlist creation ---

app.post("/createPlaylist", async (req, res) => {
  const { name, isPublic, trackIds, description } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "playlist name is required" });
  }
  if (!Array.isArray(trackIds) || trackIds.length === 0) {
    return res.status(400).json({ error: "no songs selected" });
  }

  const session = spotify.session();
  if (!session || !session.access_token) {
    return res.status(401).json({ error: "not logged in" });
  }

  const rows = store.getSongsByIds(trackIds);

  try {
    // Most rows have no URI (streaming history carries none), so look those up
    // before creating anything — a playlist is not worth making if nothing resolves.
    const uris = [];
    const missing = [];
    for (const row of rows) {
      const uri = await spotify.resolveUri(row);
      if (uri) uris.push(uri);
      else missing.push(`${row.artist} — ${row.track}`);
    }

    if (uris.length === 0) {
      return res.status(422).json({
        error: "none of the selected songs could be found on Spotify",
        missing,
      });
    }

    const playlist = await spotify.createPlaylist(
      String(name).trim(),
      !!isPublic,
      description || `Songs mentioning "${req.body.query || ""}"`.trim()
    );
    await spotify.addTracks(playlist.id, uris);

    res.json({
      ok: true,
      playlistUrl: (playlist.external_urls && playlist.external_urls.spotify) || null,
      name: playlist.name,
      added: uris.length,
      requested: rows.length,
      missing,
    });
  } catch (err) {
    const status = err.code === "NO_AUTH" ? 401 : 502;
    res.status(status).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`listening on http://127.0.0.1:${PORT}`);
  if (!spotify.isConfigured()) {
    console.log("note: Spotify credentials not set — playlist creation disabled");
  }
});
