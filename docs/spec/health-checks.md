# Health Checks - Behaviour Specification

Derived from reading the Sonarr, Radarr and Prowlarr health-check subsystems. This document
describes behaviour only; it contains no upstream code. An engineer should be able to build
the Arclight `health` module and its check catalogue from this file alone.

Conventions:

- Severity is one of **Notice** (informational), **Warning**, **Error**. A passing check has
  the implicit severity **Ok** and is never stored or shown.
- `{name}` in a message is a substitution slot. `{appName}` is the product name (in
  Arclight: "Arclight"). Message text is quoted as upstream ships it in English, with app
  names replaced by the slot. Arclight may reword, but must keep the same facts.
- "Fragment" is the anchor appended to the documentation page for the check (section 1.6).
  Arclight should keep a stable `docsAnchor` per check.
- **S** = Sonarr only, **R** = Radarr only, **S+R** = both (identical unless a difference is
  stated), **P** = Prowlarr. Where Sonarr and Radarr have a series variant and a movie
  variant of the same check, Arclight implements one check covering both media types
  (section 6).

---

## 1. The health service (framework behaviour)

### 1.1 Data model

1. A **health result** has: a source (the check's identity, one stable id per check), a
   severity, a machine-readable reason code (several per check where the check has several
   outcomes, e.g. "one root folder missing" vs "several root folders missing"), a human
   message, and a documentation URL.
2. **Only one result per check at a time.** A check returns exactly one result. If several
   providers are wrong inside one check (five failing indexers) they are folded into one
   message listing names. If several different conditions are wrong inside one check, only
   the *first* matching condition is reported, in the order described per check.
3. Results are keyed by check identity (not reason). Replacing a Warning by an Error from the
   same check overwrites the stored result.
4. Results are **held in memory only**. After a restart the list is empty until startup
   checks run. Arclight may persist, but must be able to rebuild.
5. There is no per-item dismiss. A result disappears only when the check next returns Ok.

### 1.2 Triggers

Each check declares which of these apply:

- **On startup**: after the application-started event. Default true.
- **On schedule**: the recurring "check health" job. Default true.
- **On events**: a list of (event type, condition) pairs. The check is re-evaluated when one
  of its events is published.

Only three checks override the defaults:

- Radarr's SQLite-version check: not scheduled (startup and manual only); skipped entirely on
  non-Linux hosts.
- Prowlarr's "indexer has no definition" and "outdated definition" checks: not scheduled.

Event condition semantics (per check, per event):

- **Always** (default): run whenever the event arrives.
- **FailedOnly**: run only if this check currently has a stored non-Ok result. Used for "a
  successful import happened, so a previously reported import problem may now be fixed".
- **SuccessfulOnly**: run only if this check currently has *no* stored result. Used for "an
  import failed, so there may be a new problem to report".
- A check may also supply a predicate that can veto an event (the "removed from metadata
  provider" checks only run on an update/delete if an affected item has status Deleted).

### 1.3 Scheduling and debouncing

1. **Scheduled job**: interval 6 hours. A scheduled run executes every check whose schedule
   flag is true. A **manual** run (user presses "Check health") executes **every** check
   regardless of the schedule flag.
2. **Startup**: all startup checks run immediately (not debounced) on application start.
3. **Event-driven runs are debounced by 5 seconds.** A matching event adds its check to a
   pending set; the first event arms a 5-second timer; when it fires, all pending checks run
   once and the set is cleared. This collapses bursts (bulk-editing ten indexers) into one run
   per check. While a batch is processed the debouncer is paused so batches never overlap.
4. Event wiring is by event *type*. Provider events exist per provider kind (indexer,
   download client, import list, notification connection, metadata consumer, indexer proxy,
   application): provider added, updated, deleted, and **status changed** (back-off state
   changed). Prowlarr adds bulk-updated and bulk-deleted. Other event types used: application
   started; config saved; config-file saved; model events on root folders, remote path
   mappings and naming config; series/movie updated, deleted, moved, refresh complete;
   episode/movie imported and import-failed; movie collection refresh complete / edited /
   deleted.
5. After every processing pass the service publishes a **health-check-complete** event so the
   UI can refresh. That event never triggers checks (no loops).

### 1.4 Startup grace period (alert suppression)

1. For **15 minutes after process start**, results are still computed, stored and shown in
   the UI, but failure/restore *notifications* are flagged "in startup grace period" and are
   not sent. Rationale: right after boot, download clients and indexers are often not yet
   reachable.
2. The first time *any* event (other than application-started and health-check-complete)
   arrives after the 15 minutes have elapsed, the service re-runs all startup checks once,
   immediately, then marks the grace period consumed. It then explicitly publishes a
   "failed" event (not grace-flagged) for **every currently stored non-Ok result**, so
   problems that lasted through the grace period get their one notification. This happens
   once per process lifetime. After doing so, it also still looks at the triggering event's
   own check list in the normal way.
3. The grace flag on published events means "grace period not yet consumed".

### 1.5 Result transitions and events

For each result after a run:

1. Result is Ok: if a stored result exists, publish **health-restored** (carrying the previous
   result) and delete the stored result. Otherwise nothing.
2. Result is not Ok: if *no* stored result existed, publish **health-failed**. Then store
   (overwrite) the result. A severity or message change while a stored result exists does
   **not** raise a new event: notifications fire only on Ok -> not-Ok edges, plus the one-off
   flush in 1.4.

Notification routing:

1. Failed events inside the grace period are dropped.
2. Each notification connection with "On Health Issue" enabled receives Errors always and
   Warnings only if the connection's "include health warnings" option is on. **Notices are
   never sent.**
3. Restored events use the same filter applied to the *previous* result's severity ("On
   Health Restored").
4. A connection that throws is recorded as a failure on that connection's back-off status
   (section 3) and does not stop other connections.

### 1.6 Documentation URL

1. A non-Ok result carries a URL = the system wiki page + a fragment.
2. If the check supplies a fragment it is used verbatim (they start with `#`).
3. Otherwise it is derived from the message: lower-case, drop every character that is not a
   letter a-z or a space, replace spaces with hyphens, prefix `#`.
4. Several checks share a fragment (all indexer back-off checks use "indexers are
   unavailable due to failures").

### 1.7 Server-side announcements (remote notice)

1. A pseudo-check, scheduled and at startup like others.
2. It queries the project's cloud service for announcements, sending version, OS name
   (lower-case), CPU architecture and update branch.
3. The response is an ordered list of {severity, message, wiki url}. **Only the first item is
   used.** Its severity is whatever the server says; reason "server notification".
4. Empty list, or any request failure (logged at error level) -> Ok.
5. **Arclight**: no such service. Implement the extension point but ship it empty/disabled.

### 1.8 API / UI

1. The API lists all current stored results; there is no guaranteed order.
2. The API can request a manual run of all checks.
3. The System badge uses the highest current severity: Error red, Warning amber, Notice blue.

---

## 2. Shared building blocks

### 2.1 Enabled, available, blocked

- **Enabled**: the user has not switched the provider off. **Available** = enabled and usable;
  upstream's "available providers" is the enabled set.
- **Blocked** = the provider's status record says disabled until a future time and now is
  before that time.

### 2.2 Folding lists into messages

Provider names keep repository order and are joined with ", ". Root-folder lists are joined
with " | ". Import-list and collection root-folder entries are formatted `path (name1,
name2)`, the parentheses holding the names of the lists/collections that use that path.

### 2.3 "All vs some" pattern

Most provider-status checks share one decision shape:

1. A = enabled+available providers. B = the subset that is blocked and meets the check's time
   window (if any).
2. B empty -> Ok.
3. |B| == |A| -> **Error**, "all ... unavailable" message without names.
4. Otherwise -> **Warning**, message listing names of B.

If A is empty then B is empty, so no result: "zero providers configured" is handled by
separate checks (no download client; no indexers).

---

## 3. Provider back-off model (feeds the status checks)

The status checks only read back-off state, but an implementer must reproduce the writer for
thresholds to mean anything.

### 3.1 Escalation ladder

| Level | Disabled for |
|---|---|
| 0 | healthy |
| 1 | 1 minute |
| 2 | 5 minutes |
| 3 | 15 minutes |
| 4 | 30 minutes |
| 5 | 1 hour |
| 6 | 3 hours |
| 7 | 6 hours |
| 8 | 12 hours |
| 9 | 24 hours (maximum) |

A provider kind may lower its maximum level (default 9).

### 3.2 Recording

1. **Failure**:
   - Ignore provider ids <= 0 (ad-hoc test instances).
   - Set most-recent-failure = now.
   - If level was 0: set initial-failure = now, set level 1, and do not escalate again.
   - Otherwise escalate to min(max, level+1), unless inside a grace window: the provider
     kind's "minimum time since initial failure" (default zero) or the 15-minute startup
     window.
   - If the caller supplied a minimum back-off (e.g. an indexer's Retry-After), raise the level
     until its duration is at least that minimum (capped at max).
   - Disabled-till = now + duration(level), except that inside the initial-failure grace window
     with no minimum back-off supplied the previous value stands.
   - During the 15-minute startup window with no minimum back-off, disabled-till is capped at
     now + 5 minutes so startup glitches heal quickly.
   - Publish "provider status changed" (triggers the status health checks).
2. **Connection failure**: like failure but never escalates beyond the level-1 bump.
3. **Success**: if level is 0 do nothing. Else level -= 1, clear disabled-till, publish
   status-changed. Success steps down one rung; it does not reset to zero. Initial-failure is
   not cleared by success.

### 3.3 Short-term vs long-term for indexers

- **IndexerStatus**: blocked indexers whose initial failure is **less than 6 hours ago**.
- **IndexerLongTermStatus**: blocked indexers whose initial failure is **more than 6 hours
  ago**.

The two checks partition the same blocked set. Arclight may implement one check emitting
two results, but must keep the two distinct messages. Download client, import list,
notification and application status checks do **not** split by time.

---

## 4. Check catalogue

Triggers: "startup" and "schedule" are implied unless "not scheduled" is stated. "(prov.)"
means the provider events added/updated/deleted/status-changed as listed.

### 4.1 Application, config, environment

**C-01 AllowedHosts** (S+R, P)
- Triggers: startup, schedule, config-file saved.
- Condition: parse the configured allowed-hosts list (comma separated), remove entries that
  are plain bind addresses. Pass if the remainder is non-empty and does not contain `*`.
  Otherwise report only if the "authentication required" setting is not fully Enabled
  (disabled, or disabled-for-local-addresses); if authentication is fully enabled the check
  passes regardless of hosts.
- Warning. "Allowed Hosts is not configured, {appName} will accept requests for any hostname
  or IP address. Set Allowed Hosts in General settings to restrict which hostnames can be used
  to reach {appName}." Fragment "#allowed-hosts-not-configured". Also logs a warning.
- Examples: hosts "" with auth Enabled -> Ok. hosts "*" with auth DisabledForLocalAddresses
  -> Warning. hosts "media.lan" -> Ok.

**C-02 ApiKeyValidation** (S+R, P)
- Triggers: startup, schedule, config saved.
- Condition: API key shorter than 20 characters. Warning.
- "Please update your API key to be at least {length} characters long. You can do this via
  settings or the config file" (length 20). Fragment "#invalid-api-key".
- Arclight generates long keys; keep for adopted/imported config.

**C-03 AppDataLocation** (S+R, P)
- Triggers: startup, schedule.
- Condition: the app-data folder equals, or is inside, the startup (install) folder.
- Warning. "Updating will not be possible to prevent deleting AppData on Update". Fragment
  "#updating-will-not-be-possible-to-prevent-deleting-appdata-on-update".
- Arclight: Docker keeps data in `/config`; meaningful only for non-container installs.

**C-04 SystemTime** (S+R, P)
- Triggers: startup, schedule.
- Condition: fetch authoritative time from the project cloud service; if the absolute
  difference from local UTC is >= 1 day, fail. Any request failure -> Ok (logged at warning).
- Error. "System time is off by more than 1 day. Scheduled tasks may not run correctly until
  the time is corrected". Fragment "#system-time-off". Logs both timestamps.
- Arclight: optional; can read an HTTPS `Date` header. Off by default for privacy.

**C-05 Proxy** (S+R, P)
- Triggers: startup, schedule, config saved.
- Evaluated only when an HTTP proxy is enabled in settings; otherwise Ok. Then:
  1. Resolve the proxy hostname; no addresses -> Error "Failed to resolve the IP Address for
     the Configured Proxy Host {proxyHostName}". Fragment "#proxy-failed-resolve-ip".
  2. Ping the cloud service through the proxy; status exactly 400 -> Error "Failed to test
     proxy. Status Code: {statusCode}". Other HTTP error codes are ignored.
  3. The ping throws -> Error "Failed to test proxy: {url}" (the ping URL).
  Fragment for 2 and 3: "#proxy-failed-test".
- Upstream lets a DNS exception escape (logged only). Arclight should treat it as case 1.
- Arclight: ping a configurable URL instead of the cloud service.

**C-06 Update** (S+R, P)
- Triggers: startup, schedule, config-file saved.
- Block 1 runs only if auto-update is on AND the update mechanism is "built-in" AND the process
  is not in Docker. First match wins, all Error:
  1. macOS only: startup folder has an "AppTranslocation" ancestor. "Cannot install update
     because startup folder '{startupFolder}' is in an App Translocation folder."
  2. Startup folder not writable. "Cannot install update because startup folder
     '{startupFolder}' is not writable by the user '{userName}'."
  3. The UI folder under the startup folder not writable. "Cannot install update because UI
     folder '{uiFolder}' is not writable by the user '{userName}'."
  Fragments are the slugged versions of those sentences (e.g. "#cannot-install-update-because-
  startup-folder-is-not-writable-by-the-user").
- Block 2 runs always: if the build is older than **14 days** and the update service reports a
  newer version -> Warning "New update is available: {version}" (version with a leading
  "v"). Fragment "#new-update-is-available".
- Arclight: only the "update available" branch is meaningful, and only once an update
  channel exists (Phase 6).

**C-07 ReleaseBranch** (R, P; not in Sonarr)
- Triggers: startup, schedule, config saved.
- Condition: configured branch (case-insensitive) is not one of the official branches (Radarr:
  master, develop, nightly; Prowlarr's list not read).
- Warning. "Branch {branch} is not a valid {appName} release branch, you will not receive
  updates". Fragment "#branch-is-not-a-valid-release-branch".

**C-08 SqliteVersion** (R)
- Triggers: startup, manual only (not scheduled). Skipped when not Linux.
- Condition: SQLite library < 3.9.0. Error. "Currently installed SQLite version {version} is
  no longer supported. Please upgrade SQLite to at least version {minimum}." Fragment
  "#currently-installed-sqlite-version-is-not-supported".
- Arclight bundles SQLite via better-sqlite3: drop.

**C-09 PackageGlobalMessage** (S+R, P)
- Triggers: startup, schedule.
- Condition: the deployment package supplies a non-empty global message. Severity by prefix:
  "Error:" -> Error (prefix stripped); "Warn:" -> Warning (stripped); otherwise **Notice**.
  Message is the remaining text. Reason "package". Fragment "#package-maintainer-message".
- Arclight: support an env var or file with the same prefix convention.

**C-10 PasswordResetToken** (S only)
- Triggers: startup (plus default schedule).
- Condition: an environment-configured password reset token.
  - Empty -> Ok.
  - Shorter than 20 chars -> Warning "The configured password reset token is shorter than
    {length} characters and is being ignored".
  - Otherwise -> **Notice** "A password reset token is configured. Remove the
    SONARR__AUTH__RESETTOKEN environment variable once you no longer need it".
  Fragment "#password-reset-token".
- Arclight: mirror only if an admin-recovery token is implemented.

**C-11 OidcConfiguration** (S+R)
- Triggers: startup, schedule, config-file saved.
- Only when the authentication method is OIDC. In order, all Error:
  1. Authority, client id, client secret, user identifier and scopes not all set. "OIDC
     authentication is enabled, but Authority, Client ID, Client Secret, User and Scopes are
     not all configured". "#oidc-not-configured".
  2. Authority does not start with `https://`. "The OIDC Authority must start with
     'https://'". "#oidc-authority-not-secure".
  3. Discovery document unreachable. "Unable to retrieve the OIDC configuration from
     {authority}, signing in with your identity provider will fail until it is reachable".
     "#oidc-configuration-unavailable".
- Arclight: only if OIDC sign-in is added.

### 4.2 Download clients

**C-20 DownloadClient** (S+R)
- Triggers: (prov.) added/updated/deleted/status-changed.
- Order:
  1. No enabled download clients -> **Warning** "No download client is available". Fragment
     "#no-download-client-is-available".
  2. For each enabled client in order, call its list-queue operation. The first that throws ->
     **Error** "Unable to communicate with {downloadClientName}. {errorMessage}". Fragment
     "#unable-to-communicate-with-download-client". Stops at the first failure; only one client
     is named. Failures are logged at debug.
- This check makes live network calls each run.
- Example: qBittorrent on a wrong port -> "Unable to communicate with qBittorrent. Connection
  refused".

**C-21 DownloadClientStatus** (S+R, P)
- Triggers: download client updated/deleted/status-changed (P: also bulk).
- "All vs some" over enabled clients and blocked clients, no time window.
- Error "All download clients are unavailable due to failures". Warning "Download clients
  unavailable due to failures: {downloadClientNames}". Fragment "#download-clients-are-
  unavailable-due-to-failures".

**C-22 DownloadClientRemovesCompletedDownloads** (S+R)
- Triggers: download client updated/deleted; root-folder model events; remote-path-mapping
  model events.
- For each enabled, non-blocked client, read its status; if it says the client removes
  completed downloads (qBittorrent share-limit "remove", Transmission remove-when-done,
  SABnzbd zero history retention, etc.) -> Warning for the first such client. Communication
  errors skip the client (debug); other exceptions are logged at error and skipped.
- "Download client {downloadClientName} is set to remove completed downloads. This can result
  in downloads being removed from your client before {appName} can import them." Fragment
  "#download-client-removes-completed-downloads".

**C-23 DownloadClientRootFolder** (S+R)
- Triggers: download client updated/deleted (R also added); root-folder model events;
  remote-path-mapping model events.
- For each enabled, non-blocked client read its status, which lists the client's **output
  folders** (after remote path mapping). If any configured library root folder equals, or is a
  parent of, an output folder -> Warning naming the first client and root folder.
- "Download client {downloadClientName} places downloads in the root folder {rootFolderPath}.
  You should not download to a root folder." Fragment "#downloads-in-root-folder".
- Example: root `/tv`; download path `/tv/downloads` -> Warning. `/downloads` -> Ok. A
  download path that is a parent of the root does not trigger.

**C-24 DownloadClientSorting** (S+R)
- Triggers: as C-22.
- For each enabled, non-blocked client, if its status carries a non-blank "sorting mode"
  (SABnzbd TV/date/movie sorting on for the category) -> Warning for the first.
- "Download client {downloadClientName} has {sortingMode} sorting enabled for {appName}'s
  category. You should disable sorting in your download client to avoid import issues."
  Fragment "#download-folder-and-library-folder-not-different-folders".
- qBittorrent never sets it; keep the status field for Usenet clients.

**C-25 ImportMechanism** (S+R, differ)
- Triggers: download client updated/deleted; config saved.
- Radarr: "completed download handling" disabled -> Warning "Enable Completed Download
  Handling", fragment "#completed-download-handling-is-disabled".
- Sonarr: fetch status of all enabled clients (any throw -> Ok). If the setting has never been
  written at all:
  - any client not on localhost -> Warning "Enable Completed Download Handling if possible
    (Multi-Computer unsupported)";
  - else all clients SABnzbd -> Warning "Enable Completed Download Handling if possible
    (Sabnzbd)"; all NZBGet -> "... (Nzbget)"; otherwise "Enable Completed Download Handling if
    possible". Fragment "#completedfailed-download-handling".
  If the setting is explicitly false -> Warning "Enable Completed Download Handling".
- Arclight: completed download handling is always on. **Drop.**

**C-26 RemotePathMapping** (S+R) - the most intricate check.
- Triggers: download client updated/deleted (R also added); remote-path-mapping model events;
  import-failed (SuccessfulOnly).
- Precondition: if completed download handling is disabled -> always Ok.
- Two entry points share one result slot. All outcomes are Error.

  **A. Periodic / config path.** For each enabled, non-blocked client, for each output folder
  the client reports:
  1. Folder is not a valid path for the host OS:
     - client not on localhost -> "Remote download client {downloadClientName} places
       downloads in {path} but this is not a valid {osName} path. Review your remote path
       mappings and download client settings." (#bad-remote-path-mapping)
     - else host is Docker -> "You are using docker; download client {downloadClientName}
       places downloads in {path} but this is not a valid {osName} path. Review your remote
       path mappings and download client settings." (#docker-bad-remote-path-mapping)
     - else -> "Local download client {downloadClientName} places downloads in {path} but this
       is not a valid {osName} path. Review your download client settings."
       (#bad-download-client-settings)
  2. Folder valid but absent on disk:
     - Docker -> "You are using docker; download client {downloadClientName} places downloads
       in {path} but this directory does not appear to exist inside the container. Review
       your remote path mappings and container volume settings."
       (#docker-bad-remote-path-mapping)
     - else not localhost -> "Remote download client {downloadClientName} places downloads in
       {path} but this directory does not appear to exist. Likely missing or incorrect remote
       path mapping." (#bad-remote-path-mapping)
     - else local -> "Download client {downloadClientName} places downloads in {path} but
       {appName} cannot see this directory. You may need to adjust the folder's permissions."
       (#permissions-error)
  3. Folder exists -> fine.
  Note the order: for invalid paths localhost is tested before Docker; for missing folders
  Docker is tested before localhost. Preserve exactly.

  **B. Import-failed path.** In order:
  1. The event carries identified media-file info (failure at the "import approved items"
     step):
     - file exists on disk -> "{appName} can see but not access downloaded episode {path}.
       Likely permissions error." (R: "downloaded movie") (#permissions-error)
     - file absent -> "File {path} was removed part way through processing."
       (#remote-path-file-removed)
  2. Otherwise the failure occurred locating the client's files. Find the enabled, non-blocked
     client named in the event (none -> Ok). Ask it for the item matching the event's
     download id and take its output path:
     - no path -> "{appName} failed to import (an) episode(s). Check your logs for details."
       (R: "{appName} failed to import a movie. Check your logs for details.")
       (#remote-path-import-failed)
     - path invalid for host OS: not localhost -> "Remote download client {downloadClientName}
       reported files in {path} but this is not a valid {osName} path. Review your remote
       path mappings and download client settings." (#bad-remote-path-mapping); else Docker ->
       "You are using docker; download client {downloadClientName} reported files in {path}
       but this is not a valid {osName} path. Review your remote path mappings and download
       client settings." (#docker-bad-remote-path-mapping); else "Local download client
       {downloadClientName} reported files in {path} but this is not a valid {osName} path.
       Review your download client settings." (#bad-download-client-settings)
     - path valid and folder exists -> "{appName} can see but not access download directory
       {downloadPath}. Likely permissions error." (#permissions-error)
     - path valid, folder absent: Docker -> the same "can see but not access download
       directory" text, but with fragment #docker-bad-remote-path-mapping (an upstream quirk -
       a clearer "does not exist inside the container" message would be better; Arclight may
       improve it); else not localhost -> "Remote download client {downloadClientName} reported
       files in {path} but this directory does not appear to exist. Likely missing remote
       path mapping." (#bad-remote-path-mapping); else local -> "Download client
       {downloadClientName} reported files in {path} but {appName} cannot see this directory.
       You may need to adjust the folder's permissions." (#permissions-error)
  Communication errors are swallowed (debug); other exceptions logged and swallowed.
- Arclight: one library means "episode/movie" becomes "item". Docker is the primary
  deployment, so a qBittorrent container whose `/downloads` mount differs from Arclight's
  is the main failure this check exists to catch.

### 4.3 Indexers

**C-30 IndexerStatus** (S+R, P)
- Triggers: indexer updated/deleted/status-changed (P: bulk too).
- "All vs some" over enabled indexers and blocked indexers whose initial failure is **within
  the last 6 hours**.
- Error "All indexers are unavailable due to failures". Warning "Indexers unavailable due to
  failures: {indexerNames}". Fragment "#indexers-are-unavailable-due-to-failures".
- "All" compares against *all* enabled indexers: if some are in the short window and others in
  the long window, each check reports a Warning, not an Error.

**C-31 IndexerLongTermStatus** (S+R, P)
- Same triggers and shape, initial failure **more than 6 hours ago**.
- Error "All indexers are unavailable due to failures for more than 6 hours". Warning
  "Indexers unavailable due to failures for more than 6 hours: {indexerNames}". Same fragment.

**C-32 IndexerRss** (S+R)
- Triggers: indexer added/updated/deleted/status-changed.
- In order:
  1. No enabled indexer has RSS sync enabled (back-off ignored) -> **Error** "No indexers
     available with RSS sync enabled, {appName} will not grab new releases automatically".
     Fragment "#no-indexers-available-with-rss-sync-enabled-sonarr-will-not-grab-new-releases-
     automatically" (Radarr: "radarr").
  2. RSS-enabled indexers exist but all are blocked -> **Warning** "All rss-capable indexers
     are temporarily unavailable due to recent indexer errors". "#indexers-are-unavailable-
     due-to-failures".

**C-33 IndexerSearch** (S+R)
- Triggers: as C-32. In order, all Warning:
  1. No enabled indexer with automatic search -> "No indexers available with Automatic Search
     enabled, {appName} will not provide any automatic search results". Fragment ends
     "...-sonarr-will-not-provide-any-automatic-search-results" (Radarr: "radarr").
  2. No enabled indexer with interactive search -> "No indexers available with Interactive
     Search enabled, {appName} will not provide any interactive search results".
     "#no-indexers-available-with-interactive-search-enabled".
  3. Automatic-search indexers exist but all blocked -> "All search-capable indexers are
     temporarily unavailable due to recent indexer errors". "#indexers-are-unavailable-due-to-
     failures". Interactive availability is not tested against back-off.
- RSS "none" is an Error but search "none" is a Warning. Preserve the asymmetry.

**C-34 IndexerDownloadClient** (S+R, P)
- Triggers: indexer updated/deleted; download client updated/deleted (P: bulk too).
- Any **enabled** indexer pinned to a specific download client (id > 0) that is not in the
  set of **enabled** clients (deleted or disabled) -> Warning "Indexers with invalid download
  clients: {indexerNames}." Fragment "#invalid-indexer-download-client-setting".

**C-35 IndexerJackettAll** (S+R)
- Triggers: indexer added/updated/deleted/status-changed.
- Any enabled generic Torznab indexer whose base URL or API path contains (case-insensitive)
  the Jackett aggregate path `/torznab/all/api` or `/api/v2.0/indexers/all/results/torznab`.
- Warning "Indexers using the unsupported Jackett 'all' endpoint: {indexerNames}". Fragment
  "#jackett-all-endpoint-used".
- Reason: the aggregate endpoint mixes categories/ids and defeats per-indexer back-off and
  statistics.

**C-36 PTPOldSettings** (R)
- Triggers: startup, schedule only.
- Any PassThePopcorn indexer whose "API user" is blank -> Warning "The following
  PassThePopcorn indexers have deprecated settings and should be updated: {names}". Fragment
  "#ptp-settings-old". Arclight: drop unless a PTP indexer ships.

### 4.4 Import lists, root folders, disks

**C-40 ImportListStatus** (S+R)
- Triggers: import list updated/deleted/status-changed. "All vs some", no time window.
- Error "All lists are unavailable due to failures". Warning "Lists unavailable due to
  failures: {importListNames}". Fragment "#import-lists-are-unavailable-due-to-failures".
- (A message for "possible partial fetch" exists in localisation but nothing uses it.)

**C-41 ImportListRootFolder** (S+R)
- Triggers: import list updated/deleted; any root-folder model event; series/movies deleted;
  series/movie moved; imported (FailedOnly); import failed (SuccessfulOnly).
- A list is "missing" if its root folder path is blank, not valid for the host OS, not equal
  to a registered root folder, or absent on disk. Missing lists are grouped by path.
- One distinct bad path -> Error "Missing root folder for import list(s): {rootFolderInfo}".
  Several -> Error "Multiple root folders are missing for import lists: {rootFoldersInfo}"
  (entries joined " | "). Entry format `path (listA, listB)`; a blank path shows as empty
  before the parenthesis. Fragment "#import-list-missing-root-folder".

**C-42 RootFolder** (S+R, differ)
- Triggers: series/movies deleted; series/movie moved; imported (FailedOnly); import failed
  (SuccessfulOnly). Not triggered by root-folder edits.
- For every item path find its best-matching registered root folder (item's parent directory if
  none matches). Distinct set R.
- **Missing** (both): any path in R invalid for the host OS or absent on disk -> Error.
  Single "Missing root folder: {rootFolderPath}"; several "Multiple root folders are missing:
  {rootFolderPaths}" (" | "). Fragment "#missing-root-folder".
- **Empty** (**Sonarr only**): reached only if nothing is missing; any root in R that exists
  but has no entries -> **Warning**. Single "Empty root folder: {rootFolderPath}"; several
  "Multiple root folders are empty: {rootFolderPaths}". Fragment "#empty-root-folder".
  Purpose: detect an unmounted NAS share leaving an empty mountpoint. Arclight should apply
  it to movies too.

**C-43 MovieCollectionRootFolder** (R)
- Triggers: collection refresh complete / edited / deleted; root-folder model events.
- Same "missing" test as C-41 over each collection's root folder.
- Error "Missing root folder for movie collection: {rootFolderInfo}" or "Multiple root
  folders are missing for movie collections: {rootFoldersInfo}". Entry `path (title1,
  title2)`. Fragment "#movie-collection-missing-root-folder".

**C-44 Mount** (S+R)
- Triggers: startup, schedule only.
- Resolve the mount containing each series/movie path (following symlinks/junctions); keep
  read-only mounts; dedupe by mount root.
- Error. Sonarr "Mount containing a series path is mounted read-only: " + entries
  `{mountName} ({path})` joined ", " (fragment "#series-mount-ro"). Radarr "Mount containing a
  movie path is mounted read-only: " + same entries (fragment "#movies-mount-ro").
- Example: `/tv` mounted `ro` -> "Mount containing a series path is mounted read-only: /tv
  (/tv/Show Name)".

**C-45 RecyclingBin** (S+R)
- Triggers: startup, schedule; imported (FailedOnly); import failed (SuccessfulOnly).
- A recycling bin is configured (blank -> Ok) and the folder is not writable (probe by actually
  writing). Error "Unable to write to configured recycling bin folder: {path}. Ensure this path
  exists and is writable by the user running {appName}". Fragment "#cannot-write-recycle-bin".

### 4.5 Items removed from the metadata source

**C-50 RemovedSeries** (S) / **C-51 RemovedMovie** (R)
- Triggers: item updated, items deleted, item refresh complete; for updated/deleted a predicate
  vetoes unless an affected item has status Deleted.
- Any library item whose metadata status is Deleted -> Error (always, regardless of count).
- Series: "Series {series} was removed from TheTVDB" / "Series {series} were removed from
  TheTVDB"; entries `Title (tvdbid N)` joined ", ". Fragment "#series-removed-from-thetvdb".
- Movies: "Movie {movie} was removed from TMDb" / "Movies {movies} were removed from TMDb";
  entries `Title (tmdbid N)`. Fragment "#movie-was-removed-from-tmdb".

### 4.6 Notifications and metadata

**C-60 NotificationStatus** (S+R, P)
- Triggers: notification connection updated/deleted/status-changed. "All vs some".
- Error "All notifications are unavailable due to failures". Warning "Notifications unavailable
  due to failures: {notificationNames}". Fragment "#notifications-are-unavailable-due-to-
  failures".

**C-61 SlackUrl** (R)
- Triggers: startup, schedule (event hooks target a generic factory type and may never match).
- An available Slack-type notification whose webhook URL contains "discord" -> Warning "You have
  a Discord notification setup as a Slack notification. Set this up as a Discord notification
  for better functionality. The effected notifications are: {names}". Fragment
  "#discord-as-slack-notification". Arclight: drop.

**C-62 Metadata / Kometa** (R)
- Trigger: metadata consumer updated. The deprecated Kometa consumer is enabled -> Warning
  "Kometa files will no longer be created, support will be removed completely in v6". Derived
  fragment. Arclight: drop.

**C-63 NamingConfig** (R)
- Trigger: naming-config model event.
- The movie folder format contains any deprecated file-level token (quality, media info,
  release group, etc., meaningless at folder level) -> Error "Movie Folder Format must not
  contain deprecated file related tokens: {tokens}" (matches joined ", "). Derived fragment.
- Arclight: reject at settings validation; surface health only for adopted configs.

---

## 5. Prowlarr-only checks (map to the indexer registry)

"Applications" (the downstream apps Prowlarr syncs to) do not exist in Arclight; P-01 and
P-02 are dropped.

**P-01 ApplicationStatus** - "all vs some" over enabled applications, blocked with initial
failure within 6 hours. Error "All applications are unavailable due to failures"; Warning
"Applications unavailable due to failures: {names}". "#applications-are-unavailable-due-to-
failures". **Drop.**

**P-02 ApplicationLongTermStatus** - same, more than 6 hours. "All applications are unavailable
due to failures for more than 6 hours" / "Applications unavailable due to failures for more
than 6 hours: {names}". **Drop.**

**P-03 Indexer (none enabled)** - indexer added/updated/deleted/bulk/status-changed. No enabled
indexers (back-off ignored) -> Error "No indexers enabled, {appName} will not return search
results". Derived fragment. Arclight recommendation (not upstream): when there are zero
enabled indexers, emit this and suppress C-32/C-33's "none" variants to avoid three redundant
messages.

**P-04 IndexerNoDefinition** - startup, indexer deleted/bulk-deleted, not scheduled. A
YAML-definition indexer whose definition file is no longer in the current definition set ->
Error "Indexers have no definition and will not work: {indexerNames}. Please remove and (or)
re-add to {appName}." "#indexers-have-no-definition".

**P-05 OutdatedDefinition** - same triggers, not scheduled. An indexer flagged obsolete by its
implementation, or a YAML-definition indexer whose file is on the definition blocklist ->
Warning "Indexers are obsolete or have been updated: {names}. Please remove and (or) re-add to
{appName}". "#indexers-are-obsolete".

**P-06 IndexerProxyStatus** - proxy added/updated/deleted. Actively *tests* each enabled
indexer proxy (live, not back-off state). None enabled or none failing -> Ok; all failing ->
Error "All indexer proxies are unavailable due to failures"; some -> Warning "Indexer proxies
unavailable due to failures: {indexerProxyNames}". "#indexer-proxies-are-unavailable-due-to-
failures".

**P-07 IndexerVIPExpiring** - indexer added/updated/deleted/bulk. Enabled indexers whose
settings hold a VIP-expiration date between now and now + 7 days -> Warning "Indexer VIP
benefits expiring soon: {indexerNames}". "#indexer-vip-expiring".

**P-08 IndexerVIPExpired** - same triggers; expiration earlier than now -> Error "Indexer VIP
benefits have expired: {indexerNames}". "#indexer-vip-expired".

P-07/P-08 compare against local time while back-off windows use UTC; Arclight should use UTC
throughout. Unchanged shared checks in Prowlarr: AllowedHosts, ApiKeyValidation,
AppDataLocation, DownloadClientStatus, IndexerDownloadClient, IndexerStatus,
IndexerLongTermStatus, NotificationStatus, Proxy, ReleaseBranch, SystemTime, Update.

---

## 6. Arclight implementation guidance

### 6.1 Check list

| Arclight check | Source | Phase |
|---|---|---|
| `allowed-hosts`, `api-key-length` | C-01, C-02 | 0 |
| `app-data-location` | C-03 | 0 (non-Docker) |
| `system-time` | C-04 | 0, optional |
| `package-message` | C-09 | 0 |
| `proxy` | C-05 | 1 |
| `download-client-none`, `download-client-comm` | C-20 | 1 |
| `download-client-status` | C-21 | 1 |
| `download-client-removes-completed` | C-22 | 1 |
| `download-client-in-root-folder` | C-23 | 1 |
| `download-client-sorting` | C-24 | 1 (Usenet clients) |
| `remote-path-mapping` | C-26 | 1 |
| `indexer-status`, `indexer-long-term-status` | C-30, C-31 | 1 |
| `indexer-rss`, `indexer-search` | C-32, C-33, P-03 | 1 |
| `indexer-download-client`, `indexer-jackett-all` | C-34, C-35 | 1 |
| `root-folder` (missing + empty, both media types) | C-42 | 1 |
| `collection-root-folder` | C-43 | 1 if collections |
| `mount-readonly` | C-44 | 1 |
| `recycle-bin` | C-45 | 1 |
| `item-removed-upstream` | C-50, C-51 | 1 |
| `notification-status` | C-60 | 1 |
| `import-list-status`, `import-list-root-folder` | C-40, C-41 | 2 |
| `indexer-proxy-status` | P-06 | 2 |
| `indexer-definition-missing`, `-outdated` | P-04, P-05 | 2 |
| `indexer-vip-expiring`, `-expired` | P-07, P-08 | 2 |
| `server-announcement` | 1.7 | later, empty |
| `oidc` | C-11 | only if added |

Dropped: ImportMechanism, SQLite version, PasswordResetToken (unless added), PTP, Slack,
Kometa, ReleaseBranch and Update (until Phase 6), both Application checks.

New checks suggested by the architecture (not upstream): subtitle provider back-off (use the
2.3 pattern), media-server refresh connection failing, metadata source (TMDB/TVDB) unreachable
or key missing, scheduler job repeatedly failing, low free space on a root folder (upstream only
rejects imports and has no health check for it).

### 6.2 Suggested shape

1. `HealthCheck`: `id`, `runOnStartup`, `runOnSchedule`, `triggers: {event, condition,
   predicate?}[]`, `run(): Promise<HealthResult | null>`.
2. `HealthResult`: `{ checkId, severity: 'notice'|'warning'|'error', reason, message,
   docsAnchor }`; message built from a template with the named parameters used above.
3. Service holds `Map<checkId, HealthResult>`; transitions per 1.5; 5 s debounce; 6 h job via
   the scheduler; 15 min grace measured from process start.
4. Publish `health.failed`, `health.restored`, `health.complete` on the in-process bus. Expose
   `GET /api/v1/health`; `POST /api/v1/health/check` runs all checks.
5. Provider back-off tables per provider kind implementing section 3, with a shared helper.
6. Notice is a first-class severity even though only package messages and password-reset use it.

### 6.3 Worked examples

1. **Boot with slow qBittorrent.** t=0: C-20 fails ("Unable to communicate with qBittorrent.
   Connection refused"); stored; health-failed published with grace=true; notification
   suppressed. t=2 min: a download client event re-runs the check; Ok; health-restored
   published with grace=true; suppressed. No messages sent.
2. **Failure persists through grace.** qBittorrent stays down. At t=16 min the first unrelated
   event triggers the one-off re-run; still failing; health-failed (grace=false) published for
   it; the Discord connection (Errors always) is notified. Later 6-hourly runs do not
   re-notify.
3. **Back-off windows.** Indexer A first fails 09:00 and keeps failing. Until 14:59 it is in
   IndexerStatus (Warning if other indexers are healthy). From 15:01 the same status produces
   IndexerLongTermStatus Warning and IndexerStatus goes Ok.
4. **All indexers blocked.** Three enabled, all failing since 1 h ago: IndexerStatus Error "All
   indexers are unavailable due to failures"; IndexerRss Warning; IndexerSearch Warning - three
   simultaneous results.
5. **Unmounted share.** `/tv` exists but empty: Warning "Empty root folder: /tv". Directory
   missing entirely: Error "Missing root folder: /tv".
6. **Docker mapping mistake.** qBittorrent saves to `/data/torrents/tv`; Arclight sees only
   `/downloads`. Periodic C-26(A): Error "You are using docker; download client qBittorrent
   places downloads in /data/torrents/tv but this directory does not appear to exist inside the
   container. Review your remote path mappings and container volume settings."
7. **Permissions.** A file is identified, import fails, the file exists -> Error "Arclight can
   see but not access downloaded episode /downloads/x.mkv. Likely permissions error." The next
   successful import triggers the check with FailedOnly and clears it.
8. **Short API key.** Imported config has a 12-char key -> Warning on startup and on every
   config save until it is regenerated.

---

## 7. Invariants and edge cases

1. A check that cannot gather its inputs (cloud service down, client unreachable) generally
   returns **Ok**: SystemTime, announcements, ImportMechanism (S), and per-client errors inside
   RemotePathMapping/RootFolder/Sorting/RemovesCompleted. Exceptions that deliberately report
   it: DownloadClient (C-20) and Proxy (C-05).
2. Checks that call download clients skip *blocked* clients (they get their own message in
   C-21) to avoid double reporting.
3. A client error inside a check is caught per client; one unreachable client never prevents
   checks against others (C-20 stops at its first failing client by design).
4. Only the first matching sub-condition is reported; test the order explicitly.
5. Names are not sorted; keep repository insertion order. Tests should not depend on it.
6. Provider checks run after the availability filter: disabled providers never appear.
7. FailedOnly/SuccessfulOnly use presence of a stored result for that check, not its severity.
8. Severity order: Notice < Warning < Error; highest drives the badge.
9. Every non-Ok result has a message; a docs anchor is optional but recommended.
10. Message text is localisable upstream via keys with named parameters; keep parameter names.
11. The first result a check returns after process start never fires a "restored" event (no
    stored result existed), only "failed" if not Ok.

---

## 8. Undetermined / not verified

1. Which strings count as a "bind address" in the allowed-hosts parser (wildcard addresses such
   as 0.0.0.0) - the parser was not read.
2. How the update service decides "update available" (version/branch comparison) - outside the
   health folder, not read.
3. Prowlarr's official branch list for C-07 (assumed same as Radarr's) and Prowlarr's wording
   for AllowedHosts/Proxy messages (assumed identical to Sonarr's).
4. The exact semantics of "folder empty" (whether hidden/system files count) and "folder
   writable" (probe file vs permission bits) - disk provider not read; assume a probe write and
   "any directory entry".
5. Download client "get status" contents (output folders, removes-completed, sorting mode,
   is-localhost) are produced by each client implementation; qBittorrent specifics belong in
   the download-clients spec.
6. The cloud service endpoints (announcements, time, ping) are project-operated with no
   Arclight equivalent; a decision is needed (recommended: none).
7. Whether the Radarr SlackUrl check's event hooks ever fire (they target a generic factory
   type); behaviourally it runs on startup, schedule and manual runs.
8. Sonarr's DownloadClientRemovesCompletedDownloads etc. have no "added" trigger while Radarr's
   DownloadClientRootFolder and RemotePathMapping do; whether this is deliberate is unknown.
   Arclight should trigger on added for all.
