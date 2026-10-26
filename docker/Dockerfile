# syntax=docker/dockerfile:1.7
# Three stages: build (pnpm workspace -> web dist + esbuild api bundle), externals (the few
# packages the bundle leaves out, i.e. the better-sqlite3 native addon) and a slim runtime
# that holds only the node binary, the bundle, the addon and the runtime-read assets.
FROM node:26-bookworm-slim AS build
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /src
# Lockfile-driven fetch keeps the dependency layer cached regardless of how many workspace
# packages exist; the offline install below links them from the store.
COPY pnpm-lock.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
# Web: vite build. Api: scripts/bundle.mjs -> apps/api/dist/{server.mjs,drizzle,definitions,package.json}.
RUN pnpm --filter @arclight/web build && pnpm --filter @arclight/api build

FROM node:26-bookworm-slim AS externals
WORKDIR /ext
# dist/package.json lists only the bundle's externals (scripts/bundle.mjs EXTERNALS).
COPY --from=build /src/apps/api/dist/package.json ./package.json
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund \
 && cd node_modules \
 && find . -mindepth 1 -maxdepth 1 ! -name better-sqlite3 ! -name bindings ! -name file-uri-to-path ! -name .bin -exec rm -rf {} + \
 && rm -rf .bin better-sqlite3/deps better-sqlite3/src \
 && find better-sqlite3/build -mindepth 1 ! -path '*/Release' ! -name 'better_sqlite3.node' -prune -exec rm -rf {} + \
 && node -e "require('/ext/node_modules/better-sqlite3')(':memory:').prepare('select 1').get()"

# Runtime: the node:24-bookworm-slim userland minus npm/corepack/yarn. Starting from
# debian:bookworm-slim and copying just the node binary avoids inheriting those layers
# (deleting files in a later layer would not shrink the image).
FROM debian:bookworm-slim
COPY --from=build /usr/local/bin/node /usr/local/bin/node
ARG VERSION=0.1.0-dev
ENV NODE_ENV=production \
    ARCLIGHT_DOCKER=1 \
    ARCLIGHT_CONFIG=/config \
    ARCLIGHT_WEB_DIST=/app/web \
    ARCLIGHT_ASSET_ROOT=/app/dist \
    ARCLIGHT_VERSION=${VERSION} \
    ARCLIGHT_FFPROBE=/usr/local/bin/ffprobe \
    PUID=1000 \
    PGID=1000
# gosu/tini for the entrypoint. ffmpeg/ffprobe (media analysis, sample detection, transcode)
# come as static binaries: Debian's ffmpeg package drags ~470 MB of shared libraries.
# npm, corepack and yarn are not needed at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends gosu tini && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /ffprobe /usr/local/bin/
WORKDIR /app
COPY --from=externals /ext/node_modules /app/node_modules
COPY --from=build /src/apps/api/dist /app/dist
COPY --from=build /src/apps/web/dist /app/web
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
VOLUME ["/config"]
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:7878/api/v1/system/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "dist/server.mjs"]
