# syntax=docker/dockerfile:1.7
# Three stages: build (pnpm workspace -> web dist + esbuild api bundle), externals (the few
# packages the bundle leaves out, i.e. the better-sqlite3 native addon) and a slim runtime
# that holds only the node binary, the bundle, the addon and the runtime-read assets.
# Base images are pinned by multi-arch index digest (tag kept for readability); bump both the
# tag and the digest together, e.g. from `docker buildx imagetools inspect node:24-bookworm-slim`.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
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

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS externals
WORKDIR /ext
# dist/package.json lists only the bundle's externals (scripts/bundle.mjs EXTERNALS).
COPY --from=build /src/apps/api/dist/package.json ./package.json
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund \
 && cd node_modules \
 && find . -mindepth 1 -maxdepth 1 ! -name better-sqlite3 ! -name bindings ! -name file-uri-to-path ! -name .bin -exec rm -rf {} + \
 && rm -rf .bin better-sqlite3/deps better-sqlite3/src \
 && find better-sqlite3/build -mindepth 1 ! -path '*/Release' ! -name 'better_sqlite3.node' -prune -exec rm -rf {} + \
 && node -e "require('/ext/node_modules/better-sqlite3')(':memory:').prepare('select 1').get()"

# 7-Zip (7zz) for archive unpacking: the official static Linux build, which reads RAR/RAR5 (the
# Debian 7zip package has no RAR codec). Both archives are pinned by checksum; TARGETARCH picks one.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS sevenzip
ARG TARGETARCH
ADD --checksum=sha256:dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695 \
    https://github.com/ip7z/7zip/releases/download/26.03/7z2603-linux-x64.tar.xz /dl/7z-amd64.tar.xz
ADD --checksum=sha256:2389ba20e4d8295e8709c20b6263b69bd1ec4972fe38a04ad7a1badbf595b996 \
    https://github.com/ip7z/7zip/releases/download/26.03/7z2603-linux-arm64.tar.xz /dl/7z-arm64.tar.xz
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils && rm -rf /var/lib/apt/lists/* \
 && mkdir /out && tar -xJf "/dl/7z-${TARGETARCH:-amd64}.tar.xz" -C /out 7zz \
 && /out/7zz i | head -n 3

# Runtime: the node:24-bookworm-slim userland minus npm/corepack/yarn. Starting from
# debian:bookworm-slim and copying just the node binary avoids inheriting those layers
# (deleting files in a later layer would not shrink the image).
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=sevenzip /out/7zz /usr/local/bin/7zz
ARG VERSION=0.1.0-dev
ENV NODE_ENV=production \
    ARCLIGHT_DOCKER=1 \
    ARCLIGHT_CONFIG=/config \
    ARCLIGHT_WEB_DIST=/app/web \
    ARCLIGHT_THEMES_DIR=/app/themes \
    ARCLIGHT_ASSET_ROOT=/app/dist \
    ARCLIGHT_VERSION=${VERSION} \
    ARCLIGHT_FFMPEG=/usr/lib/jellyfin-ffmpeg/ffmpeg \
    ARCLIGHT_FFPROBE=/usr/lib/jellyfin-ffmpeg/ffprobe \
    PUID=1000 \
    PGID=1000 \
    UV_THREADPOOL_SIZE=16
# UV_THREADPOOL_SIZE: Node runs every file read and write, stat and DNS lookup on libuv's
# threadpool (4 threads by default). On a disk that falls behind, a few slow writes held all
# four, and seeding reads, resume saves and tracker/indexer DNS lookups waited behind them.
# The torrent engine keeps at most 4 writes in flight; 16 threads leave room for the rest.
# gosu/tini for the entrypoint. npm, corepack and yarn are not needed at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends gosu tini ca-certificates && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
# ffmpeg/ffprobe (media analysis, sample detection, transcode) come from Jellyfin's ffmpeg build.
# A static ffmpeg cannot do hardware transcoding on Linux: Quick Sync needs a VA-API child device
# (libva + a VA driver) and NVENC needs the CUDA loader, which static builds leave out even
# though `ffmpeg -hwaccels` still lists them. jellyfin-ffmpeg7 links libva/libvpl/ffnvcodec and,
# on amd64, ships the Intel iHD VA driver and the oneVPL GPU runtime under
# /usr/lib/jellyfin-ffmpeg/lib, so VA-API, Quick Sync and NVENC work once the GPU is passed in
# (docs/using/hardware-transcoding.md). Debian's own ffmpeg package drags ~470 MB of libraries.
# The signing key is checksum-pinned like 7zz: a changed key file fails the build instead of
# silently trusting new packages (update the sha256 after checking Jellyfin's announcement).
ADD --checksum=sha256:a0cde241ae297fa6f0265c0bf15ce9eb9ee97c008904a59ab367a67d59532839 \
    https://repo.jellyfin.org/jellyfin_team.gpg.key /etc/apt/keyrings/jellyfin.asc
RUN chmod 644 /etc/apt/keyrings/jellyfin.asc \
 && printf '%s\n' 'Types: deb' 'URIs: https://repo.jellyfin.org/debian' 'Suites: bookworm' 'Components: main' \
      'Architectures: amd64 arm64' 'Signed-By: /etc/apt/keyrings/jellyfin.asc' > /etc/apt/sources.list.d/jellyfin.sources \
 && apt-get update && apt-get install -y --no-install-recommends jellyfin-ffmpeg7 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
 && ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
 && ffmpeg -hide_banner -version | head -n 1
WORKDIR /app
COPY --from=externals /ext/node_modules /app/node_modules
COPY --from=build /src/apps/api/dist /app/dist
COPY --from=build /src/apps/web/dist /app/web
# Theme packs bundled with this version (newer ones sync into /config/themes).
COPY --from=build /src/themes /app/themes
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
VOLUME ["/config"]
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "const b=(process.env.ARCLIGHT_BASE_PATH||'').split('/').filter(Boolean).join('/');fetch('http://127.0.0.1:7878/'+(b?b+'/':'')+'api/v1/system/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "dist/server.mjs"]
