# The hosted service's Node processes: the API and the worker.
#
# ONE image for both. They share every dependency and every line of src/; the
# only difference is which file starts. Two images would be two things to build,
# push and keep in step, for no gain — deploy/docker-compose.yml just overrides
# the command for the worker.
#
# Build context is the REPO ROOT (see deploy/docker-compose.yml) so the workspace
# and the shared @lyricsearch/core package are both available.
FROM node:24-slim

WORKDIR /app

# Manifests first, so the dependency layer is cached across code changes. Every
# workspace's package.json has to be here even though we install only one:
# `npm ci` validates the whole lockfile against the workspaces it declares, and
# a missing manifest makes it refuse the tree as out of date.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/personal/package.json ./apps/personal/
COPY apps/web/package.json ./apps/web/
COPY apps/web-ui/package.json ./apps/web-ui/

# Only this workspace's tree — the root and core come with it. Without the
# --workspace filter this image would also carry Next and React, which the API
# has no use for.
RUN npm ci --omit=dev --workspace @lyricsearch/web --include-workspace-root

COPY packages/core ./packages/core
COPY apps/web ./apps/web

# Uploaded export files. A named volume mounts here and the API and worker share
# it — the API writes the blob, the worker reads it back to parse. Created (and
# owned) before dropping privileges, because a named volume takes its ownership
# from the image's directory the first time it is mounted.
#
# docs/02-SCALABILITY.md wants this in object storage eventually. That is a new
# BlobStore implementation, not a change here — see src/blob-store.js.
RUN mkdir -p /data/blobs && chown -R node:node /data

ENV NODE_ENV=production \
    PORT=3001 \
    BLOB_DIR=/data/blobs

WORKDIR /app/apps/web

# Nothing in here needs root, and the upload path writes files from bytes a
# stranger sent us.
USER node

EXPOSE 3001

# Migrations run on boot inside src/server.js, under an advisory lock, so
# starting several API containers at once is safe — exactly one migrates.
CMD ["node", "src/server.js"]
