const { db } = require("./db");
// Full Spotify extraction into @lyricsearch/core lands in Phase 0 Step 5, once the
// StorageAdapter owns token storage. For now only the pure matching helpers move.
const { normalize, cleanTitle } = require("@lyricsearch/core/matching");

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

// Creating a playlist needs both — public/private is chosen per playlist at
// creation time, and Spotify requires the matching scope for each.
const SCOPES = ["playlist-modify-public", "playlist-modify-private"];

// Spotify rejects http:// redirects except on the loopback IP, and it must be
// the literal 127.0.0.1 rather than localhost.
const REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || "http://127.0.0.1:3000/callback";

db.exec(`
  CREATE TABLE IF NOT EXISTS auth (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    access_token  TEXT,
    refresh_token TEXT,
    expires_at    INTEGER,
    user_id       TEXT,
    display_name  TEXT
  );
`);

function credentials() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    const err = new Error(
      "Spotify credentials missing — set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Backend/.env"
    );
    err.code = "NO_CREDENTIALS";
    throw err;
  }
  return { id, secret };
}

function isConfigured() {
  return !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

function authorizeUrl(state) {
  const { id } = credentials();
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", id);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(body) {
  const { id, secret } = credentials();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `spotify auth ${res.status}: ${json.error_description || json.error || "unknown"}`
    );
  }
  return json;
}

function saveTokens(tok, existingRefresh) {
  const expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
  db.prepare(
    `INSERT INTO auth (id, access_token, refresh_token, expires_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at`
  ).run(tok.access_token, tok.refresh_token || existingRefresh || null, expiresAt);
}

async function exchangeCode(code) {
  const tok = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  saveTokens(tok);
  const me = await apiGet("/me");
  db.prepare("UPDATE auth SET user_id = ?, display_name = ? WHERE id = 1").run(
    me.id,
    me.display_name || me.id
  );
  return me;
}

function session() {
  return db.prepare("SELECT * FROM auth WHERE id = 1").get() || null;
}

/** Returns a valid access token, refreshing 60s before expiry. */
async function accessToken() {
  const row = session();
  if (!row || !row.access_token) {
    const err = new Error("not logged in");
    err.code = "NO_AUTH";
    throw err;
  }
  if (Date.now() < row.expires_at - 60_000) return row.access_token;

  if (!row.refresh_token) {
    const err = new Error("session expired, log in again");
    err.code = "NO_AUTH";
    throw err;
  }
  const tok = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
  });
  saveTokens(tok, row.refresh_token);
  return tok.access_token;
}

function logout() {
  db.prepare("DELETE FROM auth WHERE id = 1").run();
}

async function apiFetch(path, options = {}) {
  const token = await accessToken();
  const res = await fetch(API + path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  // Spotify asks callers to back off via Retry-After rather than failing hard.
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") || 2);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    return apiFetch(path, options);
  }
  if (res.status === 401) {
    const err = new Error("spotify rejected the token, log in again");
    err.code = "NO_AUTH";
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `spotify ${res.status}: ${(body.error && body.error.message) || "request failed"}`
    );
  }
  return res.status === 204 ? null : res.json();
}

const apiGet = (path) => apiFetch(path);
const apiPost = (path, body) =>
  apiFetch(path, { method: "POST", body: JSON.stringify(body) });

/**
 * Finds a track URI on Spotify. Only ~22% of the exported rows carry a URI
 * (streaming history has none), so the rest are looked up by name and the
 * result is written back to tracks.uri to keep it a one-time cost.
 */
async function resolveUri(track) {
  if (track.uri) return track.uri;

  const title = cleanTitle(track.track);
  const q = `track:${title} artist:${track.artist}`;
  let found = null;

  try {
    const res = await apiGet(
      `/search?q=${encodeURIComponent(q)}&type=track&limit=5`
    );
    found = pickMatch(res.items || (res.tracks && res.tracks.items) || [], track.artist, title);

    // Field-scoped search is strict; retry as free text when it finds nothing.
    if (!found) {
      const loose = await apiGet(
        `/search?q=${encodeURIComponent(`${title} ${track.artist}`)}&type=track&limit=5`
      );
      found = pickMatch(loose.tracks ? loose.tracks.items : [], track.artist, title);
    }
  } catch (err) {
    if (err.code === "NO_AUTH") throw err;
    return null;
  }

  if (!found) return null;
  db.prepare("UPDATE tracks SET uri = ? WHERE id = ?").run(found.uri, track.id);
  return found.uri;
}

function pickMatch(items, artist, title) {
  const wantArtist = normalize(artist);
  const wantTitle = normalize(title);
  let best = null;
  let bestScore = 0;

  for (const item of items) {
    if (!item || !item.uri) continue;
    const gotTitle = normalize(item.name);
    const artists = (item.artists || []).map((a) => normalize(a.name));
    let score = 0;

    if (gotTitle === wantTitle) score += 4;
    else if (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle)) score += 2;

    if (artists.some((a) => a === wantArtist)) score += 4;
    else if (artists.some((a) => a.includes(wantArtist) || wantArtist.includes(a))) score += 2;

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  // Require a real signal on both title and artist, not one strong field.
  return bestScore >= 6 ? best : null;
}

async function createPlaylist(name, isPublic, description) {
  const row = session();
  return apiPost(`/users/${encodeURIComponent(row.user_id)}/playlists`, {
    name,
    public: !!isPublic,
    description: description || "",
  });
}

/** Spotify caps additions at 100 URIs per request. */
async function addTracks(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    await apiPost(`/playlists/${playlistId}/tracks`, {
      uris: uris.slice(i, i + 100),
    });
  }
}

module.exports = {
  SCOPES,
  REDIRECT_URI,
  isConfigured,
  authorizeUrl,
  exchangeCode,
  session,
  logout,
  resolveUri,
  createPlaylist,
  addTracks,
};
