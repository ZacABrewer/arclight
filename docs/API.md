# API reference

Compiled from the `routes.ts` and `index.ts` files in `apps/api/src/modules/*` on
2026-10-26. Request and response schemas live in `packages/shared/src/*.ts`. All paths are
prefixed with `/api/v1`. Every route requires authentication unless listed as public in
[Authentication](#authentication).

Some modules (releases, imports, notifications) are not fully listed here yet; history,
blocklist and calendar are.

Module registration order (`apps/api/src/app.ts`): `installMetrics` on the root instance first
(its hooks see every route; `GET /metrics` at the root), then under `/api/v1` the auth hook,
then the audit hook (`installAudit`), then the modules: system, logs, health, jobs, events,
settings, config (applies `ARCLIGHT_CONFIG_FILE` / `ARCLIGHT_SETTING__*` while registering,
before any `onReady`), backup, metadata, library, profiles, guides, indexers, solver,
download-clients, history, blocklist, releases, import-lists, imports, scene-mapping,
notifications, media-servers (moves a legacy `mediaServer` value into the list once),
retention, media-analysis, transcode, library-hygiene, stats, updates, push (bus listener on),
subtitles, requests, discord-bot, calendar, compat, migrate, vpn, torrent, tracker-stats,
cross-seed, engine-agent, auth, audit, metrics. The Sonarr/Radarr-shaped compat API mounts at
the root afterwards. Cross-module hooks resolve their target lazily, so the order only matters
for readability: the releases engine asks tracker-stats for its freeleech-only filter through
`ReleasesDeps.releaseFilter` (rejection `notFreeleech`, wired in `wiring.ts`), and health gets
`whisper` from the subtitles module for the WhisperUnreachable check.

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
`GET /auth/status`, `POST /auth/plex/pin`, `POST /auth/plex/poll`, `GET /system/ping`, `GET /calendar/feed.ics` (checks its own `token`),
and `/setup/*` (which guard themselves: writes need the admin once one exists, and answer
409 `SETUP_COMPLETE` after setup). The SPA's static files are outside `/api/v1`.
A GET route may also be public conditionally: `config: { publicWhen: (req) => boolean }` is
evaluated per request (the public request portal uses it for `GET /public/portal`,
`GET /discover/*` and `GET /discoverslider`); the route still sees `req.auth` when credentials
were sent. `GET /auth/status` carries `mediaServerLogin: {kind, name?} | null`, the first
enabled media server with `loginEnabled` (the login page shows the Jellyfin/Emby selector or the
Plex button from it). `PUT /user/me` ignores the manager-owned settings keys
`ADMIN_MANAGED_USER_SETTINGS` (`quota`, `contentRestrictions`, `approvalPolicy`, `discordUserId`).

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
| POST | `/auth/login` | public | `{method?, username, password, rememberMe?}` → `Session`; sets the cookie. `method` (`LoginMethod`): `local` (default) checks Arclight's password; `jellyfin`/`emby`/`mediaServer` sign in against Settings > Media server (`AuthenticateByName`), creating a local `user` with the default permissions of Settings > Requests on first sign-in (`createUsersOnLogin`). 401 `INVALID_CREDENTIALS`, 400 (not configured / wrong kind), 403 (login disabled, account disabled), 429 |
| POST | `/auth/plex/pin` | public | Plex sign-in step 1 → `PlexPin` `{id, code, authUrl}`; open `authUrl` in a popup (requests module) |
| POST | `/auth/plex/poll` | public | `PlexPollRequest` `{id, rememberMe?}` → 202 `{pending: true}` until approved, then `Session` + cookie. Allowed for accounts already linked, or (Plex server configured, `createUsersOnLogin`) accounts that can reach that server; 403 otherwise |
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
| GET | `/system/feeds` | `{feeds: FeedSummary[]}`: self-updating data feeds (`guides`, `definitions`, placeholder `updates`, plus anything registered through `feedsRegistry(ctx)` in `apps/api/src/feeds.ts`) with `state` `ok`/`stale`/`error`/`never`/`disabled`/`unregistered`, interval, last sync/success/error, pending count |

Feeds are stale after 3 intervals without a success (a feed that never succeeded counts from
when it was registered); the `FeedStale` health check reports stale feeds as warnings.

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
| GET | `/settings/releases` | Decision-engine knobs (max size, minimum age, retention, season packs, availability delay, unaired, `decisionLogDays` (default 14) for the release decision log) |
| PUT | `/settings/releases` | Replace the releases settings section |

## metadata

| Method | Path | Purpose |
|---|---|---|
| GET | `/metadata/search` | Search TMDB for series or movies (`query`, `type`) |
| GET | `/metadata/series/:tmdbId` | Full series metadata from TMDB |
| GET | `/metadata/movie/:tmdbId` | Full movie metadata from TMDB |
| POST | `/command/refresh` | Refresh metadata on demand. Body `RefreshCommand`: exactly one of `{seriesId}`, `{movieId}` or `{all: true}`, plus optional `rescan: true` (re-read the folder from disk afterwards through the imports module). Answers **202** with the started `Job` (status `running`); the outcome arrives as a `job` WebSocket event and in `GET /jobs`. 400 for a bad body, 404 for an unknown id (no job is started) |

**On-demand jobs.** Per-item refreshes, redownloads and library searches run as *ad-hoc jobs*
(`Scheduler.runTask`): each gets a `jobs` row and `job` events like a scheduled job, but it is
not registered, so it is not in `GET /jobs/scheduled` and cannot be started with
`POST /jobs/run`. Names: `RefreshSeriesItem`, `RefreshMovieItem` (one at a time per item or id
set; a single-item refresh that fails is a `failed` job carrying the reason), `RefreshLibrary`
(`{all: true}`: all series, then all movies, then an optional full rescan), `HistoryRedownload`,
`SeriesSearch`, `MovieSearch`.

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
| POST | `/series` | Add a series (looks up by `tmdbId` through metadata); `searchOnAdd: true` queues a `SeriesSearch` job for it |
| PUT | `/series/bulk` | Bulk edit series: `ids` plus any of `monitored` (+ `monitorOption`), `monitorNewItems`, `qualityProfileId`, `seriesType`, `seasonFolder`, `rootFolderPath`, `tags: {add?, remove?}`; `refresh: true` queues a `RefreshSeriesItem` job for the ids and `search: true` a `SeriesSearch` job (user-invoked search per series), both after the update commits. Answers the updated series. 400 when refresh/search are asked for but the commands are not wired (nothing is changed); unknown ids 404, unknown tags or root folder 400 |
| PUT | `/series/:id` | Update a series |
| PUT | `/series/:id/seasons/:seasonNumber/monitor` | Set a season's monitored flag |
| DELETE | `/series/:id` | Delete a series |
| GET | `/episode` | List episodes (filterable) |
| GET | `/episode/:id` | One episode |
| PUT | `/episode/monitor` | Bulk set episode monitored flag |
| PUT | `/episode/:id` | Update an episode |
| GET | `/movie` | List movies (filterable) |
| GET | `/movie/:id` | One movie |
| POST | `/movie` | Add a movie (looks up by `tmdbId` through metadata); `searchOnAdd: true` queues a `MovieSearch` job for it |
| PUT | `/movie/bulk` | Bulk edit movies: `ids` plus any of `monitored`, `qualityProfileId`, `minimumAvailability`, `rootFolderPath`, `tags: {add?, remove?}`, `refresh: true` (`RefreshMovieItem` job), `search: true` (`MovieSearch` job); same rules as `/series/bulk` |
| PUT | `/movie/:id` | Update a movie |
| DELETE | `/movie/:id` | Delete a movie |
| GET | `/mediafile` | List media files |
| GET | `/mediafile/:id` | One media file |
| DELETE | `/mediafile/:id` | Delete a media file record |
| GET | `/wanted/missing/episodes` | Paged monitored episodes without a file |
| GET | `/wanted/missing/movies` | Paged monitored movies without a file |
| GET | `/wanted/cutoff/episodes` | Paged (`page`, `pageSize`, `includeSpecials`) monitored episodes of monitored series whose file has not met cutoff, as `WantedEpisodesPage` |
| GET | `/wanted/cutoff/movies` | Paged (`page`, `pageSize`) monitored movies whose file has not met cutoff, as `WantedMoviesPage` |

**Cutoff.** A file meets cutoff when, under its series' or movie's *current* quality profile,
its quality reaches the profile cutoff **and** its custom-format score reaches the format cutoff
(`cutoffFormatScore`, or `minFormatScore` when upgrades are off). The score comes from matching
the profile's custom formats against the file (scene name or relative path, quality, languages,
size, release group, edition). Files whose parent or profile is gone count as met. The same
checker (`library/cutoff.ts`, `createCutoffChecker`) drives the `CutoffUnmetSearch` job, so the
job searches exactly what these routes list.

**Multi-version library.** A series or movie may carry `versions`:
`[{ tag, qualityProfileId, enabled }]` (`MediaVersions`: at most 8, unique tags, no path
characters), set on `POST`/`PUT /series` and `/movie`; `null` or `[]` means unversioned
(one file per episode/movie, the classic behaviour). Each enabled slot is monitored, searched and
upgraded on its own against its own profile; a disabled slot keeps its file but is never wanted.

