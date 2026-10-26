# Requests Module Behaviour Specification (Seerr parity)

Scope: users, permissions, quotas, requests, approval to Radarr/Sonarr, issues, watchlist sync, availability sync, blocklist, discover, notifications, scheduled jobs. Source of truth is Seerr (Express, TypeORM). This document is plain English; where Seerr has a specific number or name it is given exactly. Items not verified in source are collected in "Open questions" at the end.

Conventions: "caller" is the authenticated user making an HTTP call; "requester" is the user the request belongs to (usually the same). "4K" means the parallel 4K tracking track. "Server" means a configured Radarr (movies) or Sonarr (series) instance.

---

## 1. Enumerations

### 1.1 Request status (stored on each request)

| Name | Value | Meaning |
|---|---|---|
| PENDING | 1 | Waiting for a manager to approve |
| APPROVED | 2 | Approved; sent (or being sent) to Radarr/Sonarr |
| DECLINED | 3 | Rejected |
| FAILED | 4 | Sending to Radarr/Sonarr failed |
| COMPLETED | 5 | Media became available |

### 1.2 Media status (stored on the media record; two tracks: normal and 4K)

| Name | Value | Meaning |
|---|---|---|
| UNKNOWN | 1 | Nothing known or wanted |
| PENDING | 2 | A request exists awaiting approval |
| PROCESSING | 3 | Approved/being downloaded or monitored in the downloader |
| PARTIALLY_AVAILABLE | 4 | Some of the content is in the library (series: some seasons) |
| AVAILABLE | 5 | In the library |
| BLOCKLISTED | 6 | Blocked from being requested |
| DELETED | 7 | Was available, now removed |

### 1.3 Other enums

| Enum | Values |
|---|---|
| Media type | "movie", "tv" |
| Media server type | PLEX=1, JELLYFIN=2, EMBY=3, NOT_CONFIGURED=4 |
| User type | PLEX=1, LOCAL=2, JELLYFIN=3, EMBY=4 |
| Issue type | VIDEO=1, AUDIO=2, SUBTITLES=3, OTHER=4 |
| Issue status | OPEN=1, RESOLVED=2 |

---

## 2. Users

### 2.1 Fields
1. Identity: id (integer; the first user, id 1, is the "owner" account whose media-server credentials every scanner and sync job uses), email (unique, always stored lowercased), username (optional display name), plexUsername, jellyfinUsername, userType (default PLEX), plexId, jellyfinUserId, jellyfinDeviceId.
2. Secrets (never returned to other users or in public views): password (bcrypt hash, 12 rounds), plexToken, jellyfinAuthToken, jellyfinDeviceId, resetPasswordGuid, plexId, email, settings. A "filtered" public view exposes only id, display names, userType, avatar, createdAt, updatedAt and request count.
3. Authorisation: permissions (integer bitmask, default 0), plus quota overrides movieQuotaLimit, movieQuotaDays, tvQuotaLimit, tvQuotaDays (all nullable; null means "use global default").
4. Avatar: avatar (url string), avatarETag, avatarVersion (integer bumped when the avatar changes, appended to the url as a cache-buster).
5. Recovery: recoveryLinkExpirationDate (24 hours after issue).
6. Relations: one settings record (section 2.7), push subscriptions, created issues, requests, watchlist items.
7. Display name: username if set, else plexUsername, else jellyfinUsername, else email.

### 2.2 Local users
1. Created by a caller with MANAGE_USERS. Body gives email (or username used as email), optional username, optional password, optional avatar.
2. Duplicate email (case-insensitive) returns HTTP 409 with error code USER_EXISTS.
3. If no password is supplied, the email notification agent must be enabled (otherwise the call fails); a random 16-character password is generated and emailed. If a password is supplied it is used as given.
4. New local user gets userType LOCAL, permissions = global default permissions (section 3.4), empty plexToken, avatar = a Gravatar URL for the email (default image "mm", size 200) unless the body gives an avatar.
5. Local sign-in works only when main setting localLogin is true (default true). It requires both email and password, matches the lowercased email and does a bcrypt compare. Failure returns 403 "Access denied" and logs a warning with the IP. Success sets a session cookie.
6. Password reset: user submits their email; a GUID is stored with a 24 hour expiry and an email is sent with a link of the form application-url/resetpassword/GUID. Setting a new password with a valid unexpired GUID clears the GUID. Requests for unknown emails must not reveal existence.
7. Logout destroys the session.

### 2.3 Plex-linked users
1. Sign-in posts a Plex auth token. The server fetches the Plex.tv account for it. A missing Plex account id is an error (500).
2. Access check: allowed if the account id equals the owner's plexId, or the account email equals the owner's email and the owner has no plexId yet, or Plex.tv confirms the account has access to the owner's server (shared library).
3. If a matching user exists (by plexId, else by email), update plexToken, plexId, plexUsername and refresh the avatar to the Plex thumbnail. If the user had no plexId yet, link it.
4. If none exists: create only when main setting newPlexLogin is true (default true); otherwise refuse. New user gets userType PLEX, global default permissions, avatar = Plex thumbnail, email from Plex.
5. The very first user created becomes the owner (id 1) with ADMIN (value 2). The media server type setting becomes PLEX on that first sign-in.
6. Import: a caller with MANAGE_USERS lists the owner's Plex shared users and imports selected plexIds. Each is created with default permissions, userType PLEX, avatar from Plex. Existing users (by plexId or email) are skipped. Returns the created users.
7. The plex-refresh-token job pings every stored Plex token daily so tokens stay valid (section 16).

### 2.4 Jellyfin and Emby users
1. Sign-in posts username and password (plus host and email when the server is not yet configured). Emby and Jellyfin share one code path; the configured media server type decides which.
2. The server authenticates against the media server using a device id derived from the username (stable per user) and obtains a user id and access token.
3. An existing user is matched by jellyfinUserId. If found, update token, device id, username and avatar. Avatar url has the form avatarproxy/JELLYFIN_USER_ID with a version query value; a check bumps avatarVersion when the media server's image tag changes.
4. If none exists: create only when main setting mediaServerLogin is true (default true). New user gets userType JELLYFIN or EMBY, the supplied or placeholder email, default permissions.
5. The first sign-in on an unconfigured instance sets the media server type and makes that user the owner (ADMIN).
6. Quick Connect (Jellyfin only): an initiate call returns a code and secret; a check call polls whether the user authorised it; when authorised, the secret is exchanged for a normal Jellyfin sign-in.
7. Import: a MANAGE_USERS caller lists server users and creates each selected one with the right userType, jellyfinUserId, avatar via the avatar proxy, default permissions, skipping existing.

### 2.5 Updating and deleting
1. A user can edit their own profile (display name; email on local accounts). Changing permissions requires MANAGE_USERS; a non-admin cannot modify an ADMIN user.
2. Bulk update lets MANAGE_USERS set permissions on many users at once.
3. Deleting a user cascades to their requests, issues, comments, watchlist items and push subscriptions. The owner (id 1) cannot be deleted.
4. User list parameters: take (default 10), skip, q (substring on email, username, plexUsername, jellyfinUsername), sort and sortDirection, includeIds.

