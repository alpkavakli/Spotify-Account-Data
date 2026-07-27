"use strict";

// Lyric-search query building and analytics. Pure logic, no DB.
// The host runs the actual FTS query; these helpers build the query string,
// count occurrences for display, and aggregate the top-words report.

/**
 * FTS5 has its own query syntax (AND, OR, *), so user input is wrapped in
 * quotes per word to make it behave like a plain word search.
 * Returns null when the query has no usable words.
 */
function toFtsQuery(q) {
  const words = String(q)
    .split(/\s+/)
    .map((w) => w.replace(/"/g, "").trim())
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => `"${w}"`).join(" ");
}

/**
 * Counts how many times the query words appear in a lyric body. The trailing
 * \w* mirrors the porter stemmer, so "door" counts "doors" too.
 */
function countOccurrences(body, q) {
  let n = 0;
  for (const word of String(q).toLowerCase().split(/\s+/).filter(Boolean)) {
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = String(body).toLowerCase().match(new RegExp(`\\b${safe}\\w*`, "g"));
    n += m ? m.length : 0;
  }
  return n;
}

// Words too common to be interesting in a "top words" report (EN + TR filler).
const STOPWORDS = new Set(
  `the a an and or but nor so yet i you he she it we they me him her us them
   my your his its our their mine yours hers ours theirs this that these those
   is am are was were be been being do does did doing have has had having
   will would shall should can could may might must let lets im youre hes shes
   its were theyre ive youve weve theyve id youd hed shed wed theyd ill youll
   hell shell well theyll isnt arent wasnt werent dont doesnt didnt wont
   wouldnt cant couldnt shouldnt aint gonna wanna gotta
   to of in on at by for with from into onto up down out off over under again
   about against between through during before after above below there here
   when where why how what which who whom whose all any both each few more
   most other some such no not only own same than too very just then once
   as if because while until
   oh ooh oohh yeah yea hey uh uhh ah ahh mmm mm hmm la na da di do dum whoa
   woah ha ooh la-la
   bir ve bu ne ben sen o biz siz ama gibi için çok da de mi mu mı bana beni
   benim seni sana senin onu ona kadar daha en ki ya değil her şey bi diye
   ile var yok olan bile artık şimdi sonra önce hep hiç böyle şu nasıl neden
   çünkü ancak yine gece gündüz olsun oldu olur musun misin`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Builds the top-words report from lyric rows.
 * @param {Array<{body: string, play_count: number}>} rows  ok-status lyric rows
 * @param {number} limit  cap on returned words (default 300)
 * @returns {Array<{word: string, songs: number, plays: number}>}
 *   songs = how many songs contain the word; plays = summed play counts of those songs
 */
function aggregateTopWords(rows, limit = 300) {
  const words = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (const m of String(r.body).toLowerCase().matchAll(/\p{L}[\p{L}']*/gu)) {
      const w = m[0].replace(/'/g, "");
      if (w.length < 3 || STOPWORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      const e = words.get(w) || { songs: 0, plays: 0 };
      e.songs += 1;
      e.plays += r.play_count;
      words.set(w, e);
    }
  }
  return [...words.entries()]
    .map(([word, e]) => ({ word, songs: e.songs, plays: e.plays }))
    .sort((a, b) => b.songs - a.songs)
    .slice(0, limit);
}

module.exports = { toFtsQuery, countOccurrences, STOPWORDS, aggregateTopWords };
