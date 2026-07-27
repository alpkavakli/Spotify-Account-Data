"use strict";

// Personal Edition entry point: load config, wire the real implementations into
// the app factory, listen. Everything else lives in app.js (routes) — keeping
// this file to just composition + listen is what makes the routes testable.

const path = require("node:path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const store = require("./store");
const spotify = require("./spotify");
const { createApp } = require("./app");

const PORT = process.env.PORT || 3000;

const app = createApp({ store, spotify });

app.listen(PORT, () => {
  console.log(`listening on http://127.0.0.1:${PORT}`);
  if (!spotify.isConfigured()) {
    console.log("note: Spotify credentials not set — playlist creation disabled");
  }
});