### 2.6 Account settings
Per-user general settings: locale, discoverRegion, streamingRegion, originalLanguage (each empty means "use global"; "all" is a valid explicit value for streamingRegion and originalLanguage meaning "no restriction"), watchlistSyncMovies and watchlistSyncTv (booleans, default false). Quota overrides are editable only by MANAGE_USERS.

### 2.7 User settings record
Fields: locale, discoverRegion, streamingRegion, originalLanguage, pgpKey (for encrypted email), discordIds (list), pushbulletAccessToken, pushoverApplicationToken, pushoverUserKey, pushoverSound, telegramChatId, telegramMessageThreadId, telegramSendSilently, watchlistSyncMovies, watchlistSyncTv, notificationTypes (map from agent key to bitmask; section 12.4).
1. Discord ids must be valid snowflakes: 17 to 20 digits.
2. Region fields hold ISO 3166-1 codes; language holds ISO 639-1 codes.

---

## 3. Permissions

### 3.1 Flag table (bitmask, stored as one integer)

| Flag | Value | Meaning |
|---|---|---|
| NONE | 0 | Always satisfied |
| ADMIN | 2 | Bypasses every check |
| MANAGE_SETTINGS | 4 | Edit application settings |
| MANAGE_USERS | 8 | Create, edit, delete, import users; exempt from quotas; may request on behalf of others |
| MANAGE_REQUESTS | 16 | Approve, decline, retry, edit, delete any request; auto-approves own requests; may bypass quota; media-status admin |
| REQUEST | 32 | Request movies and series (non-4K) |
| VOTE | 64 | Reserved (no behaviour in source) |
| AUTO_APPROVE | 128 | Own non-4K requests (movie and tv) auto-approved |
| AUTO_APPROVE_MOVIE | 256 | Own non-4K movie requests auto-approved |
| AUTO_APPROVE_TV | 512 | Own non-4K series requests auto-approved |
| REQUEST_4K | 1024 | Request 4K movies and series |
| REQUEST_4K_MOVIE | 2048 | Request 4K movies |
| REQUEST_4K_TV | 4096 | Request 4K series |
| REQUEST_ADVANCED | 8192 | May choose server, quality profile, root folder, tags on a request |
| REQUEST_VIEW | 16384 | View all users' requests |
| AUTO_APPROVE_4K | 32768 | Own 4K requests (movie and tv) auto-approved |
| AUTO_APPROVE_4K_MOVIE | 65536 | Own 4K movie requests auto-approved |
| AUTO_APPROVE_4K_TV | 131072 | Own 4K series requests auto-approved |
| REQUEST_MOVIE | 262144 | Request non-4K movies only |
| REQUEST_TV | 524288 | Request non-4K series only |
| MANAGE_ISSUES | 1048576 | Full issue management |
| VIEW_ISSUES | 2097152 | See all users' issues |
| CREATE_ISSUES | 4194304 | Report issues and comment on own |
| AUTO_REQUEST | 8388608 | Watchlist sync may auto-request movies and series |
| AUTO_REQUEST_MOVIE | 16777216 | Watchlist sync may auto-request movies |
| AUTO_REQUEST_TV | 33554432 | Watchlist sync may auto-request series |
| RECENT_VIEW | 67108864 | See the "recently added" discover slider |
| WATCHLIST_VIEW | 134217728 | See other users' Plex watchlist |
| MANAGE_BLOCKLIST | 268435456 | Add and remove blocklist entries |
| (unused) | 536870912 | Not assigned |
| VIEW_BLOCKLIST | 1073741824 | See the blocklist |

### 3.2 Check semantics
1. A check passes if the user holds ADMIN (value 2), regardless of what is asked. This is the only "implied" permission; there is no automatic expansion of one flag into others.
2. Checking permission 0 always passes.
3. A check may supply a list of flags. Default combination is "and" (all required); an "or" mode passes if any is held. Example: to request a non-4K movie the test is (REQUEST or REQUEST_MOVIE).
4. Each flag is tested by bitwise AND against the stored integer.

### 3.3 Where the "or" families apply

| Action | Needs (any one) |
|---|---|
| Request movie | REQUEST or REQUEST_MOVIE |
| Request series | REQUEST or REQUEST_TV |
| Request 4K movie | REQUEST_4K or REQUEST_4K_MOVIE |
| Request 4K series | REQUEST_4K or REQUEST_4K_TV |
| Auto-approve movie | AUTO_APPROVE or AUTO_APPROVE_MOVIE or MANAGE_REQUESTS |
| Auto-approve series | AUTO_APPROVE or AUTO_APPROVE_TV or MANAGE_REQUESTS |
| Auto-approve 4K movie | AUTO_APPROVE_4K or AUTO_APPROVE_4K_MOVIE or MANAGE_REQUESTS |
| Auto-approve 4K series | AUTO_APPROVE_4K or AUTO_APPROVE_4K_TV or MANAGE_REQUESTS |
| Choose advanced options | MANAGE_REQUESTS or REQUEST_ADVANCED |
| Watchlist auto-request movie | AUTO_REQUEST or AUTO_REQUEST_MOVIE |
| Watchlist auto-request series | AUTO_REQUEST or AUTO_REQUEST_TV |
| View all requests | MANAGE_REQUESTS or REQUEST_VIEW |
| See issues of others | MANAGE_ISSUES or VIEW_ISSUES |
| Open issues | MANAGE_ISSUES or CREATE_ISSUES |

The 4K auto-approve rule does not accept the non-4K flags and vice versa.

### 3.4 Defaults
1. New users (local, imported, or first-time sign-in) receive main setting defaultPermissions, factory value REQUEST (32).
2. The owner (id 1) has ADMIN (2).
3. Example: 32 + 128 = 160 can request any non-4K title and it is auto-approved; cannot request 4K, cannot choose servers, cannot see others' requests.
4. Example: 32 + 1024 + 16 = 1072 can request 4K and non-4K; MANAGE_REQUESTS also auto-approves everything and allows approve/decline.

### 3.5 View-style permissions
1. REQUEST_VIEW: list and read any request. Without REQUEST_VIEW or MANAGE_REQUESTS a user sees only their own; asking for another user's list returns 403.
2. VIEW_ISSUES: read all issues. VIEW_BLOCKLIST: read the blocklist.
3. RECENT_VIEW shows the recently added slider. WATCHLIST_VIEW lets the user view other users' Plex watchlists; users without it see only their own.

---

## 4. Quotas

