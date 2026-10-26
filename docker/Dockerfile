# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# Production node_modules only, for the api workspace.
RUN pnpm --filter @media-tron/api deploy --prod /out

FROM node:24-bookworm-slim
ARG VERSION=0.1.0-dev
ENV NODE_ENV=production \
    MEDIATRON_DOCKER=1 \
    MEDIATRON_CONFIG=/config \
    MEDIATRON_WEB_DIST=/app/web \
    MEDIATRON_VERSION=${VERSION} \
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
CMD ["node", "dist/index.js"]
