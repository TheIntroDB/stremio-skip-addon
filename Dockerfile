#
# TheIntroDB Stremio addon, as a self-hosted service with ffmpeg for cutting
# progressive files.
#
# No `VOLUME` instruction and no `# syntax=` directive on purpose: a managed builder
# may reject `VOLUME` (and a `VOLUME` is not what makes `-v` work anyway -- see the
# README for mounting /cache), and the syntax frontend is one more fetch in the build.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
# ffmpeg is the only thing in here that is not a Node dependency: it does the
# `-c copy` remux that removes a segment from a progressive file.
RUN apt-get update \
    # fonts-dejavu-core is what the processing card (see src/streams/splash.ts) draws its text
    # with; without a font, ffmpeg refuses to draw the card at all.
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    # The generated-subtitles engines are installed here rather than declared in package.json:
    # they are two Desert Ant packages plus an ONNX runtime, ~490 MB with the CUDA execution
    # provider left out -- weight a CI run that never loads a model should not carry. They are
    # loaded lazily (see src/subtitles/transcribe.ts); without them /health says so and nothing else changes.
    && ONNXRUNTIME_NODE_INSTALL=skip npm install --no-save --omit=dev \
        @desert-ant-labs/voz@4.2.3 @desert-ant-labs/align@4.2.3 onnxruntime-node@1.31.1 \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
# The badge the processing card draws, so drawing it never needs the network.
COPY assets ./assets

# Created and owned up front so a fresh named volume inherits the ownership it needs
# (Docker copies the image's directory into an empty volume). A bind mount or a
# platform volume brings its own ownership -- if it is root-owned, /health says the
# cache is unusable and the README says what to do.
RUN mkdir -p /cache && chown -R node:node /cache
# The speech models' weights (368 MiB) download on first use; keep them on the cache volume so
# a container recreate does not fetch them again (src/subtitles/transcribe.ts sets this too, for a host
# that maps the cache somewhere else).
ENV DAL_CACHE_ROOT=/cache/models

ENV NODE_ENV=production \
    CACHE_DIR=/cache \
    SKIP_MARGIN_SECONDS=2 \
    PREROLL_SECONDS=10 \
    PROXY=on \
    SUBTITLES=on \
    SUBTITLES_TTL_HOURS=24
# A platform may inject its own PORT; the service reads PORT and binds to it, so this
# is the default for a plain `docker run`.
EXPOSE 8787

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