1. Two independent quotas: movie and series. Each has a limit (count) and days (window length).
2. Global defaults: main setting defaultQuotas has movie and tv entries, each with optional quotaLimit and quotaDays. Factory: both empty (no quota).
3. A user override replaces the corresponding global value when non-null. Limit and days are overridden independently.
4. Exempt: anyone with MANAGE_USERS (and therefore ADMIN) is treated as having limit 0 (unlimited). MANAGE_REQUESTS alone is not exempt but can set ignoreQuota on a request (section 5.4).
5. Limit 0 or unset means unlimited. Days unset or 0 means no window (open question 5).
6. Window: a request counts if its createdAt is later than "now minus days".
7. Movie used = number of the user's movie requests in the window with status not DECLINED and ignoreQuota false.
8. Series used = sum of the seasons counts across the user's series requests in the window with status not DECLINED and ignoreQuota false. A request for 3 seasons costs 3; "all seasons" costs the number of seasons actually requested after exclusions.
9. Remaining = max(0, limit minus used) when a limit applies; undefined otherwise. Restricted = a limit applies and limit minus used is 0 or less.
10. FAILED and COMPLETED requests still count; only DECLINED are refunded. Deleting a request removes it from the count.
11. Output shape per type: days, limit, used, remaining, restricted.
12. Example: tv limit 5 per 7 days; user requested 2 seasons yesterday and 1 season 9 days ago; used 2, remaining 3. Requesting 4 seasons is refused with "Series Quota exceeded." even though restricted is false, because requested seasons exceed remaining.
13. Example: movie limit 2 per 30 days, used 2: restricted true, request refused with "Movie Quota exceeded." (HTTP 403).
14. Editing a pending series request to add seasons charges only the net new seasons, and only when the owner is unchanged and the request is inside the window. Changing the owner of a pending movie request re-checks the new owner's quota unless ignoreQuota.

---

## 5. Creating a request

### 5.1 Input
mediaType (movie or tv), mediaId (TMDB id), tvdbId (optional), seasons (list of numbers, or "all"; required for tv), is4k (default false), serverId, profileId, profileName, rootFolder, languageProfileId, userId (request on behalf of another), tags (list of integer tag ids), ignoreQuota.

### 5.2 Concurrency
Creation is serialised with a lock per requesting user and a lock per media (key is media type plus id; the 4K flag is not part of the key), so duplicate checks cannot race.

### 5.3 Step order
1. If userId is given and differs from the caller, the caller needs MANAGE_USERS or MANAGE_REQUESTS; otherwise a permission error. All further checks use that user.
2. Permission to request (table 3.3) is checked on the requester. Failure is a permission error (403).
3. Quota check (5.4).
4. Fetch TMDB details (title, seasons, tvdb id, keywords, genres).
5. Find or create the media record. New media: status = PENDING if not 4K else UNKNOWN; status4k = PENDING if 4K else UNKNOWN; tvdbId = body tvdbId or the TMDB external tvdb id.
6. If the media is BLOCKLISTED, fail with 403.
7. If the requested track's status is UNKNOWN or DELETED, set it to PENDING.
8. Duplicate checks (5.5).
9. Resolve server, profile, folder, tags via override rules (section 8).
10. Decide status (5.6) and store.

### 5.4 Quota details
1. Quota is read for the requester and the relevant media type.
2. ignoreQuota=true is honoured only when the caller has MANAGE_REQUESTS and the requester's quota limit is above 0. If the caller lacks MANAGE_REQUESTS the call fails with a permission error. When honoured, the request is stored with ignoreQuota true so it never counts in usage.
3. Restricted movie requester: "Movie Quota exceeded." Restricted tv: "Series Quota exceeded." Both 403.

### 5.5 Duplicate and exclusion rules
1. Movie: an existing request for the same media and same is4k that is neither DECLINED nor COMPLETED gives 409.
2. Any media: an existing request marked isAutoRequest by the same user for this media, whose media status is not DELETED, gives a duplicate error (stops watchlist sync from re-requesting).
3. Series "all" means every TMDB season except season 0 and except seasons whose episode_count is 0.
4. If enableSpecialEpisodes is false (default), season 0 is always dropped even if listed explicitly.
5. Seasons are excluded if already covered by a non-DECLINED, non-COMPLETED request of the same is4k, or if the media's Season on that track has a status other than UNKNOWN or DELETED.
6. If no seasons remain, return HTTP 202 "no seasons available" (no request created).
7. If the series quota has a limit and the remaining seasons count exceeds quota remaining, fail as quota restricted.
8. partialRequestsEnabled (default true): when false clients are expected to request all seasons; server enforcement unverified (open question 6).

### 5.6 Status assignment
1. APPROVED if the requester holds the matching auto-approve combination (table 3.3), MANAGE_REQUESTS or ADMIN; modifiedBy is then the requester. Otherwise PENDING.
2. Series: each SeasonRequest receives the parent's status. languageProfileId is stored.
3. Stored on every request: is4k, serverId, profileId, rootFolder, languageProfileId, tags, isAutoRequest, ignoreQuota, requestedBy, modifiedBy, createdAt, updatedAt.
4. Tags persist as a comma separated string; the text "none" represents an empty list.

### 5.7 HTTP results

| Outcome | Status |
|---|---|
| Created | 201 |
| No seasons to request | 202 |
| Permission or quota error | 403 |
| Blocklisted media | 403 |
| Duplicate | 409 |
| Anything else | 500 |

---

## 6. Request endpoints

1. List: take (default 10), skip, requestedBy, mediaType (all, movie, tv), filter, sort (modified, added, id), sortDirection (asc or desc, default desc). Returns pageInfo and results. Each result gets profileName looked up from Radarr/Sonarr and canRemove (true for MANAGE_REQUESTS). serviceErrors lists servers whose profiles could not be fetched.
2. Filters:

| Filter | Request status | Media status restriction |
|---|---|---|
| (none/all) | any | none |
| pending | PENDING | none |
| approved | APPROVED | none |
| processing | APPROVED | UNKNOWN, PENDING, PROCESSING, PARTIALLY_AVAILABLE |
| unavailable | PENDING or APPROVED | UNKNOWN, PENDING, PROCESSING, PARTIALLY_AVAILABLE |
| failed | FAILED | none |
| completed | COMPLETED | none |
| available | COMPLETED | AVAILABLE |
| deleted | COMPLETED | DELETED |

