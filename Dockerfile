# Node 24: required for the built-in `node:sqlite` module (works without a flag).
FROM node:24-slim

WORKDIR /app

# Install dependencies first so this layer is cached between code changes.
COPY Backend/package.json Backend/package-lock.json ./Backend/
RUN cd Backend && npm ci --omit=dev

# Copy the app, preserving the repo layout so ../../Frontend and ../../Data
# resolve the same way they do outside Docker.
COPY Backend ./Backend
COPY Frontend ./Frontend

# Point the app at the mounted Data volume (see docker-compose.yml). The code
# honours these env vars, which sidesteps the relative-path default.
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/Data \
    EXPORT_DIR=/app/Data

WORKDIR /app/Backend

COPY Backend/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["entrypoint.sh"]
CMD ["npm", "start"]
