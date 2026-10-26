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

1. **Session cookie** `al_session` (from `POST /auth/login` or `POST /setup/admin`):
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
| GET | `/indexer/stats` | `?days=1..90` (default 30): `IndexerStats`, queries / grabs / failures / mean response ms per indexer and per UTC day, plus totals |
| POST | `/indexer/test` | Test unsaved indexer settings (any implementation) |
| POST | `/indexer/testall` | Test every saved indexer |
| GET | `/indexer/:id` | One indexer |
| GET | `/indexer/:id/caps` | Capabilities (`?refresh=true` refetches) |
| GET | `/indexer/:id/download` | `?url=` a result link of that indexer: streams the `.torrent` / `.nzb` as an attachment, or `302` to a magnet. Goes through the indexer (definition login cookies, proxies). Links must be a recent search result or on one of the indexer's hosts (400 otherwise); 404 `UNAVAILABLE` when the indexer no longer has it |
| POST | `/indexer` | Create |
| PUT | `/indexer/:id` | Update |
| DELETE | `/indexer/:id` | Delete |
| GET | `/search` | Manual search across enabled indexers; returns a release list (results stay grabbable for 30 min) |
| POST | `/search/grab` | `SearchGrabRequest` `{guid, indexerId, force?, downloadClientId?}`: re-runs the decision engine on the cached search result and grabs it. No library match → 409 `NO_MATCH` unless `force`, which sends it untracked to the default client of its protocol (unknown in the queue). 404 when the result is no longer cached |
| GET | `/settings/indexers` | `IndexerGlobalSettings`: minimum age, retention, maximum size (shared with `/settings/releases`), RSS interval minutes (0 = off, else 10-1440), hardcoded subs, whitelisted subtitle tags, prefer indexer flags |
| PUT | `/settings/indexers` | Replace them; reschedules `RssSync` immediately |

Indexer implementations are `torznab`, `newznab` and `definition`. A definition indexer's
settings carry `definitionId` and `fields` (values for the definition's `settings` list:
checkboxes boolean, selects an option key, the rest strings; `sitelink` picks a mirror); its
`baseUrl` is the site link in use. Indexers take an optional `proxyId`; without it every proxy
sharing one of the indexer's tags applies. Responses add `definitionName`, `privacy` and
`proxyNames`.

### Definition catalogue

Bundled definitions plus user YAML files in `<config>/definitions/*.yml` (same id overrides a
bundled one; the folder is watched).

| Method | Path | Purpose |
|---|---|---|
| GET | `/indexer/definition` | `IndexerDefinitionSummary[]`, filterable by `privacy`, `protocol`, `language` (prefix) and `query` |
| GET | `/indexer/definition/:id` | `IndexerDefinitionDetail`: summary + search modes, `requiresLogin`, load warnings |
| POST | `/indexer/definition` | `{yaml}`: validate and save a custom definition (201; 400 with the parse error) |
| DELETE | `/indexer/definition/:id` | Delete a custom definition file (404 for bundled ones) |
| POST | `/indexer/definition/reload` | Re-read both folders: `{total, builtin, custom, errors[{file, code, message}]}` |

### Indexer proxies

| Method | Path | Purpose |
|---|---|---|
| GET | `/indexerproxy` | List (`password` masked as `********`) |
| GET | `/indexerproxy/:id` | One proxy |
| POST | `/indexerproxy` | Create `{name, type: flaresolverr\|http\|socks5, host, port, username?, password?, requestTimeout? (s), tags}` |
| PUT | `/indexerproxy/:id` | Partial update; the mask as password keeps the stored one |
| DELETE | `/indexerproxy/:id` | Delete (indexers pointing at it fall back to tag matching) |
| POST | `/indexerproxy/test` | Test an unsaved proxy: FlareSolverr `sessions.list` ping, or an HTTP CONNECT / SOCKS5 tunnel to `url` (default `https://www.google.com/`) |
| POST | `/indexerproxy/:id/test` | Test a saved proxy (`{url?}`) |

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

## requests

