# 09 — Publishing the public Personal Edition

This repo is private and is the source of truth for everything: `core`,
`personal`, `web`, `web-ui`, `deploy`. The **public repo is a publish target** —
a generated snapshot of the OSS edition, with its own commits, so that no
commercial code and no commercial history ever exists in it
(`01-DECISIONS.md`).

```
   PRIVATE monorepo (this repo)          PUBLIC repo
   ────────────────────────────          ───────────
   packages/core/       ──────────────►  packages/core/
   apps/personal/       ──────────────►  apps/personal/
   README, .gitignore…  ──────────────►  README, .gitignore…
                                         LICENSE      (generated, AGPL-3.0)
                                         package.json (generated)
   apps/web/            ✗
   apps/web-ui/         ✗
   deploy/              ✗
   docs/                ✗
   tools/               ✗
```

## The two decisions behind it

**`core` is vendored, not depended on.** The public repo contains
`packages/core` as a real directory, exactly as this repo has it. There is
therefore no version to negotiate, no private registry, and no skew: what ships
is what was tested, and a cloner gets one repo that works with `npm install`.
The alternative — publishing `@lyricsearch/core` to npm and having both repos
depend on a version — adds a release step and stops anyone hacking on `core`
from a clone, which is most of the point of an OSS edition.

**The public edition is AGPL-3.0.** Copyleft with the network clause: anyone who
runs a *modified* version as a hosted service has to publish their changes. For
a project whose other track is an ad-supported SaaS, that is the licence that
does not hand a competitor the product. `tools/licenses/AGPL-3.0.txt` is the
canonical FSF text, kept in-repo so publishing needs no network.

## Doing it

```bash
npm run publish:personal -- --out ../lyricsearch-public
```

It writes a directory and **nothing else** — no `git init`, no commit, no push.
Turning a tree into a commit is yours, like every other commit here.

First time:

```bash
# create the empty public repo on GitHub first, then:
git clone https://github.com/<you>/<public-repo> ../lyricsearch-public
rm -rf ../lyricsearch-public/*                  # keep .git
npm run publish:personal -- --out ../lyricsearch-public
cd ../lyricsearch-public
git add -A && git status                        # READ THIS. Every time.
git commit -m "Personal Edition <version>"
git push
```

Afterwards it is the same three commands: empty it (keeping `.git`), regenerate,
review, commit, push. The script refuses to write into a directory that still
has files, because merging into leftovers is how a file from an old layout
survives a rename and stays published.

**Read `git status` before every publish commit.** The tests below are good, but
they check the tree the script generates; the thing that actually becomes public
is what you commit.

## What makes it safe

The file list is an **allowlist**, derived from `git ls-files`. Both halves
matter, and both are the reason this is not a `.gitignore`-style denylist:

- **An allowlist fails closed.** A commercial directory added next year is
  absent from the public tree because nobody added it to `ALLOW`, not because
  someone remembered to exclude it. A denylist gets this wrong exactly once, and
  once is permanent — you cannot unpublish a git history. `git push --force`
  only hides it from the web UI.
- **`git ls-files` means untracked files cannot be swept in.** This machine has
  a pre-refactor `Backend/` directory and a real Spotify export sitting
  untracked next to the code. A filesystem walk would have published both.

`tools/publish.test.js` (18 tests) then asserts the same guarantee from several
independent directions, because any one of them alone would not be worth much:

| Direction | What it catches |
|---|---|
| **By path** | Anything under `apps/web`, `apps/web-ui`, `deploy/`, `docs/`, `tools/`, `Backend/`. And the inverse: anything at all outside the allowlist. |
| **By content** | Private paths named in comments, docs or strings — the *dangling reference* case. Credential-shaped strings. A stray `"license": "ISC"`. |
| **By resolution** | That the tree stands alone: only the two workspaces it ships, no script reaching for an unpublished one, no `@lyricsearch/*` import it does not contain. |
| **By running it** | `npm install && npm test` inside the generated tree: **277 tests** (core 163, personal 114). This is the check that a helper file or a frontend asset went missing. |

There is also a test asserting the public code still *explains itself* — that
`storage.js` keeps its Liskov reasoning and its mention of `PostgresAdapter`.
Scrubbing until the architecture stops making sense is the opposite failure, and
it is a real one. **Mentioning that a hosted edition exists is fine and
intended** — this is open core, and the README says so. Citing a file nobody
outside can open is not.

## Contributions to the public repo

The public repo is generated, so a PR against it cannot simply be merged: the
next publish would overwrite it. Apply the change **here**, in
`packages/core` or `apps/personal`, and republish. Credit the contributor in the
commit message (`Co-Authored-By:`), which survives into nothing — the public
commit is a fresh snapshot — so also say so in the public commit body.

That is the real cost of this model, and it is worth being honest about it: the
public repo is a read-only mirror in practice. If it ever attracts sustained
contribution, the answer is to promote it to the source of truth for
`core` + `personal` and have this repo consume it, not to hand-merge forever.

## Adding a file to the public edition

Add it to `ALLOW` in `tools/publish-personal.js`, and expect the tests to have
opinions. In particular, anything under `docs/` is excluded wholesale: every doc
in this repo is about the two-track product, cites the others, or is the
worklog. If the public edition needs documentation beyond its `README.md`, write
it *for* that repo rather than trying to carve a private doc down.

## Related

- `01-DECISIONS.md` — why a private monorepo with a publish target at all.
- `04-TESTING.md` — where these tests sit among the rest.
- `PROJECT_PLAN.md` §9 — the original open question this closes.
