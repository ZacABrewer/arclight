# API reference

Compiled from the `routes.ts` and `index.ts` files in `apps/api/src/modules/*` on
2026-10-26. Request and response schemas live in `packages/shared/src/*.ts`. All paths are
prefixed with `/api/v1`. Every route requires authentication unless listed as public in
[Authentication](#authentication).

Modules still being written (releases, imports, history, blocklist, notifications,
calendar) have no routes and are not listed.

Errors: modules map typed service errors to JSON `{ "error": "..." }` bodies (400, 404,
409, 5xx). Deletes answer `204` with a null body unless noted.

## Authentication

Implemented in `apps/api/src/modules/auth` (contract: `packages/shared/src/auth.ts`). An
`onRequest` hook installed by `app.ts` on the `/api/v1` scope resolves who each request is,
in this order:

1. **Session cookie** `mt_session` (from `POST /auth/login` or `POST /setup/admin`):
   httpOnly, `SameSite=Lax`, `Secure` when the request arrived over https (directly or via
   `X-Forwarded-Proto`). Only a sha256 of the token is stored. Sessions last
   `sessionDays` (default 30) and slide forward once past half their lifetime;
   `rememberMe: false` gives a browser-session cookie and a one-day server lifetime.
2. **HTTP Basic** credentials, only when the auth method is `basic`.
3. **API key** in the `X-Api-Key` header or `?apikey=` query. One key per install, generated
   on first boot and stored in the `security` settings section. It grants admin access.
4. **Local bypass**: once setup is complete, requests where the socket peer *and* every
   `X-Forwarded-For` hop are loopback, RFC 1918, IPv4 link-local, IPv6 ULA or link-local skip
   sign-in when the method is `none` or `requireForLocal` is false. Public addresses always
   need credentials, so `none` never opens the api to the internet.

Anonymous requests to protected routes get `401 {"error","code":"UNAUTHORIZED"}` (plus
`WWW-Authenticate: Basic` when the method is `basic`). Unknown routes answer 404.

**Public routes** (no credentials): `POST /auth/login`, `POST /auth/logout`,
`GET /auth/status`, `GET /system/ping`, `GET /calendar/feed.ics` (checks its own `token`),
and `/setup/*` (which guard themselves: writes need the admin once one exists, and answer
409 `SETUP_COMPLETE` after setup). The SPA's static files are outside `/api/v1`.

**Roles.** `admin` can do everything. `user` may call `GET`/`HEAD` routes; any other method
needs admin unless the route sets `config: { allowUser: true }`. Admin-only routes add the
`requireAdmin` preHandler exported by the auth module:

```ts
import { requireAdmin } from '../auth/index.js';
app.get('/thing', { preHandler: requireAdmin }, handler);   // one route
app.addHook('preHandler', requireAdmin);                    // a whole plugin
app.post('/request', { config: { allowUser: true } }, h);   // let users change state
```

`req.auth` (`{ user, via, isAdmin, sessionId?, expiresAt? }`) is available in every
handler; `user` is null for API-key and bypass callers. `authServiceFor(ctx)` returns the
shared `AuthService`. Users carry a `permissions` bitfield (`Permission` in shared; `ADMIN`
= 2 implies all) and a free-form `settings` record, ready for the requests phase. Failed
logins are limited to 10 per address per 15 minutes (429 `RATE_LIMITED`). Passwords are
hashed with scrypt (N=16384, r=8, p=1, 16-byte salt) from `node:crypto`.

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/auth/login` | public | `{username, password, rememberMe?}` → `Session`; sets the cookie. 401 `INVALID_CREDENTIALS`, 429 |
| POST | `/auth/logout` | public | Ends the session and clears the cookie (204) |
| GET | `/auth/status` | public | `{needsSetup, authMethod, authenticated, session}` |
| GET | `/auth/me` | any | Current `Session` (`user`, `via`, `isAdmin`, `expiresAt`) |
| GET | `/auth/sessions` | any | The caller's active sessions (`current` marks this one) |
| DELETE | `/auth/sessions/:id` | any | Revoke one of the caller's sessions |
| GET | `/user/me` | any | The signed-in user |
| PUT | `/user/me` | any | Update own display name, email, avatar, settings |
| PUT | `/user/me/password` | any | `{currentPassword, newPassword}`; ends the caller's other sessions (204) |
| GET | `/user` | admin | List users |
| GET | `/user/:id` | admin | One user |
| POST | `/user` | admin | Create (201); 409 `USER_EXISTS` (usernames are case-insensitive) |
| PUT | `/user/:id` | admin | Update; `password` resets it and ends the user's sessions; 409 `LAST_ADMIN` on demoting the only admin |
| DELETE | `/user/:id` | admin | Delete (204); not yourself, not the only admin |
| GET | `/settings/security` | admin | `{method, requireForLocal, sessionDays, apiKey}` |
| PUT | `/settings/security` | admin | Update `{method, requireForLocal, sessionDays}` |
| POST | `/settings/security/apikey` | admin | Regenerate the API key → `{apiKey}` |
| GET | `/setup/status` | public | `{needsSetup, steps[{id, complete, optional}]}` for admin, tmdb, rootFolders, downloadClient, indexer |
| POST | `/setup/admin` | public | Create the first admin and sign it in (201); 409 once a user exists |
| POST | `/setup/rootfolder` | setup admin | `{path, mediaType, createIfMissing}`: create the directory if asked, add the root folder (existing path returns it) |
| POST | `/setup/complete` | setup admin | `{tmdbApiKey?, rootFolders?, authMethod}` (+ `username`/`password`/`email` when no user exists: headless setup); marks setup done; 409 on a second call |

## system

| Method | Path | Purpose |
|---|---|---|
| GET | `/system/status` | App name, version, start time, uptime, runtime and config paths |
| GET | `/system/ping` | Public liveness probe: `{"status":"ok"}` |

## health

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Evaluate all health checks; overall `ok`/`warning`/`error` plus findings |

## jobs

| Method | Path | Purpose |
|---|---|---|
| GET | `/jobs` | Recent job runs |
| GET | `/jobs/scheduled` | Registered scheduled jobs with interval, last and next run |
| POST | `/jobs/run` | Run a registered job by name now (202; 404 for unknown name) |

## events

| Method | Path | Purpose |
|---|---|---|
| GET (WebSocket) | `/events` | Live feed: `hello` on connect, then every event bus message |

## settings

| Method | Path | Purpose |
|---|---|---|
| GET | `/settings/metadata` | TMDB settings; API key masked |
| PUT | `/settings/metadata` | Update TMDB settings; a masked key keeps the stored value |
| GET | `/settings/releases` | Decision-engine knobs (max size, minimum age, retention, season packs, availability delay, unaired) |
| PUT | `/settings/releases` | Replace the releases settings section |

## metadata

| Method | Path | Purpose |
|---|---|---|
| GET | `/metadata/search` | Search TMDB for series or movies (`query`, `type`) |
| GET | `/metadata/series/:tmdbId` | Full series metadata from TMDB |
| GET | `/metadata/movie/:tmdbId` | Full movie metadata from TMDB |

## library

| Method | Path | Purpose |
|---|---|---|
| GET | `/rootfolder` | List root folders with accessibility and free space |
| GET | `/rootfolder/:id` | One root folder |
| POST | `/rootfolder` | Add a root folder |
| DELETE | `/rootfolder/:id` | Remove a root folder |
| GET | `/tag` | List tags |
| GET | `/tag/:id` | One tag |
| POST | `/tag` | Create a tag |
| PUT | `/tag/:id` | Rename a tag |
| DELETE | `/tag/:id` | Delete a tag |
| GET | `/series` | List series (filterable) |
| GET | `/series/:id` | One series with seasons |
| POST | `/series` | Add a series (looks up by `tmdbId` through metadata) |
| PUT | `/series/bulk` | Bulk edit series |
| PUT | `/series/:id` | Update a series |
| PUT | `/series/:id/seasons/:seasonNumber/monitor` | Set a season's monitored flag |
| DELETE | `/series/:id` | Delete a series |
| GET | `/episode` | List episodes (filterable) |
| GET | `/episode/:id` | One episode |
| PUT | `/episode/monitor` | Bulk set episode monitored flag |
| PUT | `/episode/:id` | Update an episode |
| GET | `/movie` | List movies (filterable) |
| GET | `/movie/:id` | One movie |
| POST | `/movie` | Add a movie (looks up by `tmdbId` through metadata) |
| PUT | `/movie/bulk` | Bulk edit movies |
| PUT | `/movie/:id` | Update a movie |
| DELETE | `/movie/:id` | Delete a movie |
| GET | `/mediafile` | List media files |
| GET | `/mediafile/:id` | One media file |
| DELETE | `/mediafile/:id` | Delete a media file record |
| GET | `/wanted/missing/episodes` | Paged monitored episodes without a file |
| GET | `/wanted/missing/movies` | Paged monitored movies without a file |
| GET | `/library/exclusions` | List import exclusions |
| DELETE | `/library/exclusions/:id` | Remove an import exclusion |
| GET | `/library/statistics` | Library counts and sizes |

## profiles

| Method | Path | Purpose |
|---|---|---|
| GET | `/qualityprofile` | List quality profiles |
| GET | `/qualityprofile/schema` | Blank profile template for the UI |
| GET | `/qualityprofile/:id` | One quality profile |
| POST | `/qualityprofile` | Create |
| PUT | `/qualityprofile/:id` | Update |
| DELETE | `/qualityprofile/:id` | Delete |
| GET | `/customformat` | List custom formats |
| GET | `/customformat/schema` | Available spec implementations |
| POST | `/customformat/test` | Test a custom format against a release title |
| GET | `/customformat/:id` | One custom format |
| POST | `/customformat` | Create |
| PUT | `/customformat/:id` | Update |
| DELETE | `/customformat/:id` | Delete |
| GET | `/delayprofile` | List delay profiles |
| PUT | `/delayprofile/reorder` | Reorder delay profiles |
| GET | `/delayprofile/:id` | One delay profile |
| POST | `/delayprofile` | Create |
| PUT | `/delayprofile/:id` | Update |
| DELETE | `/delayprofile/:id` | Delete |
| GET | `/releaseprofile` | List release profiles |
| GET | `/releaseprofile/:id` | One release profile |
| POST | `/releaseprofile` | Create |
| PUT | `/releaseprofile/:id` | Update |
| DELETE | `/releaseprofile/:id` | Delete |
| GET | `/qualitydefinition` | List quality definitions (size limits) |
| PUT | `/qualitydefinition/:qualityId` | Update one definition |

## indexers

| Method | Path | Purpose |
|---|---|---|
| GET | `/indexer` | List indexers |
| GET | `/indexer/schema` | Indexer templates (Torznab, Newznab) |
| GET | `/indexer/categories` | Standard category list |
| GET | `/indexer/status` | Failure/backoff status per indexer |
| POST | `/indexer/test` | Test unsaved indexer settings |
| POST | `/indexer/testall` | Test every saved indexer |
| GET | `/indexer/:id` | One indexer |
| GET | `/indexer/:id/caps` | Capabilities (`?refresh=true` refetches) |
| POST | `/indexer` | Create |
| PUT | `/indexer/:id` | Update |
| DELETE | `/indexer/:id` | Delete |
| GET | `/search` | Manual search across enabled indexers; returns a release list |

## download-clients

| Method | Path | Purpose |
|---|---|---|
| GET | `/downloadclient` | List clients |
| GET | `/downloadclient/schema` | Client templates (qBittorrent) |
| GET | `/downloadclient/:id` | One client (password never returned) |
| POST | `/downloadclient` | Create |
| PUT | `/downloadclient/:id` | Update |
| DELETE | `/downloadclient/:id` | Delete |
| POST | `/downloadclient/test` | Test unsaved client settings |
| POST | `/downloadclient/testall` | Test every saved client |
| GET | `/remotepathmapping` | List remote path mappings |
| GET | `/remotepathmapping/:id` | One mapping |
| POST | `/remotepathmapping` | Create |
| PUT | `/remotepathmapping/:id` | Update |
| DELETE | `/remotepathmapping/:id` | Delete |
| GET | `/queue` | Paged queue of tracked downloads |
| GET | `/queue/status` | Queue totals |
| GET | `/queue/:id` | One queue item |
| DELETE | `/queue/bulk` | Remove several items (body has `ids` and options) |
| DELETE | `/queue/:id` | Remove one item (query options) |
| POST | `/queue/grab/:id` | Retry a pending item |

## Scheduler jobs

Registered through `scheduler.register` (defined in `apps/api/src/scheduler.ts`). Run any
of them with `POST /jobs/run`.

| Job | Cron | Module | What it does |
|---|---|---|---|
| `HealthCheck` | `*/5 * * * *` | health | Evaluates checks, publishes a `health` event |
| `RefreshQueue` | `* * * * *` | download-clients | Polls clients; returns immediately when idle |
| `RssSync` | `*/15 * * * *` | indexers | Fetches RSS from all indexers and dispatches new releases |
| `IndexerStatusCheck` | `0 * * * *` | indexers | Hourly indexer status check |
| `RefreshSeries` | `0 3 * * *` | metadata | Refresh all series from TMDB |
| `RefreshMovie` | `30 4 * * *` | metadata | Refresh all movies from TMDB |

The RSS and status crons can be overridden through `registerIndexerJobs` options.

## WebSocket events

`GET /api/v1/events` upgrades to a WebSocket. Messages are JSON, discriminated on `type`
(`ServerEvent` in `packages/shared/src/events.ts`). Payloads carry ids; clients refetch.

| `type` | Fields |
|---|---|
| `hello` | `serverTime` |
| `job` | `job` (the Job resource) |
| `health` | `health` (HealthResponse) |
| `library` | `action` (`added` `updated` `deleted` `fileAdded` `fileDeleted` `refreshed`), `mediaType` (`series` `movie`), `id` |
| `queue` | `action` (`changed`) |
| `release` | `action` (`grabbed` `rejected` `pending`), `title`, optional `mediaType`, `mediaId` |
| `import` | `action` (`imported` `failed` `manualRequired`), `title`, optional `mediaType`, `mediaId`, `message` |
| `indexer` | `action` (`failed` `recovered`), `id`, `name` |
| `history` | `action` (`added`) |
| `settings` | `section` |

`release`, `import` and `history` are defined in the contract (the file is uncommitted and
being edited), but their producing modules are in progress, so nothing emits them yet.
