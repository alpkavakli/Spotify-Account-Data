"use strict";

// Personal Edition Spotify glue: credentials from env, token storage via the
// StorageAdapter, all HTTP/OAuth logic delegated to @lyricsearch/core/spotify.
// The auth table schema now lives in the adapter (created on construction).

const store = require("./store");
const spotify = require("@lyricsearch/core/spotify");

// Creating a playlist needs both — public/private is chosen per playlist at
// creation time, and Spotify requires the matching scope for each.
const SCOPES = ["playlist-modify-public", "playlist-modify-private"];

// Spotify rejects http:// redirects except on the loopback IP, and it must be
// the literal 127.0.0.1 rather than localhost.
const REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || "http://127.0.0.1:3000/callback";

function credentials() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    const err = new Error(
      "Spotify credentials missing — set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in apps/personal/.env"
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
  return spotify.authorizeUrl({
    clientId: id,
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    state,
  });
}

function saveTokens(tok, existingRefresh) {
  const expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
  store.saveTokens({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || existingRefresh || null,
    expires_at: expiresAt,
  });
}

async function exchangeCode(code) {
  const { id, secret } = credentials();
  const tok = await spotify.exchangeCode({
    clientId: id,
    clientSecret: secret,
    redirectUri: REDIRECT_URI,
    code,
  });
  saveTokens(tok);
  const me = await spotify.getMe(tok.access_token);
  store.setAuthUser({ user_id: me.id, display_name: me.display_name || me.id });
  return me;
}

function session() {
  return store.getAuth();
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
  const { id, secret } = credentials();
  const tok = await spotify.refreshAccessToken({
    clientId: id,
    clientSecret: secret,
    refreshToken: row.refresh_token,
  });
  saveTokens(tok, row.refresh_token);
  return tok.access_token;
}

function logout() {
  store.clearAuth();
}

/**
 * Finds a track URI on Spotify. Only ~22% of the exported rows carry a URI
 * (streaming history has none), so the rest are looked up by name and the
 * result is written back to tracks.uri to keep it a one-time cost.
 */
async function resolveUri(track) {
  if (track.uri) return track.uri;
  const token = await accessToken();
  const uri = await spotify.searchTrackUri(token, {
    artist: track.artist,
    track: track.track,
  });
  if (uri) store.setSongUri(track.id, uri);
  return uri;
}

async function createPlaylist(name, isPublic, description) {
  const token = await accessToken();
  const row = session();
  return spotify.createPlaylist(token, row.user_id, { name, isPublic, description });
}

async function addTracks(playlistId, uris) {
  const token = await accessToken();
  return spotify.addTracks(token, playlistId, uris);
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
