#
# TheIntroDB Stremio addon, as a self-hosted service with ffmpeg for cutting
# progressive files.
#
# No `# syntax=` directive and no `VOLUME` instruction on purpose: a platform that
# builds this for you (Railway) rejects `VOLUME` and asks for its own volume instead,
# and the syntax frontend is one more network fetch in the build. A `VOLUME` is not
# what makes `-v` work anyway -- see the README for mounting /cache.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
# ffmpeg is the only thing in here that is not a Node dependency: it does the
# `-c copy` remux that removes a segment from a progressive file.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Created and owned up front so a fresh named volume inherits the ownership it needs
# (Docker copies the image's directory into an empty volume). A bind mount or a
# platform volume brings its own ownership -- if it is root-owned, /health says the
# cache is unusable and the README says what to do.
RUN mkdir -p /cache && chown -R node:node /cache
ENV NODE_ENV=production \
    CACHE_DIR=/cache \
    CUTS=on
# Railway (and most platforms) inject their own PORT; the service reads PORT and
# binds to it, so this is only the default for a plain `docker run`.
EXPOSE 8787

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
