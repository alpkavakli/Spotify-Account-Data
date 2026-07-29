"use strict";

// What may and may not leave this repo.
//
// WHY THIS FILE EXISTS. Publishing is the one operation here that cannot be
// undone. A bad deploy is rolled back, a bad migration is restored from a dump —
// but a commercial file pushed to a public git history is public, and stays
// public in every clone and every mirror that saw it. `git push --force` does
// not fix it; it only hides it from the web UI.
//
// So the publish script gets the strictest tests in the project, and they assert
// the same guarantee from several independent directions: by path, by content,
// and by what the produced tree actually resolves against. Any one of them
// passing on its own would not be worth much.
//
// These are also the tests most likely to fail for a GOOD reason — someone adds
// a directory, or a comment starts naming a private path. When one goes red,
// the fix is in the source, not here.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildPublicTree,
  publicRootManifest,
  ALLOW,
  FORBIDDEN,
  LICENSE_ID,
} = require("./publish-personal");

const temps = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyricsearch-publish-"));
  temps.push(dir);
  return dir;
}

test.after(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

/** Build once; every test below reads the same produced tree. */
const out = path.join(tempDir(), "public");
const built = buildPublicTree({ out });

/** Every published file, repo-relative, with its text (binary files excluded). */
function publishedText() {
  const entries = [];
  const walk = (dir, prefix = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else entries.push([rel, fs.readFileSync(path.join(dir, e.name), "utf8")]);
    }
  };
  walk(out);
  return entries;
}

const published = publishedText();
const paths = published.map(([p]) => p);

test.describe("the published tree contains only the OSS edition", () => {
  test.it("contains no forbidden directory, by path", () => {
    for (const dir of FORBIDDEN) {
      const hits = paths.filter((p) => p.startsWith(dir.replace(/\/$/, "")));
      assert.deepEqual(hits, [], `${dir} must never be published`);
    }
  });

  test.it("contains nothing outside the allowlist", () => {
    // The inverse of the check above, and the one that holds when somebody adds
    // a directory nobody thought to forbid.
    const generated = ["package.json", "LICENSE"];
    const stray = paths.filter(
      (p) => !generated.includes(p) && !ALLOW.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a))
    );
    assert.deepEqual(stray, []);
  });

  test.it("publishes nothing untracked by git", () => {
    // This machine has a pre-refactor `Backend/` directory and a real Spotify
    // export sitting untracked next to the code. A filesystem walk would have
    // swept both in; `git ls-files` is what makes that impossible.
    assert.equal(paths.some((p) => p.startsWith("Backend")), false);
    assert.equal(paths.some((p) => p.includes("node_modules")), false);
    assert.equal(paths.some((p) => /\.db($|-)/.test(p)), false, "no sqlite database");
  });

  test.it("publishes no real .env, only the example", () => {
    const envs = paths.filter((p) => path.basename(p).startsWith(".env"));
    assert.deepEqual(envs, ["apps/personal/.env.example"]);
  });

  test.it("holds back every private file it saw", () => {
    // The skipped list is the other half of the story: it should be large and
    // should name the commercial workspaces, or the allowlist matched too much.
    assert.ok(built.skipped.length > 20, `only ${built.skipped.length} files held back`);
    for (const dir of ["apps/web/", "deploy/", "docs/"]) {
      assert.ok(
        built.skipped.some((f) => f.startsWith(dir)),
        `${dir} should appear in the held-back list`
      );
    }
  });
});

test.describe("no private content survives inside published files", () => {
  // Ignore files legitimately name paths that need not exist — an ignore rule is
  // a pattern, not a reference — so they are exempt from the path scans below.
  const PATTERN_FILES = new Set([".gitignore", ".dockerignore", ".gitattributes"]);
  const prose = published.filter(([p]) => !PATTERN_FILES.has(path.basename(p)));

  test.it("names no private path in any comment, doc or string", () => {
    // The failure this catches is not a leak of code but a dangling reference:
    // a reader of the public repo following `docs/05-PHASE-1-SAAS.md` finds
    // nothing there, because that file is in a repo they cannot see.
    const failures = [];
    for (const [file, text] of prose) {
      for (const m of text.matchAll(/\b(?:apps\/web(?:-ui)?|deploy\/[a-z]|docs\/\d{2}-[A-Z0-9-]+\.md|tools\/)/g)) {
        const line = text.slice(0, m.index).split("\n").length;
        failures.push(`${file}:${line} → ${m[0]}`);
      }
    }
    assert.deepEqual(failures, [], "private paths referenced from published files");
  });

  test.it("carries no credential-shaped string", () => {
    // .env.example is published on purpose. It must stay placeholders.
    const secrets = [
      /\bAKIA[0-9A-Z]{16}\b/, // AWS key id
      /\bsk-[A-Za-z0-9]{20,}\b/, // generic provider secret
      /\bre_[A-Za-z0-9]{20,}\b/, // Resend
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\bpostgres:\/\/[^\s:]+:[^\s@]+@/, // a real DSN with a password in it
    ];
    const failures = [];
    for (const [file, text] of published) {
      for (const re of secrets) if (re.test(text)) failures.push(`${file} matches ${re}`);
    }
    assert.deepEqual(failures, []);
  });

  test.it("still explains the architecture that made two editions possible", () => {
    // The opposite failure: scrubbing so hard that the public code stops saying
    // why the StorageAdapter contract is shaped the way it is. Mentioning that a
    // hosted edition exists is fine and intended — this is open core. Citing a
    // file nobody outside can open is not.
    const storage = published.find(([p]) => p === "packages/core/src/storage.js")[1];
    assert.match(storage, /PostgresAdapter/);
    assert.match(storage, /Liskov/);
  });
});

