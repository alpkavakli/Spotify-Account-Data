"use strict";

// Minimal HTTP test client for Express apps.
//
// How testing an Express app actually works: an Express `app` is just a request
// handler function. `app.listen(0)` binds it to a random free port, so a test
// can start a real server, make real HTTP requests against it, and shut it down
// — no mocking of req/res, and the assertions cover the whole stack (routing,
// JSON body parsing, status codes, headers) exactly as a browser would hit it.
//
// Port 0 matters: it lets the OS pick an unused port, so tests never collide
// with your dev server on 3000 or with each other when run in parallel.
//
// This is what libraries like supertest do; it is ~40 lines with Node 24's
// built-in fetch, so the project stays dependency-free.

const { once } = require("node:events");

/**
 * Start an Express app on an ephemeral port.
 * @param {import("express").Express} app
 * @returns {Promise<{client: object, close: () => Promise<void>, baseUrl: string}>}
 */
async function startServer(app) {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    client: makeClient(baseUrl),
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

function makeClient(baseUrl) {
  async function request(method, path, { json, headers } = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      // Never follow redirects. /login redirects to accounts.spotify.com, and a
      // following client would make a real request to Spotify from the test
      // suite. We want to assert on the redirect itself anyway.
      redirect: "manual",
      headers: {
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });

    const text = await res.text();
    const isJson = (res.headers.get("content-type") || "").includes("application/json");

    return {
      status: res.status,
      headers: res.headers,
      location: res.headers.get("location"),
      text,
      body: isJson ? JSON.parse(text) : text,
    };
  }

  return {
    get: (path, opts) => request("GET", path, opts),
    post: (path, json, opts) => request("POST", path, { ...opts, json }),
  };
}

module.exports = { startServer };
