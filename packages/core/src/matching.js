"use strict";

// Song-identity matching. Pure string logic, no I/O.
//
// Spotify spells the same song differently across exports (the library says
// "Love Will Tear Us Apart - 2020 Remaster", the history says "Love Will Tear
// Us Apart"), so we collapse artist + title into one stable key built from the
// cleaned title, keeping those from landing as two separate rows.

/**
 * Collapses "Artist" + "Track" into a single stable identity key.
 */
function matchKey(artist, track) {
  return `${normalize(artist)}|||${normalize(cleanTitle(track))}`;
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strips the version cruft Spotify appends, which lyrics providers don't know about. */
function cleanTitle(title) {
  return String(title || "")
    .replace(/\s*[-–]\s*(\d{4}\s*)?(remaster(ed)?|remix|radio edit|single version|album version|mono|stereo|live|acoustic|instrumental|sped up|slowed)\b.*$/i, "")
    .replace(/\s*[\(\[][^)\]]*(remaster(ed)?|remix|radio edit|single version|album version|version|sped up|slowed|reverb|live|acoustic|bonus|feat\.?|ft\.?|with)\b[^)\]]*[\)\]]/gi, "")
    .replace(/\s+/g, " ")
    .trim() || String(title || "").trim();
}

module.exports = { matchKey, normalize, cleanTitle };
