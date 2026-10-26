# Spec: History and Blocklist

Behaviour derived from Sonarr (`History/`, `Blocklisting/`, `Download/History`, `Download/FailedDownloadService`,
`Download/IgnoredDownloadService`, `Download/RedownloadFailedDownloadService`) and Radarr (same areas).
Written for an engineer implementing the rules in TypeScript without reading upstream.

Media-Tron has one pipeline for two media types, so this spec uses neutral terms:

- **item** = an episode (TV) or a movie. A grab of a season pack or multi-episode file touches several episodes.
- **parent** = series (TV) or the movie itself.
- Rules marked **[TV]** or **[Movie]** differ between the upstream apps; unmarked rules apply to both.

There are three related stores. Do not conflate them:

1. **History** (user-visible activity log, one row per item per event).
2. **Download history** (internal, one row per download-client item per lifecycle event, keyed by download id).
3. **Blocklist** (releases that must not be grabbed again).

---

## 1. History

### 1.1 Row shape

1. Every history row has: id, parent id, item id (episode id for TV; for movies the parent is the item), event type,
   timestamp (UTC, set at insert time, never supplied by caller), source title, quality (quality + revision),
   languages (list), optional download id, and a free-form string-to-string **data** map.
2. Source title meaning depends on event type: release title for grabbed/failed/ignored; scene name or dropped file's
   base name (no extension) for imports; full file path for file-deleted; original (pre-rename) full path for renamed.
3. The download id is the download client's identifier for the item (torrent info-hash, usenet client nzo id, etc.).
   It is the join key between "grabbed", "imported", "failed" and "ignored" rows of the same download. It is absent for
   file-deleted and file-renamed rows, and may be absent for grabbed rows when the client does not return an id.
4. Data-map keys are looked up **case-insensitively** in practice (writers use PascalCase such as `Indexer`,
   readers ask for `indexer`). Implement the map with case-insensitive keys, or normalise to one case on write and
   read. Values are always strings; absent values are simply missing or null/empty.
5. One row is written **per item**. A season pack covering 10 episodes produces 10 grabbed rows, sharing the same
   download id and (apart from item id) identical data. [TV] A movie produces exactly one row.
6. History is append-only. Rows are never edited by the app (Radarr exposes an update-many on its service but nothing
   in the pipeline uses it; do not implement edit). Rows are deleted only by parent deletion and by orphan cleanup
   (1.6).

### 1.2 Event types

| Event | TV id | Movie id | Meaning |
|---|---|---|---|
| unknown | 0 | 0 | fallback |
| grabbed | 1 | 1 | release was sent to a download client |
| (series folder imported) | 2 | 2 | deprecated in both; never written. Do not implement. |
| download folder imported | 3 | 3 | a file from a completed download was imported into the library |
| download failed | 4 | 4 | download client reported failure, or user marked failed |
| file deleted | 5 | 6 | a library file was deleted |
| file renamed | 6 | 8 | a library file was renamed by the organizer |
| download ignored | 7 | 9 | user removed a queue item without blocklisting and left it in the client |
| movie folder imported | - | 7 | defined in Radarr, "not used yet", never written. Do not implement. |

Movies use different numbers for deleted/renamed/ignored because Radarr retained deprecated slots. Media-Tron is one
app: pick one enum (`grabbed, imported, failed, fileDeleted, fileRenamed, ignored`) and provide a mapping table only
if a Sonarr/Radarr compatibility API (roadmap phase 6) is built.

### 1.3 What each event records

Unless stated, every data value is stored as a string. Age fields are integers rendered as strings.

**1.3.1 Grabbed** (the grab pipeline publishes a "grabbed" event after the download client accepted the release):

- Row columns: source title = release title; quality = parsed quality from the release title; languages = the
  decision's languages; download id = id returned by the client (may be empty).
- Data: `Indexer` (name), `NzbInfoUrl` (release info url), `ReleaseGroup` (from parse), `Age` (days), `AgeHours`,
  `AgeMinutes`, `PublishedDate` (UTC, ISO-8601 second precision with a trailing Z), `DownloadClient` (client
  implementation type name), `DownloadClientName` (user-assigned name), `Size` (bytes), `DownloadUrl`, `Guid`,
  `ImdbId`, `Protocol` (integer: 1 usenet, 2 torrent, 0 unknown), `CustomFormatScore` (integer, score of the
  decision at grab time), `ReleaseSource` (enum name: unknown, rss, search, userInvokedSearch, interactiveSearch,
  releasePush), `IndexerFlags` (enum name, e.g. freeleech), `ReleaseHash` (only when the parser extracted an
  obfuscation hash from the title), `TorrentInfoHash` (only when the release is a torrent).
