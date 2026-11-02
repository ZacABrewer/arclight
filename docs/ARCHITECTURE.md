# Arclight Architecture

Arclight is a single, Docker-deployable content-acquisition service written from
scratch. It does the jobs of Sonarr (TV), Radarr (movies), Prowlarr (indexers), Bazarr
(subtitles) and Seerr (requests) in one process with one database, one API, one login,
one UI and one scheduler. It downloads torrents with its own built-in engine (external
clients such as qBittorrent, Transmission, Deluge, rTorrent, SABnzbd and NZBGet are optional)
and tells the media server (Jellyfin / Emby / Plex) when content lands. It is **not** a
media server.

Arclight was started under the working name Media-Tron.

This is a clean-room rebuild. No upstream code is copied. The upstream projects are
treated as *behaviour specifications*: what a release name should parse to, what fields
an indexer returns, how a provider is queried, what a user expects on a page. Those
specs are written down in `docs/spec/` as we go, derived from reading the upstream
source and docs, and Arclight implements them in its own code.

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
| Validation / types | Zod | One schema → request validation + TS types  |
| Database | SQLite via Drizzle ORM (Postgres optional later) | Zero-ops on a NAS, typed migrations |
| Jobs | In-process scheduler (croner) + persistent job table | No Redis dependency; jobs survive restarts |
| Realtime | WebSocket (`@fastify/websocket`) | Live queue, job progress, library and release events |
| Frontend | React 19 + Vite + TanStack Router/Query + Tailwind | SPA served by the API process |
| Tests | Vitest | Parser and decision engine are fixture-heavy; fast unit loop matters |
| Packaging | pnpm workspaces; single multi-stage Dockerfile | One image, one `docker compose up` |

## Repository layout

```
arclight/
├── apps/
│   ├── api/                 Fastify host: modules, scheduler, SQLite/Drizzle, serves web/dist
│   ├── web/                 React SPA: admin app, request portal, themes
│   └── mobile/              Capacitor companion app (iOS and Android)
├── packages/                Pure logic and service clients (see below)
├── jellyfin-plugin/         Arclight for Jellyfin (C#, separate release line)
├── push-relay/              Cloudflare Worker that relays phone push notifications
├── site/                    Public website (Astro + Starlight), built from docs/
├── themes/                  Theme packs synced by running instances
├── design/                  Brand assets
├── docker/                  Dockerfile, compose files, entrypoint (PUID/PGID)
└── docs/                    User docs, specs, API reference, QA checklists
```

### Packages

Packages are pure logic and external-service clients: no database, no HTTP server.

| Package | Purpose |
|---|---|
| `@arclight/shared` | Zod schemas and inferred types for every API shape, the quality vocabulary, the WebSocket event union and the Jellyfin plugin contract. |
| `@arclight/parser` | Release-name parsing: titles, numbering, quality, languages, release group. Fixture-driven (`pnpm --filter @arclight/parser report`). |
| `@arclight/profiles-engine` | Quality profiles, custom formats, delay and release profiles. Used by the decision engine. |
| `@arclight/indexers` | Torznab and Newznab clients, YAML site definitions, search planning, proxies, rate limiting. |
| `@arclight/download-clients` | The `DownloadClient` interface and clients for qBittorrent, Transmission, Deluge, rTorrent, SABnzbd and NZBGet. |
| `@arclight/torrent-engine` | The built-in BitTorrent engine: DHT, uTP, MSE encryption, web seeds, IPv6. |
| `@arclight/engine-agent` | The agent that runs the torrent engine on another machine (see [Remote engine](REMOTE-ENGINE.md)). |
| `@arclight/metadata` | TMDB client and mapping to Arclight shapes; MusicBrainz and audiobook catalogue clients. |
| `@arclight/organizer` | Naming templates and file and folder name builders. Spec: `docs/spec/naming.md`. |
| `@arclight/notifications` | Notification agents behind `createAgent(kind, settings)`: Discord, Telegram, webhook, email, custom script, Gotify, ntfy, Pushover and media-server refresh. |
| `@arclight/subtitles` | Subtitle providers, scoring, selection, encoding and sync. |
| `@arclight/media-servers` | Jellyfin, Emby, Plex and Audiobookshelf clients. |
| `@arclight/challenge-solver` | The built-in Cloudflare challenge solver (a local browser); FlareSolverr is the usual route in Docker. |

