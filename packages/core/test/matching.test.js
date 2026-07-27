"use strict";

// matching is the foundation of the whole data model: it decides whether two
// rows from two different export files are the same song. Get it wrong in one
// direction and your library splits into duplicates; wrong in the other and
// distinct songs merge and their play counts blend together.

const test = require("node:test");
const assert = require("node:assert/strict");

const { matchKey, normalize, cleanTitle } = require("../src/matching");

test.describe("normalize", () => {
  test.it("lowercases", () => {
    assert.equal(normalize("The DOORS"), "the doors");
  });

  test.it("strips accents so 'Beyoncé' and 'Beyonce' are the same artist", () => {
    assert.equal(normalize("Beyoncé"), "beyonce");
    assert.equal(normalize("Café Del Mar"), "cafe del mar");
    assert.equal(normalize("Sigur Rós"), "sigur ros");
  });

  test.it("turns punctuation into spaces and collapses runs of whitespace", () => {
    assert.equal(normalize("AC/DC"), "ac dc");
    assert.equal(normalize("don't"), "don t");
    assert.equal(normalize("  spaced   out  "), "spaced out");
    assert.equal(normalize("Panic! At The Disco"), "panic at the disco");
  });

  test.it("keeps letters from non-Latin scripts", () => {
    // \p{L} rather than [a-z]: the user's own library is part Turkish.
    assert.equal(normalize("Şarkı"), "sarkı");
    assert.equal(normalize("東京"), "東京");
  });

  test.it("keeps digits", () => {
    assert.equal(normalize("Blink 182"), "blink 182");
  });

  test.it("handles null and undefined without throwing", () => {
    assert.equal(normalize(null), "");
    assert.equal(normalize(undefined), "");
    assert.equal(normalize(""), "");
  });
});

test.describe("cleanTitle", () => {
  test.it("strips the trailing remaster/version suffix Spotify appends", () => {
    // This is the case that motivated the whole helper: the library export says
    // one thing and the streaming history says another, for the same song.
    assert.equal(
      cleanTitle("Love Will Tear Us Apart - 2020 Remaster"),
      "Love Will Tear Us Apart"
    );
    assert.equal(cleanTitle("Hey - 2011 Remastered Version"), "Hey");
    assert.equal(cleanTitle("Track - Live"), "Track");
    assert.equal(cleanTitle("Tune - Radio Edit"), "Tune");
    assert.equal(cleanTitle("Song - Remix"), "Song");
  });

  test.it("strips the same cruft in brackets", () => {
    assert.equal(cleanTitle("Song (Remastered 2011)"), "Song");
    assert.equal(cleanTitle("X (Sped Up)"), "X");
    assert.equal(cleanTitle("Name (feat. Someone)"), "Name");
    assert.equal(cleanTitle("Name [Radio Edit]"), "Name");
  });

  test.it("leaves ordinary titles alone, including ones with dashes", () => {
    assert.equal(cleanTitle("Plain Title"), "Plain Title");
    assert.equal(cleanTitle("Yesterday"), "Yesterday");
    assert.equal(cleanTitle("A (Deluxe Edition)"), "A (Deluxe Edition)");
  });

  test.it("never returns an empty string — a title is better than nothing", () => {
    // "(Instrumental)" is entirely cruft by the rules above; stripping it would
    // leave the song with no title at all, so the original is kept.
    assert.equal(cleanTitle("(Instrumental)"), "(Instrumental)");
    assert.equal(cleanTitle("- Live"), "- Live");
  });

  test.it("collapses whitespace", () => {
    assert.equal(cleanTitle("  spaced   out  "), "spaced out");
  });

  test.it("handles null and undefined without throwing", () => {
    assert.equal(cleanTitle(null), "");
    assert.equal(cleanTitle(undefined), "");
  });
});

test.describe("matchKey", () => {
  test.it("collapses the same song written differently into one key", () => {
    assert.equal(
      matchKey("The Doors", "Break On Through - 2020 Remaster"),
      matchKey("the doors", "Break On Through")
    );
    assert.equal(
      matchKey("Beyoncé", "Halo (Remastered)"),
      matchKey("BEYONCE", "Halo")
    );
  });

  test.it("keeps different songs apart", () => {
    assert.notEqual(matchKey("A", "Song One"), matchKey("A", "Song Two"));
    assert.notEqual(matchKey("Artist A", "Song"), matchKey("Artist B", "Song"));
  });

  test.it("separates artist from title so they cannot bleed into each other", () => {
    // Without a separator, ("ab", "c") and ("a", "bc") would collide.
    assert.notEqual(matchKey("ab", "c"), matchKey("a", "bc"));
    assert.match(matchKey("A", "B"), /\|\|\|/);
  });

  test.it("is stable — the same input always yields the same key", () => {
    assert.equal(matchKey("The Doors", "Riders"), matchKey("The Doors", "Riders"));
  });
});