- [TV] additionally: `TvdbId`, `TvRageId`, `SeriesMatchType` (unknown, alias, title, id), `ReleaseType`
  (unknown, singleEpisode, multiEpisode, seasonPack).
- [Movie] additionally: `TmdbId`, `MovieMatchType` (unknown, title, alias, id), `IndexerId` (numeric).
- Media-Tron should record the same fields; keep at least `ReleaseSource`, `*MatchType`, `TorrentInfoHash`, `Protocol`,
  `Indexer`, `PublishedDate`, `Size`, `DownloadClient`, `ReleaseGroup`, `IndexerFlags`, `CustomFormatScore` because other
  rules read them back (section 6).

**1.3.2 Imported** (a file from a completed download or a manual import was imported):

- Written only when the import was a **new download** (a file moved/copied/linked from outside the library). Imports
  that merely adopt a file already in the library folder (disk scan, "existing file" import) write **no** history.
- Row columns: source title = the scene name stored on the new library file if there is one, otherwise the dropped
  file's name without extension; quality and languages = the parsed values of the imported file; download id = the
  event's download id, or, if blank, a best-effort lookup (1.5.2).
- Data: `FileId` (library file id), `DroppedPath` (original path of the file in the download folder), `ImportedPath`
  (absolute library path of the new file), `DownloadClient` (type), `DownloadClientName`, `ReleaseGroup`,
  `CustomFormatScore`, `Size`, `IndexerFlags`. [TV] also `ReleaseType`.
- [TV] one row per episode the file covers.

**1.3.3 Failed**:

- Row columns: source title, quality, languages and download id are copied from the originating grabbed row; item id(s)
  from the grabbed rows of the same download.
- Data: `DownloadClient` (copied from grabbed row's `DownloadClient`), `DownloadClientName` (from the live tracked
  download if there is one, else absent), `Message` (human-readable reason), `ReleaseGroup`, `Size`, `Indexer`.
  For the last three, prefer live tracked-download values (release group from the parse, size = the client's reported
  total size, indexer from the release) and fall back to the same keys in the grabbed row's data.
- [TV] also `Source` (who/what marked it failed, e.g. "Sonarr Failed Download Handling", "TorrentFileValidation",
  or the request source for API calls; may be empty). [Movie] has no Source.
- One row per item id in the event (TV); a single row for movies.

**1.3.4 File deleted**:

- Row columns: source title = full file path; quality and languages = those of the deleted file; no download id.
- Data: `Reason`, `ReleaseGroup`, `Size`, `IndexerFlags`. [TV] also `ReleaseType`.
- One row per episode linked to the deleted file [TV]; one row [Movie].
- Reasons: `MissingFromDisk` (disk scan found it gone), `Manual` (user deleted), `Upgrade` (replaced by a better
  file during import), `NoLinkedEpisodes` (cleanup of an orphan file record), `ManualOverride` (manual import replaced
  an existing file).
- **Suppression:** `NoLinkedEpisodes` never writes history (both apps). [TV] `ManualOverride` also writes nothing.
  [Movie] `ManualOverride` **does** write a deleted row (upstream inconsistency). Recommendation: suppress in both,
  because the new import immediately gets its own imported row; record as a deliberate deviation.

**1.3.5 File renamed**:

- Row columns: source title = original full path before rename; quality, languages from the file; no download id.
- Data: `SourcePath` (absolute old path), `SourceRelativePath` (old path relative to parent folder), `Path` (absolute new
  path), `RelativePath` (new path relative to parent folder), `ReleaseGroup`, `Size`, `IndexerFlags`; [TV] also `ReleaseType`.
- One row per linked episode [TV]; one for movies. The event is only emitted for files the organizer actually moved.

**1.3.6 Ignored** (user removed a queue item with "keep in client, do not blocklist"):

- Row columns: source title = the download item's title in the client; quality and languages from the matched release;
  download id = client item id; item ids from the tracked download's matched items.
- Data: `DownloadClient` (type), `DownloadClientName`, `Message` (always "Manually ignored"), `ReleaseGroup`, `Size`
  (client total size), `Indexer`. [TV] also `ReleaseType`.
- [TV] if the tracked download could not be matched to a series, ignoring is refused (log warning, no row, the API
  skips that item). [Movie] ignored rows are written with whatever movie matched.
- [TV] all ignored rows for one action are inserted as one batch.

### 1.4 Writing rules

1. History writing is event driven; writers are independent of the action that caused the event. Implement as
   subscribers to domain events: grabbed, imported, download-failed, file-deleted, file-renamed, download-ignored,
   parent-deleted.
2. When a parent is deleted, all of its history rows are deleted (and its blocklist and download-history rows).
3. Writes are not de-duplicated. If the same release is grabbed twice there are two grabbed rows.
4. A failed event produces a history row even when there is no tracked download (e.g. "mark as failed" on an old
   history row); the live-only fields then fall back to the grabbed row's data (1.3.3).
