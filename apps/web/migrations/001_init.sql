-- 001 — initial multi-tenant schema for the hosted service.
--
-- The shape follows one idea: LYRICS ARE THE SAME FOR EVERYBODY. A song's words
-- do not depend on who listened to it, so songs and lyrics are stored ONCE,
-- globally, and the only per-user data is "which songs this user has and how
-- often they played them". That is what keeps storage flat as the user base
-- grows, and — more importantly — it means LRCLIB is asked about each song
-- exactly once no matter how many users own it.
--
-- Conventions:
--   * every per-user table cascades from users(id), so deleting an account
--     really deletes the account (GDPR erasure is a DELETE, not a cleanup job)
--   * identity columns rather than serial (the modern, standard-SQL form)
--   * timestamptz everywhere; never a naive timestamp
--   * epoch-millisecond bigints only where the StorageAdapter contract already
--     speaks in them (Spotify token expiry), so both adapters agree

-- Case-insensitive email without having to remember lower() at every call site.
CREATE EXTENSION IF NOT EXISTS citext;


-- ─────────────────────────────────────────────────────────────────────────────
-- Accounts
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        citext      NOT NULL UNIQUE,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Passwordless sign-in. We email a one-time link; the raw token NEVER touches
-- the database, only its SHA-256 — a leaked database dump must not be a set of
-- working login links.
--
-- Keyed by email rather than user_id on purpose: signing up and signing in are
-- the same flow, so a token can exist before the account does.
CREATE TABLE login_tokens (
  token_hash  bytea       PRIMARY KEY,
  email       citext      NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX login_tokens_email_idx   ON login_tokens (email);
CREATE INDEX login_tokens_expires_idx ON login_tokens (expires_at);

-- Sessions live in Postgres rather than in app memory so that any app server
-- can serve any request — the precondition for running more than one of them.
CREATE TABLE sessions (
  token_hash   bytea       PRIMARY KEY,
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);


-- ─────────────────────────────────────────────────────────────────────────────
-- Global song catalogue — shared by every user
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE songs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Produced by core.matching.matchKey(). The identity of a song across
  -- differently-spelled exports, and the reason two users who both own
  -- "Love Will Tear Us Apart - 2020 Remaster" share one row.
  match_key  text        NOT NULL UNIQUE,
  artist     text        NOT NULL,
  track      text        NOT NULL,
  album      text,
  -- Resolved once, globally: a track's Spotify URI is the same for everyone.
  uri        text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lyrics (
  song_id    bigint      PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
  status     text        NOT NULL CHECK (status IN ('ok', 'notfound', 'instrumental', 'error')),
  source     text,
  body       text,

  -- The search index, as a GENERATED column rather than a column the
  -- application maintains.
  --
  -- This is the one place the Postgres design is strictly better than SQLite's.
  -- In the SQLite adapter, saveLyrics has to DELETE from lyrics_fts and then
  -- re-INSERT, and if that is ever forgotten the search returns songs whose
  -- lyrics no longer exist. Here it is impossible: the tsvector is a function
  -- of `body`, recomputed by Postgres on every write. A row whose lyrics turn
  -- out to be 'notfound' has body = NULL, so its tsvector is empty and it
  -- silently stops matching. There is no index to keep in sync.
  --
  -- 'english' is written as an explicit regconfig because the one-argument
  -- to_tsvector() is only STABLE (it reads default_text_search_config) and a
  -- generated column requires IMMUTABLE.
  body_tsv   tsvector GENERATED ALWAYS AS
               (to_tsvector('english'::regconfig, coalesce(body, ''))) STORED,

  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- GIN is the right index for tsvector search: slower to write, much faster to
-- query, and lyric bodies are written once and searched forever.
CREATE INDEX lyrics_body_tsv_idx ON lyrics USING GIN (body_tsv);
-- Drives "what still needs fetching" for the global lyric worker.
CREATE INDEX lyrics_status_idx   ON lyrics (status);


-- ─────────────────────────────────────────────────────────────────────────────
-- Per-user data
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE user_songs (
  user_id      bigint   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  song_id      bigint   NOT NULL REFERENCES songs(id) ON DELETE CASCADE,

  -- 0/1 rather than boolean: the StorageAdapter contract says in_library is a
  -- number and the routes do `!!row.in_library`. A boolean column would come
  -- back from node-postgres as true/false and quietly break the contract that
  -- SqliteAdapter already satisfies.
  in_library   smallint NOT NULL DEFAULT 0 CHECK (in_library IN (0, 1)),

  -- Every play over 0 ms, skips included.
  play_count   integer  NOT NULL DEFAULT 0,
  -- Only the plays past the skip threshold (30s by default).
  stream_count integer  NOT NULL DEFAULT 0,
  -- bigint, not integer: one real user already has 3.7e9 ms of listening in a
  -- single year, which overflows int4 at 2.1e9.
  ms_played    bigint   NOT NULL DEFAULT 0,

  playlists    jsonb    NOT NULL DEFAULT '[]'::jsonb,

  PRIMARY KEY (user_id, song_id)
);

-- The primary key already covers "this user's songs"; this one exists because
-- every listing is ordered by play count within a user.
CREATE INDEX user_songs_user_plays_idx ON user_songs (user_id, play_count DESC);
-- The reverse direction: "who owns this song", used when deciding whether a
-- song still needs its lyrics fetched.
CREATE INDEX user_songs_song_idx       ON user_songs (song_id);

-- Facts about a user's ingested dataset rather than about any song: which
-- period their streaming history covers, the skip threshold that produced their
-- counts, when it was ingested. Backs getMeta()/setMeta() in the contract.
CREATE TABLE user_meta (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     text   NOT NULL,
  value   text,
  PRIMARY KEY (user_id, key)
);

-- Optional Spotify connection (Phase 2). A user with no row here is an
-- upload-only user, which is a first-class case — the whole service works
-- without ever touching Spotify's API.
--
-- Tokens are encrypted by the application before they arrive here; the column
-- type is text because it stores ciphertext, not a token.
CREATE TABLE spotify_accounts (
  user_id         bigint      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  spotify_user_id text,
  display_name    text,
  access_token    text,
  refresh_token   text,
  -- Epoch milliseconds, because the StorageAdapter contract already speaks in
  -- them (Date.now() + expires_in * 1000) and both adapters must agree.
  expires_at      bigint,
  scopes          text,
  connected_at    timestamptz NOT NULL DEFAULT now()
);

-- Export uploads. The HTTP request only stores the blob and a row here; the
-- worker does the parsing, because an export can take minutes and no request
-- should be held open for that.
CREATE TABLE uploads (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Opaque key into the BlobStore (local disk now, S3/R2 later).
  blob_key     text        NOT NULL,
  filename     text,
  bytes        bigint,
  status       text        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  error        text,
  songs_found  integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX uploads_user_idx   ON uploads (user_id, created_at DESC);
CREATE INDEX uploads_status_idx ON uploads (status);
