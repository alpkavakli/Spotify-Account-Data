"use strict";

// A minimal, read-only ZIP reader. Buffer in, entries out — no filesystem, no
// dependencies, no extraction.
//
// Why hand-written rather than a library: this parses a file an anonymous user
// uploaded, so the threat model matters more than the convenience. Extraction
// libraries write to disk, which is where the entire "zip slip" class of
// vulnerabilities lives (an entry named `../../etc/cron.d/x`). This reader
// cannot have that bug because it never writes anything — the caller gets
// Buffers and decides what to do with them.
//
// What it defends against:
//   * zip bombs      — every inflate is capped by zlib's maxOutputLength, and
//                      the caller caps the total across entries
//   * lying headers  — sizes are checked against what actually inflated, and
//                      CRC32 is verified
//   * doing needless work — `filter` runs on the NAME, before any decompression
//
// What it deliberately refuses rather than guesses at: zip64, encrypted
// entries, and compression methods other than store/deflate. A Spotify export
// is none of those, and silently misreading a container is worse than failing.

const zlib = require("node:zlib");

const SIG_EOCD = 0x06054b50; // end of central directory
const SIG_CENTRAL = 0x02014b50; // central directory file header
const SIG_LOCAL = 0x04034b50; // local file header

const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;

const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/** Locate the End Of Central Directory record, which is at the end but may be
 *  followed by up to 64 KB of archive comment — hence the backwards scan. */
function findEndOfCentralDirectory(buf) {
  const earliest = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Read the entries of a ZIP archive.
 *
 * @param {Buffer} buf
 * @param {object} [opts]
 * @param {(name: string) => boolean} [opts.filter]  called before decompressing
 * @param {number} [opts.maxEntryBytes]  per-entry uncompressed cap
 * @param {number} [opts.maxTotalBytes]  cap across every entry returned
 * @returns {{name: string, data: Buffer}[]}
 */
function readZip(buf, {
  filter = () => true,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
} = {}) {
  if (!Buffer.isBuffer(buf)) throw new Error("readZip expects a Buffer");
  if (buf.length < EOCD_MIN_SIZE) throw new Error("not a zip file (too short)");

  const eocd = findEndOfCentralDirectory(buf);
  if (eocd === -1) throw new Error("not a zip file (no end-of-central-directory record)");

  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  if (centralOffset === ZIP64_MARKER || centralSize === ZIP64_MARKER || entryCount === 0xffff) {
    throw new Error("zip64 archives are not supported");
  }
  if (centralOffset + centralSize > buf.length) {
    throw new Error("corrupt zip (central directory runs past the end of the file)");
  }

  const entries = [];
  let total = 0;
  let pos = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error("corrupt zip (bad central directory entry)");
    }

    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc32 = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);

    pos += 46 + nameLen + extraLen + commentLen;

    // Directories are entries too; they carry no data.
    if (name.endsWith("/")) continue;
    if (!filter(name)) continue;

    if (flags & 0x1) throw new Error(`encrypted zip entry: ${name}`);
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      throw new Error("zip64 archives are not supported");
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`unsupported compression method ${method} in ${name}`);
    }
    if (uncompressedSize > maxEntryBytes) {
      throw new Error(`zip entry too large: ${name} (${uncompressedSize} bytes)`);
    }
    total += uncompressedSize;
    if (total > maxTotalBytes) throw new Error("zip contents exceed the size limit");

    // The central directory records where the LOCAL header is, but the local
    // header's own name/extra lengths are what locate the data — they can differ
    // from the central copy's.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`corrupt zip (bad local header for ${name})`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`corrupt zip (${name} runs past the end of the file)`);
    }

    const raw = buf.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else {
      // maxOutputLength is the real bomb defence: a 1 KB entry claiming to
      // inflate to 10 GB fails here rather than filling memory.
      data = zlib.inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
    }

    // The header said how big it would be; check it was telling the truth.
    if (data.length !== uncompressedSize) {
      throw new Error(
        `corrupt zip (${name}: header said ${uncompressedSize} bytes, got ${data.length})`
      );
    }
    if (zlib.crc32(data) !== crc32) {
      throw new Error(`corrupt zip (${name}: checksum mismatch)`);
    }

    entries.push({ name, data });
  }

  return entries;
}

/**
 * Read a ZIP and return the JSON files a Spotify export contains.
 *
 * Matching is on the BASENAME, because the export is a folder inside the zip
 * ("Spotify Account Data/YourLibrary.json") and users also re-zip things
 * themselves, adding or removing a level.
 *
 * @param {Buffer} buf
 * @returns {{library: object|null, playlists: object|null, histories: object[],
 *            hasExtendedHistory: boolean, files: string[]}}
 */
function readSpotifyExport(buf) {
  const basename = (name) => name.split("/").pop();

  const WANTED = [
    /^YourLibrary\.json$/i,
    /^Playlist1\.json$/i,
    /^StreamingHistory_music_\d+\.json$/i,
    /^Streaming_History_Audio_.*\.json$/i,
  ];

  const entries = readZip(buf, {
    filter: (name) => {
      const base = basename(name);
      // __MACOSX/ holds AppleDouble copies with the same basenames; reading them
      // as JSON would fail, and they are never the real file.
      if (name.startsWith("__MACOSX/") || base.startsWith("._")) return false;
      return WANTED.some((re) => re.test(base));
    },
  });

  const result = {
    library: null,
    playlists: null,
    histories: [],
    hasExtendedHistory: false,
    files: entries.map((e) => e.name),
  };

  // Sorted so multi-part history files are merged in a stable order.
  const sorted = [...entries].sort((a, b) =>
    basename(a.name).localeCompare(basename(b.name), "en", { numeric: true })
  );

  for (const entry of sorted) {
    const base = basename(entry.name);
    let json;
    try {
      json = JSON.parse(entry.data.toString("utf8"));
    } catch (err) {
      throw new Error(`${base} is not valid JSON`);
    }

    if (/^YourLibrary\.json$/i.test(base)) result.library = json;
    else if (/^Playlist1\.json$/i.test(base)) result.playlists = json;
    else {
      result.histories.push(json);
      if (/^Streaming_History_Audio_/i.test(base)) result.hasExtendedHistory = true;
    }
  }

  return result;
}

module.exports = { readZip, readSpotifyExport };
