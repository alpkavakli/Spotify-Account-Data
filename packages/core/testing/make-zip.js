"use strict";

// A minimal ZIP *writer*, for tests only.
//
// The reader is tested against archives built here rather than against a
// checked-in binary fixture: a fixture is opaque, cannot be varied, and tells
// you nothing about why a test fails. This lets a test say "an archive with a
// lying size header" or "a deflated entry inside a folder" in one line.
//
// Exported from @lyricsearch/core/testing so any host can build export archives
// for its own tests too.

const zlib = require("node:zlib");

/**
 * @param {Record<string, string|Buffer>} files  name -> contents
 * @param {object} [opts]
 * @param {boolean} [opts.compress=true]  deflate (method 8) vs store (method 0)
 * @param {string}  [opts.comment=""]     archive comment (exercises the EOCD scan)
 * @param {(entry: object) => void} [opts.corrupt]  mutate an entry before writing
 * @returns {Buffer}
 */
function makeZip(files, { compress = true, comment = "", corrupt = null } = {}) {
  const entries = [];
  const chunks = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = compress ? zlib.deflateRawSync(data) : data;

    const entry = {
      name: nameBuf,
      method: compress ? 8 : 0,
      crc: zlib.crc32(data),
      compressedSize: compressed.length,
      uncompressedSize: data.length,
      localOffset: offset,
    };
    if (corrupt) corrupt(entry);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressedSize, 18);
    local.writeUInt32LE(entry.uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra

    chunks.push(local, nameBuf, compressed);
    offset += local.length + nameBuf.length + compressed.length;
    entries.push(entry);
  }

  const centralOffset = offset;
  for (const entry of entries) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressedSize, 20);
    central.writeUInt32LE(entry.uncompressedSize, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(entry.localOffset, 42);

    chunks.push(central, entry.name);
    offset += central.length + entry.name.length;
  }

  const commentBuf = Buffer.from(comment, "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(offset - centralOffset, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);

  chunks.push(eocd, commentBuf);
  return Buffer.concat(chunks);
}

/**
 * A believable Spotify export archive.
 * @param {object} [parts] override any of the JSON payloads
 * @param {string} [folder] the folder the export sits in inside the zip
 */
function makeSpotifyExportZip(parts = {}, folder = "Spotify Account Data") {
  const {
    library = { tracks: [{ artist: "Aurora Vale", track: "Open Door", album: "First Light" }] },
    playlists = {
      playlists: [
        { name: "Morning", items: [{ track: { artistName: "Aurora Vale", trackName: "Open Door" } }] },
      ],
    },
    histories = [[{ endTime: "2025-04-16 17:48", artistName: "Aurora Vale", trackName: "Open Door", msPlayed: 200000 }]],
    extended = false,
    extras = {},
  } = parts;

  const files = { ...extras };
  const prefix = folder ? `${folder}/` : "";

  if (library) files[`${prefix}YourLibrary.json`] = JSON.stringify(library);
  if (playlists) files[`${prefix}Playlist1.json`] = JSON.stringify(playlists);
  histories.forEach((h, i) => {
    const name = extended
      ? `Streaming_History_Audio_2019-2020_${i}.json`
      : `StreamingHistory_music_${i}.json`;
    files[`${prefix}${name}`] = JSON.stringify(h);
  });

  return makeZip(files);
}

module.exports = { makeZip, makeSpotifyExportZip };