Implemented in `apps/api/src/modules/requests` (contract: `packages/shared/src/requests.ts`;
behaviour: `docs/spec/requests.md`). Every route below is open to role `user` (state-changing
ones carry `config.allowUser`); the service enforces the permission bitfield
(`Permission` in the contract). API-key and local-bypass callers act as an admin; when they
create a request without `userId` it is owned by the oldest admin account. Errors are
`{ error, code }` with `403 FORBIDDEN` (permission or quota), `404 NOT_FOUND`,
`409 CONFLICT` (duplicate or wrong state), `400 VALIDATION`, `503 NOT_CONFIGURED` (no TMDB key).

### Requests

| Method | Path | Purpose |
|---|---|---|
| GET | `/request` | `RequestListQuery` (`take`, `skip`, `filter`, `mediaType`, `requestedBy`, `sort`, `sortDirection`) → `RequestPage`. Without `MANAGE_REQUESTS`/`REQUEST_VIEW` only the caller's own; asking for another user's is 403 |
| GET | `/request/count` | `RequestCount` over the requests the caller may see |
| GET | `/request/:id` | One `MediaRequest` (owner, `MANAGE_REQUESTS` or `REQUEST_VIEW`) |
| POST | `/request` | `CreateRequest` → 201 `MediaRequest`, or 202 `{ message }` when every season is already requested/available. Checks permission (`REQUEST`/`REQUEST_MOVIE`/`REQUEST_TV`, 4K variants), quota, duplicates, import exclusions; applies override rules; auto-approves when permitted, globally enabled or a matching rule says so |
| PUT | `/request/:id` | `UpdateRequest` on a pending request (owner or `MANAGE_REQUESTS`; overrides need `REQUEST_ADVANCED`) |
| DELETE | `/request/:id` | `MANAGE_REQUESTS`, or the owner while pending |
| POST | `/request/:id/approve` | `MANAGE_REQUESTS`; optional `ApproveRequest` overrides. Adds the title to the library (series: only the requested seasons monitored) and searches |
| POST | `/request/:id/decline` | `MANAGE_REQUESTS`; optional `{ reason }` |
| POST | `/request/:id/retry` | `MANAGE_REQUESTS`; re-runs a failed approval |
| POST | `/request/bulk/approve` | `BulkRequestAction` → `BulkRequestResult` |
| POST | `/request/bulk/decline` | `BulkRequestAction` → `BulkRequestResult` |

### Discover (TMDB proxy with Arclight status)

Each result is a `DiscoverItem` carrying `mediaStatus`/`mediaStatus4k`, the newest active
request and the library id. `hideAvailable`/`hideRequested` settings filter list pages.

| Method | Path | Purpose |
|---|---|---|
| GET | `/discover/movies` | `DiscoverQuery` → `DiscoverPage` (TMDB discover/movie) |
| GET | `/discover/tv` | `DiscoverQuery` → `DiscoverPage` (TMDB discover/tv) |
| GET | `/discover/trending` | `TrendingQuery` (`mediaType` all/movie/tv, `timeWindow` day/week, `page`) |
| GET | `/discover/upcoming` | `DiscoverKindQuery` (`mediaType` movie/tv): release/first-air date from today |
| GET | `/discover/search` | `DiscoverSearchQuery` (`query`, `page`): movies and series |
| GET | `/discover/genres` | `?mediaType=movie` or `tv` → `DiscoverGenre[]` |
| GET | `/discover/genre/:id` | `DiscoverKindQuery`: titles in a genre |
| GET | `/discover/network/:id` | Series on a network (`title` = network name) |
| GET | `/discover/studio/:id` | Movies by a studio (`title` = studio name) |
| GET | `/discover/keyword/:id` | `DiscoverKindQuery`: titles with a keyword |
| GET | `/discover/person/:id` | `PersonDetail` with annotated cast/crew credits |
| GET | `/discover/movie/:tmdbId` | `TitleDetail`: details, cast, crew, videos, similar, recommendations, requests, flags |
| GET | `/discover/tv/:tmdbId` | `TitleDetail` incl. per-season status |
| GET | `/discover/slider/:id` | `?page`: the items of one slider (`recentlyAdded` needs `RECENT_VIEW`); genre/studio/network list sliders answer 400 (the web renders those from `/discover/genres` and the `POPULAR_STUDIOS`/`POPULAR_NETWORKS` constants) |

