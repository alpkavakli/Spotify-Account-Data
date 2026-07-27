"use strict";

// The StorageAdapter contract.
//
// core and the hosts depend on THIS abstraction, never on a concrete database
// (Dependency Inversion). Each edition ships one implementation:
//   - SqliteAdapter    (apps/personal)   — node:sqlite, single-user
//   - PostgresAdapter   (apps/web, later) — multi-tenant, user_id-scoped
// They must be fully interchangeable behind this interface (Liskov).
//
// Grouped by concern (Interface Segregation): ingest / search+read / lyrics /
// spotify-auth / lifecycle. The base class methods throw so a partial
// implementation fails loudly instead of silently misbehaving.
//
// EVERY METHOD IS ASYNC, and callers must await. node:sqlite is synchronous and
// SqliteAdapter could return values directly — but `pg` is Promise-based, so a
// synchronous contract is simply unimplementable on Postgres. One async contract
// is what keeps the two adapters interchangeable (Liskov) and lets `core` and the
// routes stay identical across editions. The cost on SQLite is one already-
// resolved promise per call; the alternative is two contracts and two hosts that
// drift apart. See docs/05-PHASE-1-SAAS.md, Step 2.

/**
 * @typedef {object} SongInput  Canonical song produced by core.ingest.buildSongs
 * @property {string} match_key
 * @property {string} artist
 * @property {string} track
 * @property {string|null} album
 * @property {string|null} uri
 * @property {number} in_library   0 | 1
 * @property {number} play_count
 * @property {number} ms_played
 * @property {string[]} playlists
 */

/**
 * @typedef {object} SearchRow  A lyric-search hit (host maps this to the HTTP shape)
 * @property {number} id
 * @property {string} artist
 * @property {string} track
 * @property {string|null} album
 * @property {string|null} uri
 * @property {number} play_count
 * @property {number} in_library
 * @property {string} playlists   raw JSON array string
 * @property {string} body        full lyric text (used for occurrence counting)
 * @property {string} snippet     highlighted excerpt
 */

/**
 * @typedef {object} LyricResult
 * @property {"ok"|"notfound"|"instrumental"|"error"} status
 * @property {string|null} source
 * @property {string|null} body
 */

class StorageAdapter {
  // ── ingest ──
  /** Insert/merge canonical songs. MUST be atomic (all-or-nothing).
   *  @param {SongInput[]} songs @returns {{inserted:number}} */
  async upsertSongs(songs) { throw new Error("StorageAdapter.upsertSongs not implemented"); }

  // ── search & read ──
  /** @param {string} ftsQuery @returns {SearchRow[]} (may throw on invalid FTS) */
  async searchByLyrics(ftsQuery) { throw new Error("StorageAdapter.searchByLyrics not implemented"); }
  /** @param {number} id @returns {object|null} full song + lyric status/body */
  async getSong(id) { throw new Error("StorageAdapter.getSong not implemented"); }
  /** @param {number[]} ids @returns {{id:number,artist:string,track:string,uri:string|null}[]} */
  async getSongsByIds(ids) { throw new Error("StorageAdapter.getSongsByIds not implemented"); }
  /** @returns {{totals:object, topSongs:object[], topArtists:object[]}} */
  async getStats() { throw new Error("StorageAdapter.getStats not implemented"); }
  /** @returns {{tracks:number, statuses:{status:string,count:number}[]}} */
  async getStatus() { throw new Error("StorageAdapter.getStatus not implemented"); }
  /** @returns {number} count of lyrics with status 'ok' (top-words cache key) */
  async getOkLyricCount() { throw new Error("StorageAdapter.getOkLyricCount not implemented"); }
  /** @returns {{body:string, play_count:number}[]} ok-status lyric bodies */
  async getOkLyricBodies() { throw new Error("StorageAdapter.getOkLyricBodies not implemented"); }

  // ── lyrics ──
  /** @param {{retryErrors?:boolean}} opts
   *  @returns {{id:number,artist:string,track:string}[]} songs missing lyrics */
  async getSongsNeedingLyrics(opts) { throw new Error("StorageAdapter.getSongsNeedingLyrics not implemented"); }
  /** Persist a lyric result and keep the search index in sync.
   *  @param {number} songId @param {LyricResult} result */
  async saveLyrics(songId, result) { throw new Error("StorageAdapter.saveLyrics not implemented"); }
  /** @returns {{status:string,count:number}[]} */
  async getLyricStatusCounts() { throw new Error("StorageAdapter.getLyricStatusCounts not implemented"); }

  // ── spotify auth (single-user here; per-user in the SaaS) ──
  /** @returns {object|null} the stored auth row */
  async getAuth() { throw new Error("StorageAdapter.getAuth not implemented"); }
  /** @param {{access_token:string, refresh_token:string|null, expires_at:number}} tokens */
  async saveTokens(tokens) { throw new Error("StorageAdapter.saveTokens not implemented"); }
  /** @param {{user_id:string, display_name:string}} identity */
  async setAuthUser(identity) { throw new Error("StorageAdapter.setAuthUser not implemented"); }
  async clearAuth() { throw new Error("StorageAdapter.clearAuth not implemented"); }
  /** Cache a resolved Spotify URI back onto a song. @param {number} songId @param {string} uri */
  async setSongUri(songId, uri) { throw new Error("StorageAdapter.setSongUri not implemented"); }

  // ── lifecycle ──
  async close() { throw new Error("StorageAdapter.close not implemented"); }
}

module.exports = { StorageAdapter };
