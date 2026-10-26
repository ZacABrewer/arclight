# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /src
# Lockfile-driven fetch keeps the dependency layer cached regardless of how many workspace
# packages exist; the offline install below links them from the store.
COPY pnpm-lock.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build
# Production node_modules only, for the api workspace.
RUN pnpm --filter @arclight/api deploy --prod --legacy /out

FROM node:24-bookworm-slim
ARG VERSION=0.1.0-dev
ENV NODE_ENV=production \
    ARCLIGHT_DOCKER=1 \
    ARCLIGHT_CONFIG=/config \
    ARCLIGHT_WEB_DIST=/app/web \
    ARCLIGHT_VERSION=${VERSION} \
    PUID=1000 \
    PGID=1000
RUN apt-get update && apt-get install -y --no-install-recommends gosu tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
COPY --from=build /src/apps/api/dist /app/dist
COPY --from=build /src/apps/api/drizzle /app/drizzle
COPY --from=build /src/apps/web/dist /app/web
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
VOLUME ["/config"]
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:7878/api/v1/system/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
# Workspace packages are consumed as TypeScript sources; tsx loads them at runtime.
CMD ["node", "--import", "tsx", "dist/index.js"]