### Discover sliders

| Method | Path | Purpose |
|---|---|---|
| GET | `/discoverslider` | All sliders in order (users get enabled ones only) |
| POST | `/discoverslider` | `MANAGE_SETTINGS`: create a custom slider (`DiscoverSliderInput`) |
| PUT | `/discoverslider/order` | `MANAGE_SETTINGS`: `DiscoverSliderOrder` rewrites order and enabled flags |
| POST | `/discoverslider/reset` | `MANAGE_SETTINGS`: delete custom sliders, restore built-in defaults |
| PUT | `/discoverslider/:id` | `MANAGE_SETTINGS`: `DiscoverSliderUpdate` (built-ins: `enabled` only) |
| DELETE | `/discoverslider/:id` | `MANAGE_SETTINGS`: custom sliders only |

### Issues

| Method | Path | Purpose |
|---|---|---|
| GET | `/issue` | `IssueListQuery` → `IssuePage` (own only without `MANAGE_ISSUES`/`VIEW_ISSUES`) |
| GET | `/issue/count` | `IssueCount` |
| GET | `/issue/:id` | One `Issue` with comments |
| POST | `/issue` | `CreateIssue` (`MANAGE_ISSUES` or `CREATE_ISSUES`); the message becomes the first comment; admins notified |
| POST | `/issue/:id/comment` | `IssueCommentInput`: `MANAGE_ISSUES` or the creator → updated `Issue` |
| POST | `/issue/:id/status` | `IssueStatusUpdate` (`open`/`resolved`): creator or `MANAGE_ISSUES` |
| DELETE | `/issue/:id` | `MANAGE_ISSUES`, or the creator while it has one comment |
| PUT | `/issuecomment/:id` | Edit own comment → updated `Issue` |
| DELETE | `/issuecomment/:id` | Author or `MANAGE_ISSUES` |

### Override rules (`MANAGE_SETTINGS`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/overriderule` | All rules |
| POST | `/overriderule` | `OverrideRuleInput` → `OverrideRule` |
| PUT | `/overriderule/:id` | Replace a rule |
| DELETE | `/overriderule/:id` | Delete |

### Watchlist

| Method | Path | Purpose |
|---|---|---|
| GET | `/watchlist` | `?userId` (others need `WATCHLIST_VIEW`) → `WatchlistItem[]` |
| POST | `/watchlist` | `WatchlistCreate`: add to the caller's list (409 duplicate) → 201 `WatchlistItem` |
| DELETE | `/watchlist/:id` | Remove one of the caller's items (`MANAGE_USERS` may remove anyone's) |
| POST | `/watchlist/sync` | Run `WatchlistSync` now (`MANAGE_USERS`) → `WatchlistSyncResult` |

### Users, quotas and settings

| Method | Path | Purpose |
|---|---|---|
| GET | `/user/:id/permissions` | `UserPermissions` (self or `MANAGE_USERS`) |
| PUT | `/user/:id/permissions` | `MANAGE_USERS`; the ADMIN bit follows the role; a non-admin cannot edit an admin |
| GET | `/user/:id/quota` | `UserQuotaResponse` (self or `MANAGE_USERS`) |
| PUT | `/user/:id/quota` | `MANAGE_USERS`: `UserQuota` overrides (null = global default) → `UserQuotaResponse` |
| GET | `/user/:id/requestsettings` | `UserRequestSettings`: personal notification agents, Plex token (masked), watchlist sync (self or `MANAGE_USERS`) |
| PUT | `/user/:id/requestsettings` | Replace them; a masked token keeps the stored one |
| POST | `/user/:id/requestsettings/test` | Send a test through each enabled personal agent → `UserNotificationTestResult` |
| GET | `/settings/requests` | `RequestsSettings` (any signed-in user; the web reads the 4K and partial-request flags) |
| PUT | `/settings/requests` | `MANAGE_SETTINGS`: replace the section |

## subtitles