- `media_files.version_tag` records the slot a file fills; one file per (movie, tag) and per
  (episode, tag) (series links live in `episode_version_files`). An untagged file on a versioned
  item belongs to the first configured slot.
- `Episode`/`Movie` expose `files[]` (`{id, versionTag, quality, sizeBytes, relativePath}`,
  primary first); `hasFile` is true when any version exists; `episodeFileId`/`movieFileId` point
  at the primary file (untagged, else the first configured slot). `MediaFile.versionTag`.
- `/wanted/missing/*` and `/wanted/cutoff/*` work per slot: a versioned item is listed while
  any enabled slot is empty / below its own profile's cutoff, with `wantedVersions: string[]`.
- Releases: a release is evaluated against the enabled slot whose profile fits it best (allowed,
  then nearest the cutoff, then format score, then config order) and only competes with that
  slot's file, queue and history; `ReleaseDecision.versionTag` says which. One grab per slot.
- Imports: a file goes into the best-fitting slot and replaces only that slot's file
  (`ManualImportRequestItem.versionTag` pins it). Naming: `{Version}` token; setting
  `naming.versionLayout`: `sideBySide` (default, appends ` - <tag>` when the format has no
  `{Version}`) or `subfolder` (`<folder>/<tag>/<file>`).
- Requests: the 4K track maps to slot `4K` (an item already in the library keeps its copy as
  slot `Standard`); a file in slot `4K` makes the 4K track available.
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

`CustomFormat` responses carry `guideId` (read-only): the TRaSH `trash_id` the format is synced
from by the guides module, null for user-created formats.

## guides

