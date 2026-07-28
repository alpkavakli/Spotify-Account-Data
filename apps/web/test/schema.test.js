"use strict";

// Tests for the multi-tenant schema in migrations/001_init.sql.
//
// These are not "does the table exist" tests. They check the things the design
// actually depends on, each of which is a way the SaaS could be silently wrong:
//
//   * tenant isolation — one user's data can never appear in another's results
//   * global sharing   — two users owning the same song share ONE songs row and
//                        ONE lyrics row, which is the whole storage argument
//   * the generated tsvector — stemming, and staying correct with no index
//                        maintenance code to forget
//   * erasure          — deleting a user really deletes their data (GDPR)
//   * types            — what node-postgres hands back has to match what
//                        SqliteAdapter already returns, or Step 4's conformance
//                        suite fails in ways that look like adapter bugs

const test = require("node:test");
const assert = require("node:assert/strict");

const { skipWithoutPostgres, freshDatabase, createUser, createSong } = require("./helpers/pg");

test.describe("schema", { skip: skipWithoutPostgres() }, () => {
  let pool;

  test.before(async () => {
    // One migrated database for the whole file: the migration is the expensive
    // part, and each test creates its own users, so they cannot collide.
    pool = await freshDatabase("schema");
  });

  test.after(async () => {
    await pool?.end();
  });

  // ── tenant isolation ────────────────────────────────────────────────────

  test.describe("multi-tenancy", () => {
    test.it("keeps two users' libraries completely separate", async () => {
      const [alice, bob] = [await createUser(pool), await createUser(pool)];
      const song = await createSong(pool, { artist: "Aurora Vale", track: "Open Door" });

      await pool.query(
        "INSERT INTO user_songs (user_id, song_id, play_count) VALUES ($1, $2, 30)",
        [alice, song]
      );

      const mine = await pool.query("SELECT * FROM user_songs WHERE user_id = $1", [alice]);
      const theirs = await pool.query("SELECT * FROM user_songs WHERE user_id = $1", [bob]);
      assert.equal(mine.rows.length, 1);
      assert.equal(theirs.rows.length, 0);
    });

    test.it("lets two users own the same song with different play counts", async () => {
      // The core of the model: one global song, two independent per-user rows.
      const [alice, bob] = [await createUser(pool), await createUser(pool)];
      const song = await createSong(pool);

      await pool.query(
        `INSERT INTO user_songs (user_id, song_id, play_count, stream_count)
         VALUES ($1, $3, 30, 24), ($2, $3, 4, 1)`,
        [alice, bob, song]
      );

      const { rows } = await pool.query(
        "SELECT user_id, play_count FROM user_songs WHERE song_id = $1 ORDER BY play_count DESC",
        [song]
      );
      assert.deepEqual(rows.map((r) => r.play_count), [30, 4]);
      assert.equal(
        (await pool.query("SELECT count(*)::int n FROM songs WHERE id = $1", [song])).rows[0].n,
        1,
        "the song must be stored once, not once per user"
      );
    });

    test.it("cannot give the same user the same song twice", async () => {
      const user = await createUser(pool);
      const song = await createSong(pool);
      await pool.query("INSERT INTO user_songs (user_id, song_id) VALUES ($1, $2)", [user, song]);
      await assert.rejects(
        () => pool.query("INSERT INTO user_songs (user_id, song_id) VALUES ($1, $2)", [user, song]),
        /duplicate key/
      );
    });

    test.it("refuses per-user rows for a user or song that does not exist", async () => {
      const user = await createUser(pool);
      const song = await createSong(pool);
      await assert.rejects(
        () => pool.query("INSERT INTO user_songs (user_id, song_id) VALUES ($1, $2)", [user, 9999999]),
        /foreign key/
      );
      await assert.rejects(
        () => pool.query("INSERT INTO user_songs (user_id, song_id) VALUES ($1, $2)", [9999999, song]),
        /foreign key/
      );
    });
  });

  // ── the global catalogue ────────────────────────────────────────────────

  test.describe("global songs and lyrics", () => {
    test.it("treats match_key as the global identity", async () => {
      await createSong(pool, { match_key: "the doors|||break on through" });
      await assert.rejects(
        () => createSong(pool, { match_key: "the doors|||break on through" }),
        /duplicate key/
      );
    });

    test.it("stores lyrics once per song, not per user", async () => {
      const song = await createSong(pool);
      await pool.query(
        "INSERT INTO lyrics (song_id, status, source, body) VALUES ($1, 'ok', 'lrclib', $2)",
        [song, "I opened the door"]
      );
      await assert.rejects(
        () => pool.query("INSERT INTO lyrics (song_id, status) VALUES ($1, 'ok')", [song]),
        /duplicate key/
      );
    });

    test.it("rejects a lyric status the application does not define", async () => {
      const song = await createSong(pool);
      await assert.rejects(
        () => pool.query("INSERT INTO lyrics (song_id, status) VALUES ($1, 'weird')", [song]),
        /check constraint/
      );
    });

    test.it("deletes lyrics when their song goes", async () => {
      const song = await createSong(pool);
      await pool.query("INSERT INTO lyrics (song_id, status) VALUES ($1, 'ok')", [song]);
      await pool.query("DELETE FROM songs WHERE id = $1", [song]);
      const { rows } = await pool.query("SELECT count(*)::int n FROM lyrics WHERE song_id = $1", [song]);
      assert.equal(rows[0].n, 0);
    });
  });

  // ── full-text search ────────────────────────────────────────────────────

  test.describe("full-text search", () => {
    async function songWithLyrics(body, status = "ok") {
      const song = await createSong(pool);
      await pool.query(
        "INSERT INTO lyrics (song_id, status, body) VALUES ($1, $2, $3)",
        [song, status, body]
      );
      return song;
    }

    const search = (q) =>
      pool.query(
        `SELECT song_id FROM lyrics
         WHERE body_tsv @@ websearch_to_tsquery('english', $1)`,
        [q]
      );

    test.it("stems — searching 'door' finds a body that only says 'doors'", async () => {
      // The conformance suite asserts this for every adapter. SQLite gets it
      // from the porter tokenizer; Postgres has to get it from the english
      // dictionary, and this is where we find out whether it really does.
      const song = await songWithLyrics("Two doors down the hallway waits");
      const { rows } = await search("door");
      assert.ok(rows.some((r) => r.song_id === song));
    });

    test.it("matches other inflections too", async () => {
      const song = await songWithLyrics("she was running through the rain");
      assert.ok((await search("run")).rows.some((r) => r.song_id === song));
    });

    test.it("does not match a word that is not there", async () => {
      const song = await songWithLyrics("a window in the quiet field");
      assert.ok(!(await search("door")).rows.some((r) => r.song_id === song));
    });

    test.it("maintains the index with no application code at all", async () => {
      // body_tsv is a GENERATED column. There is no INSERT into an index table
      // anywhere in the app, which is why it cannot drift out of sync the way
      // the SQLite FTS table can.
      const song = await songWithLyrics("lanterns only");
      assert.ok((await search("lanterns")).rows.some((r) => r.song_id === song));

      await pool.query("UPDATE lyrics SET body = $2 WHERE song_id = $1", [song, "corridors only"]);
      assert.ok(!(await search("lanterns")).rows.some((r) => r.song_id === song), "stale term still indexed");
      assert.ok((await search("corridor")).rows.some((r) => r.song_id === song), "new term not indexed");
    });

    test.it("drops a song out of search when its lyrics stop being ok", async () => {
      // The exact failure the SQLite adapter needs explicit DELETE code for:
      // a re-fetch turning a hit into a miss. Here, body becomes NULL and the
      // generated tsvector empties itself.
      const song = await songWithLyrics("I opened the door");
      assert.ok((await search("door")).rows.some((r) => r.song_id === song));

      await pool.query(
        "UPDATE lyrics SET status = 'notfound', body = NULL WHERE song_id = $1",
        [song]
      );
      assert.ok(!(await search("door")).rows.some((r) => r.song_id === song));
    });

    test.it("gives an instrumental an empty index entry rather than null", async () => {
      const song = await songWithLyrics(null, "instrumental");
      const { rows } = await pool.query("SELECT body_tsv FROM lyrics WHERE song_id = $1", [song]);
      assert.equal(rows[0].body_tsv, "", "coalesce should produce an empty tsvector, not NULL");
    });

    test.it("produces snippets with the [[ ]] markers the contract requires", async () => {
      // The conformance suite asserts [[ ]] around the match, because that is
      // what SqliteAdapter's snippet() emits and what the frontend turns into
      // <mark>. ts_headline has to be configured to match exactly.
      const song = await songWithLyrics("I opened the door and stepped into the light");
      const { rows } = await pool.query(
        `SELECT ts_headline('english', body, websearch_to_tsquery('english', $2),
                            'StartSel=[[, StopSel=]], MaxWords=12, MinWords=5') AS snippet
         FROM lyrics WHERE song_id = $1`,
        [song, "door"]
      );
      assert.match(rows[0].snippet, /\[\[door\]\]/i);
    });

    test.it("uses the GIN index rather than scanning every lyric", async () => {
      const { rows } = await pool.query(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'lyrics' AND indexdef ILIKE '%gin%'`
      );
      assert.equal(rows.length, 1, "the tsvector GIN index is missing");
      assert.equal(rows[0].indexname, "lyrics_body_tsv_idx");
    });
  });

  // ── GDPR erasure ────────────────────────────────────────────────────────

  test.describe("account deletion", () => {
    test.it("removes every trace of the user, and nothing else", async () => {
      // "Working disconnect + delete" is a legal obligation once we host user
      // data. Making it a single DELETE with cascades — rather than a cleanup
      // routine someone has to remember to extend — is what keeps it true as
      // tables are added.
      const [victim, bystander] = [await createUser(pool), await createUser(pool)];
      const song = await createSong(pool);

      for (const u of [victim, bystander]) {
        await pool.query("INSERT INTO user_songs (user_id, song_id) VALUES ($1, $2)", [u, song]);
        await pool.query("INSERT INTO user_meta (user_id, key, value) VALUES ($1, 'k', 'v')", [u]);
        await pool.query(
          "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
          [Buffer.from(`session-${u}`), u]
        );
        await pool.query("INSERT INTO spotify_accounts (user_id) VALUES ($1)", [u]);
        await pool.query("INSERT INTO uploads (user_id, blob_key) VALUES ($1, 'k')", [u]);
      }

      await pool.query("DELETE FROM users WHERE id = $1", [victim]);

      for (const table of ["user_songs", "user_meta", "sessions", "spotify_accounts", "uploads"]) {
        const gone = await pool.query(
          `SELECT count(*)::int n FROM ${table} WHERE user_id = $1`, [victim]
        );
        assert.equal(gone.rows[0].n, 0, `${table} still holds the deleted user's data`);

        const kept = await pool.query(
          `SELECT count(*)::int n FROM ${table} WHERE user_id = $1`, [bystander]
        );
        assert.equal(kept.rows[0].n, 1, `${table} lost another user's data`);
      }
    });

    test.it("leaves the global catalogue alone — other users still need it", async () => {
      const user = await createUser(pool);
      const song = await createSong(pool);
      await pool.query("INSERT INTO lyrics (song_id, status, body) VALUES ($1, 'ok', 'words')", [song]);
      await pool.query("INSERT INTO user_songs (user_id, song_id) VALUES ($1, $2)", [user, song]);

      await pool.query("DELETE FROM users WHERE id = $1", [user]);

      const { rows } = await pool.query("SELECT count(*)::int n FROM songs WHERE id = $1", [song]);
      assert.equal(rows[0].n, 1, "deleting a user must not delete shared songs");
    });
  });

  // ── accounts ────────────────────────────────────────────────────────────

  test.describe("accounts", () => {
    test.it("treats email as case-insensitive", async () => {
      // citext, so "Alp@Example.com" and "alp@example.com" are one account —
      // otherwise a passwordless login link silently creates a second one.
      await createUser(pool, "Case.Test@Example.com");
      await assert.rejects(() => createUser(pool, "case.test@example.com"), /duplicate key/);
    });

    test.it("finds a user by differently-cased email", async () => {
      const id = await createUser(pool, "Mixed.Case@Example.com");
      const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", [
        "MIXED.CASE@EXAMPLE.COM",
      ]);
      assert.equal(rows[0].id, id);
    });

    test.it("stores login tokens hashed, never in the clear", async () => {
      const { rows } = await pool.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'login_tokens' AND column_name = 'token_hash'`
      );
      assert.equal(rows[0].data_type, "bytea", "token_hash must hold a digest, not a token");
    });

    test.it("keeps a login token usable only once, by recording consumption", async () => {
      await pool.query(
        `INSERT INTO login_tokens (token_hash, email, expires_at)
         VALUES ($1, $2, now() + interval '15 minutes')`,
        [Buffer.from("hash-1"), "single.use@example.com"]
      );
      const { rows } = await pool.query(
        "SELECT consumed_at FROM login_tokens WHERE token_hash = $1",
        [Buffer.from("hash-1")]
      );
      assert.equal(rows[0].consumed_at, null);
    });
  });

  // ── types that the adapter contract depends on ──────────────────────────

  test.describe("column types the StorageAdapter contract relies on", () => {
    test.it("returns in_library as a number, not a boolean", async () => {
      // The contract says in_library is 0|1 and the routes do `!!row.in_library`.
      // A boolean column would come back as true/false and break the contract
      // SqliteAdapter already satisfies — so the column is smallint on purpose.
      const user = await createUser(pool);
      const song = await createSong(pool);
      await pool.query(
        "INSERT INTO user_songs (user_id, song_id, in_library) VALUES ($1, $2, 1)",
        [user, song]
      );
      const { rows } = await pool.query(
        "SELECT in_library FROM user_songs WHERE user_id = $1", [user]
      );
      assert.equal(typeof rows[0].in_library, "number");
      assert.equal(rows[0].in_library, 1);
    });

    test.it("rejects an in_library value that is not 0 or 1", async () => {
      const user = await createUser(pool);
      const song = await createSong(pool);
      await assert.rejects(
        () => pool.query(
          "INSERT INTO user_songs (user_id, song_id, in_library) VALUES ($1, $2, 7)",
          [user, song]
        ),
        /check constraint/
      );
    });

    test.it("returns play_count and stream_count as numbers", async () => {
      const user = await createUser(pool);
      const song = await createSong(pool);
      await pool.query(
        `INSERT INTO user_songs (user_id, song_id, play_count, stream_count)
         VALUES ($1, $2, 30, 24)`,
        [user, song]
      );
      const { rows } = await pool.query(
        "SELECT play_count, stream_count FROM user_songs WHERE user_id = $1", [user]
      );
      assert.equal(typeof rows[0].play_count, "number");
      assert.equal(typeof rows[0].stream_count, "number");
    });

    test.it("holds more milliseconds than an int4 can", async () => {
      // A real user has 3.7e9 ms of listening in ONE year; int4 tops out at
      // 2.1e9. This is why ms_played is bigint.
      const user = await createUser(pool);
      const song = await createSong(pool);
      await pool.query(
        "INSERT INTO user_songs (user_id, song_id, ms_played) VALUES ($1, $2, $3)",
        [user, song, 3_725_461_745]
      );
      const { rows } = await pool.query(
        "SELECT ms_played FROM user_songs WHERE user_id = $1", [user]
      );
      assert.equal(Number(rows[0].ms_played), 3_725_461_745);
    });

    test.it("can render playlists as the JSON array string the contract expects", async () => {
      // The contract says searchByLyrics returns `playlists` as a raw JSON
      // ARRAY STRING, which the host JSON.parses. jsonb::text gives exactly that.
      const user = await createUser(pool);
      const song = await createSong(pool);
      await pool.query(
        "INSERT INTO user_songs (user_id, song_id, playlists) VALUES ($1, $2, $3::jsonb)",
        [user, song, JSON.stringify(["Morning", "Late Night"])]
      );
      const { rows } = await pool.query(
        "SELECT playlists::text AS playlists FROM user_songs WHERE user_id = $1", [user]
      );
      assert.equal(typeof rows[0].playlists, "string");
      assert.deepEqual(JSON.parse(rows[0].playlists), ["Morning", "Late Night"]);
    });

    test.it("stores Spotify token expiry as epoch milliseconds", async () => {
      // The contract's saveTokens() passes Date.now() + expires_in * 1000, and
      // SqliteAdapter stores that integer verbatim. Postgres must agree, or a
      // token looks expired (or eternal) depending on which adapter is loaded.
      const user = await createUser(pool);
      const expiresAt = Date.now() + 3600_000;
      await pool.query(
        "INSERT INTO spotify_accounts (user_id, expires_at) VALUES ($1, $2)",
        [user, expiresAt]
      );
      const { rows } = await pool.query(
        "SELECT expires_at FROM spotify_accounts WHERE user_id = $1", [user]
      );
      assert.equal(Number(rows[0].expires_at), expiresAt);
    });
  });

  // ── indexes the query plans depend on ───────────────────────────────────

  test.describe("indexes", () => {
    test.it("has every index the planned queries need", async () => {
      const { rows } = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
      );
      const names = rows.map((r) => r.indexname);
      for (const expected of [
        "user_songs_user_plays_idx", // per-user listings, ordered by plays
        "user_songs_song_idx", // "who owns this song"
        "lyrics_body_tsv_idx", // lyric search
        "lyrics_status_idx", // what still needs fetching
        "sessions_user_idx",
        "uploads_user_idx",
      ]) {
        assert.ok(names.includes(expected), `missing index: ${expected}`);
      }
    });

    test.it("uses the tsvector index for a lyric search", async () => {
      // Guards against the index existing but not being usable — the operator
      // class or the tsquery config being wrong makes Postgres quietly seq-scan.
      await pool.query("SET enable_seqscan = off");
      try {
        const { rows } = await pool.query(
          `EXPLAIN (FORMAT JSON)
           SELECT song_id FROM lyrics WHERE body_tsv @@ websearch_to_tsquery('english', 'door')`
        );
        assert.match(JSON.stringify(rows[0]["QUERY PLAN"]), /lyrics_body_tsv_idx/);
      } finally {
        await pool.query("SET enable_seqscan = on");
      }
    });
  });
});
