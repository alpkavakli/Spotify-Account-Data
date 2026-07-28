"use strict";

// The zip reader parses a file an anonymous user uploaded, so these tests care
// as much about what it REFUSES as about what it reads.

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const { readZip, readSpotifyExport } = require("../src/zip");
const { makeZip, makeSpotifyExportZip } = require("../testing/make-zip");

const text = (entries, name) =>
  entries.find((e) => e.name === name)?.data.toString("utf8");

test.describe("readZip", () => {
  test.it("reads a deflated archive", () => {
    const zip = makeZip({ "a.txt": "hello", "b.txt": "world" });
    const entries = readZip(zip);
    assert.equal(entries.length, 2);
    assert.equal(text(entries, "a.txt"), "hello");
    assert.equal(text(entries, "b.txt"), "world");
  });

  test.it("reads a stored (uncompressed) archive", () => {
    const zip = makeZip({ "a.txt": "hello" }, { compress: false });
    assert.equal(text(readZip(zip), "a.txt"), "hello");
  });

  test.it("round-trips binary content byte for byte", () => {
    const data = Buffer.from([0x00, 0xff, 0xfe, 0x7f, 0x80, 0x01]);
    const entries = readZip(makeZip({ "b.bin": data }));
    assert.deepEqual(entries[0].data, data);
  });

  test.it("reads content larger than one deflate block", () => {
    const big = "x".repeat(500_000) + "needle" + "y".repeat(500_000);
    const entries = readZip(makeZip({ "big.txt": big }));
    assert.equal(entries[0].data.toString("utf8").length, big.length);
    assert.ok(entries[0].data.toString("utf8").includes("needle"));
  });

  test.it("keeps nested paths and skips directory entries", () => {
    const zip = makeZip({ "folder/": "", "folder/a.txt": "nested" });
    const entries = readZip(zip);
    assert.deepEqual(entries.map((e) => e.name), ["folder/a.txt"]);
  });

  test.it("finds the central directory past an archive comment", () => {
    // The EOCD record is followed by up to 64 KB of comment, so it has to be
    // found by scanning backwards rather than read from a fixed offset.
    const zip = makeZip({ "a.txt": "hi" }, { comment: "z".repeat(3000) });
    assert.equal(text(readZip(zip), "a.txt"), "hi");
  });

  test.it("handles an empty archive", () => {
    assert.deepEqual(readZip(makeZip({})), []);
  });

  test.it("handles a zero-byte file inside the archive", () => {
    const entries = readZip(makeZip({ "empty.txt": "" }));
    assert.equal(entries[0].data.length, 0);
  });

  test.it("decodes UTF-8 filenames", () => {
    const entries = readZip(makeZip({ "şarkı.json": "{}" }));
    assert.equal(entries[0].name, "şarkı.json");
  });

  // ── filtering ───────────────────────────────────────────────────────────

  test.it("filters by name BEFORE decompressing", () => {
    // Which is what stops a hostile archive making us inflate 200 files we were
    // never going to read.
    const seen = [];
    const zip = makeZip({ "keep.json": "{}", "skip.bin": "x".repeat(1000) });
    const entries = readZip(zip, {
      filter: (name) => {
        seen.push(name);
        return name.endsWith(".json");
      },
    });
    assert.deepEqual(entries.map((e) => e.name), ["keep.json"]);
    assert.deepEqual(seen.sort(), ["keep.json", "skip.bin"]);
  });

  // ── refusals ────────────────────────────────────────────────────────────

  test.it("refuses input that is not a zip", () => {
    assert.throws(() => readZip(Buffer.from("not a zip at all")), /not a zip file/);
    assert.throws(() => readZip(Buffer.alloc(4)), /too short/);
    assert.throws(() => readZip("a string"), /expects a Buffer/);
  });

  test.it("refuses an entry whose uncompressed size exceeds the cap", () => {
    const zip = makeZip({ "big.txt": "x".repeat(10_000) });
    assert.throws(() => readZip(zip, { maxEntryBytes: 1000 }), /too large/);
  });

  test.it("refuses when the total across entries exceeds the cap", () => {
    const zip = makeZip({ a: "x".repeat(600), b: "y".repeat(600) });
    assert.throws(() => readZip(zip, { maxTotalBytes: 1000 }), /exceed the size limit/);
  });

  test.it("survives a zip bomb — a small entry claiming to be enormous", () => {
    // 10 MB of zeroes deflates to a few KB. Without a cap on the INFLATED size,
    // a handful of these is an out-of-memory crash.
    const bomb = Buffer.alloc(10 * 1024 * 1024, 0);
    const zip = makeZip({ "bomb.bin": bomb });
    assert.ok(zip.length < 100_000, "the test bomb should be small on disk");
    assert.throws(() => readZip(zip, { maxEntryBytes: 64 * 1024 }), /too large/);
  });

  test.it("refuses an entry whose real size does not match its header", () => {
    // A header that under-reports its size would slip past the caps.
    const zip = makeZip({ "liar.txt": "x".repeat(1000) }, {
      corrupt: (e) => {
        e.uncompressedSize = 10;
      },
    });
    assert.throws(() => readZip(zip), /header said 10 bytes|too large/);
  });

  test.it("refuses an entry whose checksum does not match", () => {
    const zip = makeZip({ "tampered.txt": "hello" }, {
      corrupt: (e) => {
        e.crc = 0xdeadbeef;
      },
    });
    assert.throws(() => readZip(zip), /checksum mismatch/);
  });

  test.it("refuses an encrypted entry rather than returning nonsense", () => {
    const zip = makeZip({ "secret.txt": "hello" }, {
      corrupt: (e) => {
        e.flags = 0x1; // encrypted
      },
    });
    assert.throws(() => readZip(zip), /encrypted/);
  });

  test.it("refuses a compression method it does not implement", () => {
    const zip = makeZip({ "weird.txt": "hello" }, {
      corrupt: (e) => {
        e.method = 12; // bzip2
      },
    });
    assert.throws(() => readZip(zip), /unsupported compression method 12/);
  });

  test.it("refuses zip64 rather than misreading it", () => {
    const zip = makeZip({ "a.txt": "hi" }, {
      corrupt: (e) => {
        e.uncompressedSize = 0xffffffff;
      },
    });
    assert.throws(() => readZip(zip), /zip64|too large/);
  });

  test.it("refuses an archive truncated after the header", () => {
    const zip = makeZip({ "a.txt": "hello world" });
    const eocd = zip.subarray(zip.length - 22);
    const truncated = Buffer.concat([zip.subarray(0, 20), eocd]);
    assert.throws(() => readZip(truncated), /corrupt zip|not a zip file/);
  });

  test.it("refuses a central directory pointing past the end of the file", () => {
    const zip = makeZip({ "a.txt": "hi" });
    zip.writeUInt32LE(zip.length + 5000, zip.length - 22 + 16); // central offset
    assert.throws(() => readZip(zip), /past the end|corrupt zip/);
  });
});

