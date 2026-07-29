# The Next.js frontend.
#
# Two stages, because a Next build needs the whole npm tree and running one does
# not. `output: "standalone"` (next.config.mjs) emits a server plus exactly the
# modules the build traced, so the runtime stage copies that and nothing else —
# no npm install, no node_modules to audit.
#
# Build context is the REPO ROOT (see deploy/docker-compose.yml).

# ── build ───────────────────────────────────────────────────────────────────
FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/personal/package.json ./apps/personal/
COPY apps/web/package.json ./apps/web/
COPY apps/web-ui/package.json ./apps/web-ui/

RUN npm ci --omit=dev --workspace @lyricsearch/web-ui --include-workspace-root

COPY apps/web-ui ./apps/web-ui

# Baked into the routes manifest, so it cannot be changed at runtime — this is
# the `next build` half of the note in next.config.mjs. In production Caddy
# routes /api and /auth straight to the API and these rewrites never fire; they
# are set correctly anyway so that hitting this container directly still works.
ARG API_ORIGIN=http://api:3001
ENV API_ORIGIN=$API_ORIGIN

# Unset here even though the app sets it: a stray NEXT_DIST_DIR in the build
# environment would put the output where the copies below do not look.
ENV NEXT_DIST_DIR="" \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN npm run build --workspace @lyricsearch/web-ui

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Standalone keeps the workspace's shape, so server.js lands at
# apps/web-ui/server.js with node_modules hoisted to the root beside it.
COPY --from=build --chown=node:node /app/apps/web-ui/.next/standalone ./
# Static assets and the compiled pages are deliberately NOT part of standalone
# (they are meant to be served from a CDN), so they are copied in separately.
COPY --from=build --chown=node:node /app/apps/web-ui/.next/static ./apps/web-ui/.next/static

USER node

EXPOSE 3000

# HOSTNAME=0.0.0.0 above matters: the standalone server binds localhost by
# default, and a container that only answers on its own loopback is invisible
# to Caddy.
CMD ["node", "apps/web-ui/server.js"]