5. Timestamps use "now" in UTC for every event; do not backdate.

### 1.5 Queries the rest of the system relies on

1.5.1 **Look-ups:**

- most recent row for an item (max timestamp, any event type);
- all rows for an item, newest first;
- most recent row for a download id; all rows for a download id; rows for a download id of a given type;
- all rows for a parent, optionally restricted to a season [TV] and/or one event type, newest first;
- rows since a timestamp (inclusive), oldest first, optionally one event type (used by third-party pollers);
- paged list sorted by date descending by default; sortable by date and parent sort-title (Radarr also by quality and
  languages); **sort by quality** orders by the quality's rank inside the *item's own quality profile* (unknown rank
  sorts as -1);
- filters on the paged list: event type (multi), download id, parent ids, item id [TV], language ids (any of), quality
  ids (any of; matches quality id only, ignoring revision).
- Quality-ceiling query [Movie only]: the best quality ever present in an item's history, ranked by the item's quality
  profile. Used by upgrade logic to know what has ever been obtained even if the file was later deleted.

1.5.2 **Finding a download id for an import that lacks one** (manual import from "wanted" or API import without a
download id). This lets a manual import close out the grabbed row.

1. Fetch history rows for the parent that have the same quality as the imported file and event type in
   {grabbed, failed, imported}. [TV] keep only rows for the imported file's episode ids.
2. "Processed" ids = download ids of rows in that set that are *not* grabbed rows and have a download id.
3. "Still downloading" = grabbed rows whose download id is not in the processed set.
4. If none: result is blank.
5. [TV] For each imported episode, take its still-downloading rows. If any episode has **zero or more than one**,
   return blank (ambiguous). All episodes must agree on one download id, otherwise blank. Otherwise return that id.
6. [Movie] If there is exactly one still-downloading grabbed row return its id; if more than one, blank.

Example (TV): episode S01E01 has one grabbed row (download id A, WEBDL-1080p) and nothing later. Manual import of a
WEBDL-1080p file for S01E01 with no download id: processed={}, still-downloading={A}, result A. The imported row is
written with download id A, which stops the grab counting as "still downloading".

Example (ambiguous): S01E01 has two grabbed rows (A, B) at the same quality, neither imported or failed. Result blank.

### 1.6 Housekeeping

1. A periodic housekeeping job deletes history rows whose parent no longer exists. [TV] also deletes rows whose episode
   no longer exists. [Movie] only the parent check.
2. There is **no age-based pruning** of history upstream. History grows until the parent is deleted. Media-Tron may add
   an optional retention setting; default must be "keep forever".

### 1.7 Consumers of history (rules that read it)

Specified fully in the decision-engine and import specs; summarised so the data above is sufficient.

1. **Already imported check (decision engine, permanent rejection).** Skipped when completed-download handling is off.
   For each item (TV: each episode of the release) that currently has a file: find the newest grabbed row and the
   newest imported row with the *same download id*. If either is missing, pass. If grabbed quality equals imported
   quality, pass (the guard exists only for the case where the file ended up a different quality than the grab and the
   same release would otherwise be grabbed repeatedly). Otherwise reject if the candidate is a torrent whose info-hash
   (upper-cased) equals the grabbed row's download id ("Has same torrent hash as a grabbed and imported release"), or
   its title equals the grabbed row's source title case-insensitively ("Has same release name as a grabbed and imported
   release"). Title-only comparison is intentional: the same title on another indexer is the same content.
   [TV] any single failing episode rejects the whole release; a passing episode `continue`s to the next one.
2. **Recent-grab check (RSS sync only; skipped for searches).** Look at the most recent history row per item. If it is
   a grabbed row and (it is newer than 12 hours *or* completed-download handling is off), compare the candidate against
   the grabbed quality/custom-format score using the normal cutoff/upgrade logic. Reject (permanent) with one of:
   recent grab already meets cutoff; equal or higher preference; equal or higher revision; meets quality cutoff;
   meets custom-format cutoff; equal or higher custom-format score; within the minimum score increment; profile does not
   allow upgrades. Messages are prefixed "Recent" when under 12 hours, else "CDH is disabled and". If the last grab is
   older than 12 hours and completed-download handling is on, the check is skipped (the grab either imported, failed,
   or is still downloading and tracked in the queue). If the grabbed quality's cutoff is *not* yet met and the upgrade
   reason is "none" (candidate is a real upgrade), the item passes. The custom formats of the earlier grab are
   recomputed from the history row (source title, quality, languages, size, flags), not read from storage.
   [TV] runs per episode; first rejecting episode wins.
