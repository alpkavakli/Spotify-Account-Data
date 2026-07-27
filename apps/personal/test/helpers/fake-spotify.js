"use strict";

// A stand-in for src/spotify.js.
//
// The real module talks to accounts.spotify.com and api.spotify.com, needs
// client credentials, and cannot be exercised in CI at all. Because createApp
// takes the Spotify client as an argument, a test can hand in this object
// instead and drive every branch of the auth and playlist routes — including
// the failure paths (token rejected, no match on Spotify) that are almost
// impossible to trigger against the real API on demand.
//
// It records the calls it received so tests can assert on what the route did,
// not just on what it replied.

/**
 * @param {object} [overrides] any property here replaces the default behavior
 */
function fakeSpotify(overrides = {}) {
  const calls = { exchangeCode: [], resolveUri: [], createPlaylist: [], addTracks: [], logout: 0 };

  const fake = {
    REDIRECT_URI: "http://127.0.0.1:3000/callback",
    SCOPES: ["playlist-modify-public", "playlist-modify-private"],
    calls,

    configured: true,
    currentSession: null,

    isConfigured() {
      return fake.configured;
    },
    authorizeUrl(state) {
      return `https://accounts.spotify.com/authorize?state=${state}`;
    },
    async exchangeCode(code) {
      calls.exchangeCode.push(code);
      fake.currentSession = { access_token: "test-token", display_name: "Test User", user_id: "u1" };
      return { id: "u1", display_name: "Test User" };
    },
    async session() {
      return fake.currentSession;
    },
    async logout() {
      calls.logout++;
      fake.currentSession = null;
    },
    async resolveUri(track) {
      calls.resolveUri.push(track);
      return track.uri || `spotify:track:resolved-${track.id}`;
    },
    async createPlaylist(name, isPublic, description) {
      calls.createPlaylist.push({ name, isPublic, description });
      return {
        id: "playlist-1",
        name,
        external_urls: { spotify: "https://open.spotify.com/playlist/playlist-1" },
      };
    },
    async addTracks(playlistId, uris) {
      calls.addTracks.push({ playlistId, uris });
    },

    /** Convenience: pretend the user is already logged in. */
    loggedIn() {
      fake.currentSession = {
        access_token: "test-token",
        display_name: "Test User",
        user_id: "u1",
      };
      return fake;
    },
  };

  return Object.assign(fake, overrides);
}

module.exports = { fakeSpotify };