Module `apps/api/src/modules/subtitles` (spec: `docs/spec/subtitles.md`); contract in
`packages/shared/src/subtitles.ts`. Series and movies carry `languageProfileId` (null = no
subtitles wanted); `POST /series` and `POST /movie` use the subtitles default profile when the
field is omitted, and `PUT /series/:id` / `PUT /movie/:id` accept it. Writes and the settings,
providers and manual-search routes are admin-only.

| Method | Path | Purpose |
|---|---|---|
| GET | `/languageprofile` | List language profiles |
| GET | `/languageprofile/:id` | One profile |
| POST | `/languageprofile` | Create (`LanguageProfileInput`: languages with forced/HI `never`/`also`/`only`, cutoff code or `*`, must(-not)-contain, original format) |
| PUT | `/languageprofile/:id` | Replace a profile |
| DELETE | `/languageprofile/:id` | Delete; series/movies and defaults that used it are cleared |
| GET | `/subtitle/languages` | Language picker options (`code`, `name`) |
| GET | `/subtitle/settings` | `SubtitleSettings`; provider secrets are `********` |
| PUT | `/subtitle/settings` | Replace the settings; the mask keeps a stored secret; credential changes reset auth/config throttles |
| GET | `/subtitle/providers` | Provider form schemas plus status (enabled, configured, throttle with retry time) |
| POST | `/subtitle/providers/test` | `{id, settings}` → `{ok, message}` |
| POST | `/subtitle/providers/reset` | `{onlyAuthOrConfig}` clears throttles |
| GET | `/subtitle/wanted` | `?mediaType=series\|movie&page&pageSize`: files missing profile languages, with last search and attempts |
| GET | `/subtitle/history` | Paged history (`action`, `provider`, `mediaType`, `seriesId`, `movieId`, `mediaFileId` filters) |
| GET | `/subtitle/blacklist` | Paged blacklist |
| POST | `/subtitle/blacklist` | `{subtitleId, search}`: blacklist a downloaded subtitle, delete it, optionally search again |
| DELETE | `/subtitle/blacklist/:id` | Remove one entry |
| DELETE | `/subtitle/blacklist` | Clear the blacklist |
| GET | `/subtitle/file` | `?mediaFileId\|seriesId\|movieId`: per media file, subtitles present (external/embedded, forced, HI, provider, score) and `missing` |
| POST | `/subtitle/scan` | Same scope in the body: rescan disk and embedded streams |
| GET | `/subtitle/search` | `?mediaFileId&language?`: manual search, every candidate with score, matches and a one-hour `key` |
| POST | `/subtitle/download` | `{mediaFileId, key}`: download a manual-search candidate (410 when the key expired) |
| POST | `/subtitle/upload` | multipart: `mediaFileId`, `language`, `forced`, `hi` + one `file` part (5 MB max) |
| POST | `/subtitle/sync/:id` | Run ffsubsync/alass on an external subtitle (manual, ignores thresholds) |
| POST | `/subtitle/extract/:id` | Extract an embedded text track to a file (ffmpeg stream copy) |
| DELETE | `/subtitle/:id` | Delete an external subtitle file |
| POST | `/command/subtitlesearch` | `{seriesId, seasonNumber?}` \| `{episodeIds}` \| `{movieId}` \| `{mediaFileId}`: search now, ignoring backoff |

## Scheduler jobs

Registered through `scheduler.register` (defined in `apps/api/src/scheduler.ts`). Run any
of them with `POST /jobs/run`.

