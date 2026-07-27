// @lyricsearch/core — storage- and HTTP-agnostic domain logic.
//
// Import a single concern via its subpath (preferred, keeps coupling narrow):
//   const { matchKey } = require("@lyricsearch/core/matching");
// ...or the whole namespaced surface:
//   const core = require("@lyricsearch/core");  core.matching.matchKey(...)
//
// See docs/03-PHASE-0-REFACTOR.md. (spotify module lands in Step 5.)

module.exports = {
  matching: require("./matching"),
  ingest: require("./ingest"),
  lyrics: require("./lyrics"),
  search: require("./search"),
};