test.describe("readSpotifyExport", () => {
  test.it("pulls the library, playlists and history out of a real export layout", () => {
    const result = readSpotifyExport(makeSpotifyExportZip());
    assert.ok(result.library.tracks);
    assert.ok(result.playlists.playlists);
    assert.equal(result.histories.length, 1);
    assert.equal(result.hasExtendedHistory, false);
  });

  test.it("matches on the basename, so the enclosing folder does not matter", () => {
    // Spotify nests the export in a folder, and users re-zip things themselves —
    // adding or removing a level must not stop it working.
    for (const folder of ["Spotify Account Data", "", "a/b/c", "my stuff"]) {
      const result = readSpotifyExport(makeSpotifyExportZip({}, folder));
      assert.ok(result.library, `folder: "${folder}"`);
      assert.equal(result.histories.length, 1, `folder: "${folder}"`);
    }
  });

  test.it("recognises the extended streaming history format", () => {
    const result = readSpotifyExport(
      makeSpotifyExportZip({
        extended: true,
        histories: [[{ ts: "2019-03-04T08:00:00Z", ms_played: 1000 }]],
      })
    );
    assert.equal(result.hasExtendedHistory, true);
    assert.equal(result.histories.length, 1);
  });

  test.it("reads multi-part history in numeric order", () => {
    const result = readSpotifyExport(
      makeSpotifyExportZip({
        histories: [
          [{ artistName: "A", trackName: "0", msPlayed: 1 }],
          [{ artistName: "A", trackName: "1", msPlayed: 1 }],
          [{ artistName: "A", trackName: "2", msPlayed: 1 }],
        ],
      })
    );
    assert.deepEqual(result.histories.map((h) => h[0].trackName), ["0", "1", "2"]);
  });

  test.it("ignores everything else in the export", () => {
    // A real export has Payments.json, Inferences.json, podcasts, and more.
    const result = readSpotifyExport(
      makeSpotifyExportZip({
        extras: {
          "Spotify Account Data/Payments.json": "{}",
          "Spotify Account Data/Inferences.json": "{}",
          "Spotify Account Data/StreamingHistory_podcast_0.json": "[]",
          "Spotify Account Data/Streaming_History_Video_2020_0.json": "[]",
          "Spotify Account Data/read_me_first.pdf": "not json at all",
        },
      })
    );
    assert.equal(result.files.length, 3, `unexpected: ${result.files.join(", ")}`);
    assert.ok(!result.files.some((f) => /podcast|Video|Payments/i.test(f)));
  });

  test.it("ignores macOS resource forks", () => {
    // Zipping on a Mac adds __MACOSX/._YourLibrary.json, which has the right
    // basename and is not JSON.
    const result = readSpotifyExport(
      makeSpotifyExportZip({
        extras: {
          "__MACOSX/Spotify Account Data/._YourLibrary.json": "\x00\x05\x16binary",
        },
      })
    );
    assert.ok(result.library.tracks, "the real file should still be read");
    assert.ok(!result.files.some((f) => f.includes("__MACOSX")));
  });

  test.it("copes with a partial export", () => {
    const result = readSpotifyExport(
      makeSpotifyExportZip({ library: null, playlists: null })
    );
    assert.equal(result.library, null);
    assert.equal(result.playlists, null);
    assert.equal(result.histories.length, 1);
  });

  test.it("reports an empty result for a zip with nothing we recognise", () => {
    const result = readSpotifyExport(makeZip({ "notes.txt": "hi" }));
    assert.deepEqual(result.files, []);
    assert.equal(result.library, null);
  });

  test.it("names the file when the JSON is broken", () => {
    // The message reaches the user on the uploads page, so it has to say which
    // file rather than "Unexpected token < in JSON at position 0".
    const zip = makeZip({ "Spotify Account Data/YourLibrary.json": "{not json" });
    assert.throws(() => readSpotifyExport(zip), /YourLibrary\.json is not valid JSON/);
  });
});