| Job | Cron | Module | What it does |
|---|---|---|---|
| `HealthCheck` | `*/5 * * * *` | health | Evaluates checks, publishes a `health` event |
| `RefreshQueue` | `* * * * *` | download-clients | Polls clients; returns immediately when idle |
| `RssSync` | from Settings → Indexer options (default `*/15 * * * *`; on demand only at 0) | indexers | Fetches RSS from all indexers and dispatches new releases; rescheduled with `scheduler.update` when the interval changes |
| `IndexerStatusCheck` | `0 * * * *` | indexers | Hourly indexer status check |
| `IndexerStatsCleanup` | `20 3 * * *` | indexers | Deletes `indexer_stats` rows older than 90 days |
| `RefreshSeries` | `0 3 * * *` | metadata | Refresh all series from TMDB |
| `RefreshMovie` | `30 4 * * *` | metadata | Refresh all movies from TMDB |
| `RequestsStatusSync` | `*/5 * * * *` | requests | Recomputes media status from the library (plus an optional media-server availability hook), completes requests, sends available notifications |
| `WatchlistSync` | `*/15 * * * *` | requests | Pulls Plex watchlists of users with a token and sync enabled; auto-requests when they hold `AUTO_REQUEST*` |
| `SubtitleSearchWanted` | `*/15 * * * *` | subtitles | Searches wanted subtitles, least recently searched first, up to `search.batchSize` items; adaptive backoff per language; stops when every provider is throttled |
| `SubtitleUpgrade` | `30 3 * * *` | subtitles | Re-searches recent downloads (upgrade window) scoring below perfect; needs old score + 2 |
| `SubtitleScan` | `0 4 * * 0` | subtitles | Re-indexes external and embedded subtitles of every file, prunes orphaned rows |

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
| `request` | `action` (`created` `updated` `approved` `declined` `failed` `completed` `deleted`), `id` |
| `issue` | `action` (`created` `updated` `deleted`), `id` |
| `subtitle` | `action` (`downloaded` `upgraded` `deleted` `uploaded` `synced` `scanned` `blacklisted` `profiles` `settings`), optional `mediaType`, `mediaId`, `mediaFileId` |

`release`, `import` and `history` are defined in the contract (the file is uncommitted and
being edited), but their producing modules are in progress, so nothing emits them yet.

## Compatibility API (Sonarr / Radarr v3)

Implemented in `apps/api/src/modules/compat` (settings contract: `packages/shared/src/compat.ts`).
Third-party tools that speak Sonarr or Radarr (Overseerr/Jellyseerr, Bazarr, Prowlarr, Notifiarr,
Homarr, Recyclarr, LunaSea, nzb360, dashboards) can point at Arclight as if it were either app.
The native `/api/v1` API is unaffected.

**Mounting.** `compatApi(ctx)` is registered at the root (not inside `/api/v1`) and serves
`/api/v3/*` plus the probes `/api`, `/ping`, `/initialize.json`, `/initialize.js`. It installs the
same auth hook as `/api/v1` (`installAuthHook` with its own public-route predicate) on its own
encapsulated scope, so the same credentials work: `X-Api-Key` header, `?apikey=`, session cookie,
Basic, and the local bypass. Only the four probes are public (`/initialize.json` never contains
the API key). `compatModule` adds `GET/PUT /api/v1/settings/compat`.

**One prefix, both shapes.** Both apps use `/api/v3`, so resources are split:

| Shape | Resources |
|---|---|
| Sonarr | `series` (+ `/lookup`), `episode` (+ `/monitor`), `episodefile`, `calendar`, `wanted/missing`, `wanted/cutoff` |
| Radarr | `movie` (+ `/lookup`, `/lookup/tmdb`, `/lookup/imdb`), `moviefile`, `collection` |
| Sonarr + harmless Radarr fields | `qualityprofile`, `qualitydefinition` (+ `/update`), `customformat`, `delayprofile`, `releaseprofile`, `rootfolder`, `tag`, `language`, `languageprofile`, `indexer` (+ `/schema`, `/test`, `/testall`), `downloadclient`, `notification`, `importlist`, `history` (+ `/since`, `/series`, `/movie`), `blocklist` (+ `/bulk`), `queue` (+ `/status`, `/details`, `/bulk`), `command`, `release` (+ `/push`), `system/status`, `system/task`, `system/backup`, `health`, `diskspace`, `filesystem`, `update`, `config/host`, `config/naming`, `config/mediamanagement`, `config/ui` |

Movie rows in shared resources (history, queue, blocklist) carry `movieId` and Radarr event names
(`movieFileDeleted`), with `seriesId`/`episodeId` set to 0 so Sonarr-only clients do not choke.

