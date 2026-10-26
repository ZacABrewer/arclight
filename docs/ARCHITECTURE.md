# Media-Tron Architecture

Media-Tron is a single, Docker-deployable content-acquisition service written from
scratch. It does the jobs of Sonarr (TV), Radarr (movies), Prowlarr (indexers), Bazarr
(subtitles) and Seerr (requests) in one process with one database, one API, one login,
one UI and one scheduler. It drives an external download client (qBittorrent by default)
and tells the media server (Jellyfin / Emby / Plex) when content lands. It is **not** a
media server.

This is a clean-room rebuild. No upstream code is copied. The upstream projects are
treated as *behaviour specifications*: what a release name should parse to, what fields
an indexer returns, how a provider is queried, what a user expects on a page. Those
specs are written down in `docs/spec/` as we go, derived from reading the upstream
source and docs, and Media-Tron implements them in its own code.

## Why one app changes the design

The five upstream apps each own a private copy of the same machinery: an HTTP server,
auth, a job scheduler, a parser, an indexer client, a download-client client, a
notification pipeline, a media library, a settings system and a React shell. Then they
talk to each other over HTTP with API keys. Measured on the upstream trees, roughly 70%
of Sonarr and Radarr is literally the same code at the same path, and Bazarr and Seerr
exist mostly to *poll* the others for library state they could share.

In one app:

- One **media library** table family holds series/seasons/episodes and movies. Subtitles
  and requests attach directly to those rows. No polling, no sync, no path mapping
  between apps.
- One **release pipeline**: indexers → parse → decide (quality, custom formats,
  language, size, seeders, blocklist) → grab → track in download client → import →
  rename → post-process (subtitles, notifications, media-server refresh). Series and
  movies are two media types through the same pipeline, not two pipelines.
- One **indexer registry** consumed in-process. "Prowlarr sync" ceases to exist.
- One **user model** with roles, permissions and request quotas, so requesting is a
  first-class action on the library rather than a separate app.
- One **scheduler** with a visible job board (RSS sync, searches, imports, subtitle
  passes, availability checks, housekeeping, backups).

## Stack

TypeScript end to end, one language for the whole project.

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 24 | Long-running background service, excellent HTTP/IO, single container |
| API | Fastify | Fast, schema-first (JSON Schema from Zod), plugin model for modules |
| Validation / types | Zod | One schema → request validation + TS types + OpenAPI |
| Database | SQLite via Drizzle ORM (Postgres optional later) | Zero-ops on a NAS, typed migrations |
| Jobs | In-process scheduler (croner) + persistent job table | No Redis dependency; jobs survive restarts |
| Realtime | WebSocket (`@fastify/websocket`) | Live queue, job progress, request updates |
| Frontend | React 19 + Vite + TanStack Router/Query + Tailwind | SPA served by the API process |
| Tests | Vitest | Parser and decision engine are fixture-heavy; fast unit loop matters |
| Packaging | pnpm workspaces; single multi-stage Dockerfile | One image, one `docker compose up` |

## Repository layout

```
media-tron/
├── apps/
│   ├── api/            Fastify host: modules, scheduler, DB, serves web/dist
│   └── web/            React SPA (Tron Legacy theme is a theme layer, Phase 5)
├── packages/
│   ├── shared/         Zod schemas + types shared by api and web (the API contract)
│   ├── parser/         Release-name parser + quality detection (pure, fixture-tested)
│   ├── indexers/       Torznab/Newznab clients + YAML-defined site scrapers
│   ├── download-clients/ qBittorrent first; Transmission, Deluge, SABnzbd, NZBGet…
│   ├── metadata/       TMDB (movies + TV), TVDB fallback, image caching
│   ├── subtitles/      Subtitle provider abstraction + providers + scoring
│   └── notifications/  Discord, Telegram, webhook, email, Jellyfin/Emby/Plex refresh…
├── docker/             Dockerfile, compose, entrypoint (PUID/PGID handling)
└── docs/
    ├── ARCHITECTURE.md  this file
    ├── ROADMAP.md       phases
    └── spec/            behaviour specs derived from upstream (parser cases, API shapes…)
```

`apps/api` is organised by **module**, each owning its routes, services, DB tables and
jobs, all registered through one plugin interface:

```
apps/api/src/modules/
  auth/  users/  settings/  system/        core
  library/   (series, episodes, movies, files, root folders)
  metadata/  (lookups, refresh jobs, images)
  indexers/  (definitions, registry, search, stats, proxies)
  releases/  (parse → decision engine → grab)
  downloads/ (clients, queue tracking, completed-download handling, import)
  organizer/ (naming, renaming, media management)
  profiles/  (quality, custom formats, languages, delay, release profiles)
  subtitles/ (language profiles, wanted, providers, history, blacklist)
  requests/  (requests, approvals, quotas, issues, discover, watchlists)
  notifications/
  calendar/  history/  blocklist/  health/  backup/  jobs/
```

## Runtime shape

```
docker compose up
├── media-tron      Node 24, port 7878, serves API + SPA + WebSocket
│     ├── /config   media-tron.db, logs, backups, image cache
│     ├── /tv  /movies  /downloads
│     └── scheduler: rss sync · searches · import · subtitle pass ·
│         availability · health · housekeeping · backup
└── qbittorrent     lscr.io/linuxserver/qbittorrent, auto-wired on first boot
```

Headless by design: the UI is a window onto the service, never required for it to run.

## API

`/api/v1/*`, one API key, one session cookie, OpenAPI generated from the Zod schemas.
A compatibility layer exposing Sonarr/Radarr-shaped endpoints for third-party tools
(e.g. `*/api/v3/series`) is a Phase 6 option, not a design constraint.

## Out of scope

Media playback/transcoding/library scanning (media servers), music/books/comics
(module shape allows them later), embedding a torrent or usenet client.

## Licence

GPL-3.0. No upstream code is incorporated; `NOTICE.md` credits the projects whose
behaviour informed the specs.
