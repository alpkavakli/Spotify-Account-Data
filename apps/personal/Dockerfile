# Node 24: required for the built-in `node:sqlite` module (works without a flag).
# Build context is the REPO ROOT (see docker-compose.yml) so the workspace + the
# shared @lyricsearch/core package are both available.
FROM node:24-slim

WORKDIR /app

# Install dependencies first so this layer is cached between code changes.
# Copy only the manifests + lockfile; npm links the core workspace by package.json.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/personal/package.json ./apps/personal/
RUN npm ci --omit=dev

# Copy the shared core and the Personal Edition source.
COPY packages/core ./packages/core
COPY apps/personal ./apps/personal

# The app reads DATA_DIR/EXPORT_DIR from the environment, so the mounted volume
# (see docker-compose.yml) can live at a fixed path regardless of repo layout.
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    EXPORT_DIR=/data

WORKDIR /app/apps/personal

COPY apps/personal/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["entrypoint.sh"]
CMD ["npm", "start"]
