# syntax=docker/dockerfile:1
#
# TheIntroDB Stremio addon, as a self-hosted service with ffmpeg for cutting
# progressive files.

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

RUN mkdir -p /cache && chown -R node:node /cache
ENV NODE_ENV=production \
    PORT=8787 \
    CACHE_DIR=/cache
VOLUME ["/cache"]
EXPOSE 8787

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