### API modules

`apps/api/src/modules/<name>/` holds one folder per area, registered in
`apps/api/src/app.ts`. Every route lives under `/api/v1`. See [API.md](API.md) for routes.
The main areas:

- Core: `system`, `settings`, `auth`, `health`, `jobs`, `events`, `audit`, `backup`, `updates`, `logs`, `debug`, `metrics`, `config-export`.
- Library and metadata: `library`, `metadata`, `profiles`, `profile-migration`, `library-hygiene`, `health-scan`, `tag-rules`, `retention`, `scene-mapping`, `media-analysis`, `transcode`, `bulk`.
- Acquisition: `indexers`, `releases`, `download-clients`, `torrent`, `vpn`, `imports`, `history`, `blocklist`, `calendar`, `cross-seed`, `tracker-stats`, `solver`, `engine-agent`.
- Subtitles and languages: `subtitles`, `additional-languages`.
- Music and audiobooks: `music`, `audiobooks`.
- Requests and users: `requests`, `import-lists`, `discord-bot`, `notifications`, `push`, `mobile`, `themes`.
- Media servers: `media-servers`, `watch-history`, `jellyfin-plugin`.
- Compatibility and import: `compat` (the Sonarr/Radarr-shaped API), `migrate` (the stack import wizard).

Not built yet: Plex watch-history sync, season-pack and archive-unpacking import, ebooks,
podcasts, single sign-on and a media player. See [Roadmap](ROADMAP.md).

### Database

SQLite through Drizzle (`better-sqlite3`). `apps/api/src/db/schema.ts` defines the core tables
and re-exports each module's `schema.ts`. Migrations live in `apps/api/drizzle/` and run at
boot. Tests build in-memory databases from the table definitions with `createTestDb`.

### Web

`apps/web` is a TanStack Router code-based route tree with navigation driven by `nav.ts`.
It holds the admin app (library, wanted, activity, calendar, settings, system), the
request portal for non-admin users, Discover, the command palette and the theme system
(see [Themes](THEMES.md)). It has a typed API client per module and a React Query cache
kept live by the WebSocket feed. Below 768 px tables turn into cards. The companion app
in `apps/mobile` shows this same UI.

## Runtime shape

```
docker compose up
├── gluetun         optional VPN layouts: the tunnel and firewall
├── arclight        Node 24, port 7878, serves API + SPA + WebSocket
│     ├── /config   arclight.db, logs, backups, themes
│     ├── /data     downloads/ and media/ (one share, so imports are hard links)
│     ├── built-in torrent engine
│     └── scheduler with a visible job board (RSS sync, searches, import,
│         subtitles, health scan, tag rules, retention, backup, ...)
└── flaresolverr    solves Cloudflare challenges for indexers
```

qBittorrent and Whisper are optional compose profiles. Headless by design: the UI is a
window onto the service, never required for it to run.

## API

`/api/v1/*`, request and response validation from the Zod schemas in `packages/shared`.
The WebSocket feed is `/api/v1/events`. Access needs a session cookie or an API key.
Sonarr/Radarr v3-shaped endpoints let third-party tools talk to Arclight (see
[API](API.md)). Do not expose port 7878 to the internet without a reverse proxy; see
[Exposing Arclight outside your home](getting-started/exposing-outside-home.md).

## Out of scope

Media playback and library streaming (media servers do that).

## Licence

GPL-3.0. No upstream code is incorporated; `NOTICE.md` credits the projects whose
behaviour informed the specs.
