"use strict";

// Helpers for testing the two modules that talk to the internet.
//
// Both are tested by replacing the global `fetch` with a stub. That is the whole
// technique: because core/lyrics.js and core/spotify.js call the global rather
// than importing an HTTP client, a test can swap it out with one line and drive
// every response the real API could give — including the 429s and 503s that are
// impossible to trigger on demand and are exactly where the bugs live.
//
// node:test undoes the mock automatically when the test finishes.

const assert = require("node:assert/strict");

/**
 * Replace global fetch with a queue of responses (or a function).
 *
 * @param {object} t                node:test context
 * @param {Array|Function} responses  a response per call, or a handler(url, init)
 * @returns {{calls: Array<{url: string, init: object}>}}
 */
function mockFetch(t, responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : null;

  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    if (queue) {
      assert.ok(queue.length > 0, `unexpected extra fetch call to ${url}`);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(String(url), init) : next;
    }
    return responses(String(url), init);
  });

  return { calls };
}

/** A JSON response. */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An error response with no useful body (what a 5xx usually looks like). */
function status(code, headers = {}) {
  return new Response("", { status: code, headers });
}

/**
 * Make the retry/backoff sleeps instant.
 *
 * Both clients back off exponentially (up to 7.5s in core/lyrics.js), which
 * would make the suite unusably slow. `fetch` is already mocked, so nothing else
 * in the call stack needs a real timer.
 */
function instantTimers(t) {
  t.mock.method(globalThis, "setTimeout", (fn) => {
    fn();
    return { unref() {} };
  });
}

module.exports = { mockFetch, json, status, instantTimers };
