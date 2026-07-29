"use strict";

// Boots the frontend the way it actually runs: a real Next.js dev server in its
// own process, with the real API process's routes behind it.
//
// There is no browser engine here, and that is the point. What these tests are
// for is the SERVER half of a server-rendered app — does the page fetch the
// right thing, forward the session cookie, and put the data in the HTML — and
// all of that is observable in the bytes Next sends back. A browser would add
// hydration and clicking, which is a real gap (see the README), but it would
// also add a ~300 MB dependency and a second runtime to install in CI, which
// docs/01-DECISIONS.md has repeatedly declined.
//
// The one thing that makes this workable: `next dev` reads next.config.mjs at
// BOOT, so the `/api/*` and `/auth/*` rewrites pick up API_ORIGIN from the
// environment. That means a test can start the API on a random port and point a
// dev server at it — with `next build && next start` the rewrite destination is
// baked into the routes manifest and a random port would need a rebuild per run.

const net = require("node:net");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const UI_DIR = path.join(__dirname, "..", "..");

// Cold `next dev` boot plus the first route compile. Generous because CI
// machines are slower than laptops and a flaky timeout here reads as a broken
// frontend, which is the worst kind of false alarm.
const BOOT_TIMEOUT_MS = 120_000;

/** A port nothing is listening on, released again immediately. */
async function freePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

/**
 * Start `next dev` on a random port, proxying to an already-running API.
 *
 * @param {object} options
 * @param {string} options.apiOrigin  where the API is listening, e.g. http://127.0.0.1:53742
 * @returns {Promise<{origin: string, log: () => string, close: () => Promise<void>}>}
 */
async function startNext({ apiOrigin }) {
  const port = await freePort();

  const child = spawn(
    process.execPath,
    [require.resolve("next/dist/bin/next"), "dev", "-p", String(port)],
    {
      cwd: UI_DIR,
      env: {
        ...process.env,
        API_ORIGIN: apiOrigin,
        // Its own build directory, so `node --test` and a dev server you left
        // open in another terminal cannot corrupt each other's .next.
        NEXT_DIST_DIR: ".next-test",
        NODE_ENV: "development",
        // Next asks about telemetry on first run and the prompt is not
        // something a test process can answer.
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  // Kept so a failing test can say what the dev server was complaining about —
  // a compile error otherwise shows up only as an unhelpful 500.
  let log = "";
  const record = (chunk) => {
    log += chunk;
  };
  child.stdout.setEncoding("utf8").on("data", record);
  child.stderr.setEncoding("utf8").on("data", record);

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const origin = `http://127.0.0.1:${port}`;

  async function close() {
    if (exited) return;
    // child.kill() on Windows kills the launcher and orphans the server that is
    // actually holding the port; /T takes the tree with it.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
    await once(child, "exit");
  }

  // Poll a real page rather than a rewritten path: if the rewrites were broken,
  // waiting on /api/health would time out here and the failure would read as
  // "Next never started" instead of "the proxy is misconfigured" — which is the
  // exact bug this whole file exists to catch.
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      throw new Error(`next dev exited before it was ready:\n${log}`);
    }
    try {
      await fetch(`${origin}/signin`, { redirect: "manual" });
      break;
    } catch {
      if (Date.now() > deadline) {
        await close();
        throw new Error(`next dev did not come up within ${BOOT_TIMEOUT_MS}ms:\n${log}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return { origin, log: () => log, close };
}

module.exports = { startNext, freePort };
