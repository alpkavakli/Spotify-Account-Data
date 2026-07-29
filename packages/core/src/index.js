// @lyricsearch/core — storage- and HTTP-agnostic domain logic.
//
// Import a single concern via its subpath (preferred, keeps coupling narrow):
//   const { matchKey } = require("@lyricsearch/core/matching");
// ...or the whole namespaced surface:
//   const core = require("@lyricsearch/core");  core.matching.matchKey(...)
//
// Nothing here touches a database or an HTTP server. Persistence arrives as a
// StorageAdapter (see ./storage.js), which is what lets the same logic run on
// SQLite in the Personal Edition and on Postgres in the hosted one.

module.exports = {
  matching: require("./matching"),
  ingest: require("./ingest"),
  lyrics: require("./lyrics"),
  search: require("./search"),
  storage: require("./storage"),
  zip: require("./zip"),
  spotify: require("./spotify"),
};