test.describe("licensing", () => {
  test.it("ships the AGPL text", () => {
    const license = published.find(([p]) => p === "LICENSE")[1];
    assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
    assert.match(license, /Version 3, 19 November 2007/);
    assert.ok(license.length > 30_000, "the full text, not a stub");
  });

  test.it("says AGPL in every published manifest", () => {
    // A LICENSE file the manifests contradict is a licence nobody can rely on,
    // and npm/GitHub both read the manifest rather than the file.
    for (const p of ["package.json", "packages/core/package.json", "apps/personal/package.json"]) {
      const manifest = JSON.parse(published.find(([f]) => f === p)[1]);
      assert.equal(manifest.license, LICENSE_ID, `${p} declares the wrong licence`);
    }
  });

  test.it("never leaks the private repo's licence field", () => {
    assert.equal(
      published.some(([, text]) => /"license":\s*"(ISC|UNLICENSED)"/.test(text)),
      false
    );
  });
});

test.describe("the produced tree stands on its own", () => {
  test.it("declares only the two workspaces it ships", () => {
    const root = JSON.parse(published.find(([p]) => p === "package.json")[1]);
    assert.deepEqual(root.workspaces, ["packages/core", "apps/personal"]);
  });

  test.it("has no script pointing at a workspace it does not ship", () => {
    // `npm test` on a fresh clone must not fail because it reaches for
    // @lyricsearch/web.
    const root = JSON.parse(published.find(([p]) => p === "package.json")[1]);
    for (const [name, cmd] of Object.entries(root.scripts)) {
      assert.doesNotMatch(cmd, /web|tools/, `script "${name}" needs an unpublished workspace`);
    }
  });

  test.it("requires no @lyricsearch package it does not contain", () => {
    // The whole reason core is vendored rather than depended on: a clone has to
    // work with `npm install`, with no private registry and no version to match.
    const failures = [];
    for (const [file, text] of published) {
      for (const m of text.matchAll(/@lyricsearch\/([a-z-]+)/g)) {
        if (m[1] !== "core" && m[1] !== "personal") failures.push(`${file} → @lyricsearch/${m[1]}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test.it("ships everything the Personal Edition's entry points import", () => {
    // A missing test helper or frontend file is the kind of thing that only
    // shows up when somebody clones it.
    for (const needed of [
      "packages/core/src/index.js",
      "packages/core/src/storage.js",
      "packages/core/testing/adapter-conformance.js",
      "apps/personal/src/server.js",
      "apps/personal/src/sqlite-adapter.js",
      "apps/personal/frontend/index.html",
      "apps/personal/test/routes.test.js",
      "apps/personal/Dockerfile",
      "README.md",
    ]) {
      assert.ok(paths.includes(needed), `${needed} is missing from the public tree`);
    }
  });
});

test.describe("the script itself", () => {
  test.it("refuses to write into a directory that already has files", () => {
    // Publishing generates a COMPLETE tree. Merging into leftovers is how a file
    // from an old layout survives a rename and quietly stays published.
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "leftover.txt"), "x");
    assert.throws(() => buildPublicTree({ out: dir }), /not empty/);
  });

  test.it("tolerates a .git directory, so the target can be a clone", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, ".git"));
    assert.doesNotThrow(() => buildPublicTree({ out: dir }));
  });

  test.it("drops private scripts when rewriting the root manifest", () => {
    const rewritten = publicRootManifest({
      license: "ISC",
      scripts: {
        test: "npm test --workspaces --if-present",
        start: "npm start --workspace @lyricsearch/personal",
        "publish:personal": "node tools/publish-personal.js",
        webthing: "npm start --workspace @lyricsearch/web",
      },
    });
    assert.deepEqual(Object.keys(rewritten.scripts), ["test", "start"]);
    assert.equal(rewritten.license, LICENSE_ID);
  });
});