3. **Download matching.** The tracked-download service looks up history by download id to find which items the download
   belongs to (the grabbed rows give item ids, indexer, time added, indexer flags). When the client item's own title
   cannot be matched, the grabbed row's source title is parsed instead.
4. **Import metadata.** When importing, the newest grabbed row for the download id supplies `IndexerFlags` and (TV)
   `ReleaseType` for the new library file. A release type from history that is "unknown" does not override the parsed one.
5. **Mark as failed.** Looks up grabbed rows by download id (section 3).
6. **Import-blocked warnings.** [TV] if a download cannot be matched by name and falls back to grab history, the grabbed
   row's `SeriesMatchType` and `ReleaseSource` decide whether to trust it: if the series was matched by id (not title or
   alias) and the source was not interactive search, automatic import is blocked with a warning; interactive grabs are
   trusted. (Rationale: an id-only match from an RSS release can be wrong.)

### 1.8 History API behaviour worth keeping

1. Each returned row includes `qualityCutoffNotMet` (boolean): whether the row's quality is below its parent's profile
   cutoff. Computed at read time, not stored.
2. Each row's custom formats are recomputed at read time; only the score at grab/import time is stored in data.
3. Paged results can embed the parent (and episode [TV]) objects on request.
4. "Mark as failed" on a history row: see 3.5.

---

## 2. Blocklist

### 2.1 Row shape

1. Fields: id, parent id, [TV] list of item ids (episode ids), source title (release title), quality, date added (UTC),
   published date (nullable), size (nullable bytes), protocol (usenet or torrent), indexer name (nullable), indexer
   flags, message (reason), torrent info-hash (nullable, torrents only), languages.
2. [TV] additionally: `source` (what created the entry: e.g. "TorrentFileValidation", an API origin, or blank) and
   `releaseType`. [Movie] has neither.
3. A row is scoped to a parent. Blocking a release for series A does not block it for series B (or a movie).

### 2.2 How entries are created

There are four creators.

**2.2.1 Download failed (automatic or manual).** Every download-failed event creates a blocklist row, *regardless of how
the failure was detected* (client reports failed/encrypted, user clicked "mark as failed" in history, user removed a
queue item with the blocklist option). Values:

- parent id, [TV] item ids = the failed event's item ids (all episodes of the grab).
- source title, quality, languages from the event (copied from the grabbed history row).
- date = now.
- published date = the grabbed row's `PublishedDate` data, parsed. Upstream requires it (a missing value throws and no
  row is written). Media-Tron should treat missing as null instead of failing.
- size = grabbed row's `Size` data, 0 if absent.
- indexer = grabbed row's `Indexer` data.
- protocol = grabbed row's `Protocol` data (integer) mapped to the enum.
- message = the failure message; [TV] source = the failure source.
- torrent info-hash: if the live tracked download is a torrent, use the download client's item id (for torrent clients
  this is the hash); otherwise use the grabbed row's `TorrentInfoHash` data if any.
- indexer flags and [TV] release type: parsed from the grabbed row's data (`IndexerFlags`, `ReleaseType`) by enum name,
  case-insensitive; if absent or unparsable leave at default (none / unknown).

**2.2.2 Manual block of a pending release.** In the queue, a *pending* release (delayed by a delay profile, not yet
sent to a client) can be removed with the "blocklist" flag, which creates a row from the pending release. Values:
parent, [TV] item ids, release title, parsed quality, date now, release publish date, release size, indexer, protocol,
message "Pending release manually blocklisted" ([TV] also passes a source: the request origin, may be null), languages,
and torrent hash if the release is a torrent with a hash. This path reads the release object, not a history row, and
does not set indexer flags.

**2.2.3 [TV only] Torrent file validation.** After a torrent client has accepted a torrent and the file list is
visible, the list is inspected. If it contains executable files (for example `.exe`, `.bat`, `.sh`, `.msi` and similar)
or files whose extension is on the user's rejected-extension list, the release is blocklisted immediately with message
beginning "Caution:" followed by one line per finding ("Found executables with extensions: ..." and "Found files with
user defined rejected extensions: ..."), source "TorrentFileValidation", and the grab is aborted as "release blocked".
[Movie] has no such creator in this snapshot; recommended to implement for both.

**2.2.4 Queue removal with blocklist (tracked downloads).** This does not write the blocklist directly: it marks the
grabbed history as failed (3.5), which triggers 2.2.1.

Not creators: ignoring a queue item (1.3.6), removing with keep-in-client and no blocklist, or an import failing. An
import failure leaves the download in "import blocked/failed" state until the user acts.

### 2.3 Matching a candidate release against the blocklist

Used by the decision engine's blocklist specification (permanent rejection) for every candidate in RSS and search.
Input: parent id and the release.

2.3.1 **Candidate pre-selection** (upstream uses substring matching):

- Torrent with non-blank info-hash: select rows for this parent whose stored hash *contains* the candidate hash.
  Then apply 2.3.2 to each. Rows with null hash never match here.
- Torrent without info-hash: select rows for this parent whose source title contains the release title, keep only
  rows whose protocol is torrent, then apply 2.3.2.
- A release whose protocol is torrent but which carries no torrent data (cannot read a hash property at all) is never
  considered blocklisted.
- Usenet: select rows for this parent whose source title contains the release title, keep only usenet rows, then apply
  2.3.3.

Recommended Media-Tron behaviour: use **case-insensitive equality** on title and hash instead of substring. This is
stricter than upstream only when a blocklisted title is a proper superstring of a new release's title (upstream: the
blocklisted "Show.S01E01.1080p.WEB-DL-GRP.REPACK" would block the shorter candidate "Show.S01E01.1080p.WEB-DL-GRP",
because the stored title contains the candidate). Record as a deliberate deviation.

