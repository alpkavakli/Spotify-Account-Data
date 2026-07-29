"use strict";

// Build the public Personal Edition tree out of this private monorepo.
//
// This repo is the source of truth for everything — `core`, `personal`, `web`,
// `web-ui`, `deploy`. The public repo is a PUBLISH TARGET: a generated snapshot
// containing only the OSS edition, pushed as its own commits so that no
// commercial code and no commercial history ever exists in it
// (`docs/01-DECISIONS.md`).
//
//   node tools/publish-personal.js --out ../lyricsearch-public
//   node tools/publish-personal.js --out /tmp/x --json     (machine-readable)
//
// It writes a directory. It does NOT run git, and it never pushes: turning a
// directory into a commit is the user's call, like every other commit here.
// `docs/09-PUBLISHING.md` has the full procedure.
//
// ── THE ONE RULE ────────────────────────────────────────────────────────────
//
// The file list is an ALLOWLIST, and it is derived from `git ls-files` rather
// than from walking the disk. Both halves matter:
//
//   - An allowlist fails CLOSED. A new commercial directory added next year is
//     absent from the public tree because nobody added it, not because someone
//     remembered to exclude it. A denylist gets this wrong exactly once, and
//     "once" is permanent — you cannot unpublish a git history.
//   - `git ls-files` means an untracked file on the publisher's disk cannot be
//     swept in. This machine has a `Backend/` directory of pre-refactor code and
//     a private Spotify export sitting untracked; a filesystem walk would have
//     published both.
//
// Everything the script produces is then checked by tools/publish.test.js, which
// is where the real guarantees live.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");

/**
 * The only paths that may reach the public repo.
 *
 * Directories are published whole (their tracked files, recursively). Anything
 * not matching one of these prefixes does not exist as far as publishing is
 * concerned.
 */
const ALLOW = [
  "packages/core/", // the shared domain logic — vendored, not a dependency
  "apps/personal/", // the OSS edition itself
  "README.md",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
];

/**
 * Paths that must never appear, asserted separately from the allowlist.
 *
 * Redundant by construction — none of these can match a prefix above — and kept
 * anyway, because this is the list a human reads to answer "is my commercial
 * code safe?". A guarantee nobody can find is a guarantee nobody trusts.
 */
const FORBIDDEN = ["apps/web/", "apps/web-ui/", "deploy/", "docs/", "tools/", "Backend/"];

/** The licence the public edition ships under (docs/01-DECISIONS.md). */
const LICENSE_ID = "AGPL-3.0-only";

/** Tracked files only — see the note above about untracked private data. */
function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** @param {string} file @returns {boolean} */
function isAllowed(file) {
  return ALLOW.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}

/**
 * The public repo's root manifest.
 *
 * Rewritten rather than copied: the private root declares a licence that is not
 * the public one, and carries scripts for workspaces that will not exist.
 */
function publicRootManifest(privateManifest) {
  const { scripts = {}, ...rest } = privateManifest;

  return {
    ...rest,
    license: LICENSE_ID,
    // Only the two published workspaces can match, but listing them explicitly
    // means the public repo does not silently adopt a directory someone adds.
    workspaces: ["packages/core", "apps/personal"],
    scripts: Object.fromEntries(
      // Anything aimed at a workspace that is not published would be a script
      // that fails on a fresh clone.
      Object.entries(scripts).filter(([, cmd]) => !/web|tools/.test(cmd))
    ),
  };
}

/** The licence text, kept beside this script so publishing needs no network. */
function licenseText() {
  return fs.readFileSync(path.join(__dirname, "licenses", "AGPL-3.0.txt"), "utf8");
}

/**
 * @param {object} options
 * @param {string} options.out  directory to write (created; must be empty or absent)
 * @returns {{files: string[], skipped: string[], out: string}}
 */
function buildPublicTree({ out }) {
  const outDir = path.resolve(out);

  if (fs.existsSync(outDir) && fs.readdirSync(outDir).some((e) => e !== ".git")) {
    // Refuse rather than merge. Writing into a populated directory is how a
    // stale file from a previous layout survives into a publish, and the whole
    // point of generating the tree is that it contains exactly what it should.
    // `.git` is spared so the target can be a clone of the public repo.
    throw new Error(
      `${outDir} is not empty. Publishing writes a complete tree; ` +
        `empty it first (keeping .git if it is a clone of the public repo).`
    );
  }

  const all = trackedFiles();
  const files = all.filter(isAllowed).sort();
  const skipped = all.filter((f) => !isAllowed(f)).sort();

  for (const file of files) {
    const dest = path.join(outDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, file), dest);
  }

  // Generated, not copied.
  const privateManifest = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  fs.writeFileSync(
    path.join(outDir, "package.json"),
    JSON.stringify(publicRootManifest(privateManifest), null, 2) + "\n"
  );
  fs.writeFileSync(path.join(outDir, "LICENSE"), licenseText());

  // The two published manifests declare the private licence too.
  for (const pkg of ["packages/core/package.json", "apps/personal/package.json"]) {
    const target = path.join(outDir, pkg);
    const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
    manifest.license = LICENSE_ID;
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n");
  }

  return { files: [...files, "package.json", "LICENSE"].sort(), skipped, out: outDir };
}

module.exports = { buildPublicTree, isAllowed, publicRootManifest, ALLOW, FORBIDDEN, LICENSE_ID };

// ── CLI ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const out = args[args.indexOf("--out") + 1];
  const asJson = args.includes("--json");

  if (!args.includes("--out") || !out || out.startsWith("--")) {
    console.error("usage: node tools/publish-personal.js --out <dir> [--json]");
    process.exit(2);
  }

  try {
    const result = buildPublicTree({ out });

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`wrote ${result.files.length} files to ${result.out}`);
      console.log(`licence: ${LICENSE_ID}`);
      console.log(`held back: ${result.skipped.length} private files`);
      console.log("");
      console.log("Next: review it, then commit and push it yourself —");
      console.log("see docs/09-PUBLISHING.md. This script never runs git.");
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
