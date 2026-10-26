# Media-Tron

One content-acquisition service for a home media stack, written from scratch.
Media-Tron does the jobs of Sonarr (TV), Radarr (movies), Prowlarr (indexers), Bazarr
(subtitles) and Seerr (requests) in a single application: one database, one API, one
login, one UI, one background scheduler. It drives an external download client
(qBittorrent by default) and notifies your media server (Jellyfin, Emby, Plex) when
content lands. It is not a media server.

Status: **Phase 1 in progress** (library, metadata, profiles, indexers and download-client
plumbing work; the release/import pipeline and most UI pages are still being built; no
authentication yet). See [docs/ROADMAP.md](docs/ROADMAP.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Deploy

```yaml
# docker-compose.yml
services:
  media-tron:
    image: ghcr.io/media-tron/media-tron:latest
    container_name: media-tron
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
    volumes:
      - ./config:/config
      - /volume1/media/tv:/tv
      - /volume1/media/movies:/movies
      - /volume1/downloads:/downloads
    ports:
      - 7878:7878
    restart: unless-stopped

  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    container_name: qbittorrent
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
      - WEBUI_PORT=8080
    volumes:
      - ./qbittorrent:/config
      - /volume1/downloads:/downloads
    ports:
      - 8080:8080
      - 6881:6881
      - 6881:6881/udp
    restart: unless-stopped
```

The first-run setup wizard and automatic qBittorrent wiring are planned, not built. Add the
download client yourself under the download-clients API (Settings UI page is a placeholder).
There is no login yet: keep port 7878 on a trusted network.

`docker/docker-compose.yml` is the build-from-source variant of the snippet above (it uses
`PUID`, `PGID`, `TZ`, `CONFIG_ROOT`, `TV_ROOT`, `MOVIES_ROOT`, `DOWNLOADS_ROOT` from your
environment or a `.env` file, defaulting to `./data/...`).

## Develop

Requirements: Node 24, pnpm 10.

```bash
pnpm install
pnpm dev          # api on :7878 (tsx watch), web on :5173 proxying /api to it
pnpm build        # api -> apps/api/dist, web -> apps/web/dist
pnpm test         # vitest in every workspace project
pnpm typecheck    # tsc --noEmit in every workspace project
pnpm db:generate  # drizzle-kit generate: new migration in apps/api/drizzle
```

Parser fixture report (pass rate per fixture file, first failures):

```bash
pnpm --filter @media-tron/parser report              # all fixtures
pnpm --filter @media-tron/parser report -- quality   # only paths containing "quality"
pnpm --filter @media-tron/parser report -- --all     # list every failure
```

If port 7878 is already in use (Radarr uses 7878 too),
start the api with another port: `MEDIATRON_PORT=7979 pnpm dev`. The Vite proxy target is
hard-coded to `http://localhost:7878` in `apps/web/vite.config.ts` (there is no
`VITE_API_TARGET`), so change the target there when you move the api.

Local data (SQLite database, logs) goes in `./config` unless `MEDIATRON_CONFIG` is set.
See [docs/DEVELOPING.md](docs/DEVELOPING.md) for how to add modules and packages and
[docs/API.md](docs/API.md) for the routes.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MEDIATRON_CONFIG` | `/config` in Docker, else `./config` | Config dir: `media-tron.db`, `logs/` |
| `MEDIATRON_PORT` | `7878` | HTTP port |
| `MEDIATRON_HOST` | `0.0.0.0` | Bind address |
| `MEDIATRON_LOG_LEVEL` | `info` | pino log level |
| `MEDIATRON_DOCKER` | auto (`/.dockerenv`) | Force Docker path defaults with `1` |
| `MEDIATRON_WEB_DIST` | unset | Built web app to serve (set to `/app/web` in the image) |
| `MEDIATRON_VERSION` | `0.1.0-dev` | Version reported by `/system/status` (set at image build) |
| `MEDIATRON_TMDB_API_KEY` | unset | TMDB key fallback when none is stored in Settings |

The image also takes `PUID` and `PGID` (handled in `docker/entrypoint.sh`); compose passes `TZ`.

## Licence

GPL-3.0. Media-Tron is an independent implementation; see [NOTICE.md](NOTICE.md) for
the projects whose behaviour informed it.
