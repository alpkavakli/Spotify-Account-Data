"use strict";

// The production proxy and the development proxy must agree.
//
// WHY THIS FILE EXISTS. There are two copies of one routing table. In
// development and in every test, `rewrites()` in next.config.mjs puts the API
// under /api and /auth. In production Caddy does it instead — one hop fewer, and
// it keeps a 200 MB upload body out of a Node proxy. Same paths, two files, and
// nothing connecting them.
//
// That is the exact shape of the bug this project has already had once: the
// first next.config.mjs proxied /api/* but not /auth/*, so the link we email
// people 404'd in a browser while every test stayed green (docs/10-WORKLOG.md,
// 2026-07-28). A copy of that table which no test reads is a copy that will
// drift, and the failure mode is again "nobody can log in, and the suite is
// green".
//
// So: no Postgres, no server, no network — just the assertion that the two
// files describe the same routes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..", "..");
const caddyfile = fs.readFileSync(path.join(REPO, "deploy", "Caddyfile"), "utf8");
const compose = fs.readFileSync(path.join(REPO, "deploy", "docker-compose.yml"), "utf8");

/** The rewrite table Next actually builds, with a known API origin. */
async function nextRewrites() {
  const before = process.env.API_ORIGIN;
  process.env.API_ORIGIN = "http://api-origin.test";
  try {
    // next.config.mjs is ESM and this file is CommonJS; a dynamic import is how
    // the two meet. Cache-busted so the API_ORIGIN above is the one that is read.
    const url = new URL(`../next.config.mjs?t=${Date.now()}`, `file://${__filename}`);
    const { default: config } = await import(url);
    return await config.rewrites();
  } finally {
    if (before === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = before;
  }
}

test.describe("deploy routing matches next.config.mjs", () => {
  test.it("proxies exactly the paths Caddy proxies, and no others", async () => {
    // If a third rewrite is ever added, this fails until Caddy learns it too.
    const sources = (await nextRewrites()).map((r) => r.source).sort();
    assert.deepEqual(sources, ["/api/:path*", "/auth/:path*"]);
  });

  test.it("Caddy STRIPS /api, exactly as the rewrite does", async () => {
    // `{source: "/api/:path*", destination: ORIGIN + "/:path*"}` — no /api on
    // the far side. Caddy's handle_path is the directive that strips; plain
    // `handle` does not, and the API would see /api/searchForWord and 404.
    const [api] = (await nextRewrites()).filter((r) => r.source.startsWith("/api"));
    assert.ok(
      api.destination.endsWith("/:path*") && !api.destination.includes("/api/"),
      `next strips /api (destination ${api.destination})`
    );
    assert.match(caddyfile, /handle_path \/api\/\*\s*\{[^}]*reverse_proxy api:3001/);
  });

  test.it("Caddy does NOT strip /auth, exactly as the rewrite does not", async () => {
    // The emailed link is https://host/auth/callback?token=…, and the API serves
    // it at /auth/callback. Strip the prefix here and every sign-in link breaks
    // — the one failure nobody can work around, because the way back in is the
    // thing that is broken.
    const [auth] = (await nextRewrites()).filter((r) => r.source.startsWith("/auth"));
    assert.ok(auth.destination.endsWith("/auth/:path*"), `destination ${auth.destination}`);
    assert.match(caddyfile, /\bhandle \/auth\/\*\s*\{[^}]*reverse_proxy api:3001/);
    assert.doesNotMatch(
      caddyfile,
      /handle_path \/auth\//,
      "handle_path would strip /auth and break every sign-in link"
    );
  });

  test.it("everything else reaches the frontend", () => {
    // Without a catch-all, Caddy answers pages with a 404 and only the API
    // works — which looks like "the site is down" rather than a routing typo.
    assert.match(caddyfile, /handle \{\s*reverse_proxy web-ui:3000/);
  });

  test.it("names upstreams that exist in docker-compose.yml", () => {
    // A renamed service is a DNS failure inside the compose network, visible
    // only as a 502 after deploying.
    for (const upstream of caddyfile.match(/reverse_proxy (\S+)/g) || []) {
      const [host] = upstream.replace("reverse_proxy ", "").split(":");
      assert.match(
        compose,
        new RegExp(`^  ${host}:$`, "m"),
        `Caddy proxies to "${host}", which is not a service in docker-compose.yml`
      );
    }
  });

  test.it("lets a body through that is larger than the API's own limit", () => {
    // The API returns a JSON 413 the upload form can display. If Caddy's cap
    // were the lower of the two, a big upload would die at the proxy instead
    // and the user would get an opaque error page.
    const { MAX_UPLOAD_BYTES } = require("@lyricsearch/web/src/app");
    const [, size, unit] = caddyfile.match(/max_size (\d+)(MB|MiB)/);
    const bytes = Number(size) * (unit === "MiB" ? 1024 * 1024 : 1000 * 1000);
    assert.ok(
      bytes > MAX_UPLOAD_BYTES,
      `Caddy caps at ${bytes} bytes, the API at ${MAX_UPLOAD_BYTES}`
    );
  });
});
