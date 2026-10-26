# Media-Tron Roadmap

Clean-room build. Each phase ends with something that runs in Docker on the NAS and does
real work. Functionality first; the Tron theme is a layer in Phase 5 and does not block
anything before it. Behaviour specs for each area are written to `docs/spec/` before the
code, derived from how the upstream apps behave.

## Phase 0 — Skeleton that boots

- pnpm monorepo, `apps/api` (Fastify + Drizzle/SQLite), `apps/web` (React + Vite),
  `packages/shared` (Zod contract).
- Auth (first-run setup, sessions, API key), settings store, system info, health,
  structured logging, in-process scheduler with a persistent job table, WebSocket feed.
- Multi-stage Dockerfile + compose with qBittorrent; PUID/PGID entrypoint.

Done when: `docker compose up` on the NAS → setup wizard → dashboard, jobs visible.

## Phase 1 — Library, metadata, parser, download pipeline (TV + movies)

The core loop, for both media types from day one:

- `packages/metadata`: TMDB search/lookup for series and movies, images, refresh jobs.
- `library` module: root folders, series/seasons/episodes, movies, monitored flags,
  media files, disk scan, free-space.
- `packages/parser`: release-name parser (title, year, season/episode/daily/anime/absolute
  numbering, quality source + resolution, codecs, HDR, audio, release group, proper/repack,
  languages, edition for movies, hash/scene checks). Fixture suite built from the
  documented upstream parser test cases (as data, not code).
- `profiles` module: quality definitions and profiles, custom formats (spec engine),
  language profiles, delay profiles, release profiles (must/must-not contain, preferred).
- `indexers` module + `packages/indexers`: Torznab/Newznab clients, categories,
  per-indexer settings, RSS sync, interactive + automatic search, indexer health/backoff.
- `releases` module: decision engine (quality cutoff/upgrade, custom-format score,
  language, size limits, seeders, blocklist, already-grabbed, delay, protocol priority).
- `downloads` module + `packages/download-clients`: qBittorrent client (add/track/remove,
  categories, seed limits, path mapping), queue, completed-download handling, import with
  episode/movie matching, failed-download handling and auto re-search.
- `organizer` module: naming tokens, rename preview, file moves/hardlinks, media
  management settings.
- `history`, `blocklist`, `calendar`, `notifications` (Discord, Telegram, webhook,
  email, custom script, Jellyfin/Emby/Plex library refresh).
- Web: Library (one grid, TV + movies), item pages, add-new, Activity (queue/history/
  blocklist), Calendar, Settings for everything above, interactive search modal.

Done when: add a series and a movie, both get searched, grabbed through qBittorrent,
imported, renamed, and the media server is refreshed, with no other \*arr installed.

## Phase 2 — Indexer depth (Prowlarr parity)

- YAML-defined site indexers (public and private trackers that lack Torznab), with
  login flows, search templates, result parsing. Definition format designed for
  Media-Tron, informed by Cardigann/Prowlarr's catalogue.
- Indexer proxies (FlareSolverr, HTTP/SOCKS), per-indexer stats, rate limits,
  category mapping per media type, cross-indexer manual search page.
- Additional download clients: Transmission, Deluge, SABnzbd, NZBGet, rTorrent.
- Import lists (Trakt, TMDB lists, Plex watchlist, IMDb lists).

## Phase 3 — Subtitles (Bazarr parity)

- `subtitles` module: language profiles (forced/HI/cutoff), wanted list, per-file
  subtitle state, history, blacklist, upgrade logic, scoring with ranked matches.
- `packages/subtitles`: provider abstraction; OpenSubtitles.com, Subdl, Addic7ed,
  Podnapisi, Gestdown, Subf2m, Napisy24, Animetosho, embedded-subtitle extraction
  first; more by usage. Whisper (optional, external endpoint) last.
- Post-processing: sync (ffsubsync/alass), encoding, custom scripts.
- Web: Subtitles pages — wanted, history, blacklist, profiles, providers, per-item
  manual search/upload.

Done when: subtitles arrive automatically after import for every configured language.

## Phase 4 — Requests and discover (Seerr parity)

- Users with roles, permission flags, quotas; local and media-server (Jellyfin/Emby/
  Plex) sign-in.
- `requests` module: movie/series/season requests, approval flow and auto-approve,
  4K/alternate-profile targets, override rules, issues + comments, watchlist sync,
  availability tracking against the library and the media server.
- Discover: TMDB trending/popular/upcoming/genres/networks/people, configurable sliders.
- Notifications for request events; per-user notification agents (push, email,
  Discord DM, Telegram, webhook).
- Web: Discover pages, request flow, Requests admin, Issues, per-user settings.

Done when: a non-admin user requests a show, an admin approves, it is grabbed,
imported, subtitled, and the user is notified it is available.

## Phase 5 — Tron Legacy theme and polish

- Theme tokens (neon cyan / orange on near-black, grid, glow), motion, typography.
- Dashboard as a live grid of activity; mobile layout; PWA.

## Phase 6 — Adoption and release

- Importer that reads existing Sonarr / Radarr / Prowlarr / Bazarr / Seerr databases
  and configs to adopt a running stack in place.
- Optional Sonarr/Radarr-shaped compatibility API for third-party tools.
- Backup/restore, update channel, docs, GHCR image, release process.
