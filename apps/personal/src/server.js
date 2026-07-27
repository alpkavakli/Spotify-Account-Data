const path = require("node:path");
const crypto = require("node:crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const { db } = require("./db");
const spotify = require("./spotify");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// The UI lives in the sibling frontend/ folder, served as static files.
app.use(express.static(path.join(__dirname, "..", "frontend")));

// FTS5 has its own query syntax (AND, OR, *), so user input is wrapped in
// quotes per word to make it behave like a plain word search.
function toFtsQuery(q) {
  const words = q
    .split(/\s+/)
    .map((w) => w.replace(/"/g, "").trim())
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => `"${w}"`).join(" ");
}

function countOccurrences(body, q) {
  let n = 0;
  for (const word of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // trailing \w* mirrors the porter stemmer, so "door" counts "doors" too
    const m = body.toLowerCase().match(new RegExp(`\\b${safe}\\w*`, "g"));
    n += m ? m.length : 0;
  }
  return n;
}

app.get("/searchForWord", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "missing query parameter: q" });

  const ftsQuery = toFtsQuery(q);
  if (!ftsQuery) return res.status(400).json({ error: "empty query" });

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT t.id, t.artist, t.track, t.album, t.uri, t.play_count, t.in_library, t.playlists,
                l.body,
                snippet(lyrics_fts, 0, '[[', ']]', ' … ', 12) AS snippet
         FROM lyrics_fts
         JOIN tracks t ON t.id = lyrics_fts.rowid
         JOIN lyrics l ON l.track_id = t.id
         WHERE lyrics_fts MATCH ?
         ORDER BY t.play_count DESC, t.artist, t.track`
      )
      .all(ftsQuery);
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
  const row = db
    .prepare(
      `SELECT t.id, t.artist, t.track, t.album, t.uri, t.play_count, t.ms_played,
              t.in_library, t.playlists, l.status, l.body
       FROM tracks t LEFT JOIN lyrics l ON l.track_id = t.id
       WHERE t.id = ?`
    )
    .get(Number(req.params.id));
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

const STOPWORDS = new Set(
  `the a an and or but nor so yet i you he she it we they me him her us them
   my your his its our their mine yours hers ours theirs this that these those
   is am are was were be been being do does did doing have has had having
   will would shall should can could may might must let lets im youre hes shes
   its were theyre ive youve weve theyve id youd hed shed wed theyd ill youll
   hell shell well theyll isnt arent wasnt werent dont doesnt didnt wont
   wouldnt cant couldnt shouldnt aint gonna wanna gotta
   to of in on at by for with from into onto up down out off over under again
   about against between through during before after above below there here
   when where why how what which who whom whose all any both each few more
   most other some such no not only own same than too very just then once
   as if because while until
   oh ooh oohh yeah yea hey uh uhh ah ahh mmm mm hmm la na da di do dum whoa
   woah ha ooh la-la
   bir ve bu ne ben sen o biz siz ama gibi için çok da de mi mu mı bana beni
   benim seni sana senin onu ona kadar daha en ki ya değil her şey bi diye
   ile var yok olan bile artık şimdi sonra önce hep hiç böyle şu nasıl neden
   çünkü ancak yine gece gündüz olsun oldu olur musun misin`
    .split(/\s+/)
    .filter(Boolean)
);

let wordCache = null;

function topWords() {
  const okCount = db
    .prepare("SELECT COUNT(*) c FROM lyrics WHERE status = 'ok'")
    .get().c;
  if (wordCache && wordCache.okCount === okCount) return wordCache;

  const rows = db
    .prepare(
      `SELECT l.body, t.play_count FROM lyrics l
       JOIN tracks t ON t.id = l.track_id WHERE l.status = 'ok'`
    )
    .all();

  // songs = how many songs contain the word, plays = summed play counts of those songs
  const words = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (const m of r.body.toLowerCase().matchAll(/\p{L}[\p{L}']*/gu)) {
      const w = m[0].replace(/'/g, "");
      if (w.length < 3 || STOPWORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      const e = words.get(w) || { songs: 0, plays: 0 };
      e.songs += 1;
      e.plays += r.play_count;
      words.set(w, e);
    }
  }

  const list = [...words.entries()]
    .map(([word, e]) => ({ word, songs: e.songs, plays: e.plays }))
    .sort((a, b) => b.songs - a.songs)
    .slice(0, 300);

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
  const totals = db
    .prepare(
      `SELECT COUNT(*) tracks, COUNT(DISTINCT artist) artists,
              SUM(play_count) plays, SUM(ms_played) ms FROM tracks`
    )
    .get();
  const topSongs = db
    .prepare(
      `SELECT id, artist, track, play_count, ms_played FROM tracks
       WHERE play_count > 0 ORDER BY ms_played DESC LIMIT 25`
    )
    .all();
  const topArtists = db
    .prepare(
      `SELECT artist, COUNT(*) songs, SUM(play_count) plays, SUM(ms_played) ms
       FROM tracks GROUP BY artist HAVING plays > 0
       ORDER BY ms DESC LIMIT 25`
    )
    .all();
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
  const tracks = db.prepare("SELECT COUNT(*) c FROM tracks").get().c;
  const statuses = db
    .prepare("SELECT status, COUNT(*) c FROM lyrics GROUP BY status")
    .all();
  const lyrics = Object.fromEntries(statuses.map((r) => [r.status, r.c]));
  res.json({
    tracks,
    processed: statuses.reduce((s, r) => s + r.c, 0),
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
      .send("Spotify credentials missing — see Backend/.env.example");
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

  const placeholders = trackIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, artist, track, uri FROM tracks WHERE id IN (${placeholders})`
    )
    .all(...trackIds.map(Number));

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
