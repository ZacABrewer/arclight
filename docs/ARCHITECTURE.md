# Arclight Architecture

Arclight is a single, Docker-deployable content-acquisition service written from
scratch. It does the jobs of Sonarr (TV), Radarr (movies), Prowlarr (indexers), Bazarr
(subtitles) and Seerr (requests) in one process with one database, one API, one login,
one UI and one scheduler. It drives an external download client (qBittorrent by default)
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
| Validation / types | Zod | One schema → request validation + TS types (OpenAPI generation planned) |
| Database | SQLite via Drizzle ORM (Postgres optional later) | Zero-ops on a NAS, typed migrations |
| Jobs | In-process scheduler (croner) + persistent job table | No Redis dependency; jobs survive restarts |
| Realtime | WebSocket (`@fastify/websocket`) | Live queue, job progress, library and release events |
| Frontend | React 19 + Vite + TanStack Router/Query + Tailwind | SPA served by the API process |
| Tests | Vitest | Parser and decision engine are fixture-heavy; fast unit loop matters |
| Packaging | pnpm workspaces; single multi-stage Dockerfile | One image, one `docker compose up` |

## Repository layout

State as of 2026-10-26. Test counts come from one `pnpm -r test` run (all green).

```
arclight/
├── apps/
│   ├── api/                 Fastify host: modules, scheduler, SQLite/Drizzle, serves web/dist
│   └── web/                 React SPA shell; most pages are still ComingSoon placeholders
├── packages/
│   ├── shared/              Zod contract shared by api and web
│   ├── parser/              Release-name parser (in progress, uncommitted)
│   ├── profiles-engine/     Quality profile / custom format / delay / release profile logic
│   ├── indexers/            Torznab + Newznab clients, caps, query planning, rate limiting
│   ├── download-clients/    qBittorrent client, torrent hash helpers
│   ├── metadata/            TMDB client and mapping to Arclight shapes
│   ├── organizer/           Naming-template parsing, file/folder name builders
│   └── notifications/       Notification agents behind one event model
├── docker/                  Dockerfile, compose (build-from-source), entrypoint (PUID/PGID)
└── docs/                    ARCHITECTURE, ROADMAP, CONVENTIONS, API, DEVELOPING, spec/
```

### Packages

Packages are pure logic and external-service clients: no database, no HTTP server.

| Package | Purpose | Tests |
|---|---|---|
| `@arclight/shared` | Zod schemas and inferred types for every API shape, the quality vocabulary and the WebSocket event union. Areas: system, jobs, events, quality, profiles, library, indexers, download-clients, naming, settings, metadata, releases, imports, history, notifications, calendar. The last five files (releases, imports, history, notifications, calendar) are new and uncommitted. | none (`--passWithNoTests`) |
| `@arclight/parser` | Release-name parsing: series and movie titles, numbering, quality and revision, languages, release group, hash/obfuscation detection. Fixture-driven; fixtures run at 2910/2932 (99.2%) in `pnpm --filter @arclight/parser report`. In progress: the folder is untracked, `scripts/_dbg.ts` is scratch, and `series.ts`/`movie.ts` have no unit test files of their own. | 41 |
| `@arclight/profiles-engine` | Evaluate quality profiles (allowed, cutoff, upgrade, revision), custom formats (spec matching and scoring), delay and release profiles. Used by the profiles module and, later, the decision engine. | 64 |
| `@arclight/indexers` | `Indexer` abstraction over Torznab and Newznab: caps, RSS, search, test; search planning, URL redaction, category helpers, per-indexer rate limiter. No YAML site definitions yet. | 58 |
| `@arclight/download-clients` | `DownloadClient` interface and a qBittorrent WebUI v2 client; torrent file and magnet hash extraction. qBittorrent only. | 64 |
| `@arclight/metadata` | TMDB client (search, series, movie, trending/discover helpers), mapping to Arclight metadata shapes, image URL builder, title cleaning. No TVDB fallback, no image caching. | 57 |
| `@arclight/organizer` | Parse naming formats and build episode/movie file names and series/season/movie folder names. Spec: `docs/spec/naming.md`. | 224 |
| `@arclight/notifications` | Agents behind `createAgent(kind, settings)`: Discord, Telegram, webhook, email (own SMTP), custom script, Gotify, ntfy, Pushover, Plex and Jellyfin/Emby (media-browser) refresh; event formatting. | 67 |