2.3.2 **Same-torrent test.** If the candidate has a non-blank info-hash: match iff hashes are equal ignoring case.
Otherwise: match iff the blocklist row has no indexer recorded **or** its indexer name equals the candidate's indexer
ignoring case. (Title already matched in pre-selection.)

2.3.3 **Same-NZB test.**
- [TV] Indexer must match (a blank blocklist indexer counts as a match; otherwise case-insensitive equality) **and** the
  published date must be exactly equal (a row with null published date never equals).
- [Movie] Match if published dates are exactly equal (indexer ignored). Else match if **all** hold: indexer differs from
  the candidate's (the same release re-posted on another indexer), the candidate's publish date is within +/- 2 minutes
  of the row's (a row with no published date counts as within range), and size is within 2 MiB (a row with size 0 or null
  counts as same size). Radarr therefore catches the same NZB reposted to another indexer; Sonarr does not.
- Media-Tron should use the Radarr rule for both media types; it is a superset. Flag as a deliberate unification.

2.3.4 **Hash-only check** used at grab time (2.4): true iff any row of this parent has a hash equal (ignore case) to
the given hash.

Worked examples:

1. Torrent `Show.S02E03.1080p.WEB-DL-GRP`, hash `ABC123`, indexer "Tracker1"; blocklist has a row with hash `abc123`
   (failed earlier from "Tracker1"). Matches (hash equal ignoring case). Rejected.
2. Same release arrives from "Tracker2" with the same hash. Still matches: indexer is irrelevant when a hash exists.
3. Same release from an RSS feed that omits the hash (known only after the .torrent is fetched), indexer "Tracker1";
   row has indexer "Tracker1": title matches, no candidate hash, indexer equal, match. From "Tracker2": no match. This is
   why the grab-time hash check (2.4) exists.
4. Usenet `Movie.2020.1080p.BluRay-GRP` published 12:00:30, size 8.000 GB, indexer A; row from indexer B published
   12:01:10, size 8.001 GB. [Movie] match (different indexer, within 2 minutes, within 2 MiB). [TV] no match.
5. Row has null indexer (migrated data). Any candidate with a matching title and, for usenet, matching published date
   passes the indexer test.

### 2.4 Rejecting blocklisted torrents at grab time

1. Some indexers expose a per-indexer boolean "reject blocklisted torrent hashes" (upstream: Torznab, FileList, HDBits,
   IPTorrents, Nyaa, Torrentleech, TorrentRss, plus BroadcastheNet [TV], PassThePopcorn and TorrentPotato [Movie]; not
   available for usenet). Default false.
2. When a torrent is added to a client and the candidate had no info-hash during decisioning (the hash only became known
   after fetching the .torrent or magnet), the computed hash is stored on the release. Then, if the release did not come
   from an interactive search, the indexer's setting is on, and the hash is blocklisted for the parent (2.3.4), the
   grab throws "release blocked" with message "Release previously added to blocklist". The release is **not** added to
   the client and no new blocklist row is created.
3. Interactive searches skip this check on purpose: the user can force a blocklisted release through.
4. Media-Tron has one indexer registry; keep this as a per-indexer boolean on every torrent-capable indexer.

### 2.5 Interactive search and blocklisted releases

Interactive search shows blocklisted releases as rejected (permanent rejection) but the user can still choose to grab
them. Grabbing does not remove the blocklist row. If the grab fails again, a second row is created (no de-duplication).

### 2.6 Removing entries

1. A single entry can be deleted by id; many by a list of ids; all entries cleared by a "clear blocklist" command
   (full purge across all parents). All are user actions via API/UI.
2. Entries are deleted when their parent is deleted (event handler) and by housekeeping when the parent is missing.
3. Entries **do not expire**. There is no TTL. Deleting an entry is the only way to unblock (apart from deleting the
   parent).
