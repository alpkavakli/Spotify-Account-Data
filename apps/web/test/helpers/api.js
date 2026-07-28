"use strict";

// Starts the real API on a random port, over a real Postgres, with a temp blob
// directory and a recording mailer. Same technique as the Personal Edition's
// test/helpers/http.js, plus cookie handling — sessions are the whole point of
// half these tests, so the client has to behave like a browser about them.

const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../../src/app");
const { LocalBlobStore } = require("../../src/blob-store");
const { MemoryMailer } = require("../../src/mailer");

const tempDirs = [];

function cleanupBlobDirs() {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  tempDirs.length = 0;
}

/**
 * @param {import("pg").Pool} pool
 * @returns {Promise<{client, close, mailer, blobStore, baseUrl}>}
 */
async function startApi(pool) {
  const blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "lyricsearch-api-blobs-"));
  tempDirs.push(blobDir);

  const blobStore = new LocalBlobStore(blobDir);
  const mailer = new MemoryMailer();

  const server = createApp({
    pool,
    blobStore,
    mailer,
    baseUrl: "http://127.0.0.1:0",
  }).listen(0);
  await once(server, "listening");

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    mailer,
    blobStore,
    client: makeClient(baseUrl),
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

/**
 * A client that keeps cookies, like a browser.
 *
 * Each call to makeClient() is a separate "browser", which is how the tests put
 * two signed-in users side by side and check that neither can see the other.
 */
function makeClient(baseUrl) {
  let cookies = new Map();

  async function request(method, path, { body, headers, raw } = {}) {
    const cookieHeader = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

    const res = await fetch(baseUrl + path, {
      method,
      redirect: "manual",
      headers: {
        ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...headers,
      },
      body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });

    for (const value of res.headers.getSetCookie?.() || []) {
      const [pair] = value.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (val === "") cookies.delete(name);
      else cookies.set(name, val);
    }

    const text = await res.text();
    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: isJson && text ? JSON.parse(text) : text,
    };
  }

  return {
    get: (p, opts) => request("GET", p, opts),
    post: (p, body, opts) => request("POST", p, { ...opts, body }),
    delete: (p, opts) => request("DELETE", p, opts),
    /** Upload raw bytes, the way the real client will. */
    upload: (p, buffer) =>
      request("POST", p, {
        body: buffer,
        raw: true,
        headers: { "Content-Type": "application/zip" },
      }),
    cookies: () => new Map(cookies),
    clearCookies: () => cookies.clear(),
  };
}

/** Sign in end-to-end: request a link, pull it out of the mailer, follow it. */
async function signIn(api, email) {
  const client = makeClient(api.baseUrl);
  await client.post("/auth/request-link", { email });
  const message = api.mailer.lastTo(email);
  if (!message) throw new Error(`no sign-in email was sent to ${email}`);
  const token = new URL(message.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const res = await client.get(`/auth/callback?token=${encodeURIComponent(token)}`);
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${res.text}`);
  return client;
}

module.exports = { startApi, makeClient, signIn, cleanupBlobDirs };
