"use strict";

// Spotify OAuth + Web API client. Stateless: every call takes the credentials or
// access token it needs as an argument — no token storage, no env, no DB. The host
// owns persistence (via the StorageAdapter) and supplies tokens.

const { cleanTitle, normalize } = require("./matching");

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

/** Build the OAuth authorize URL. */
function authorizeUrl({ clientId, redirectUri, scopes, state }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest({ clientId, clientSecret }, body) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
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

/** Exchange an authorization code for tokens. Returns Spotify's raw token JSON. */
async function exchangeCode({ clientId, clientSecret, redirectUri, code }) {
  return tokenRequest(
    { clientId, clientSecret },
    { grant_type: "authorization_code", code, redirect_uri: redirectUri }
  );
}

/** Refresh an access token. Returns Spotify's raw token JSON. */
async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  return tokenRequest(
    { clientId, clientSecret },
    { grant_type: "refresh_token", refresh_token: refreshToken }
  );
}

async function apiFetch(token, path, options = {}) {
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
    return apiFetch(token, path, options);
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

const apiGet = (token, path) => apiFetch(token, path);
const apiPost = (token, path, body) =>
  apiFetch(token, path, { method: "POST", body: JSON.stringify(body) });

/** Fetch the authenticated user's profile. */
async function getMe(token) {
  return apiGet(token, "/me");
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

/**
 * Find a track's Spotify URI by name. Returns the URI or null. Rethrows NO_AUTH
 * (token rejected) but swallows other search errors as "not found" — same policy
 * as the original resolveUri. Does NOT persist; the host caches the result.
 */
async function searchTrackUri(token, { artist, track }) {
  const title = cleanTitle(track);
  const q = `track:${title} artist:${artist}`;
  let found = null;

  try {
    const res = await apiGet(token, `/search?q=${encodeURIComponent(q)}&type=track&limit=5`);
    found = pickMatch(res.items || (res.tracks && res.tracks.items) || [], artist, title);

    // Field-scoped search is strict; retry as free text when it finds nothing.
    if (!found) {
      const loose = await apiGet(
        token,
        `/search?q=${encodeURIComponent(`${title} ${artist}`)}&type=track&limit=5`
      );
      found = pickMatch(loose.tracks ? loose.tracks.items : [], artist, title);
    }
  } catch (err) {
    if (err.code === "NO_AUTH") throw err;
    return null;
  }

  return found ? found.uri : null;
}

async function createPlaylist(token, userId, { name, isPublic, description }) {
  return apiPost(token, `/users/${encodeURIComponent(userId)}/playlists`, {
    name,
    public: !!isPublic,
    description: description || "",
  });
}

/** Spotify caps additions at 100 URIs per request. */
async function addTracks(token, playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    await apiPost(token, `/playlists/${playlistId}/tracks`, {
      uris: uris.slice(i, i + 100),
    });
  }
}

module.exports = {
  authorizeUrl,
  exchangeCode,
  refreshAccessToken,
  getMe,
  pickMatch,
  searchTrackUri,
  createPlaylist,
  addTracks,
};
