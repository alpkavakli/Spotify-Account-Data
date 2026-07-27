"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  toFtsQuery,
  countOccurrences,
  aggregateTopWords,
  STOPWORDS,
} = require("../src/search");

test.describe("toFtsQuery", () => {
  test.it("quotes each word so FTS treats it as a literal, not an operator", () => {
    assert.equal(toFtsQuery("door"), '"door"');
    assert.equal(toFtsQuery("open door"), '"open" "door"');
  });

  test.it("neutralises FTS operators typed by the user", () => {
    // Without quoting, a search for "AND" or "NEAR" is a syntax error, and
    // "a OR b" would silently mean something the user did not ask for.
    assert.equal(toFtsQuery("AND"), '"AND"');
    assert.equal(toFtsQuery("a OR b"), '"a" "OR" "b"');
    assert.equal(toFtsQuery("NEAR(x)"), '"NEAR(x)"');
  });

  test.it("strips embedded double quotes so the generated query stays balanced", () => {
    // An unbalanced quote is the one input that would make SQLite raise.
    assert.equal(toFtsQuery('say "hello"'), '"say" "hello"');
    assert.equal(toFtsQuery('a"b'), '"ab"');
  });

  test.it("collapses arbitrary whitespace", () => {
    assert.equal(toFtsQuery("  open   door  "), '"open" "door"');
    assert.equal(toFtsQuery("open\tdoor\nwide"), '"open" "door" "wide"');
  });

  test.it("returns null when there is nothing to search for", () => {
    assert.equal(toFtsQuery(""), null);
    assert.equal(toFtsQuery("   "), null);
    assert.equal(toFtsQuery('"'), null);
    assert.equal(toFtsQuery('""""'), null);
  });
});

test.describe("countOccurrences", () => {
  test.it("counts every occurrence, not just the first", () => {
    assert.equal(countOccurrences("door door door", "door"), 3);
  });

  test.it("is case-insensitive", () => {
    assert.equal(countOccurrences("Door DOOR door", "door"), 3);
    assert.equal(countOccurrences("door", "DOOR"), 1);
  });

  test.it("counts stemmed forms, matching what the index found", () => {
    // The FTS index stems, so a search for "door" returns a song that only says
    // "doors". If the count did not agree, the UI would show "0 occurrences"
    // next to a result — so the trailing \w* mirrors the stemmer.
    assert.equal(countOccurrences("two doors down", "door"), 1);
    assert.equal(countOccurrences("running runs runner", "run"), 3);
  });

  test.it("respects word boundaries at the start", () => {
    assert.equal(countOccurrences("indoor backdoor", "door"), 0);
  });

  test.it("sums across a multi-word query", () => {
    assert.equal(countOccurrences("open the door, open the window", "open door"), 3);
  });

  test.it("does not treat regex metacharacters in the query as regex", () => {
    // The query goes into a RegExp, so "c++" or "(x)" must not blow up.
    assert.doesNotThrow(() => countOccurrences("some lyrics", "c++"));
    assert.doesNotThrow(() => countOccurrences("some lyrics", "(unclosed"));
    assert.doesNotThrow(() => countOccurrences("some lyrics", "a|b"));
    assert.equal(countOccurrences("100% sure", "100"), 1);
  });

  test.it("returns 0 for an absent word", () => {
    assert.equal(countOccurrences("nothing here", "door"), 0);
  });

  test.it("survives a null body", () => {
    assert.equal(countOccurrences(null, "door"), 0);
  });
});

test.describe("aggregateTopWords", () => {
  const rows = [
    { body: "door window door light", play_count: 10 },
    { body: "door lantern", play_count: 5 },
    { body: "lantern lantern lantern", play_count: 1 },
  ];

  test.it("counts each word once per song, not once per mention", () => {
    // The report answers "how many of my songs mention this word", so a song
    // that repeats a word 30 times must not outweigh 30 songs that say it once.
    const words = Object.fromEntries(
      aggregateTopWords(rows).map((w) => [w.word, w])
    );
    assert.equal(words.door.songs, 2);
    assert.equal(words.lantern.songs, 2);
    assert.equal(words.window.songs, 1);
  });

  test.it("sums the play counts of the songs containing each word", () => {
    const words = Object.fromEntries(
      aggregateTopWords(rows).map((w) => [w.word, w])
    );
    assert.equal(words.door.plays, 15);
    assert.equal(words.lantern.plays, 6);
  });

  test.it("sorts by number of songs, descending", () => {
    const counts = aggregateTopWords(rows).map((w) => w.songs);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  });

  test.it("drops stopwords", () => {
    const words = aggregateTopWords([
      { body: "the and was into down all door", play_count: 1 },
    ]).map((w) => w.word);
    assert.deepEqual(words, ["door"]);
  });

  test.it("drops words shorter than three letters", () => {
    const words = aggregateTopWords([{ body: "a bc door", play_count: 1 }]).map(
      (w) => w.word
    );
    assert.deepEqual(words, ["door"]);
  });

  test.it("ignores punctuation and folds apostrophes into the word", () => {
    const words = aggregateTopWords([
      { body: "heaven's — stop! (please)", play_count: 1 },
    ]).map((w) => w.word);
    assert.ok(words.includes("heavens"), "apostrophe should be folded away");
    assert.ok(words.includes("stop"));
    assert.ok(words.includes("please"));
  });

  test.it("treats contractions as stopwords, not as content", () => {
    // "dont", "youre", "theyll" and friends are in STOPWORDS in their folded
    // form, so folding has to happen before the stopword check — otherwise the
    // report fills up with filler.
    const words = aggregateTopWords([
      { body: "don't you're they'll door", play_count: 1 },
    ]).map((w) => w.word);
    assert.deepEqual(words, ["door"]);
  });

  test.it("counts non-Latin words", () => {
    const words = aggregateTopWords([{ body: "şarkı söylüyorum", play_count: 2 }]).map(
      (w) => w.word
    );
    assert.ok(words.includes("şarkı"));
  });

  test.it("does not stem — the report shows what is actually sung", () => {
    const words = aggregateTopWords([{ body: "door doors", play_count: 1 }]).map(
      (w) => w.word
    );
    assert.deepEqual(words.sort(), ["door", "doors"]);
  });

  test.it("respects the limit", () => {
    const big = [{ body: "alpha bravo charlie delta echo foxtrot", play_count: 1 }];
    assert.equal(aggregateTopWords(big, 3).length, 3);
  });

  test.it("returns an empty list for no input", () => {
    assert.deepEqual(aggregateTopWords([]), []);
  });

  test.it("includes both English and Turkish filler in STOPWORDS", () => {
    for (const w of ["the", "and", "yeah", "bir", "çok", "gibi"]) {
      assert.ok(STOPWORDS.has(w), `expected "${w}" to be a stopword`);
    }
    assert.ok(!STOPWORDS.has("door"));
  });
});