There is no `packages/subtitles` yet (Phase 3).

### API modules

`apps/api/src/modules/<name>/` is registered in `apps/api/src/app.ts` in this order:
system, health, jobs, events, settings, metadata, library, profiles, indexers,
download-clients. Every route lives under `/api/v1`. See [API.md](API.md) for routes.

| Module | Purpose | Tests |
|---|---|---|
| `system` | `GET /system/status`: version, uptime, paths | none |
| `health` | Health check aggregation and the `HealthCheck` job | none |
| `jobs` | Recent job runs, scheduled jobs, manual run | none |
| `events` | WebSocket feed of bus events | none |
| `settings` | Key-value settings store; currently TMDB (metadata) settings, API key masked | 7 |
| `metadata` | TMDB search/lookup routes, library metadata adapter, daily refresh jobs | 17 (incl. map tests) |
| `library` | Root folders, tags, series/seasons/episodes, movies, media files, wanted-missing, import exclusions, statistics | 41 |
| `profiles` | Quality profiles, custom formats, delay profiles, release profiles, quality definitions; seeded defaults | 17 |
| `indexers` | Persisted indexer config, caps cache, status/backoff, fan-out manual search, RSS sync and status jobs | 43 |
| `download-clients` | Client registry, remote path mappings, tracked downloads and queue, queue refresh job | 45 |

`apps/api` also has 170 tests in total (these module numbers sum to it).
Web has 33 tests.

Not present in the tree yet: `releases`, `imports`, `history`, `blocklist`,
`notifications` and `calendar` modules (their shared contracts exist, in progress),
and `auth`, `users`, `organizer` (api side), `subtitles`, `requests`, `backup`.
Several of these are being written in parallel; their internals are not described here
until they land.

### Database

SQLite through Drizzle (`better-sqlite3`). `apps/api/src/db/schema.ts` defines the core tables
(`settings`, `jobs`, `scheduled_jobs`) and re-exports each module's `schema.ts`
(profiles, library, indexers, download-clients). Three migrations in `apps/api/drizzle/`
(`0000` core, `0001` profiles + library, `0002` indexers + download clients) create 23
tables. Tests build in-memory databases from the table definitions with `createTestDb`.

### Web

`apps/web` is a TanStack Router code-based route tree with a sidebar driven by `nav.ts`.
Built pages: Dashboard, Search, System Status, System Tasks, System Health. Everything
else in the sidebar renders a `ComingSoon` placeholder tagged with its roadmap phase.
The app has a typed API client per module, a React Query cache kept live by the WebSocket
feed, and a small component kit (table, form, modal, tabs, toast).

## Runtime shape

```
docker compose up
├── arclight      Node 24, port 7878, serves API + SPA + WebSocket
│     ├── /config   arclight.db, logs, backups, image cache
│     ├── /tv  /movies  /downloads
│     └── scheduler (today): RssSync · IndexerStatusCheck · RefreshQueue ·
│         RefreshSeries · RefreshMovie · HealthCheck
│         (planned: searches · import · subtitle pass · availability · housekeeping · backup)
└── qbittorrent     lscr.io/linuxserver/qbittorrent; auto-wiring on first boot is planned
```

Headless by design: the UI is a window onto the service, never required for it to run.

## API

`/api/v1/*`, request and response validation from the Zod schemas in `packages/shared`.
The WebSocket feed is `/api/v1/events`. Not built yet: authentication (one API key, one
session cookie) and generated OpenAPI; both are design targets. The API is currently
unauthenticated, so do not expose port 7878 beyond a trusted network. A compatibility layer exposing Sonarr/Radarr-shaped endpoints for third-party tools
(e.g. `*/api/v3/series`) is a Phase 6 option, not a design constraint.

## Out of scope

Media playback/transcoding/library scanning (media servers), music/books/comics
(module shape allows them later), embedding a torrent or usenet client.

## Licence

GPL-3.0. No upstream code is incorporated; `NOTICE.md` credits the projects whose
behaviour informed the specs.
