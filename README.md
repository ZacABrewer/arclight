# Media-Tron

One content-acquisition service for a home media stack, written from scratch.
Media-Tron does the jobs of Sonarr (TV), Radarr (movies), Prowlarr (indexers), Bazarr
(subtitles) and Seerr (requests) in a single application: one database, one API, one
login, one UI, one background scheduler. It drives an external download client
(qBittorrent by default) and notifies your media server (Jellyfin, Emby, Plex) when
content lands. It is not a media server.

Status: **Phase 0 — skeleton**. See [docs/ROADMAP.md](docs/ROADMAP.md) and
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
      - TZ=America/New_York
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
      - TZ=America/New_York
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

On first boot Media-Tron walks you through setup and offers to configure the
qBittorrent container as the default download client.

## Develop

Requirements: Node 24, pnpm 10.

```bash
pnpm install
pnpm dev          # api on :7878, web on :5173 proxied to it
pnpm test
pnpm build        # produces apps/api/dist + apps/web/dist
```

## Licence

GPL-3.0. Media-Tron is an independent implementation; see [NOTICE.md](NOTICE.md) for
the projects whose behaviour informed it.