TRaSH-style sync of custom formats and quality-profile scores from a guide repository
(`GuidesSettings`, settings section `guides`). The guide's `metadata.json` names the
custom-format and quality-profile folders per app; GitHub-hosted repos are listed through the
contents API (`api.github.com/repos/<owner>/<repo>/contents/<dir>?ref=<branch>`), files are read
from `raw.githubusercontent.com`; other hosts must serve `<dir>/index.json` (a JSON array of file
names). Responses are cached in `guides_cache` (ETag revalidation; files whose git blob sha is
unchanged are not downloaded). Synced formats = formats the mapped guide profiles list plus
`includeFormats` globs, minus `excludeFormats` (names or trash ids, `*`/`?`). A sync never deletes
a format and never changes a user-created one unless its `adoptFormat` item is applied by id.
Changes are announced as an `applicationUpdate` notification (`previousVersion`/`newVersion` =
`guides <revision>`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/guides/status` | `GuidesStatus`: settings summary, last sync/success/error/apply, pending count, last fetch stats, synced format count |
| GET | `/guides/diff` | The pending `GuidesDiff`: `items` (`createFormat`, `updateFormat`, `adoptFormat`, `setScore`; stable ids `format:<trashId>` / `score:<profileId>:<trashId>`), `staleFormats` (synced formats the guide dropped; never deleted), `warnings` |
| POST | `/guides/sync` | Fetch + diff now; mode `notify` stores the diff, mode `apply` applies it (`adoptFormat` stays pending). `GuidesSyncResult`; 502 `UPSTREAM` when the guide is unreachable |
| POST | `/guides/apply` | `{ids?}`: apply the pending diff or a subset; without ids everything except `adoptFormat`. Idempotent. `GuidesApplyResult` (`applied`, `skipped[{id, reason}]`, counts, `pendingCount`) |
| GET | `/guides/profiles` | `GuideProfileInfo[]`: quality profiles the guide offers (score set, formats, `mappedTo`); `?refresh=true` refetches the profile files |
| GET | `/settings/guides` | `GuidesSettings`: `enabled` (false), `source` `trash`/`custom`, `repoUrl`, `branch` (`master`), `apps` (`["radarr"]`), `syncIntervalHours` (24), `mode` `notify`/`apply`, `profiles[{guideProfileName, localQualityProfileId, app?}]`, `includeFormats`, `excludeFormats`, `scoreAllSyncedFormats` (true) |
| PUT | `/settings/guides` | Replace the section; reschedules `GuidesSync` |

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

Three layers, later ones overriding earlier ones by id: bundled definitions, the definition
feed's downloads in `<config>/definitions/feed/`, user YAML files in `<config>/definitions/*.yml`
(watched). `source` in summaries is `builtin`, `feed` or `custom`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/indexer/definition` | `IndexerDefinitionSummary[]`, filterable by `privacy`, `protocol`, `language` (prefix) and `query` |
| GET | `/indexer/definition/:id` | `IndexerDefinitionDetail`: summary + search modes, `requiresLogin`, load warnings |
| POST | `/indexer/definition` | `{yaml}`: validate and save a custom definition (201; 400 with the parse error) |
| DELETE | `/indexer/definition/:id` | Delete a custom definition file (404 for bundled ones) |
| POST | `/indexer/definition/reload` | Re-read the folders: `{total, builtin, feed, custom, errors[{file, code, message}]}` |

### Definition feed

Settings `indexers.definitionFeed` (`DefinitionFeedSettings`): `enabled` (true), `url` (default
`https://raw.githubusercontent.com/zacheryabrewer/arclight/main/packages/indexers/src/definitions/builtin/`,
this repository's builtin folder; owner/repo are `ARCLIGHT_GITHUB_*` in
`packages/shared/src/project.ts`), `intervalHours` (12), `mode` `auto`/`manual`. While the
default feed's `index.json` answers 404 (repository not published yet) a sync succeeds with no
changes and the feed reports `state: never` with detail "feed not published yet" instead of an
error or a stale-feed warning; any other URL's 404 is an error as before. The feed serves `index.json` = `{schemaVersion: 1, definitions: [{id, version,
file, sha256}]}` (`sha256` over the UTF-8 text with CRLF normalised to LF) and the files it names,
relative to `url`. Changed entries are downloaded, verified (sha256, package parser, id) and
installed into `<config>/definitions/feed/`; the replaced version is kept in `feed/.previous/`;
entries no longer listed are removed; the catalogue is reloaded and an `applicationUpdate`
notification sent. Rejected entries keep the installed version. The bundled set is published in
the same format as `packages/indexers/src/definitions/builtin/index.json`
(`node scripts/build-definition-index.mjs`, `--check` to verify), so the repository can serve as
its own feed.

| Method | Path | Purpose |
|---|---|---|
| GET | `/indexer/definition/feed/status` | `DefinitionFeedStatus`: settings, last sync/success/error, index schemaVersion, installed (`version`, `sha256`, `previousVersion`, `active` = not overridden by a user file), `rejected[{id, version, reason}]` |
| POST | `/indexer/definition/feed/sync` | Sync now: `{notModified, added, updated, removed, unchanged, rejected}`; 502 `UPSTREAM` when the index cannot be read or is invalid |
| POST | `/indexer/definition/feed/rollback/:id` | Restore the kept previous version (the rolled-back version is skipped until the feed publishes a different one); 404 not a feed definition, 400 no previous version |
| GET | `/indexer/definition/feed/settings` | `DefinitionFeedSettings` |
| PUT | `/indexer/definition/feed/settings` | Replace them; reschedules `IndexerDefinitionFeedSync` |

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
| GET | `/queue/:id` | One queue item (with `stateCode` / `stateReason` / `stateSeverity`, `stalledSince`, `live` rates and peers) |
| GET | `/queue/:id/timeline` | What happened to the download (grabbed, paused by the kill switch, stalled, imported, ...), oldest first; kept 30 days, also after it left the queue |
| DELETE | `/queue/bulk` | Remove several items (body has `ids` and options) |
| DELETE | `/queue/:id` | Remove one item (query options) |
| POST | `/queue/grab/:id` | Retry a pending item |
| POST | `/queue/:id/limits` | `{ downloadLimit?, uploadLimit? }` in bytes/s (0 = unlimited) for one download; built-in engine (kept in its resume data) and qBittorrent. Returns the queue item; 409 when the client cannot |
| POST | `/queue/:id/move` | `{ move: top / up / down / bottom }`: download queue order (built-in engine; qBittorrent with torrent queueing on) |
| POST | `/queue/:id/forcestart` | `{ enabled }`: run past the active-download limit without taking a slot |

Queue items' `live` block carries `downloadLimit`, `uploadLimit`, `queuePosition` (1-based among
unfinished downloads) and `forceStart` when the client reports them.

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
| POST | `/request/:id/approve` | `MANAGE_REQUESTS` (admins included). Optional `ApproveRequest` overrides: `rootFolderPath`, `qualityProfileId`, `tags` (stored on the request), `monitorOption` (series: applied when the series is added, or re-applied to an existing one; the requested seasons are always monitored too), `minimumAvailability` (movies), `seasons: number[]` (series: replaces the requested seasons, checked like `PUT /request/:id`). Series-only fields on a movie request (and `minimumAvailability` on a series) answer 400 and leave the request pending. Adds the title to the library and searches when the settings say so |
| POST | `/request/:id/decline` | `MANAGE_REQUESTS`; optional `{ reason }` |
| POST | `/request/:id/retry` | `MANAGE_REQUESTS`; re-runs a failed approval |
| GET | `/request/:id/policy` | Owner, `MANAGE_REQUESTS` or `REQUEST_VIEW` → `RequestPolicyExplanation` `{decision: approve/hold/pending, held, estimatedSizeBytes, nextWindowAt, steps[{rule, outcome, message}]}`: the auto-approval chain (permission, settings, override rule, user override, size, budgets, windows) evaluated now with the stored size estimate |
| POST | `/request/bulk/approve` | `BulkRequestAction` → `BulkRequestResult` |
| POST | `/request/bulk/decline` | `BulkRequestAction` → `BulkRequestResult` |

### Approval policies

Evaluated in `POST /request` after the permission, global `autoApprove` and override-rule
checks, only when none of them approved (`RequestsSettings`):

- `autoApproveIfSizeBelowGb` (GB = GiB; null off): approve when the best approved release is
  smaller. The size comes from a quick interactive search (`releases.interactiveSearch`, 20 s
  timeout; series: the sum over the requested seasons) and only for titles already in the
  library; otherwise the size is unknown and the rule is skipped. It is stored on the request
  (`media_requests.estimated_size_bytes`) and only searched for when a policy needs it.
- `approvalBudgets[] {scope: user|role|all, role?, userIds?, movieGb?, tvSeasons?, periodDays,
  autoApproveUnder: {sizeGb?}}`: approve while the scope's approved/completed usage of the last
  `periodDays` plus this request fits (`movieGb`: estimated sizes of movie requests, unknown
  sizes count 0, the request itself must have a size; `tvSeasons`: seasons). `user`: per user
  (optionally only `userIds`); `role`: per role (optionally only `role`); `all`: shared. Any
  applicable budget with room approves.
- `approvalWindows[] {days 0-6, startHour, endHour (exclusive; <= start wraps midnight), action}`
  in server local time. Inside an `autoApprove` window every request is approved; with such
  windows configured, requests outside them are **held** (`pending`, `heldByPolicy: true`,
  `media_requests.policy_hold = 'window'`) until one opens. Inside a `hold` window nothing is
  auto-approved; requests that would have been are held until it closes.
- Per-user override (`users.settings.approvalPolicy`, shown on the user resource, set through
  `PUT /user/:id/permissions`): `autoApprove` inherit/always/never, `autoApproveIfSizeBelowGb`
  (replaces the global one), `budgetExempt` (neither limited by nor counted in budgets).

Policy approvals have no human approver (`modifiedBy: null`). Job `RequestsPolicySweep`
(hourly) re-evaluates held requests: approves (and sends to the library) those the policies now
approve, and releases those no window holds any more to plain pending. Manual approve/decline
clears the hold.

### Content caps (kids accounts)

`users.settings.contentRestrictions` (`ContentRestrictions`, set by `MANAGE_USERS` through
`PUT /user/:id/permissions`): `maxCertification.movie` G/PG/PG-13/R/NC-17/NR and
`maxCertification.tv` TV-Y/TV-Y7/TV-G/TV-PG/TV-14/TV-MA (null = no cap), `hideAdultContent`
(hides NC-17 movies and TV-MA series). Certifications are TMDB's (metadata region, else US),
cached per title for a day (failed lookups for a minute). A title without a known US rating
counts as unrated: only a movie cap of NR admits it, a TV cap never does. Capped users see
discover lists, sliders, similar/recommended titles and person credits filtered; title pages
above the cap answer 403; `POST /request` (also on their behalf) answers 403 with the reason.
Public-portal visitors get `hideAdultContent`.

### Public request portal

`RequestsSettings.publicPortal {enabled, allowAnonymousDiscover, message}`. While enabled,
`GET /public/portal` → `PublicPortal {enabled, title, applicationUrl, message,
allowAnonymousDiscover, loginMethods {local, mediaServer {kind, name?} | null, plex}}` is
public (signed-in callers may always read it). With `allowAnonymousDiscover` too, every
`GET /discover/*` route and `GET /discoverslider` answer anonymous visitors (as a user without
permissions: `canRequest: false`, no requests or watchlist). Anonymous calls are rate-limited
per client IP by a token bucket (burst 30, 1 token / 2 s) answering
`429 {code: "RATE_LIMITED"}` with `Retry-After`; signed-in callers are not limited.
Requesting always needs sign-in.

### Discover (TMDB proxy with Arclight status)

Each result is a `DiscoverItem` carrying `mediaStatus`/`mediaStatus4k`, the newest active
request and the library id. `hideAvailable`/`hideRequested` settings filter list pages; content
caps filter them per user (see above).

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

Sync sources: the plex.tv watchlist (user's `plexToken`) and, for users linked to the
Jellyfin/Emby server of Settings > Media server, that account's **favourite** movies and series
(`/Users/{id}/Items?Filters=IsFavorite`, read with the link's token or the server API key).
Items mirror into the list with `source` `plex`/`jellyfin`/`emby`; items no longer listed
leave it. Auto-requests need `autoRequestFromWatchlist` (default on), `AUTO_REQUEST*` and the
per-type `watchlistSyncMovies`/`watchlistSyncSeries` flag.

### Media server (compatibility view over `mediaServers`)

One Jellyfin, Emby or Plex server used for sign-in, user import, links and favourites. Since the
consolidation this is a **view** over the [media-servers](#media-servers) list: the first enabled
server flagged `loginEnabled`, else the first enabled server. `PUT /settings/mediaserver` writes
into the list (updates that server in place keeping its purpose flags, or appends one with
`usedForAvailability`; `kind: null` turns login off on it, or removes it when it is not used for
retention or refresh). Availability uses every listed server flagged `usedForAvailability`
(falling back to the Jellyfin/Emby notification connections when the list has none).
Contract: `MediaServerSettings` `{kind: 'jellyfin'|'emby'|'plex'|null, url, apiKey, name,
loginEnabled, createUsersOnLogin}`; `apiKey` is an API key (Plex: owner X-Plex-Token) and reads
back as `********` (send it back to keep it). Links are stored in the user's settings JSON as
`mediaServerLink` `{kind, externalId, username, accessToken (masked on read), deviceId, linkedAt}`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/settings/mediaserver` | `MANAGE_SETTINGS` → `MediaServerSettings` (masked) |
| PUT | `/settings/mediaserver` | `MANAGE_SETTINGS`: replace the section (URL must be http(s)) |
| POST | `/settings/mediaserver/test` | `MANAGE_SETTINGS`; optional body = unsaved settings → `MediaServerTestResult` (`System/Info` / Plex `identity`) |
| POST | `/user/:id/mediaserver/link` | Self or `MANAGE_USERS`. `{username, password}` (Jellyfin/Emby `AuthenticateByName`) or `{pinId}` (a completed Plex PIN; also sets `plexToken`) → `UserRequestSettings`. 403 bad credentials, 409 account linked to another user |
| DELETE | `/user/:id/mediaserver/link` | Self or `MANAGE_USERS`: remove the link → `UserRequestSettings` |
| POST | `/user/me/mediaserver/plex/pin` | Signed-in user: start a Plex PIN for linking (no sign-in) → `PlexPin` |
| POST | `/user/me/mediaserver/plex/poll` | Signed-in user, `{id}`: 202 `{pending: true}` until approved, then links the Plex account to the caller (stores the token and `plexToken`; no new session) → `UserRequestSettings`; 409 when linked to another user |
| GET | `/user/import/mediaserver` | `MANAGE_USERS` → `MediaServerUser[]` (Jellyfin/Emby users, or Plex friends) with `linkedUserId` |
| POST | `/user/import/mediaserver` | `MANAGE_USERS`: `MediaServerImportRequest` `{externalIds?}` (absent = all) → `MediaServerImportResult`; creates linked `user`s with default permissions, skips linked/disabled ones |
| POST | `/request/digest` | `MANAGE_REQUESTS`: send the admin digest now → `RequestsDigestResult` |

**Availability** (`RequestsSettings.useMediaServerAvailability`): `RequestsStatusSync` asks the
media server (falling back to the Jellyfin/Emby connections under Settings > Notifications when
none is configured). Jellyfin/Emby: items by `Tmdb`/`Tvdb` provider id, episodes counted per
season (virtual episodes ignored, multi-episode files count each episode). Plex: movie/show
libraries indexed by guid (cached 5 minutes), seasons by `leafCount`. The normal track is then
available only when the server has it (series: every requested season with all aired episodes);
library files the server lacks show as `processing`; a server that cannot answer completes
nothing. 4K stays library-based. `MediaRequest.availableOn` names the server (Settings name, or
Jellyfin/Emby/Plex). With no server at all the library decides, as before.

### Users, quotas and settings

| Method | Path | Purpose |
|---|---|---|
| GET | `/user/:id/permissions` | `UserPermissions {permissions, contentRestrictions, approvalPolicy}` (self or `MANAGE_USERS`) |
| PUT | `/user/:id/permissions` | `MANAGE_USERS`; the ADMIN bit follows the role; a non-admin cannot edit an admin. `contentRestrictions` / `approvalPolicy` are optional (absent: unchanged) |
| GET | `/user/:id/quota` | `UserQuotaResponse` (self or `MANAGE_USERS`) |
| PUT | `/user/:id/quota` | `MANAGE_USERS`: `UserQuota` overrides (null = global default) → `UserQuotaResponse` |
| GET | `/user/:id/requestsettings` | `UserRequestSettings`: personal notification agents, Plex token (masked), watchlist sync, `autoRequestFromWatchlist`, `mediaServerLink` (token masked) (self or `MANAGE_USERS`) |
| PUT | `/user/:id/requestsettings` | Replace them; a masked token keeps the stored one; `mediaServerLink` is ignored (use the link routes) |
| POST | `/user/:id/requestsettings/test` | Send a test through each enabled personal agent → `UserNotificationTestResult` |
| GET | `/settings/requests` | `RequestsSettings` (any signed-in user; the web reads the 4K and partial-request flags) |
| PUT | `/settings/requests` | `MANAGE_SETTINGS`: replace the section |

`RequestsSettings` also carries `applicationUrl` (public URL used for links in
notifications), `digestEnabled` and `digestHour` (0-23, server local time), and
`approvalBudgets`, `approvalWindows`, `autoApproveIfSizeBelowGb`, `publicPortal` (above).

### Sitewide request notifications

Notification connections (`/notification`) have six more trigger flags: `onRequestCreated`,
`onRequestApproved`, `onRequestDeclined`, `onRequestAvailable`, `onIssueCreated`,
`onIssueUpdated` (with matching `supportsOn*` capabilities; chat agents, webhook and custom
script support them, media servers do not). The requests module dispatches every request and
issue event to the notifications service, which delivers it to enabled connections with the
flag (personal per-user agents keep working as before). With `applicationUrl` set, events carry
deep links: pending requests get Approve (`/requests/:id?action=approve`), Decline
(`?action=decline`) and View (`/requests/:id`) actions, issues link to `/issues/:id`. Discord
renders them as an Actions field plus a "Requested by" footer with the requester's avatar and
the poster as thumbnail; Telegram as inline links; ntfy as action buttons; Gotify as markdown
links; email/Pushover in the body (Pushover's URL = the request); webhooks get an `actions`
array next to the raw event. The `requestsDigest` event (job `RequestsDigest`) goes to
connections with `onRequestCreated` or `onIssueCreated`.

## media-servers

Module `apps/api/src/modules/media-servers`; contract `packages/shared/src/media-servers.ts`;
clients `@arclight/media-servers`. A **list** of Jellyfin/Emby/Plex connections stored in the
`mediaServers` settings section (`MediaServersSettings {servers: MediaServerConfig[]}`), each
`{id, kind: 'jellyfin'|'emby'|'plex', name, url, apiKey, enabled, usedForAvailability,
usedForRetention, usedForRefresh, loginEnabled, createUsersOnLogin}`. `apiKey` is a Jellyfin/Emby API key or the Plex owner's
X-Plex-Token and reads back as `********`; sending the mask (or omitting the key) on update keeps
the stored key. Names are unique (case-insensitive); URLs are normalised (`host:port` gets
`http://`, trailing slash dropped) and must be http(s).

This list is meant to be shared: other modules call
`mediaServersServiceFor(ctx).clients(purpose)` with `'availability' | 'retention' | 'refresh'`
and get a fresh `MediaServerClient` for every enabled server with that flag. The list is the
source of truth: the requests module's single-server `mediaServer` shape (sign-in, user links,
`GET/PUT /settings/mediaserver`) is a view over it (see [Media server](#media-server-compatibility-view-over-mediaservers)),
requests availability asks `clients('availability')`, and a stored legacy `mediaServer` value is
moved into the list once at boot (the legacy row is then deleted).

| Method | Path | Purpose |
|---|---|---|
| GET | `/mediaserver` | `MediaServerResource[]` (keys masked) |
| GET | `/mediaserver/:id` | One server; 404 unknown id |
| POST | `/mediaserver` | `MediaServerInput` → 201 `MediaServerResource`; 400 invalid (missing key, bad URL), 409 duplicate name |
| PUT | `/mediaserver/:id` | Replace a server (mask keeps the key) |
| DELETE | `/mediaserver/:id` | 204 |
| POST | `/mediaserver/test` | `MediaServerTestRequest` (unsaved form; `id` + masked key reuses the stored key) → `MediaServerProbeResult` |
| POST | `/mediaserver/:id/test` | `MediaServerProbeResult`: `{ok, serverName, version, libraries[]}` or `{ok: false, message, code}` (`System/Info` + `Library/VirtualFolders`, Plex `/` + `library/sections`) |
| GET | `/mediaserver/:id/users` | `MediaServerAccountResource[]` `{id, name, isAdmin, isDisabled, lastActivityAt}` (Jellyfin/Emby `Users`, Plex server `accounts`); 502 when the server fails |

**Clients** (`@arclight/media-servers`, native fetch, no db): `createMediaServerClient({kind,
url, apiKey, fetch?, timeoutMs?})` → `info()`, `libraries()`, `users()`, `listItems(mediaType)`,
`findItems({mediaType, tmdbId?, tvdbId?, imdbId?})`, `playState(item, userId)`,
`listPlayStates(userId, mediaType)` and `refreshLibrary({path?, mediaType?, updateType?})`.
Jellyfin/Emby: per-user `UserData` (Played, PlayCount, LastPlayedDate, PlaybackPositionTicks);
a series is played when every present episode is; provider-id filters are verified and fall
back to a library index. Plex: items found through a guid index of the movie/show sections;
the owner's state is on the items (viewCount, lastViewedAt, viewOffset, viewedLeafCount), other
accounts' state comes from `status/sessions/history/all?accountID=`. Errors are
`MediaServerError` with a `code` (`unauthorized`, `network`, `timeout`, `notFound`, ...).

## retention

Module `apps/api/src/modules/retention`; contract `packages/shared/src/retention.ts`; tables
`retention_rules`, `retention_candidates`. A rule `{name, enabled, mediaType, scope, conditions[],
graceDays, action, addExclusion, keepIfRequestedWithinDays, keepIfInCollection, dryRun}`:

- `scope`: `{type:'all'}`, `{type:'tags', tagIds}` or `{type:'rootFolders', paths}`.
- `conditions` (all must hold): `watchedByAll` (every enabled user who can see the item),
  `watchedByAny`, `watchedByUsers {users: names}`, `addedOlderThanDays {days}`,
  `notWatchedWithinDays {days}` (no play in N days and added longer ago; never true for items
  no server knows), `sizeAbove {bytes}`. Users are merged by name (case-insensitive) across all
  enabled servers flagged `usedForRetention`.
- `action`: `unmonitor`; `deleteFiles` (unmonitor, then each media file goes to the recycle bin
  and its row is removed); `deleteItem` (every file in the folder to the recycle bin, then the
  series/movie and its folder are deleted via the library service; `addExclusion` adds an
  import exclusion). Without a recycle bin files are deleted.
- `keepIfRequestedWithinDays` (a request for the TMDB id that recent keeps it),
  `keepIfInCollection` (movies in a TMDB collection), `dryRun` (default **true**: staged and
  notified, never applied automatically).

`RetentionSweep` stages matches as `pending` candidates (`reasons`, `watchedBy`,
`applyAfter = firstSeen + graceDays`), drops waiting ones that stopped matching, and applies due
candidates of non-dry-run rules. `kept` candidates are never applied; `failed` ones are retried
on the next sweep; an applied item that matches again starts a new cycle. When any retention
server cannot be read (or none is configured), rules with watch conditions are skipped for that
sweep: their candidates are neither dropped nor applied. After a sweep that staged, applied or
failed something, a `retention` notification (summary: staged/applied/failed lines, freed bytes,
link to `/retention`) is dispatched to the notification connections.

| Method | Path | Purpose |
|---|---|---|
| GET | `/retentionrule` | `RetentionRule[]` |
| GET | `/retentionrule/:id` | One rule |
| POST | `/retentionrule` | `RetentionRuleInput` → 201; 400 invalid, 409 duplicate name |
| PUT | `/retentionrule/:id` | Replace; waiting candidates take the new action and grace (from first sighting) |
| DELETE | `/retentionrule/:id` | 204; deletes its candidates |
| GET | `/retention/candidates` | `RetentionCandidate[]`, oldest `applyAfter` first; filters `status`, `ruleId`, `mediaType` |
| POST | `/retention/sweep` | Body `{dryRun?}` (optional) → `RetentionSweepResult` `{rulesEvaluated, rulesSkipped[], serverErrors[], staged, dropped, applied, failed, matches[]}`; `dryRun` evaluates only (no staging, applying or notification) |
| POST | `/retention/candidate/:id/apply` | Apply now (ignores grace, pin and dry run) → the candidate (`applied` or `failed` with `error`); 409 when already applied |
| POST | `/retention/candidate/:id/keep` | Pin: status `kept`; 409 when already applied |
| DELETE | `/retention/candidate/:id` | Remove (unpins; a later sweep may stage it again) |

## subtitles

Module `apps/api/src/modules/subtitles` (spec: `docs/spec/subtitles.md`); contract in
`packages/shared/src/subtitles.ts`. Series and movies carry `languageProfileId` (null = no
subtitles wanted); `POST /series` and `POST /movie` use the subtitles default profile when the
field is omitted, and `PUT /series/:id` / `PUT /movie/:id` accept it. Writes and the settings,
providers and manual-search routes are admin-only.

Sync-quality scoring (`subtitles.sync`): with `autoCheck` on, every download is scored against
the audio. `checkMethod` `builtin` runs ffmpeg `silencedetect` (or `ebur128`, `audioDetector`)
over the first `checkWindowMinutes` (plus a half-length window at 60 % for long media) and
cross-correlates speech onsets with cue starts over offsets up to `maxOffsetSeconds` and the
usual frame-rate ratios; `tool` runs ffsubsync (`--no-fix-framerate`) / alass into a scratch
`*.synccheck.*` file and compares cue times. `offsetMs` is the shift to add to the subtitle,
`driftPpm` its scale error, `syncScore` 100 at ≤ 0.1 s mean error, 50 at 0.6 s. A score below
`autoFixBelow` runs the sync tool and checks again; a provider download still below
`autoRetryProviderBelow` is blacklisted and the next candidate is downloaded (at most
`maxProviderRetries` per language). History records carry `syncScore`, `syncOffsetMs`,
`syncDriftPpm`. Providers whose settings have `onlyWhenNoOtherResult` (Whisper defaults to it)
are searched only for languages where no other provider found a candidate reaching the minimum
score.

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
| GET | `/subtitle/file` | `?mediaFileId\|seriesId\|movieId`: per media file, subtitles present (external/embedded, forced, HI, provider, score, `syncScore`/`syncOffsetMs`/`syncDriftPpm`/`syncCheckedAt`/`syncMethod` of the last sync check) and `missing` |
| POST | `/subtitle/scan` | Same scope in the body: rescan disk and embedded streams |
| GET | `/subtitle/search` | `?mediaFileId&language?`: manual search, every candidate with score, matches and a one-hour `key` |
| POST | `/subtitle/download` | `{mediaFileId, key}`: download a manual-search candidate (410 when the key expired) |
| POST | `/subtitle/upload` | multipart: `mediaFileId`, `language`, `forced`, `hi` + one `file` part (5 MB max) |
| POST | `/subtitle/sync/:id` | Run ffsubsync/alass on an external subtitle (manual, ignores thresholds) |
| POST | `/subtitle/:id/synccheck` | Measure sync now (no auto actions) → `SubtitleSyncCheckResult` `{ok, message, check: {method, reliable, syncScore 0-100, offsetMs, driftPpm, meanErrorMs, confidence, matched}, actions, subtitle}`; the result is stored on the subtitle and its history entry |
| GET | `/subtitle/whisper/status` | `SubtitleWhisperStatus`: `ARCLIGHT_WHISPER_URL`, the whisperai entry (registered, enabled, autoRegistered, onlyWhenNoOtherResult) and a live probe (`reachable`) |
| POST | `/subtitle/extract/:id` | Extract an embedded text track to a file (ffmpeg stream copy) |
| DELETE | `/subtitle/:id` | Delete an external subtitle file |
| POST | `/command/subtitlesearch` | `{seriesId, seasonNumber?}` \| `{episodeIds}` \| `{movieId}` \| `{mediaFileId}`: search now, ignoring backoff |

## releases (decision log)

Contract: `DecisionLog*` in `packages/shared/src/releases.ts`. Every evaluation batch (RSS sync,
automatic/user search, interactive search, interactive grab, push, pending re-check) is written to
`release_decisions`: one row per release with its item, quality, custom formats, score,
approval, rejections, `chosen` (grabbed from this batch) and `rank` (1-based engine preference per
item; approved first). Releases without a library item are not kept, except search results, which
are logged against the searched item. Per item (series or movie) the last 20 batches are kept;
`DecisionLogCleanup` prunes rows older than `releases.decisionLogDays`. Grabs carry the batch id
into the history record's data as `decisionBatchId`, so History details can link to "why this
release".

| Method | Path | Notes |
|---|---|---|
| GET | `/release/decisions` | `DecisionLogQuery`: exactly one of `seriesId`, `episodeId`, `movieId`, plus `page`, `pageSize` (default 10, max 100). `DecisionLogPage` of `DecisionLogBatch` (newest first; rows of the item in rank order; `winnerId` = the grabbed row, else the best approved; `grabbed`). Per episode: rows covering the episode. 400 without (or with several) ids |
| GET | `/release/decisions/:batchId` | One whole batch (all items); 404 unknown |

## scene-mapping

Contract: `packages/shared/src/scene-mapping.ts`. Per-series scene numbering rules in
`scene_mappings` (`source` `manual` or `feed`). Kinds: `season` (scene season, optional episode
anchor, to library season/episode or library absolute; anchors are piecewise offsets until the
next anchor), `absolute` (scene absolute anchor, optionally within `sceneSeason`, to library
season/episode or absolute), `title` (`sceneTitle` alias; with `tvdbSeason`, releases matched
through it land in that season). The release matcher tries title aliases first, then maps the
parsed numbers: manual rules, then feed rules, then for `seriesType: anime` the absolute fallback
(library absolute numbers, else derived by counting episodes across seasons; `S01E27` past the end
of season 1 reads as absolute 27).

| Method | Path | Notes |
|---|---|---|
| GET | `/series/:id/scenemapping` | Rules of the series, manual first |
| POST | `/series/:id/scenemapping` | `SceneMappingInput`; creates a manual rule (201) |
| PUT | `/series/:id/scenemapping/:mappingId` | Replace a manual rule; feed rules are read-only (400) |
| DELETE | `/series/:id/scenemapping/:mappingId` | Delete a manual rule (204); feed rules 400 |
| POST | `/series/:id/scenemapping/apply` | Re-map the series's library files (scene name, else path) under the current rules; changed files are re-registered with the new episode links (bytes untouched; new file ids), files that map onto another kept file's episodes are skipped; then the imports rescan runs. `SceneMappingApplyResult` |
| GET | `/scenemapping/feed` | `SceneMappingFeedStatus` |
| POST | `/scenemapping/feed/sync` | Sync the community feed now; 502 on failure |

Feed file (`DEFAULT_SCENE_MAPPING_FEED_URL`, `feeds/scene-mappings.json` on the repository's
main branch): `{ "schemaVersion": 1, "generatedAt"?: ISO, "series": [ { "tvdbId"?, "tmdbId"?,
"title"?, "mappings": [SceneMappingInput, ...] } ] }`. Series match by tvdbId, then tmdbId; each
sync replaces all feed rows; invalid entries are counted as `rejected`. A 404 is "not published"
(info, never stale). Registered in the feeds registry as `sceneMappings`.

## history

Contract: `packages/shared/src/history.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/history` | Paged, sortable, filterable history (`eventType`, `mediaType`, `seriesId`, `episodeId`, `movieId`, `downloadId`, `quality`, `language`, `include*`) |
| GET | `/history/since` | Records since `date` (optional `eventType`) |
| GET | `/history/series` | Records of a series (`seriesId`, `seasonNumber?`, `eventType?`) |
| GET | `/history/movie` | Records of a movie (`movieId`, `eventType?`) |
| POST | `/history/failed/:id` | Mark the grab failed (`{message?, skipRedownload?}`): writes `downloadFailed`, blocklists the release, and unless `skipRedownload` is set (or `mediaManagement.autoRedownloadFailed` is off) re-searches the record's episodes/movie in the background (wiring.ts, priority-100 handler). Answers the new `downloadFailed` records |
| POST | `/history/:id/redownload` | Re-run the automatic search for the record's movie, or its episode plus every episode recorded under the same download id and event type. Answers **202** with the started `HistoryRedownload` `Job`; 404 unknown id, 400 for a record without an episode or movie, 503 when release search is not wired |

## blocklist

Contract: `packages/shared/src/history.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/blocklist` | Paged, sortable list (`mediaType`, `seriesId`, `movieId`, `protocol` filters) |
| GET | `/blocklist/series` | Entries of a series (`seriesId`) |
| GET | `/blocklist/movie` | Entries of a movie (`movieId`) |
| POST | `/blocklist` | Add an entry by hand (`BlocklistAddRequest`: `mediaType`, `seriesId` + `episodeIds` or `movieId`, `sourceTitle`, `quality`, `protocol`, optional indexer, hash, size, message), 201 |
| POST | `/blocklist/clear` | Remove every entry, answers `{deleted}` |
| DELETE | `/blocklist/bulk` | Body `{ids: number[]}` (at least one positive id; anything else is 400), answers `{deleted}` |
| DELETE | `/blocklist/:id` | Remove one entry |

## calendar

Contract: `packages/shared/src/calendar.ts`. Episodes by air date, movies once per release date
(cinema, digital, physical). Week and day views are client-side over `start`/`end`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/calendar` | Items in `[start, end]` (defaults: today, +7 days). Filters: `mediaType` (`all` default, `series`, `movie`), `tags` (any of), `unmonitored` (include unmonitored items, default false), plus `includeSeries`, `includeEpisodeFile` |
| GET | `/calendar/feed` | `{token, path}` of the iCal feed |
| POST | `/calendar/feed/regenerate` | Admin. Rotates the feed token, answers `{token, path}`; the old feed URL answers 401 from then on |
| GET | `/calendar/feed.ics` | Public, `?token=` required; `pastDays`, `futureDays`, `tags`, `unmonitored` |

## media-analysis

Contract: `packages/shared/src/media-analysis.ts`; results land in `MediaFile.mediaInfo`
(`packages/shared/src/library.ts`: codec/profile/bit depth/resolution/fps/scan type, dynamic
range `SDR`/`HDR10`/`HDR10Plus`/`HLG`/`PQ`/`DV`/`DV HDR10`/`DV HDR10Plus`/`DV HLG`/`DV SDR` plus
`doviProfile`, every audio track (codec, profile, channels, language, bitrate) and subtitle track
(language, forced, hearing impaired), container, duration, overall bitrate).

ffprobe is found through `ARCLIGHT_FFPROBE` or `PATH` (the Docker image ships ffmpeg). Files are
queued in `media_analysis_jobs` on any `library fileAdded` (imports, rescans, manual imports) and
by the command below; the `AnalyzeMedia` job analyzes them `ARCLIGHT_ANALYSIS_CONCURRENCY`
(default 2) at a time and publishes `library updated` per item. Health check `FfprobeMissing`
(warning) when ffprobe cannot be found.

| Method | Path | Purpose |
|---|---|---|
| POST | `/command/analyze` | Body: exactly one of `seriesId`, `movieId`, `all: true`; optional `force` (default true for an item, false for `all` = only files without media info). Answers `{queued, ffprobeAvailable}` |
| GET | `/mediaanalysis/queue` | Queue counts (`pending`, `running`, `done`, `failed`), ffprobe path, concurrency, last 20 failures |

## transcode

Contract: `packages/shared/src/transcode.ts`. Rules (`transcode_rules`) pick library files by
media type, scope (`{kind:'all'}`, `{kind:'tags', tagIds}`, `{kind:'profiles', qualityProfileIds}`
of the parent series/movie) and `when` conditions on the file's media info (`container`,
`videoCodec`, `audioCodec` (any track), `hdr`, `resolutionAbove` (height px),
`bitrateAboveKbps`, `sizeAboveGb` (GiB); all must hold, files without media info only match
rules without media conditions). Actions: `remux` (copy into `options.container`),
`transcode` (video `copy`/`h264`/`hevc`/`av1`, audio `copy`/`aac`/`eac3` + `channels`),
`stripTracks` (copy, keep only `keepLanguages` audio/subtitles, `dropSubtitles`) and
`addAudioTrack` (copy everything, add one compatibility track, default AAC stereo, from the first
kept audio track). `keepLanguages` applies to every action and never drops all audio; untagged
tracks are always kept. mp4 output gets `-movflags +faststart`, text subtitles as `mov_text`
(image subtitles are dropped) and `hvc1` for HEVC.

Hardware encoding (`options.hwaccel`): `vaapi` (`-vaapi_device /dev/dri/renderD128` +
`hwupload`, `*_vaapi`, crf as `-qp`), `qsv` (`*_qsv`, `-global_quality`), `nvenc`
(`-hwaccel cuda`, `*_nvenc`, `-rc vbr -cq`, presets mapped to `p1`-`p7`), `videotoolbox`
(`-q:v`, no AV1). `none` uses libx264/libx265/libsvtav1 with `-crf`/`-preset`. No tone mapping:
an HDR source encoded to h264 stays PQ/HLG-tagged 8-bit.

ffmpeg is `ARCLIGHT_FFMPEG`, else the `ffmpeg` next to `ARCLIGHT_FFPROBE`, else `PATH`.

Jobs (`transcode_jobs`) are drained by `TranscodeWorker` one file at a time. A rule's
`schedule` window (`{start, end}` `HH:MM`, server-local time, may cross midnight, equal = all day,
null = any time) gates when its **rule** and **import** jobs may start; a job that started runs
to the end. **Manual** single-file runs (`POST /transcode/run {mediaFileId}`) start at once,
ignoring the window. Output goes to `.<name>.arclight-transcode.<ext>` next to the source, then:

- `keepOriginal: false`: the original goes to the recycle bin (`mediaManagement.recycleBinPath`,
  same as imports; deleted when no bin is set), the result takes its name (new extension if the
  container changed).
- `keepOriginal: true`: if the result has the same name the original becomes
  `<name>.original.<ext>`; after a container change the original stays where it is, no longer
  tracked by the library.

Then `media_files` `path`/`relative_path`/`size_bytes` are updated, `media_info` is cleared and
the file is queued for media analysis, a `fileTranscoded` history row is written (data:
`sourcePath`, `path`, `action`, `rule`, `sizeBefore`, `size`, `recycleBinPath`/`originalPath`),
`library updated` is published and a `fileTranscoded` notification is sent (connections with
`onRename`). `runAfterImport` rules are checked on every `import imported` event against the
item's newest file; files still without media info wait (up to 6 h, in memory) for analysis to
publish `library updated`. Running a rule by id skips files it already completed. Deleting a
rule cancels its queued jobs. Jobs left `running` by a restart go back to `queued`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/transcoderule` | List rules |
| GET | `/transcoderule/:id` | One rule |
| POST | `/transcoderule` | Create (`TranscodeRuleInput`; 201) |
| PUT | `/transcoderule/:id` | Replace |
| DELETE | `/transcoderule/:id` | Delete (204); queued jobs of the rule are cancelled |
| GET | `/transcode/jobs` | Jobs, newest first (`?status=queued\|running\|completed\|failed\|cancelled`); `progress` 0-100, `command` (display) |
| POST | `/transcode/run` | `{mediaFileId}`: queue for the first enabled matching rule (400 when none, 409 when the file already has an active job); `{ruleId}`: queue every matching file. Answers `{queued, jobs}` |
| POST | `/transcode/jobs/:id/cancel` | Queued: cancelled; running: ffmpeg is killed and the temp file removed (409 when finished) |
| GET | `/transcode/hwaccel` | `ffmpeg -hide_banner -hwaccels`: `{ffmpegPath, methods, backends}` |

## library-hygiene

Contract: `packages/shared/src/library-hygiene.ts`. The `OrphanScan` job walks every root folder
(skipping hidden/system folders, extras, the recycle bin and nested root folders) and replaces
the `library_hygiene_findings` table:

* `orphan`: a video file no media file row points at, with the parser's guess and up to three
  suggestions (score 1 when inside the item's folder, else title similarity; series suggestions
  carry the parsed episodes' ids);
* `duplicate`: `episode`/`movie` (a file for an episode/movie that already has one, a second
  library row for one movie, a series file no episode links to) or `content` (same size and
  sha256 of the first MiB; hard links excluded);
* `empty`: the topmost folders without any (non-junk) file, except an item's own folder.

Health check `OrphanFilesFound` (warning) from 25 orphans; the health contract has no info level.

| Method | Path | Purpose |
|---|---|---|
| GET | `/library/hygiene` | Findings of the last scan; filters `type` (`orphan`, `duplicate`, `empty`) and `rootFolderPath`. Answers `{lastScan, counts, records}` |
| POST | `/library/hygiene/scan` | Start an `OrphanScan` job; **202** with the `Job` |
| POST | `/library/hygiene/:id/map` | Import an orphan via manual import (`HygieneMapRequest`: `seriesId` + `episodeIds` or `movieId`, `importMode` default `move`; omitted fields use the best suggestion). Files already inside the item's folder are registered in place. 400 without a usable target, 409 when the import fails |
| DELETE | `/library/hygiene/:id` | Delete the file (through the recycle bin, keeping its path below the root folder) or the empty folder (409 when it is no longer empty). A library duplicate also loses its media file row (`library fileDeleted`). Answers `{recycledTo, removedMediaFileId}` |

## stats

Contract: `packages/shared/src/stats.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/stats/storage` | Per root folder total/free bytes (volume) and bytes/files used by Arclight; top `top` (default 10) series and movies by size; buckets by quality, video codec, resolution (2160p/1080p/720p/SD/Unknown from media info, else quality) and dynamic range; growth over 30/90 days and daily points from `stats_snapshots` |
| GET | `/stats/library` | Series (monitored, continuing, ended), episodes (downloaded, missing = monitored + aired, unaired, unmonitored, cutoff unmet), movies (monitored, downloaded, missing as in `/wanted/missing/movies`, cutoff unmet), files and size |
| GET | `/stats/activity` | Grabs, imports and failures per UTC day for `days` (default 30, max 365) from history; season packs count once (per download id / imported path) |
| GET | `/stats/indexers` | Proxy of `GET /indexer/stats` (`days`, default 30) |

## config (config as code)

Implemented in `apps/api/src/modules/config-export` (contract: `packages/shared/src/operations.ts`).
Format, managed mode and env overrides: [OPERATIONS.md](OPERATIONS.md).

| Method | Path | Purpose |
|---|---|---|
| GET | `/config/export?format=yaml\|json&includeSecrets=false` | Admin. One document: every settings section plus tags, custom formats, quality/delay/release profiles, download clients, indexer proxies, indexers, remote path mappings, root folders, notifications, import lists, language profiles, keyed by name. Secrets are `********`; `includeSecrets=true` also needs the header `X-Confirm: export-secrets` (else 400 `CONFIRMATION_REQUIRED`). Served as an attachment (`arclight-config.yml` / `.json`) |
| POST | `/config/import` | Admin. Body `{document}` or `{content}` (YAML/JSON text) plus `dryRun`, `prune`; or a raw body with `Content-Type: application/yaml` and `?dryRun=true&prune=true`. Upserts by name, deletes only with `prune` (and only inside collections the document lists), all in one transaction. Returns `ConfigImportResult` `{dryRun, applied, changes[{kind,key,op,fields?}], summary, errors, warnings}`; 422 with the same body when an apply has errors, 400 for unparsable text |
| POST | `/config/validate` | Admin. Same body; `{valid, errors, warnings}` without writing |
| GET | `/config/managed-keys` | Settings keys and resource keys owned by `ARCLIGHT_CONFIG_FILE` / `ARCLIGHT_SETTING__*` (the UI locks them): `{file, appliedAt, settings: {section: keys[]}, resources: {kind: keys[]}, env[], errors[]}` |

## audit

Implemented in `apps/api/src/modules/audit`. Every mutating `/api/v1` request is recorded by an
`onResponse` hook; `login.success` / `login.failed` come from the auth service. Admin only.

| Method | Path | Purpose |
|---|---|---|
| GET | `/audit?page&pageSize&user&action&from&to` | `AuditPage`, newest first. `user`: username (case-insensitive) or user id; `action`: exact or prefix (`settings` matches `settings.update`); `from` inclusive, `to` exclusive (ISO-8601; 400 when not a date) |
| GET | `/audit/actions` | Distinct action names (filter list) |
| GET | `/audit/export?user&action&from&to` | Same filters as CSV (`time,username,userId,ip,action,target,method,route,statusCode,details`) |
| GET/PUT | `/settings/audit` | `{enabled, retentionDays}` (default `true`, `90`; 0 keeps events forever) |

## metrics

Implemented in `apps/api/src/modules/metrics`. The scrape endpoint lives at the root, not under
`/api/v1`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/metrics` (root) | Prometheus text format 0.0.4. Same credentials as the API (`X-Api-Key`, `?apikey=`, Basic, session); anonymous when `metrics.allowAnonymous` |
| GET/PUT | `/settings/metrics` | `{allowAnonymous}` (default `false`) |

## discord-bot

Implemented in `apps/api/src/modules/discord-bot`. A Discord bot user (not a webhook) that
connects to the gateway over the Node global `WebSocket` (Identify with intents `GUILDS |
GUILD_MESSAGES`, jittered heartbeat, Resume on the `resume_gateway_url`, reconnect with
exponential backoff from 1 s up to 60 s; a missing heartbeat ACK, op 7 and op 9 reconnect;
close codes 4004/4010-4014 stop with `state: error`). On Ready it bulk-overwrites the slash
commands on `guildId` (instant) or globally. Settings are the `discordBot` row of the settings
table (`DiscordBotSettings`); saving restarts the bot.

| Method | Path | Purpose |
|---|---|---|
| GET/PUT | `/settings/discordbot` | Admin. `DiscordBotSettings` `{enabled, botToken, guildId, requestChannelId, adminRoleId}`; `botToken` reads back as `********` and sending the mask keeps it; ids are Discord snowflakes; enabling needs a token |
| GET | `/discordbot/status` | Admin. `DiscordBotStatus`: `state` (`disabled`/`connecting`/`connected`/`reconnecting`/`error`), bot user, `connectedAt`, `lastError`, `reconnectAttempts`, `commandsRegistered`, `linkedUsers` |
| POST | `/discordbot/test` | Admin. Optional `DiscordBotSettings` body (mask = stored token). `GET /users/@me` with the token, then posts a test embed to `requestChannelId` when set → `DiscordBotTestResult` |
| POST | `/user/me/discord/link-code` | Signed-in user (not API key). One-time 8-character code valid 10 minutes (a newer code replaces older ones) → `DiscordLinkCode` `{code, expiresAt, linkedDiscordUserId}` |
| DELETE | `/user/me/discord/link` | Removes the caller's Discord link (204) |

The link is `users.settings.discordUserId` (in `ADMIN_MANAGED_USER_SETTINGS`, so `PUT /user/me`
cannot set it); one Arclight user per Discord account (a new `/link` moves it).

Slash commands (every interaction is acknowledged with an ephemeral deferral, then the
original response is edited):

| Command | Behaviour |
|---|---|
| `/link <code>` | Links the caller to the Arclight user who created the code |
| `/request <title> [year] [4k]` | TMDB multi-search; up to 5 matches as buttons. A click creates the request as the linked user (`requests.create`, series request all seasons), so permissions, quotas, approval policies and content caps apply. Unlinked users are told to create a code under Profile > Discord |
| `/status [title]` | The linked user's requests (up to 10), filtered by title |
| `/search <title>` | TMDB matches with library / request status (normal and 4K) |
| `/pending` | Up to 5 pending requests with Approve/Decline buttons. Allowed for linked users with `MANAGE_REQUESTS` (who act as themselves) and for members holding `adminRoleId` (who act as the system; `modifiedBy` stays empty). Checked again on each click |

Request events (`created`, `approved`, `completed`) are posted as embeds to `requestChannelId`
through `POST /channels/{id}/messages` with the bot token. Health check
`DiscordBotDisconnected` (warning): enabled but not connected for 2 minutes, or stopped on a
fatal close code.

## torrent (built-in engine)

| Method | Path | Purpose |
|---|---|---|
| GET | `/settings/torrent` | Engine settings plus `effectiveDownloadsRoot` and `resumeDir`. The transport options `encryption` (`preferred` / `required` / `disabled`), `tcp`, `utp`, `ipv6` and `webSeedConnectionsPerTorrent` are filled with the engine defaults when never saved |
| PUT | `/settings/torrent` | Any subset; omitted keys keep their stored value. Applied live: limits, queue, `encryption` and `webSeedConnectionsPerTorrent` at once; `tcp` / `utp` / `ipv6` re-open the sockets on the same port; `dht` restarts the engine |
| GET | `/torrent/status` | Engine state, bound address/port, VPN binding, `dhtNodes`, `dht6Nodes`, `utpConnections`, `peers`, `encryptedPeers`, `encryptedPeerRatio` (0..1), rates, counts per state |
| GET | `/torrent/torrents` | `?id=&category=`: detailed torrents. Each peer has `encrypted` and `transport` (`tcp` / `utp`); each torrent has `webSeeds` (url, rate, downloaded, active requests, failures, `retryAt`, `lastError`), `superSeeding` and `limits` |
| POST | `/torrent/:id/recheck` | Re-hash the payload |
| POST | `/torrent/:id/pause` / `resume` | Pause / resume (resume is 409 while the VPN kill switch holds) |
| POST | `/torrent/:id/move` | `{ savePath }` |
| POST | `/torrent/:id/priority` | `{ files?: [{ index, priority 0..7 }], sequential? }` |
| POST | `/torrent/:id/limits` | `{ uploadLimit?, downloadLimit?, peerUploadLimit?, peerDownloadLimit? }` in bytes/s (0 = unlimited); omitted keys keep their value; persisted in the resume data |
| POST | `/torrent/:id/superseed` | `{ enabled }`: BEP 16 super-seeding |
| GET | `/torrent/speed` | Current speed mode: `mode` (`normal` / `alternative`), `reason` (`manual` / `schedule`), `slowMode`, `slowModeUntil`, `nextChange`, effective `downloadLimit` / `uploadLimit` in bytes/s. Also `speed` in `/torrent/status` |
| POST | `/torrent/slowmode` | `{ enabled, until? }`: manual slow mode (alternative limits) until turned off or until `until` (ISO-8601). Applied live; mirrored to qBittorrent's alternative limits when `mirrorToQbittorrent` |
| GET | `/settings/torrent/speed` | `altDownloadLimitKbps` (default 1024), `altUploadLimitKbps` (256), `scheduleEnabled`, `schedule: [{ days: 0..6 (0 = Sunday), start, end: HH:MM }]` in server-local time (an end at or before the start runs past midnight), `mirrorToQbittorrent` (true) |
| PUT | `/settings/torrent/speed` | Any subset; applied live. The schedule is re-checked every 30 s |
| GET | `/settings/torrent/seedingrules` | `{ rules: [...] }`: per rule `id`, `name`, `enabled`, filters `categories` / `indexerIds` / `trackers` (host names, subdomains match; empty = any), `ratio` and/or `seedTimeMinutes` (either reached), `action` (`pause` / `remove`), `deleteFiles` |
| PUT | `/settings/torrent/seedingrules` | Replaces the list; the first enabled matching rule applies |
| POST | `/torrent/seedingrules/apply` | Run one pass now (the `ApplySeedingRules` job runs every 5 minutes): `{ checked, paused, removed, held: [{ infoHash, reason }] }`, null while the engine is not running |

Seeding rules never act before a tracker's hit-and-run requirement is met, only remove downloads
Arclight has imported, and delete files only when the download's folder does not overlap a
library folder (root, series or movie folder) or another torrent's data; otherwise the torrent is
removed and the files kept. Pauses and removals are written to the download timeline with
`data.reason = seedingRule`.

`:id` is the 40-character info-hash. Errors: 400 validation, 404 unknown torrent, 409 engine not running.
The `builtin` download client settings also carry the defaults for new torrents: `superSeeding`,
`uploadLimitKbps`, `downloadLimitKbps`, `peerUploadLimitKbps`, `peerDownloadLimitKbps` (KiB/s,
empty or 0 = unlimited). `AddTorrentInput.skipChecking` (cross-seeding) makes the built-in client
trust a payload whose file sizes match (fast-resume data with every piece) and qBittorrent send
`skip_checking`.

## engine-agent (Arclight as a remote engine)

| Method | Path | Purpose |
|---|---|---|
| GET | `/settings/engineagent` | `{ enabled, path, engineRunning }` |
| PUT | `/settings/engineagent` | `{ enabled? }` (admin) |
| * | `/engine-agent/*` | The engine agent protocol (see [REMOTE-ENGINE.md](REMOTE-ENGINE.md#protocol)) over this instance's built-in engine, for another Arclight's `remoteEngine` download client. Requires `engineAgent.enabled` (else 404) and the API key in `X-Api-Key` (a browser session is refused, 401). Errors use the agent shape `{ error, code }`. `PUT /engine-agent/listen-port` is always 409: this instance's port follows its own torrent/VPN settings |
| GET (WS) | `/engine-agent/events` | Agent event stream (`hello`, `added`, `removed`, `stateChange`, `completed`, `metadata`, `listenPort`) |

The `remoteEngine` download client kind has settings `url`, `token` (write-only, masked like
passwords), `category`, `postImportCategory`, `pullMode`, `localDownloadPath`,
`bandwidthLimitKbps` and `followVpnPort`. Health check `RemoteEngineUnreachable` reports each
enabled remote engine whose agent did not answer the last queue poll.

## tracker-stats (private trackers)

| Method | Path | Purpose |
|---|---|---|
| GET | `/indexer/:id/tracker` | Tracker account settings of a torrent indexer (defaults when never saved) |
| PUT | `/indexer/:id/tracker` | `{ enabled, ratioRequired?, hnrRule: { minSeedHours?, minRatio? }, freeleechOnly, bufferTracking, minBufferBytes?, announceHosts[], scrapeAccount }`; 400 for usenet indexers, 404 unknown |
| GET | `/tracker/stats` | Per tracker: engine totals of its torrents (`torrents`, `seeding`, `uploaded`, `downloaded`, `seedingTimeMs`, `hnrPending`), the scraped account page (`accountRatio`, `accountUploaded`, `accountDownloaded`, `accountBuffer`, `accountHnrCount`, `accountSeedBonus`, `accountError`), the effective `ratio`, `buffer` and `ratioStatus` (`ok` / `warning` within 10 % / `low` / `unknown`) |
| POST | `/tracker/stats/sync` | Run the TrackerStatsSync now; returns `{ message, stats }` |

Engine torrents are attributed to an indexer by: a cross-seed record, the grab snapshot of the
tracked download, the account's `announceHosts` (exact), else the indexer's site hosts (subdomains
match). Hooks: the H&R rule of an enabled account is attached to the engine Session; the `builtin`
client reports a finished torrent of that tracker as read-only and not removable, and
`removeItem` throws `rejected`, until it has seeded `minSeedHours` or reached `minRatio`.
`trackerStatsServiceFor(ctx).releaseFilter(indexerId, release)` returns
`{ reason: 'notFreeleech', message }` for a non-freeleech release of an indexer in freeleech-only
mode (null otherwise) for the decision engine. Health check `TrackerRatioLow`: error below the
required ratio, warning within 10 % above it, below `minBufferBytes`, or when the account page
reports hit-and-runs. Definitions may declare an optional `account` block
(`path`, `method`, `inputs`, `fields: { ratio, uploaded, downloaded, buffer, hnrCount, seedBonus }`
as selector blocks), scraped logged-in with the html engine.

## cross-seed

| Method | Path | Purpose |
|---|---|---|
| GET | `/settings/crossseed` | `{ enabled, indexerIds[], sizeTolerancePercent (0.5), onImport, schedule (cron, default daily), excludeTags[], downloadClientId, category ('cross-seed'), linkDir, searchIntervalDays, maxPerRun }` |
| PUT | `/settings/crossseed` | Full settings; reschedules `CrossSeedSearch` |
| GET | `/crossseed` | `?mediaFileId=&state=seeding\|failed`: recorded cross-seeds (`infoHash`, indexer, client, `savePath`, `state`, `message`) |
| POST | `/crossseed/search` | Exactly one of `{ mediaFileId \| seriesId \| movieId }`: search now; returns `{ filesSearched, candidates, added[], skipped[{ title, indexerId, reason }] }` |

For each library file the enabled torrent indexers are searched (TV: season + episode, movie:
ids + year). A release qualifies when its size is within `sizeTolerancePercent` (exact sizes
first), its parsed title names the same episode(s) / movie (season packs, multi-season and other
episodes are skipped) and its info-hash is not already a cross-seed, a tracked download or an
engine torrent. The .torrent is downloaded through the indexer; magnets and multi-file torrents
are skipped. The single file must have the library file's exact size; the torrent seeds in place
when it names the file the same, otherwise from a hard link (symlink fallback) under
`<linkDir>/<infohash>/`. The first and last pieces are hashed against the file before adding it
seed-only (`skipChecking`) to the chosen client (Built-in first, or qBittorrent).

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
| `IndexerDefinitionFeedSync` | `41 */12 * * *` from `indexers.definitionFeed.intervalHours` (on demand only when disabled or `manual`) | indexers | Definition feed sync (see Definition feed) |
| `GuidesSync` | `17 4 * * *` from `guides.syncIntervalHours` (`17 */N * * *` below a day; on demand only when disabled) | guides | Guide fetch + diff; applies or stores the pending diff per `mode` |
| `RefreshSeries` | `0 3 * * *` | metadata | Refresh all series from TMDB |
| `RefreshMovie` | `30 4 * * *` | metadata | Refresh all movies from TMDB |
| `CutoffUnmetSearch` | `40 3 * * *` | releases | Searches the items `GET /wanted/cutoff/*` lists (same cutoff checker), least recently searched first |
| `RequestsStatusSync` | `*/5 * * * *` | requests | Recomputes media status from the library, or from the media server when `useMediaServerAvailability` is on (Jellyfin/Emby provider ids, Plex guids, per-season episode counts), completes requests, sends available notifications |
| `WatchlistSync` | `*/15 * * * *` | requests | Pulls Plex watchlists (users with a token) and Jellyfin/Emby favourites (linked users); auto-requests when `autoRequestFromWatchlist`, `AUTO_REQUEST*` and the per-type sync flag allow |
| `RequestsPolicySweep` | `0 * * * *` | requests | Re-evaluates requests held by approval windows: approves those the policies now approve, releases the rest to pending when no window holds them |
| `RequestsDigest` | `0 * * * *` | requests | Hourly tick; once a day at `digestHour` (when `digestEnabled`) sends one notification summarising pending requests and open issues (nothing when both are empty) |
| `RetentionSweep` | `30 3 * * *` | retention | Pulls play state from servers flagged `usedForRetention`, stages rule matches, applies candidates past their grace period, sends the `retention` summary |
| `SubtitleSearchWanted` | `*/15 * * * *` | subtitles | Searches wanted subtitles, least recently searched first, up to `search.batchSize` items; adaptive backoff per language; stops when every provider is throttled |
| `SubtitleUpgrade` | `30 3 * * *` | subtitles | Re-searches recent downloads (upgrade window) scoring below perfect; needs old score + 2 |
| `SubtitleScan` | `0 4 * * 0` | subtitles | Re-indexes external and embedded subtitles of every file, prunes orphaned rows |
| `SubtitleSyncCheck` | `20 * * * *` | subtitles | While `sync.autoCheck` is on, scores up to `sync.checkBatchSize` external subtitles never checked and applies `autoFixBelow` / `autoRetryProviderBelow` |
| `WhisperAutoDetect` | `7 * * * *` (and once at boot) | subtitles | Probes `ARCLIGHT_WHISPER_URL` (HEAD `/docs` or `/asr`); when it answers, adds the whisperai provider last with `onlyWhenNoOtherResult` (a hand-configured entry is left alone) |
| `AnalyzeMedia` | `*/15 * * * *` (and on demand when files are queued) | media-analysis | Queues files without media info, then runs ffprobe over the queue N at a time |
| `TranscodeWorker` | `*/5 * * * *` (and on demand when jobs are queued) | transcode | Runs queued transcode jobs one at a time; rule/import jobs wait for their rule's window |
| `OrphanScan` | `0 2 * * 1` | library-hygiene | Orphan, duplicate and empty-folder scan of every root folder |
| `StatsSnapshot` | `15 0 * * *` | stats | Daily per-root-folder storage snapshot (keeps 400 days) |
| `DecisionLogCleanup` | `50 4 * * *` | releases | Deletes `release_decisions` rows older than `releases.decisionLogDays` (default 14) |
| `SceneMappingSync` | `23 5 * * *` | scene-mapping | Pulls the community scene-mapping feed and replaces the `feed` rules (404 = not published) |
| `DownloadEventsCleanup` | `41 3 * * *` | download-clients | Deletes download timeline entries (`download_events`) older than 30 days |
| `AuditCleanup` | `17 3 * * *` | audit | Deletes `audit_events` older than `audit.retentionDays` (nothing at 0) |
| `TrackerStatsSync` | `*/30 * * * *` | tracker-stats | Engine totals per tracker, then the account pages of enabled accounts with `scrapeAccount` |
| `CrossSeedSearch` | `crossSeed.schedule` (default `0 4 * * *`) | cross-seed | Searches up to `maxPerRun` files not searched within `searchIntervalDays`, newest first (nothing while disabled) |

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
| `download` | `action` (`event`), `event` (a DownloadEvent: new timeline entry of a tracked download) |
| `torrent` | `action` (`lockdown` `unlocked`), optional `reason`, `infoHashes` (torrents the kill switch paused / resumed) |
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