4. Deleting an entry has no side effects on history or queue.

### 2.7 Listing

1. Paged list sorted by date descending by default; sortable by date, indexer, parent sort title, source title, and
   (via the sort key "quality") the quality's rank within the parent's profile.
2. Filters: parent ids, protocols (usenet/torrent). Custom formats are recomputed at read time from title, quality,
   languages, size and flags.
3. [Movie] also has a "blocklist for one movie" listing used on the movie detail page.

### 2.8 Effects on search and redownload

1. Blocklisting happens in the same event dispatch as the failed history row; the redownload step is ordered **last**
   (3.3), so when the new search runs the blocklist already contains the failed release.
2. The following automatic search therefore never picks the same release again (hash match or title+indexer match) but
   may pick the next-best one.

### 2.9 Cascade summary

| Event | History | Blocklist | Download history |
|---|---|---|---|
| parent deleted | rows deleted | rows deleted | rows deleted |
| episode deleted [TV] | orphan rows removed by housekeeping | untouched (housekeeping checks parent only) | untouched |
| clear blocklist command | untouched | all rows deleted | untouched |

---

## 3. Failed download flow (source of failed history + blocklist)

This ties together how failed events are created; the import spec covers the tracked-download lifecycle in depth.

### 3.1 Detection

1. On each queue refresh a tracked download is checked only if its state is **downloading** or **import blocked**
   (import-blocked is included because a download can fail after an import attempt).
2. A tracked download is *failed* if the client says its status is failed, or the client says it is encrypted.
3. If failed and no grabbed history row exists for its download id, the app did not grab it: do not act, add a warning
   to the tracked download ("... wasn't grabbed by <app>, skipping automatic download handling"); state unchanged.