**Writes supported:** series and movies (POST add by `tvdbId`/`tmdbId`/`imdbId` with
`addOptions`, PUT, DELETE with `deleteFiles` / `addImportListExclusion` / `addImportExclusion`),
episode monitoring, episode/movie file delete, root folders, tags, quality profiles (POST/PUT,
Recyclarr-style items/groups/formatItems), quality definitions, indexers (Prowlarr application
sync: Torznab/Newznab `fields[]`, masked `apiKey` keeps the stored key, seed times in minutes),
queue removal (`removeFromClient`, `blocklist`, `skipRedownload`), blocklist delete, interactive
grab (`POST /release`), release push, commands.

**Paging.** `page, pageSize, sortKey, sortDirection` (`ascending`/`descending`/`default`) on
`queue`, `history`, `blocklist`, `wanted/*`; responses are
`{page, pageSize, sortKey, sortDirection, totalRecords, records}`.

**Commands.** `POST /api/v3/command {name, ...}` returns a CommandResource whose `id` is a row in
the `jobs` table; `GET /command/:id` reads it back (`queued/started/completed/failed/cancelled`).

| Command | Runs |
|---|---|
| `SeriesSearch` `{seriesId}`, `SeasonSearch` `{seriesId, seasonNumber}`, `EpisodeSearch` `{episodeIds}`, `MoviesSearch` `{movieIds}` | user-invoked release search + grab |
| `MissingEpisodeSearch`, `MissingMoviesSearch`, `CutoffUnmetEpisodeSearch`/`CutoffUnmetMoviesSearch`, `RssSync` | the scheduler job of the same purpose |
| `RefreshSeries` / `RefreshMovie` (with ids: those items; without: the full refresh job) | metadata refresh |
| `RescanSeries` / `RescanMovie` | imports rescan |
| `RenameFiles`, `RenameSeries`, `RenameMovie` | imports rename |
| `DownloadedEpisodesScan`, `DownloadedMoviesScan`, `RefreshMonitoredDownloads` | `RefreshQueue` job |
| `ManualImport` `{files, importMode}` | imports manual import |
| anything else naming a registered job (`HealthCheck`, ...) | that job; unknown names answer 400 |

**System status and versions.** `system/status` reports `appName: "Arclight"`,
`instanceName` (setting), the real Arclight `version`, plus `isProduction`, `branch`,
`startupPath`, `urlBase`, `appData`, `osName`, `runtimeVersion`, `authentication`,
`migrationVersion`. Overseerr/Jellyseerr check `version` loosely (presence; the major decides
v3/v4 behaviour). Every compat response also carries `X-Application-Version`
(setting `advertisedVersion`, default `4.0.4.0`), which Prowlarr requires to be at least the
Sonarr/Radarr minimum before it syncs.

**Settings** (`compat` section, `GET/PUT /api/v1/settings/compat`): `enabled` (default true;
false makes every compat route and probe answer 404), `instanceName` (default `Arclight`),
`advertisedVersion`.

**Errors.** 404 `{message}`; 400 is an array of `{propertyName, errorMessage, severity}` (e.g.
`This series has already been added`); other failures `{message}`.

**Known gaps.**

- SignalR (`/signalr/messages`) is not emulated: clients that wait for push updates fall back to
  polling or show stale state. The native WebSocket is `/api/v1/events`.
- `calendar` and `wanted/missing` are episode-only (Sonarr shape); Radarr's movie calendar is not
  served on the shared path.
- Lookups are TMDB-backed: `tvdbId` is 0 unless TMDB knows it; `tvdb:` lookups go through TMDB's
  external-id search. TV Rage / TV Maze ids are always 0; `airTime` is UTC, not network time.
- Read-only: `customformat`, `delayprofile`, `releaseprofile`, `downloadclient`, `notification`,
  `importlist`, `config/*`, `system/backup` (always empty). Their writes go through `/api/v1`.
- Root folders list both series and movie folders (with an extra `mediaType`); a POST without a
  media type guesses from the path (`movie`/`film` means movies).
- `POST /indexer/test` validates the body only; it does not contact the indexer.
- Stored indexer base URLs are normalised (trailing slash dropped), so Prowlarr may report a
  difference and re-send the indexer on its next sync.
- Queue records expand multi-episode downloads into one record per episode (ids encode the
  download); queue quality comes from the grab's history row.
- Custom format specification values are best-effort upstream encodings; `languageprofile` is a
  single fixed "Any" profile for Sonarr v3 clients.
