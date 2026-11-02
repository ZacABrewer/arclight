# Arclight Roadmap

Status as of release 0.20.0 (Jellyfin plugin 1.3.0). See the
[changelog](../CHANGELOG.md), which also lists what shipped release by release. This page lists what is done by area and what is planned.

Planned items are ideas under development or on the list. They are not available yet, and
the order is not a promise. Behaviour specs for each area are written to `docs/spec/` before the
code, derived from how the upstream apps behave. The project is a clean-room build; see
[Conventions](CONVENTIONS.md).

## Done

### Core

- pnpm monorepo: `apps/api` (Fastify, Drizzle, SQLite), `apps/web` (React, Vite), `apps/mobile`,
  shared packages, `jellyfin-plugin` and `push-relay`.
- First-run wizard, login, API keys (including per-user keys with scopes), roles and permissions,
  single sign-on (OpenID Connect), two-factor sign-in and passkeys, forward-auth behind a trusted
  proxy, sub-path hosting, audit log, backup and restore, in-app
  updates (including container self-update), config as code, metrics, scheduler with a persistent
  job table, WebSocket feed, health checks with a fix for each.
- Docker image on GHCR, compose files for VPN (Gluetun) and no-VPN layouts, guides for Linux,
  Synology, UGREEN, Unraid, TrueNAS SCALE, QNAP, Windows, macOS, Raspberry Pi and Portainer.

### TV and movies (Sonarr and Radarr)

- TMDB metadata, library, root folders, monitoring, release-name parser, quality and language
  profiles, custom formats, delay and release profiles, naming and renaming, hard-link imports.
- Decision engine, automatic and interactive search (with filters and "Grab anyway"), upgrades,
  blocklist, history, calendar and ICS feed, Wanted lists (missing, cutoff unmet) with a release filter.
- Bulk actions on every list, tags and tag rules, library hygiene and a library health scan,
  command palette and universal search.
- Hardware transcoding rules (Quick Sync, VA-API, NVENC) and media analysis with ffprobe.
- Season packs: multi-season, complete-series, partial-season and anime batch releases, preferred
  by how much of the season you want, with only-wanted imports.

### Indexers (Prowlarr)

- Torznab and Newznab, YAML-defined site indexers, indexer proxies including FlareSolverr,
  per-indexer stats and health, rate limits, category mapping.

### Downloads

- Built-in BitTorrent engine with VPN binding, kill switch, tunnel guard and disk guard, stall
  recovery and a disk-space guard, plus an optional remote engine.
- Download clients: qBittorrent, Transmission, Deluge, rTorrent, SABnzbd, NZBGet.
- Gluetun and native Windows VPN integrations with forwarded-port handling.
- Archive unpacking (RAR, 7z, zip) before import, and a fake-release and malware filter that
  rejects, blocklists and re-searches unsafe downloads.

### Subtitles (Bazarr)

- Language profiles, providers, scoring, wanted list, history and blacklist, optional Whisper
  speech-to-text, and requests for missing subtitles or audio languages.

### Requests and Discover (Seerr)

- Local and media-server users, permissions, quotas, per-user request type switches, approval and
  auto-approve rules, issues, watchlist, Discover for movies, series, music and audiobooks.
- Request portal for non-admin users, installable as a PWA.
- Import lists from TMDB, Trakt, IMDb, Letterboxd, MDBList, AniList, MyAnimeList, Kitsu, Simkl,
  Jellyfin/Emby favourites and custom URLs, with per-list rules, preview and clean-up.
- Notifications through 29 kinds of connection (and many more services through Apprise), with routing filters, message templates, reliable
  delivery and personal destinations for every user.

### Music, audiobooks, books and podcasts (preview, off by default)

- Music library, search, grab and import, and audiobooks with Audiobookshelf support. Both
  have import of existing files and requests in Discover. Turn them on in Settings > General > Features.
- Music editions, per-track wanted, cue sheets, tagging, an optional Soulseek source through
  slskd, and playlists from Spotify, Deezer, ListenBrainz and Last.fm.
- Ebooks and comics: library, monitoring, search, import, calendar and requests.
- Podcasts: RSS subscriptions with directory search, OPML, auto-download and clean-up rules.

### Media servers and apps

- Jellyfin, Emby and Plex library refresh, and watch history sync for Jellyfin, Emby and Plex
  (Plex users, history and live playback).
- Playback stats, Year in review, smart collections and a Leaving Soon collection synced to
  Jellyfin and Emby.
- **Arclight for Jellyfin** plugin (1.3.0): request and browse Discover inside Jellyfin, title
  pages, status badges, watchlist, issues, language requests and opt-in themes. Install it from
  `https://arclight.moviemethat.com/jellyfin/manifest.json`.
- Companion app for iOS and Android with mobile push through a relay (built from `apps/mobile`;
  not in the app stores yet).
- Import wizard for Sonarr, Radarr, Prowlarr, Bazarr, Overseerr or Jellyseerr and qBittorrent,
  and a Sonarr/Radarr-compatible API for third-party tools.

### Look and feel

- Tron look by default and syncable theme packs; installable PWA; phone-friendly lists.
- Translations framework with several languages.
- Public website with the documentation at https://arclight.moviemethat.com.

## Planned

- **Music, books and podcasts** moving out of preview once they have had more real-world testing.
- **A built-in media player**, so you can browse and play your library in Arclight. Arclight is
  not a media server today and keeps working alongside Jellyfin, Emby and Plex.
- **Companion app in the app stores**, after review.
- **Pre-rename clean-up**: remove the deprecated `MEDIATRON_*` environment fallback, the one-time
  `media-tron.db` to `arclight.db` file move and acceptance of `media-tron_*.zip` backups.