3. Users without MANAGE_REQUESTS or REQUEST_VIEW see only their own requests; asking for another user's returns 403.
4. Count: total, movie, tv, pending, approved, declined, processing, available, completed.
5. Get one: the requester, MANAGE_REQUESTS or REQUEST_VIEW.
6. Update: allowed for MANAGE_REQUESTS, or the owner (movie owners additionally need REQUEST_ADVANCED; series owners need nothing extra). Only PENDING requests, else 409. Editable: userId (needs MANAGE_USERS or MANAGE_REQUESTS), serverId, profileId, rootFolder, tags, languageProfileId; for series the seasons list (must be non-empty; recomputed with the exclusion rules; 202 if nothing results; new SeasonRequests are PENDING).
7. Delete: MANAGE_REQUESTS, or the owner while PENDING. Returns 204; otherwise 401.
8. Retry: MANAGE_REQUESTS, only FAILED (else 409). Sets APPROVED and modifiedBy, re-triggering the send.
9. Approve and decline: MANAGE_REQUESTS, only PENDING (else 409). Sets status and modifiedBy.
10. Media-level admin endpoints (MANAGE_REQUESTS): mark a track available, partial (series only), processing, pending or unknown (is4k in the body); marking a series available may list seasons to flag AVAILABLE (creating Season rows). Delete media: if BLOCKLISTED only service data is reset, otherwise the record is removed. Delete file: asks the Radarr/Sonarr server (default, or the media's stored server) to remove the movie or series, sets status DELETED (every season for series) and resets service data; 409 if no server is configured. Watch data via Tautulli is ADMIN only.
11. Media list: take (default 20), filter (available, partial, allavailable, processing, pending), sort (modified, mediaAdded).

---

## 7. Request and media lifecycle

### 7.1 Request status transitions
1. PENDING to APPROVED (manual or auto-approve at creation).
2. PENDING to DECLINED.
3. APPROVED to FAILED (downloader rejected or unreachable).
4. FAILED to APPROVED (retry).
5. APPROVED or FAILED to COMPLETED (media became available or deleted; 7.3).
6. APPROVED to COMPLETED immediately if at send time the media track is already AVAILABLE.
7. APPROVED to DECLINED automatically when a downloader scan finds the item vanished (10.5).
8. Any to removed (delete).

### 7.2 Media status rules driven by requests
1. Request approved and track not in AVAILABLE, PARTIALLY_AVAILABLE or PROCESSING: track becomes PROCESSING.
2. Request PENDING at creation: track PENDING (if it was UNKNOWN or DELETED).
3. Movie request declined: track becomes UNKNOWN unless DELETED.
4. Series request declined: its SeasonRequests become DECLINED. If the track is PENDING and no other PENDING request of the same is4k exists, the track becomes UNKNOWN. Each media Season that is PENDING and not covered by another active (not declined, not completed) request goes to UNKNOWN.
5. Series approved: all its SeasonRequests become APPROVED.
6. Request removed: if no active (not COMPLETED, not DECLINED) request of that is4k remains and the track is not AVAILABLE or PARTIALLY_AVAILABLE, the track becomes DELETED if any COMPLETED request existed, else UNKNOWN. For series, PENDING or PROCESSING seasons not covered by another active request go to UNKNOWN.
7. A track moving from PENDING to AVAILABLE (scanner or admin) first turns all PENDING requests on that track into APPROVED.

### 7.3 Completion
1. When media status or any season status changes and the new status is PARTIALLY_AVAILABLE, AVAILABLE or DELETED, requests on the same track with status APPROVED or FAILED are re-evaluated.
2. Movie: AVAILABLE or DELETED completes the request.
3. Series: a requested season is complete when the matching media Season is AVAILABLE or DELETED and either its status just changed or the SeasonRequest was already COMPLETED. The request is COMPLETED when all requested seasons are complete. A season missing from the media is not complete.
4. Completion sends the "available" notification: movies if media is AVAILABLE; series only when every requested season is AVAILABLE in the media (and at least one).

### 7.4 4K tracking
1. Media holds two parallel tracks: status, serviceId, externalServiceId, externalServiceSlug, ratingKey, jellyfinMediaId and the same with a 4K suffix. Seasons likewise hold status and status4k.
2. A request's is4k flag chooses the track. Requests of different is4k never interfere (duplicates, exclusions, completion, decline all filter by is4k).
3. 4K tracks are populated by scanners only when a 4K server exists (any Radarr/Sonarr with is4k true). Public settings expose movie4kEnabled and series4kEnabled, true when a default 4K server exists.
4. One physical server can be configured twice (normal and 4K); file resolution then distinguishes them (width 2000 or more is 4K).

### 7.5 Media record
Unique on tvdbId; indexed on (tmdbId, mediaType). Extra fields: mediaAddedAt, lastSeasonChange, imdbId. Derived, not stored: media urls (Plex web link of the form app/#!/server/MACHINEID/details?key=/library/metadata/RATINGKEY; Jellyfin/Emby web/index.html#!/details?id=... with Emby using "item"), service url, downloadStatus and downloadStatus4k, hasActiveRequest (when "hide requested" is on).

---

## 8. Override rules

Purpose: choose root folder, quality profile and tags automatically per request.

### 8.1 Rule fields
radarrServiceId or sonarrServiceId (owning server), users (comma separated user ids), genre (comma separated TMDB genre ids), language (pipe separated ISO 639-1 codes), keywords (comma separated TMDB keyword ids), profileId, rootFolder, tags (comma separated tag ids). Server settings list their attached rule ids.

### 8.2 Algorithm
1. Service id = the request's serverId if valid, else the default server whose is4k matches.
2. Load rules for that service.
3. Anime series (TMDB keyword 210024 present) skip every rule unless the rule's keyword list explicitly contains 210024.
4. A rule matches only if every non-empty condition holds: users must include the requester; genre needs at least one overlap with the title's genres; language must equal the title's original_language; keywords need at least one overlap (movie keywords from the keywords list, tv from the results list).
5. Choose the match with the most specified conditions among genre, language, keywords. Ties: first in stored order.
6. Apply rootFolder and profileId if set. Tags are unioned with the request's tags.
7. Advanced callers (MANAGE_REQUESTS or REQUEST_ADVANCED): rule output fills only fields the body left unset. Non-advanced callers: rule output overrides.

### 8.3 Example
Rule A: genre [16], language "ja", profile 7, root "/anime". Rule B: genre [16], profile 4. A Japanese animated title matches both; A has two conditions so wins: profile 7, root "/anime".

---

## 9. Approval: what is sent to the downloader

Triggered whenever a request is inserted or updated with status APPROVED. Work happens asynchronously after the request is stored.

### 9.1 Server selection
1. Candidate = the default server (isDefault) whose is4k equals the request's is4k.
2. If request.serverId is 0 or higher and differs from the default, use that server.
3. No servers configured or no default match: log and do nothing; the request stays APPROVED.
4. If the media track is already AVAILABLE: mark the request (and its seasons) COMPLETED and send nothing.

### 9.2 Radarr (movies)

| Field | Source |
|---|---|
| rootFolderPath | request.rootFolder, else server activeDirectory |
| quality profile | request.profileId, else server activeProfileId |
| tags | request.tags if different from the server's, else server tags; plus the user tag if tagRequests |
| minimumAvailability | server setting (announced, inCinemas, released) |
| title, tmdbId, year | from TMDB (year from release date) |
| monitored | true |
| search on add | true unless server preventSearch is true |

On success store serviceId (server id), externalServiceId (Radarr movie id) and externalServiceSlug (title slug) on the matching track.

### 9.3 Sonarr (series)
1. tvdbId from TMDB external ids, falling back to media.tvdbId. If missing, delete the media and request and fail.
2. Anime = TMDB keywords contain id 210024.
3. seriesType = server seriesType (default "standard"); if anime, server animeSeriesType (default "anime"). Allowed: standard, daily, anime.

| Field | Standard | Anime (when anime values set) |
|---|---|---|
| rootFolderPath | activeDirectory | activeAnimeDirectory |
| quality profile | activeProfileId | activeAnimeProfileId |
| language profile | activeLanguageProfileId | activeAnimeLanguageProfileId |
| tags | tags | animeTags |

4. Request-level rootFolder, profileId, languageProfileId, tags override on top.
5. Other fields: title, tvdbid, seasons (requested season numbers, each monitored), seasonFolder = server enableSeasonFolders, monitored true, monitorNewItems (server setting "all" or "none": whether future seasons are monitored), search on add = not preventSearch.

### 9.4 User tags
When server tagRequests is true: ensure a tag labelled "USERID-sanitizedDisplayName" exists on the server (create if not). Sanitising removes diacritics, turns spaces into hyphens, removes non-alphanumerics, collapses repeated hyphens and trims them. An older label "ID - name" is matched by id prefix so renames reuse the tag. The tag id is added to the tag list.

### 9.5 Failure
Any exception (connection, bad config, API rejection) sets the request FAILED, sends MEDIA_FAILED to admins/system, and logs. Retry (section 6) re-runs.

### 9.6 Server settings
id, name, hostname, port, apiKey, useSsl, baseUrl, activeProfileId, activeProfileName, activeDirectory, tags, is4k, isDefault, externalUrl, syncEnabled, preventSearch, tagRequests, overrideRule list. Radarr adds minimumAvailability. Sonarr adds seriesType, animeSeriesType, anime profile/directory/language profile/tags, activeLanguageProfileId, enableSeasonFolders, monitorNewItems.

---

## 10. Availability sync

### 10.1 Overview
Library scanners (Plex or Jellyfin/Emby) mark things AVAILABLE; Radarr and Sonarr scanners mark PROCESSING and attach ids; the availability sync demotes things that disappeared; the download tracker reports live progress.

### 10.2 Scanner base behaviour
1. Bundle size 20 (50 for Plex, Radarr, Sonarr); pause 4000 ms between bundles. One run per scanner; a new run cancels the old.
2. Movies: an existing AVAILABLE is never downgraded by a scan. Has file and not processing: AVAILABLE. Processing (monitored, no file): PROCESSING (DELETED stays DELETED). No file and was PROCESSING: UNKNOWN. Media records are created only if there is a file or it is processing. 4K status is only touched if a 4K server exists.
3. Series: per-season status. AVAILABLE when episodes found equals total and is above 0, or already AVAILABLE. PARTIALLY_AVAILABLE when some episodes found. PROCESSING when monitored in Sonarr with no files. A season with 0 total episodes is zeroed.
4. Series rollup per track: AVAILABLE if every non-special season is AVAILABLE; else PARTIALLY_AVAILABLE if any season is partial or available; else PROCESSING if any season is processing (or no seasons known); else DELETED stays, otherwise UNKNOWN. lastSeasonChange updates when seasons newly become AVAILABLE.
5. Fills mediaAddedAt, ratingKey or jellyfinMediaId, imdbId and service ids.

### 10.3 Plex matching
1. Uses the owner's Plex token and only libraries enabled in settings (each library: id, name, enabled, type movie or show, lastScan).
2. Recently added scan: items added since lastScan minus a 10 minute buffer, de-duplicated by item, parent and grandparent key; lastScan updated per library after the run. Full scan pages the whole library.
3. Id resolution from the item guid. New Plex agent: guid list with imdb, tmdb, tvdb entries, preferring tmdb; imdb-only or tvdb-only resolve to TMDB through TMDB "find". Legacy imdb agent: resolve imdb to TMDB. Legacy tmdb agent: used directly. Legacy tvdb agent: resolve via tvdb. The themoviedb agent id is a TMDB id. Hama anime agent: tvdb ids resolve via tvdb; anidb ids resolve through an anidb to tvdb/tmdb/imdb anime list.
4. No TMDB id: skip with "unable to find TMDB ID".
5. Movies: 4K when any version has resolution "4k" and 4K movies are enabled.
6. Series: children metadata gives seasons and episodes. Season 0 ignored unless enableSpecialEpisodes. Per TMDB season count episodes with a non-4K version (all episodes if 4K disabled) and, if 4K enabled, episodes with a 4K version. Total episodes comes from TMDB episode_count. Hama specials are treated as movies via the anime list.
7. The TV metadata provider (TMDB or TVDB) is configurable separately for tv and anime; anime detected by keyword 210024.

### 10.4 Jellyfin and Emby matching
1. Uses the owner's user id and device id with the server api key; only enabled libraries; recent scans de-duplicate by series, season or item id.
2. Movie ids from provider ids: Tmdb (or TheMovieDb), else Imdb resolved to TMDB, else AniDB via the anime list.
3. Movie 4K: any video stream width above 2000. Standard exists if any stream width is 2000 or less; with no 4K server, 4K-only files count as standard. The 4K record is created only if a 4K stream exists and a 4K server is enabled.
4. Series ids: Tmdb, then Tvdb, then AniDB (anime list with tvdb season mapping; movie-like entries handled as movies). Seasons match by IndexNumber equals TMDB season number. Episodes are counted per episode; multi-episode files count IndexNumberEnd minus IndexNumber plus 1. With a 4K server, an episode with both versions counts in both tracks. AniDB entries accumulate across seasons.
5. mediaAddedAt = the item's DateCreated.

### 10.5 Radarr and Sonarr scanners
1. Servers are de-duplicated by host, port and base url; only syncEnabled servers are scanned.
2. Radarr: processing = no file and monitored; sets service id, external id, slug, 4K track if the server is 4K.
3. Sonarr: tmdb id via stored tvdbId, else TMDB find by tvdb. Per season: episodes = episodeFileCount, total = totalEpisodeCount, processing = monitored and no files, 4K when server is 4K.
4. Orphan cleanup after all servers scan: only if every server of that profile type (normal or 4K) has syncEnabled and none returned an empty list. For media in PROCESSING not seen, confirm absence directly on every server (an API failure counts as "exists"). If absent: track UNKNOWN (and PROCESSING seasons UNKNOWN) and the APPROVED requests on that track are DECLINED. Media that became unmonitored with no file is reset the same way and its requests declined.

### 10.6 Availability sync job (demotion of removed media)
1. Pages through media whose status, status4k or any season status is AVAILABLE or PARTIALLY_AVAILABLE (page size 50). Uses the owner account (id 1) to reach Plex or Jellyfin/Emby; Jellyfin first verifies server info.
2. Per track, "exists" means present in the media server or present with a file in the matching Radarr/Sonarr servers (Radarr by stored external id, checking tmdbId matches; Sonarr by stored series id, checking tvdbId matches and episodeFileCount above 0).
3. Plex existence uses the stored ratingKey. With 4K enabled, a normal movie whose versions are all 2000 wide or more does not count as normal; a 4K track needs at least one version 2000 wide or more. Series 4K needs at least one 4K episode. In Radarr, when the same server serves both modes, resolution width of 2000 or more decides.
4. Errors other than "not found" (404) are treated as "exists" and suppress the per-season check, to avoid false deletion.
5. Series per-season existence: on Plex a season exists if the season entry has at least one episode version (4K rules as above; failing to fetch episodes counts as existing); on Sonarr if season statistics report episodeFileCount above 0. Seasons not found are false.
6. A movie not found anywhere with status AVAILABLE or partial gets mediaUpdater. A series not found anywhere with track or any season AVAILABLE or PARTIALLY_AVAILABLE gets mediaUpdater. A series found but with some seasons missing gets seasonUpdater.
7. mediaUpdater: sets the track DELETED. If an APPROVED request of that is4k is still in flight it keeps service ids, external ids, slug, ratingKey and jellyfinMediaId; otherwise it nulls them.
8. seasonUpdater: every missing season that was AVAILABLE or PARTIALLY_AVAILABLE becomes DELETED. If any non-special season is missing and the track is AVAILABLE, the track becomes PARTIALLY_AVAILABLE (specials alone do not demote). lastSeasonChange is set to now.
9. DELETED triggers 7.3 so requests complete.

### 10.7 Download sync
1. Each minute, for every Radarr/Sonarr server with syncEnabled (de-duplicated by host), refresh monitored downloads then read the queue.
2. Each queue item maps to: externalId (movie id or series id), estimatedCompletionTime, mediaType, size, sizeLeft, status, timeLeft, title, downloadId, and for series the episode.
3. Data is copied to servers sharing the same host. It is exposed on Media as downloadStatus and downloadStatus4k, looked up by (serviceId, externalServiceId). A daily reset at 01:00 clears stored data.

---

## 11. Watchlist and watchlist sync

### 11.1 Watchlist records
1. Unique on (tmdbId, mediaType, requestedBy). Fields: ratingKey, mediaType, title, tmdbId, requestedBy, media link.
2. Creating one fetches TMDB, finds or creates the media (status UNKNOWN) and rejects duplicates with 409. Create returns 201. Delete by tmdbId with mediaType query returns 204; missing 404; bad mediaType 400.
3. Viewing: users see their own Plex watchlist; others' only with WATCHLIST_VIEW.

### 11.2 Sync job
1. Every 3 minutes (Plex only). Considers users with a plexToken, at least one of AUTO_REQUEST, AUTO_REQUEST_MOVIE, AUTO_REQUEST_TV, and watchlistSyncMovies or watchlistSyncTv enabled.
2. Fetches the user's Plex watchlist (page size 20, ETag cache). Items without a TMDB id are dropped.
3. Skip an item if: this user already has an auto-request on its media whose media status is not DELETED; media is BLOCKLISTED; a movie whose status is anything other than UNKNOWN or DELETED; a series whose status is AVAILABLE.
4. Series need a tvdbId. Movie needs (AUTO_REQUEST or AUTO_REQUEST_MOVIE) and watchlistSyncMovies. Series need (AUTO_REQUEST or AUTO_REQUEST_TV) and watchlistSyncTv.
5. Creates a normal request (section 5) as that user: is4k false, seasons "all" for series, isAutoRequest true. All normal checks apply (permission, quota, duplicates, exclusions, auto-approve).
6. Errors: permission, duplicate, quota and no-seasons are logged at debug level; blocklisted is silently ignored; everything else is logged as an error.
7. Notifications: pending auto-requests send MEDIA_PENDING plus MEDIA_AUTO_REQUESTED; auto-approved ones send MEDIA_AUTO_APPROVED to admins and MEDIA_AUTO_REQUESTED to the user.

---

## 12. Notifications

### 12.1 Event types (bitmask)

| Event | Value |
|---|---|
| NONE | 0 |
| MEDIA_PENDING | 2 |
| MEDIA_APPROVED | 4 |
| MEDIA_AVAILABLE | 8 |
| MEDIA_FAILED | 16 |
| TEST_NOTIFICATION | 32 |
| MEDIA_DECLINED | 64 |
| MEDIA_AUTO_APPROVED | 128 |
| ISSUE_CREATED | 256 |
| ISSUE_COMMENT | 512 |
| ISSUE_RESOLVED | 1024 |
| ISSUE_REOPENED | 2048 |
| MEDIA_AUTO_REQUESTED | 4096 |

The test event always passes any mask check; mask 0 passes any check.

### 12.2 Who gets what

| Event | Admin/system audience | Requester audience |
|---|---|---|
| MEDIA_PENDING | admins with MANAGE_REQUESTS, system agents | none |
| MEDIA_AUTO_APPROVED | admins with MANAGE_REQUESTS, system | none |
| MEDIA_AUTO_REQUESTED | none | the requester |
| MEDIA_APPROVED, MEDIA_DECLINED, MEDIA_AVAILABLE | none | requester |
| MEDIA_FAILED | admins with MANAGE_REQUESTS, system | none |
| ISSUE_CREATED | admins with MANAGE_ISSUES, system | none |
| ISSUE_COMMENT, RESOLVED, REOPENED | admins with MANAGE_ISSUES, system | issue creator (13.6) |

Admin permission mapping: media events need MANAGE_REQUESTS, issue events need MANAGE_ISSUES, anything else needs ADMIN. Admin sends exclude: the explicit notifyUser; AUTO_APPROVED where the user is the modifier or the requester; ISSUE_CREATED where the user is the creator; ISSUE_COMMENT where the user is the commenter; RESOLVED/REOPENED where the user is the modifier.

### 12.3 Payload
Event title (examples: "New Movie Request", "New 4K Movie Request", "Series Request Approved", "Movie Request Now Available"), subject (media title with year), message (overview truncated to 500 characters), image (TMDB poster, size w600_and_h900), extra fields (series adds "Requested Seasons"), request, issue, comment, pendingRequestsCount (webpush), and flags notifySystem, notifyAdmin, notifyUser.

### 12.4 Agents
Agent keys: discord, email, gotify, ntfy, pushbullet, pushover, slack, telegram, webhook, webpush.
1. System-wide agents (discord, slack, telegram, pushbullet, pushover, gotify, ntfy, webhook) send only when the payload has notifySystem and the agent's global types mask includes the event. All agents ship disabled. embedPoster default true, except pushbullet and gotify (false). Email defaults: smtp port 587, sender name "Seerr". ntfy priority 3.
2. Email and webpush have no global types mask and are per-user only.
3. Per-user delivery also needs the user's per-agent mask (notificationTypes) to include the event:
   - email: user's email, optional PGP key, user locale.
   - discord: mentions the user's discordIds when mentions are enabled (valid snowflakes only).
   - telegram: user's chat id, thread id, silent flag.
   - pushover: user's application token, user key, sound.
   - pushbullet: user's access token.
   - webpush: stored subscriptions (endpoint, p256dh, auth, userAgent; unique on endpoint plus user).
4. Per-user default masks: email = all event bits, webpush = all event bits, every other agent = 0. Unknown agent keys in saved settings are discarded.
5. Webhook default payload carries: notification_type, event, subject, message, image, a media block (media_type, tmdbId, tvdbId, status, status4k), a request block (request_id, requestedBy email/username/avatar, discord id, telegram chat id), an issue block (issue_id, issue_type, issue_status, reportedBy fields), a comment block (comment_message, commentedBy fields), and an extra list. A user-defined JSON template with variable substitution is supported.

### 12.5 Request notification timing
1. Insert as PENDING: MEDIA_PENDING (and MEDIA_AUTO_REQUESTED if auto).
2. Insert auto-approved: MEDIA_AUTO_APPROVED to admins and system; MEDIA_AUTO_REQUESTED to the user if auto.
3. Manual approve: MEDIA_APPROVED to the requester; if media already AVAILABLE send MEDIA_AVAILABLE instead.
4. Decline: MEDIA_DECLINED. Failed: MEDIA_FAILED. Completed: MEDIA_AVAILABLE (series: all requested seasons AVAILABLE).

---

## 13. Issues

### 13.1 Data
Issue: issueType, status (default OPEN), problemSeason (default 0), problemEpisode (default 0), media, createdBy, modifiedBy, comments (ordered by id), createdAt, updatedAt. Comment: user, issue, message.

### 13.2 Create
1. Needs MANAGE_ISSUES or CREATE_ISSUES. Reporting on behalf of another user (userId in body) needs MANAGE_ISSUES.
2. Body: issueType, message (required; becomes the first comment by the creator), mediaId, problemSeason, problemEpisode.

### 13.3 Read
List and get need MANAGE_ISSUES, VIEW_ISSUES or CREATE_ISSUES. Without MANAGE_ISSUES or VIEW_ISSUES a user sees only their own and gets 403 for another user's. List: take (default 10), skip, sort ("modified" orders by updatedAt, otherwise createdAt), always descending, filter (open, resolved, all), createdBy. Count: total, video, audio, subtitles, others, open, closed.

### 13.4 Comments
1. Add: MANAGE_ISSUES, or CREATE_ISSUES on one's own issue. Bumps issue updatedAt.
2. Edit: author only. Delete: author or MANAGE_ISSUES.

### 13.5 Status and delete
1. Resolve or reopen: creator or MANAGE_ISSUES (else 401). Sets modifiedBy.
2. Delete issue: MANAGE_ISSUES, or the creator while the issue has at most one comment.

### 13.6 Notifications
1. ISSUE_CREATED: admins with MANAGE_ISSUES and system.
2. ISSUE_COMMENT (not sent for the first comment): admins, plus the creator when the creator lacks MANAGE_ISSUES and is not the commenter.
3. ISSUE_RESOLVED and ISSUE_REOPENED: admins, plus the creator when the creator lacks MANAGE_ISSUES and is not the modifier.
4. Event titles: "New Video Issue Reported", "New Audio Issue Reported", "New Subtitle Issue Reported"; for type OTHER the type word is omitted. Series issues add "Affected Season" and "Affected Episode" extras when both problemSeason and problemEpisode are above 0. The message is the first comment.
5. Media records only expose issues to users holding MANAGE_ISSUES, VIEW_ISSUES or CREATE_ISSUES.

---

## 14. Blocklist

1. Entry: unique on (tmdbId, mediaType). Fields: mediaType, title, tmdbId, user (who added), media (one-to-one, deleted with the entry), blocklistedTags (comma-wrapped list such as ",123,456," when added by tag processing), createdAt.
2. Adding an entry creates or updates the Media record with status and status4k both BLOCKLISTED. Needs MANAGE_BLOCKLIST; viewing needs VIEW_BLOCKLIST.
3. Effects: request creation on blocklisted media fails with 403; watchlist sync silently skips it; discover hides it when main setting hideBlocklisted is true.
4. Removing an entry removes the blocklisted media state (cascade).
5. Tag processor job (process-blocklisted-tags): main setting blocklistedTags holds comma-separated TMDB keyword ids; blocklistedTagsLimit (default 50) caps pages per query. Steps: delete previously tag-created entries (media with blocklistedTags, batches of 500); for each keyword, query TMDB discover for movies and tv for each sort option up to the page limit with a 250 ms pause between calls, using blocklistRegion and blocklistLanguage; existing tagged entries gain the tag; new titles are blocklisted with the tag; invalid keywords are removed from settings. Runs in a transaction and is cancellable.
6. Settings: blocklistRegion, blocklistLanguage, blocklistedTags (default empty), blocklistedTagsLimit (50), hideBlocklisted (false).

---

## 15. Discover

### 15.1 Slider types

| Name | Value | Notes |
|---|---|---|
| RECENTLY_ADDED | 1 | needs RECENT_VIEW |
| RECENT_REQUESTS | 2 | |
| PLEX_WATCHLIST | 3 | others' lists need WATCHLIST_VIEW |
| TRENDING | 4 | |
| POPULAR_MOVIES | 5 | |
| MOVIE_GENRES | 6 | |
| UPCOMING_MOVIES | 7 | |
| STUDIOS | 8 | |
| POPULAR_TV | 9 | |
| TV_GENRES | 10 | |
| UPCOMING_TV | 11 | |
| NETWORKS | 12 | |
| TMDB_MOVIE_KEYWORD | 13 | custom; data = keyword id |
| TMDB_MOVIE_GENRE | 14 | custom; data = genre id |
| TMDB_TV_KEYWORD | 15 | custom |
| TMDB_TV_GENRE | 16 | custom |
| TMDB_SEARCH | 17 | custom; data = query |
| TMDB_STUDIO | 18 | custom; data = studio id |
| TMDB_NETWORK | 19 | custom; data = network id |
| TMDB_MOVIE_STREAMING_SERVICES | 20 | custom |
| TMDB_TV_STREAMING_SERVICES | 21 | custom |

### 15.2 Storage and ordering
1. Slider record: id, type, order (integer), isBuiltIn, enabled, title (null for built-ins, set for custom), data (string payload such as an id or search text), createdAt, updatedAt.
2. Defaults: the first twelve types in enum order, order 0 through 11, all enabled, isBuiltIn true. At startup any missing built-in type is created.
3. Built-ins can be disabled and reordered, not deleted. Custom sliders can be created, edited, deleted. Reordering rewrites the order of all sliders. Reset restores defaults (contracts unverified; open question 7).
4. Main settings hideAvailable, hideBlocklisted, hideRequested (all false) filter slider results.

### 15.3 Common discover rules
1. Region and language come from the user: streamingRegion (blank falls back to main discoverRegion; "all" means none), originalLanguage (blank falls back to main originalLanguage; "all" means none). The effective region is sent as TMDB region; the language restriction becomes with_original_language. Watch providers need watch_region.
2. Paging uses page; interface language is the request locale or the "language" query value.
3. Date ranges: if only one end of a release date range is supplied the other is filled (past default 1900-01-01, future default far in the future) because TMDB needs both.
4. Adult content excluded; include_video false.
5. Results are annotated with local Media status and optionally the active request.

### 15.4 Sort options
Common: popularity.desc/asc, vote_average.desc/asc, vote_count.desc/asc. Movies add release_date.desc/asc, revenue.desc/asc, primary_release_date.desc/asc, original_title.desc/asc. Series add first_air_date.desc/asc, original_name.desc/asc. Default for both is popularity.desc. An invalid sort value is ignored (falls back to the default).

### 15.5 Parameters per page

| Page | TMDB endpoint | Parameters |
|---|---|---|
| Movies (popular and filtered) | discover/movie | sort_by, page, primary_release_date.gte/lte, with_genres, with_companies (studio), with_keywords, without_keywords, with_runtime.gte/lte, vote_average.gte/lte, vote_count.gte/lte, with_watch_providers, watch_region, certification (plus .gte/.lte and certification_country), with_original_language, region |
| TV (popular and filtered) | discover/tv | sort_by, page, first_air_date.gte/lte, include_null_first_air_dates, with_genres, with_networks, with_keywords, without_keywords, with_runtime, vote_average, vote_count, with_watch_providers, watch_region, with_status, certification, with_original_language, region |
| Movies by genre | discover/movie | with_genres = genre id |
| Movies by studio | discover/movie | with_companies = studio id |
| Movies by language | discover/movie | with_original_language = path code; 404 if not in TMDB languages |
| TV by genre | discover/tv | with_genres |
| TV by network | discover/tv | with_networks |
| TV by language | discover/tv | with_original_language; 404 if unknown |
| Upcoming movies | discover/movie | primary_release_date.gte = today (timezone-corrected local date) |
| Upcoming TV | discover/tv | first_air_date.gte = today |
| Trending | trending/all, trending/movie or trending/tv | mediaType all (default), movie, tv; timeWindow day (default) or week; page; language |
| Keyword | movies by keyword | keyword id; page |
| Genre slider (movies, tv) | genre list plus one discover call per genre | each genre card takes a backdrop from that genre's discover results |
| Watchlist | Plex watchlist | offset based; others' lists need WATCHLIST_VIEW |

Trending "all" may contain people and collections, mapped separately from movies and series. Studio and network sliders show logos from settings; keyword and streaming-service sliders resolve via the stored data id.

---

## 16. Scheduled jobs

Cron strings have six fields (seconds first).

| Job | Cron | Interval | Applies to |
|---|---|---|---|
| plex-recently-added-scan | 0 */5 * * * * | every 5 min | Plex |
| plex-full-scan | 0 0 3 * * * | daily 03:00 | Plex |
| plex-watchlist-sync | 0 */3 * * * * | every 3 min | Plex |
| plex-refresh-token | 0 0 5 * * * | daily 05:00 | Plex |
| jellyfin-recently-added-scan | 0 */5 * * * * | every 5 min | Jellyfin, Emby |
| jellyfin-full-scan | 0 0 3 * * * | daily 03:00 | Jellyfin, Emby |
| radarr-scan | 0 0 4 * * * | daily 04:00 | all |
| sonarr-scan | 0 30 4 * * * | daily 04:30 | all |
| availability-sync | 0 0 5 * * * | daily 05:00 | all |
| download-sync | 0 * * * * * | every minute | all |
| download-sync-reset | 0 0 1 * * * | daily 01:00 | all |
| image-cache-cleanup | 0 0 5 * * * | daily 05:00 | all (clears TMDB and avatar caches) |
| process-blocklisted-tags | 0 30 1 */7 * * | every 7 days 01:30 | all |

1. The job set depends on the configured media server type (Plex jobs vs Jellyfin jobs).
2. Each job exposes "running" and "cancel". A job is not started if already running. Schedules are editable per job (cron string); manual runs can be triggered.
3. Scanners and sync jobs use the owner account (id 1) credentials.

---

## 17. Main settings defaults

| Setting | Default |
|---|---|
| applicationTitle | "Seerr" |
| defaultPermissions | REQUEST (32) |
| defaultQuotas | movie and tv empty |
| hideAvailable / hideBlocklisted / hideRequested | false |
| localLogin | true |
| mediaServerLogin | true |
| newPlexLogin | true |
| discoverRegion, streamingRegion, originalLanguage | empty |
| blocklistRegion, blocklistLanguage, blocklistedTags | empty |
| blocklistedTagsLimit | 50 |
| mediaServerType | NOT_CONFIGURED (4) |
| partialRequestsEnabled | true |
| enableSpecialEpisodes | false |
| locale | "en" |
| versionCheck | true |
| cacheImages | false |
| Plex port / Jellyfin port | 32400 / 8096 |

---

## 18. Worked examples

1. A user with permissions 32 requests series seasons [1,2] with a default non-4K Sonarr. No auto-approve: request PENDING, media PENDING, MEDIA_PENDING to admins. Admin approves: request APPROVED, SeasonRequests APPROVED, media PROCESSING, Sonarr receives seasons 1 and 2 with default profile and root folder; MEDIA_APPROVED to the user. A later Sonarr scan sees all episodes: seasons AVAILABLE, media AVAILABLE, request COMPLETED, MEDIA_AVAILABLE sent.
2. The same user requests season 2 again: it is in an active request, nothing left, HTTP 202.
3. An anime film with an override rule keyed on keyword 210024 and a Radarr server with tagRequests true: sent with the rule's profile and root folder, user tag appended.
4. A 4K movie needs REQUEST_4K or REQUEST_4K_MOVIE, goes to the default 4K Radarr, and only status4k changes; the normal status stays UNKNOWN.
5. A title deleted from Plex: availability sync marks the track DELETED and completes APPROVED requests; a new request on the same title is allowed (DELETED may be requested again).
6. Permissions 32 + 8 (MANAGE_USERS): exempt from quotas, can create requests on behalf of other users, but not auto-approved because MANAGE_REQUESTS and the auto-approve flags are missing.

---

## 19. Open questions

1. Behaviour of quota days when a limit exists but days is unset or 0 (assumed: no window, lifetime count).
2. Exact user-list sort fields, bulk-edit semantics and import response shapes were not fully inspected.
3. Whether the first Plex or Jellyfin sign-in always grants ADMIN itself or whether setup logic does (assumed it does).
4. Password policy (minimum length) and session lifetime/cookie settings.
5. Server-side enforcement of partialRequestsEnabled=false.
6. Slider create/edit/reorder/reset endpoint contracts and validation.
7. Radarr/Sonarr client behaviour when the series already exists in Sonarr (update vs error), and the exact mapping of the monitor option to Sonarr's monitor values.
8. Blocklist HTTP route contract (add body, pagination, filters); discover, override-rule and notification-agent settings routes were not read.
9. Watch provider and region list endpoints; exact TV upcoming/genre slider parameters beyond those listed.
10. Web Push VAPID handling, email template contents, image proxy/cache behaviour.
11. Whether the "VOTE" permission has any behaviour in the current UI.