4. If failed and grabbed history exists, the state becomes **failed pending**.
5. Later in the same cycle failed-pending items are processed: pick the grabbed rows for the download id (newest first;
   all rows of a season pack), build the message (priority: "Encrypted download detected" if encrypted; else the
   client's failure message if non-blank; else "Failed download detected"), set state to **failed**, and publish a
   download-failed event with source "<AppName> Failed Download Handling" [TV only has a source].

### 3.2 The failed event

Fields: parent id, item ids (distinct across all grabbed rows of the download; one for movies), quality, source title,
client type (from grabbed row data), download id, message, source [TV], the grabbed row's data map, the live tracked
download (nullable), languages, `skipRedownload`, and `releaseSource` parsed from the grabbed row's `ReleaseSource`
data (default unknown).

### 3.3 Subscribers (redownload runs last)

1. History: writes failed row(s) (1.3.3).
2. Blocklist: writes blocklist row (2.2.1).
3. Download history: if there is a tracked download, writes a "download failed" row (4.2); otherwise nothing.
4. Download event hub: if there is a tracked download whose item can be removed and the client definition has "remove
   failed downloads" enabled (default true), remove the item from the client.
5. Redownload (3.4).

### 3.4 Automatic redownload

1. Skipped if the event has `skipRedownload`.
2. Skipped if the global setting "auto redownload failed" is off (default **on**).
3. Skipped if the release came from interactive search and "auto redownload failed from interactive search" is off
   (default **on**).
4. [Movie] Otherwise queue a search command for the movie.
5. [TV] If the event has exactly one episode id: episode search for it. Else let S be the season of the first episode
   id; if the number of episode ids equals the number of episodes that exist in that season: season search (series +
   season). Otherwise (multi-episode file, partial pack): episode search for all ids in the event.
6. Commands are queued, not run inline.

Worked examples [TV]:
- Failed single-episode grab S03E05: episode search [S03E05].
- Failed pack with 10 grabbed rows, season 3 has 10 episodes: season search for S03.
- Failed pack with 8 grabbed rows, season has 10 existing episodes: episode search for the 8 ids. (The comparison is
  against *all existing* episodes in the season, not only monitored ones.)
- Failed double-episode release S03E05E06: episode search for both.

### 3.5 Manual "mark as failed"

1. **From a history row.** [TV] If the row has no download id: allowed only if it is a grabbed row, in which case a
   failed event is published for just that row's item (honouring skip-redownload); otherwise error "Unable to mark
   download as failed, history item was not grabbed and has no download ID". If it has a download id: list = the row
   itself (if grabbed) plus all grabbed rows with that id, de-duplicated; first is the template and all their item ids
   are used; error if the list is empty. Default message "Manually marked as failed". [Movie] always publishes a single
   failed event from the chosen row (no grabbed requirement, no error cases); the skip flag is honoured only in the
   no-download-id branch (an upstream inconsistency; recommend honouring it always).
2. **From the queue (tracked download), with the blocklist option.** Looks up grabbed rows by download id and publishes a
   failed event using the first as template and the live tracked download attached; if none exist, [TV] throws,
   [Movie] silently does nothing (recommend erroring).
3. Queue-remove options: `removeFromClient` (default true), `blocklist` (default false), `skipRedownload` (default
   false), `changeCategory` (default false: leave the item in the client but switch it to the post-import category so
   it stops being tracked). Order: first remove from client, else change category; then if blocklist, mark as failed
   (history + blocklist + maybe redownload); then if none of removeFromClient / blocklist / changeCategory were chosen,
   treat as **ignore** (1.3.6). Finally drop the tracked download from the in-memory list so the UI updates. Changing
   category is a bad request if the client has no post-import category.
4. A failed row created through (1) with no live tracked download has no `DownloadClientName`.

---

## 4. Download history (internal)

A separate store, written by the download pipeline and read by the tracked-download service to decide what to do with a
client item. Not shown in the UI.

### 4.1 Row shape

id, event type, parent id, download id (required), source title, date (UTC now), protocol, indexer id (int, 0 if
unknown), download client id (int), release (the full release object serialised; grabbed rows only), data map.

Event types: downloadGrabbed, downloadImported, downloadFailed, downloadIgnored, fileImported.

### 4.2 Writing rules

1. **Grabbed**: only when the grab produced a download id (clients that return none, such as blackhole folders, get no
   row). One row per grab (not per episode). Data: `Indexer`, `DownloadClient` (type), `DownloadClientName`,
   `CustomFormatScore`. Release object stored.
2. **File imported** (per imported file): written for new-download imports only; download id = the event's, or the
   fallback lookup (1.5.2); if still blank nothing is written. Source title = original file path. Data:
   `DownloadClient`, `DownloadClientName`; [TV] also `SourcePath` and `DestinationPath`.
3. **Download imported** (the tracked download completed): written when the completed-download event fires. Source
   title = client item title. Data: `DownloadClient`, `DownloadClientName`.
4. **Failed**: only when the failed event has a live tracked download. Same data as 3.
5. **Ignored**: always, with client info.
6. On parent deletion all rows for it are deleted.

### 4.3 Reading rules

1. **Already imported?** Walk the rows for the download id newest first. The first *grabbed* row found means "not
   imported" (grabbed again after import, or never imported). The first *download imported* row found means "imported".
   No relevant row: not imported. File-imported, failed and ignored rows are skipped during this walk.
2. **Latest state.** Walk newest first and return the first row whose type is ignored, grabbed, imported or failed
   (file-imported rows skipped). The tracked-download service maps it to an initial state when a client item is first
   seen after a restart: grabbed -> downloading, imported -> imported, failed -> failed, ignored -> ignored.
3. **Latest grab** for a download id: newest grabbed row (used to recover the indexer id).

Worked example: a torrent is grabbed (G1), imported (I1), later re-grabbed (G2, same hash), then the app restarts.
Newest first: G2 -> latest state "downloading", "already imported" false, so the item is processed again. Without G2:
I1 -> imported, not reprocessed even though the client still lists the item (e.g. seeding).

---

## 5. Ordering and tie-break notes

1. "Newest first" has no secondary key upstream; a season pack inserts N rows in the same instant so order among them is
   undefined. Media-Tron should tie-break on `id desc`.
2. The "first grabbed row" used as a failure template is the newest by timestamp. For packs all rows are equal apart from
   item id, so any is acceptable.
3. "Last grabbed" in the already-imported check is the first grabbed row in the newest-first list for the item.

---

## 6. Data keys that other rules depend on

An implementation is behaviourally compatible if at least these are persisted and retrievable:

| Key | Written by | Read by |
|---|---|---|
| `Indexer` | grabbed, failed, ignored | tracked download (indexer column), failed -> blocklist |
| `PublishedDate` | grabbed | failed -> blocklist |
| `Size` | grabbed, imported, failed | failed -> blocklist |
| `Protocol` | grabbed | failed -> blocklist |
| `TorrentInfoHash` | grabbed (torrent) | failed -> blocklist |
| `DownloadClient` | grabbed, imported, failed, ignored | failed event |
| `IndexerFlags` | grabbed, imported, deleted, renamed | import (file flags), failed -> blocklist |
| `ReleaseType` [TV] | grabbed, imported, ... | import (file release type), failed -> blocklist |
| `ReleaseSource` | grabbed | redownload (interactive exemption), import-blocked warning |
| `SeriesMatchType` / `MovieMatchType` | grabbed | import-blocked warning [TV] |
| `CustomFormatScore` | grabbed, imported | informational (formats are recomputed on read) |
| `ReleaseGroup`, `DroppedPath`, `ImportedPath`, `FileId`, `Reason` | various | UI only |
| `Message`, `Source` | failed / ignored | UI, blocklist message/source |

---

## 7. Sonarr vs Radarr differences

| Topic | Sonarr | Radarr | Recommendation |
|---|---|---|---|
| Rows per event | one per episode | one per movie | per item |
| History numeric ids deleted/renamed/ignored | 5/6/7 | 6/8/9 | one enum |
| `ManualOverride` delete creates history | no | yes | no |
| Same-NZB blocklist rule | indexer + exact publish date | exact date, or (other indexer + 2 min + 2 MiB) | Radarr rule |
| Blocklist `source`, `releaseType` | yes | no | keep both; null for movies |
| Torrent file-extension validation blocklists | yes | absent | implement for both |
| Failed `Source` field | yes | no | keep |
| Mark failed from history, no download id | grabbed rows only, else error | any row | require grabbed row |
| Mark failed from queue, no grabbed rows | error | silent no-op | error |
| Redownload | episode / season / multi-episode search | movie search | same |
| Ignore when parent unknown | refused | allowed | refuse |
| Find-download-id fallback | per-episode consistency | single still-downloading row | per-item generalisation |
| Quality-ceiling query | absent | present | implement for both |
| Data key comparison | case-sensitive dictionary, tolerant layer | explicitly case-insensitive | case-insensitive |
| History sort keys | date, series title | date, languages, movie title, quality | all |

---

## 8. Worked end-to-end scenarios

**Scenario A: successful TV pack.** User grabs Season 2 (8 episodes) via RSS.
1. Eight grabbed history rows (one per episode), same download id `H1`, same indexer/size/published date; one
   download-history grabbed row holding the release object.
2. Torrent finishes; import writes imported history rows (one per episode actually imported); each file gets a
   file-imported download-history row; when the tracked download completes a download-imported row is written.
3. A later RSS item with the same title: the already-imported check fires only if grabbed quality differs from imported
   quality. If the pack was tagged WEBDL-1080p and the files imported as WEBDL-1080p, the check passes and normal upgrade
   logic decides.

**Scenario B: failed movie, auto retry.**
1. Movie grabbed from indexer X, hash `H`. The client later reports failed with "Disk full".
2. Check: state failed-pending; process: failed event with message "Disk full". History failed row (Message, Indexer,
   Size from the client). Blocklist row: indexer X, hash `H` (the client item id), published date from the grabbed row,
   protocol torrent, message "Disk full". Download-history failed row. Client item removed (setting on). Movie search queued.
3. The search finds the same torrent on indexer X: hash match, rejected. A different torrent is grabbed instead.

**Scenario C: user removes a bad usenet item from the queue.**
- "Remove from client + blocklist", defaults: item deleted from client, failed event (message "Manually marked as
  failed"), blocklist row, failed history row, redownload search.
- Same with "do not search again" ticked: identical except no search.
- "Remove from queue only" (keep in client, no blocklist, no category change): ignored history row and download-history
  ignored row; the item is no longer tracked or retried. No blocklist.

**Scenario D: same release grabbed twice.** Two grabs with the same download id yield two grabbed rows per item. If it
fails, the failed event covers all grabbed rows sharing the id, so failed rows may duplicate. Media-Tron may collapse
duplicates by item id.

**Scenario E: renamed file.** The organizer renames `Show - S01E01 - Pilot.mkv` to `Show (2020) - S01E01 - Pilot
[WEBDL-1080p].mkv`: one renamed history row per linked episode with old and new absolute and relative paths. No
blocklist or download-history effect.

**Scenario F: manual import of a missing episode.** User imports a file for S01E02 from the downloads folder with no
download id; the grabbed row (hash `H2`, WEBDL-720p) exists and the file is WEBDL-720p. The fallback lookup (1.5.2)
finds `H2`; the imported history row carries `H2`, a file-imported download-history row is written, and
the grab no longer counts as still downloading, so a later manual import for another episode will not wrongly attach
to `H2`.

**Scenario G: blocklist entry blocks one parent only.** Release `X` fails for series A and is blocklisted for A. An RSS
item with identical title and hash matched to series B is not rejected by the blocklist spec.

---

## 9. Could not be determined / decisions needed

1. Case-sensitivity and substring behaviour of the upstream `Contains` queries differs by database (SQLite `LIKE`
   vs Postgres); the spec defines intended behaviour only.
2. Exact stored JSON key casing of the history data map was not verified; use case-insensitive keys.
3. The definition of "executable" extensions and the default user-rejected-extension list live in a helper that was not
   read; treat both as configuration.
4. Radarr's queue controller blocklist path for pending releases was only partially read (Radarr has a matching
   "Pending release manually blocklisted" call); assumed equivalent to Sonarr.
5. The client-polling history limit setting (default 60) belongs to the download-client spec, not here.
6. Whether any upstream scheduled job prunes old history was searched for and not found.
