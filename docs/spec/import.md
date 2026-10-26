# Import Specification

Behaviour spec for the completed-download and import pipeline in Media-Tron. It is derived from Sonarr (series) and Radarr (movies). Where the two apps differ, the difference is marked **[Sonarr]** or **[Radarr]**. Unmarked rules apply to both. Durations are ms, sizes are bytes, timestamps are ISO strings.

Pipeline overview:

1. Download-client items are polled and wrapped as **tracked downloads**.
2. A tracked download is checked for failure, then for completion.
3. A completed, matched download is handed to the **import service**.
4. The import service enumerates files and runs each through the **decision engine** (aggregation plus import specifications).
5. Approved decisions are **executed**: the old file is recycled, the new file is moved/copied/hard-linked, extras follow, events and history are written.
6. The tracked download is marked Imported, and the client item may be removed or re-categorised.

---

## 1. Download client items

1.1 A client item is a snapshot of one download as reported by a client. Fields: DownloadId (client-unique string), Category, Title, TotalSize, RemainingSize, RemainingTime, SeedRatio, OutputPath, Message, Status, IsEncrypted, CanMoveFiles, CanBeRemoved, plus client info (id, name, RemoveCompletedDownloads, RemoveFailedDownloads, HasPostImportCategory).

1.2 Item status values: Queued, Paused, Downloading, Completed, Failed, Warning. Each client maps its own states onto these. Example (qBittorrent): error → Warning; paused/stopped while downloading → Paused; queued/checking → Queued; paused/stopped/uploading/stalled/queued/forced while seeding → Completed; stalled downloading and missing files → Warning.

1.3 **CanMoveFiles** says whether the importer may move (consume) the files. **CanBeRemoved** says whether the item may be deleted from the client after import. They determine move vs copy (section 9):
- Usenet clients (SABnzbd, NZBGet, NzbVortex, Pneumatic, Download Station usenet): both true once Completed.
- Torrent clients: both true only when "remove completed downloads" is enabled for that client and the seeding goal (ratio/time) has been reached and the torrent is paused/stopped. Otherwise both false (the torrent is still seeding and must keep its files).
- Blackhole torrent: CanMoveFiles = not read-only.
- Aria2, Flood: CanMoveFiles always false.

1.4 OutputPath is always converted through remote path mappings (section 12) before use.

---

## 2. Tracked downloads

### 2.1 States

| State | Meaning |
|---|---|
| Downloading | In the client, or completed but not yet evaluated |
| ImportBlocked | Completed, cannot import automatically; needs manual action |
| ImportPending | Completed and matched; waiting for the import pass |
| Importing | Import pass is running |
| Imported | Import verified complete |
| FailedPending | Marked failed; awaiting failure processing |
| Failed | Failure processed |
| Ignored | User marked it ignored |

Status (separate from state): Ok, Warning, Error. Warning status carries a list of status messages (title plus detail lines) shown in the UI queue.

### 2.2 Refresh cycle

2.2.1 For every enabled download client (when download handling is enabled for it):
- Fetch its items.
- On success record client success and stop tracking any tracked download whose item vanished from the client list.
- On failure record client failure and continue.

2.2.2 Each item is passed to TrackDownload. If the resulting state is Downloading or ImportBlocked, run failed-download check (section 10) then completed-download check (section 3), in that order.

2.2.3 An item is **trackable** unless state is Imported, Failed or Ignored. When completed download handling is disabled, items whose client status is Completed are also not trackable.

2.2.4 After each refresh a "process monitored downloads" pass is queued at high priority (section 3.5).

2.2.5 A refresh is triggered on a timer and additionally, debounced by 5 seconds, after: release grabbed, episode/movie imported, manual interaction required, download client added/updated/deleted.

### 2.3 TrackDownload

2.3.1 If an in-memory tracked download already exists for the DownloadId and its state is not Downloading, only replace its client item and keep it trackable. Nothing else changes.

2.3.2 Otherwise build a new tracked download:
- Look up the most recent **download history** event for the DownloadId. Initial state: DownloadImported → Imported; DownloadFailed → Failed; DownloadIgnored → Ignored; anything else → Downloading.
- Parse the client item title (release parser) and try to map it to a series+episodes **[Sonarr]** or a movie **[Radarr]** via the parsing service.
- If the latest history event is DownloadImported, map directly via the stored SeriesId/MovieId instead of by title.
- If title parsing yields no result, no series, or no episodes, fall back to the *grabbed history* item for this DownloadId: use its source title and its recorded episode ids / movie id. **[Sonarr]** also tries the special-episode parser. **[Radarr]** maps by MovieId only.
- Set Indexer and Added (grab time) from the grabbed event. Copy indexer id and indexer flags onto the release. Run the remote-item aggregators and calculate custom formats using the client item's TotalSize.
- If more than one series/movie is plausible: status Warning, message "Unable to import automatically, found multiple series/movies: …". For any other parse failure: Warning, "Unable to parse episodes from title" **[Radarr]** "…parse movie from title".
- Carry over HasNotifiedManualInteractionRequired from any prior instance.

2.3.3 **Cache invalidation.** When a release with the same DownloadId is grabbed again, drop cached Imported/Failed/Ignored entries for that id so it is processed fresh. When episodes are refreshed/removed, or a series is added/edited/bulk-edited/deleted, re-parse the cached tracked downloads that reference it.

### 2.4 Download history (separate from user-facing History)

A small table recording the lifecycle of a download id. Events: DownloadGrabbed (not stored when DownloadId is empty), FileImported (only for new downloads; DownloadId may be inferred), DownloadImported, DownloadFailed (only when a tracked download exists), DownloadIgnored.

**"Already imported" test (DownloadAlreadyImported):** scan events for the DownloadId newest to oldest. If a grabbed event is seen first, result is false. If an imported event is seen first, result is true. If neither exists, false.

---

## 3. Completed-download handling

3.1 Enabled by "completed download handling" (default **true**). When disabled the importer relies on the user running a manual scan; Completed items are untracked.

### 3.2 Check (state Downloading or ImportBlocked, client status Completed)

1. Resolve the import item: ask the client for the final item (some clients return a different path for the completed state), using the previous item as hint.
2. Find the latest *Grabbed* history for the DownloadId.
3. If there is no grab history **and** the category is empty: warn "Download wasn't grabbed by {app} and not in a category, Skipping." Stay in current state.
4. Validate the output path:
   - Empty → warn "Download doesn't contain intermediate path, Skipping."
   - Not a valid *local* path (for example a Linux path on a Windows host) → warn "…is not a valid local path. You may need a Remote Path Mapping."
5. Match the series/movie from the client item title. If that fails, fall back to the series/movie recorded in the grab history.
6. If neither resolves: warn "Series title mismatch…" **[Radarr]** "Movie title mismatch…Manual Import required." and set ImportBlocked.
7. If the fallback was used and the grab's match type was *Id* (matched by tvdb/imdb/tmdb id rather than title) and the release source was not InteractiveSearch: warn and set ImportBlocked. Reason: the identity guess is unreliable without user confirmation.
8. Otherwise state becomes ImportPending.

### 3.3 Import (state ImportPending, completed download handling on)

1. Re-resolve the import item and re-validate the path as above.
2. If the tracked download has no resolved series (**[Radarr]** movie): warn "Unable to parse download, automatic import is not possible." and set ImportBlocked.
3. Set state Importing and call ProcessPath with: path = import item OutputPath, mode Auto, known series/movie, the client item.
4. Evaluate the results (3.4).

### 3.4 Evaluating import results

Let `results` be the per-file import results.

3.4.1 **Verify import.** 
- **[Sonarr]** count imported episodes in this run; if count ≥ max(1, expected episode count of the release) the download is verified.
- **[Radarr]** any imported result verifies.
- Fallback when nothing was imported just now: if the download-history/history shows each expected episode's (**[Radarr]** the movie's) most recent history event is DownloadFolderImported, treat as verified. Log a debug note about a possible history issue.
- On verified: state Imported; publish DownloadCompleted (series/movie, episodes, files, release info).
- Not verified: state returns to ImportPending (to retry next pass) before the blocking logic below.

3.4.2 **Empty results.**
- **[Sonarr]** First check the client's file list for a rejected extension (dangerous/executable/user-rejected). If found, apply rejected-import processing (3.4.3). Otherwise warn "No files found are eligible for import in {path}" and block.
- **[Radarr]** No client file-list check; same warning.

3.4.3 **Rejected-import processing** (when exactly one result and it is rejected, and the release is known):
- If the indexer settings cannot be found: warn and block.
- Reasons DangerousFile, ExecutableFile, and **[Sonarr only]** UserRejectedExtension: if the indexer's "fail downloads" setting includes the matching category (PotentiallyDangerous, Executables, UserDefinedExtensions) then **fail** the download: status Error, state FailedPending, CanBeRemoved = true. Otherwise warn and block.
- **[Sonarr]** a single MultiSeason rejection: warn and block (user must import manually).
- **[Radarr]** has no UserRejectedExtension branch and no MultiSeason.

3.4.4 **Otherwise** (some files rejected, not all expected items imported): build status messages. First line: "One or more episodes expected in this release were not imported or missing from the release" **[Radarr]** "One or more movies expected…". Then one line per rejected file, sorted by path, with its rejection reasons. Status Warning, state ImportBlocked.

3.4.5 **ImportBlocked notification.** On entering ImportBlocked publish ManualInteractionRequired once. HasNotifiedManualInteractionRequired prevents repeats on later cycles.

### 3.5 ProcessMonitoredDownloads

For each trackable tracked download:
- state ImportPending and completed download handling on → run Import (3.3).
- state FailedPending → run ProcessFailed (section 10).
Afterwards publish DownloadCanBeRemoved for each item with CanBeRemoved and state Imported. Finally publish DownloadsProcessed (extras use it to flush batched work, section 14).

### 3.6 Reacting to completion events

- DownloadCompleted: mark the item as imported on the client (apply post-import category or tag, when configured). Then remove from the client if all hold: CanBeRemoved, client status is not Downloading, and the client's RemoveCompletedDownloads is on.
- DownloadFailed: remove from client only if CanBeRemoved and the client's RemoveFailedDownloads is on.
- DownloadCanBeRemoved: remove if CanBeRemoved and RemoveCompletedDownloads.
- A successful removal stops tracking. A NotSupported client response is a warning only; other errors are logged and not fatal.

---

## 4. Import entry points

4.1 `ProcessPath(path, mode, series|movie?, clientItem?)`:
- If path is a directory → ProcessFolder.
- If it is a file → ProcessFile.
- Neither exists → log an error mentioning permissions, that the service user must be able to reach the path, and (on Windows) network-share caveats; return no results.

4.2 **Scan command** ("Downloaded episodes scan" / "Downloaded movies scan"): imports a given path, optionally tied to a downloadId. With a downloadId, verification (3.4.1) runs against that tracked download. If nothing imported the command reports unsuccessful.

4.3 **Root-folder scan** (path is the downloads root): each subfolder is processed as a folder import; each loose video file at the root is processed as a file import.

### 4.4 ProcessFolder

1. **Without a known series/movie:** clean the folder name by removing "_UNPACK_" and "_FAILED_" markers; look up the series/movie by that cleaned name. Unknown → rejection "Unknown Series/Movie" (one result, rejected).
2. **With a known series/movie:**
   - If the folder path equals the series' (movie's) library path: reject SeriesFolder/MovieFolder, "Import path is mapped to a series folder".
   - Parse the folder name (folder info) and the client item title (client info).
   - Collect video files under the folder (recursive), applying the path filters of 4.7.
   - If there is no client item and any video file is locked (cannot be opened exclusively): return rejection FileLocked "Locked file, try again later".
   - **[Sonarr]** If the client title parses as a multi-season pack: reject MultiSeason "Multi-season download, unable to import automatically".
   - Run decisions with sceneSource = true (4.8), then execute imports.
3. **Mode resolution for Auto:** Move if there is no client item or the client item CanMoveFiles; otherwise Copy (hard link or copy per config, section 9).
4. **Cleanup:** if the resolved mode is Move, at least one file imported, and ShouldDeleteFolder holds, delete the folder recursively (IO errors ignored). If no files imported, run the empty-result check (4.6).

### 4.5 ShouldDeleteFolder

True only when:
- every video file in the folder parses and is judged a Sample, and
- no `.rar` file is larger than 10 MB.
Any exception → false. **[Radarr]** a video file that does not parse → false.

Worked example: a release folder contains `movie.mkv` (imported, moved) and `Sample/sample.mkv` (rejected as sample). After the move the folder holds only the sample, so it is deleted. If a 3 GB `.rar` remained, the folder is kept.

### 4.6 Empty-result issue check

When a folder produced no results, report the first of:
1. Dangerous extension file present.
2. Executable extension file present.
3. **[Sonarr]** user-rejected extension file present.
4. Archive file present → ArchiveFile "Found archive file, might need to be extracted".

### 4.7 File filters

Excluded folders: `@eaDir`, `.@__thumb`, `plex versions`, and any folder whose name starts with a dot.
Excluded files: names starting with `._`, `.unmanic`, `.DS_Store`, `Thumbs.db`.
When extras are filtered (import of a download): skip any path under these folders: extras, extrafanart, behind the scenes, deleted scenes, featurettes, interviews, other, scenes, samples, shorts, trailers, theme music, backdrops; and skip file names ending (before the extension) with -trailer, -other, -behindthescenes, -deleted, -featurette, -interview, -scene, -short.

### 4.8 ProcessFile checks, in order

1. File name starts with "._" → InvalidFilePath.
2. Dangerous extension (.arj .lnk .lzh .ps1 .scr .vbs .zipx) → DangerousFile.
3. Executable extension (.bat .cmd .exe .sh) → ExecutableFile.
4. **[Sonarr]** extension in user-rejected list → UserRejectedExtension.
5. Extension not a recognised media extension → UnsupportedExtension.
6. Locked file (only when no client item) → FileLocked.
7. Otherwise run decisions and import.

Archive extensions (for warnings only): .7z .bz2 .gz .r00 .rar .tar.bz2 .tar.gz .tar .tb2 .tbz2 .tgz .zip.

Media extensions and the fallback quality they imply when nothing else is known:
- Unknown: .webm
- SDTV: .m4v .3gp .nsv .ty .strm .rm .rmvb .m3u .ifo .mov .qt .divx .xvid .bivx .nrg .pva .wmv .asf .asx .ogm .ogv .m2v .avi .bin .dat .dvr-ms .mpg .mpeg .mp4 .avc .vp3 .svq3 .nuv .viv .dv .fli .flv .wpl
- DVD: .img .iso .vob
- HDTV-720p: .mkv .ts .wtv
- Bluray-720p: .m2ts

---

## 5. Decision engine

5.1 `GetImportDecisions(files, series|movie?, downloadClientItem?, folderInfo?, sceneSource, filterExistingFiles, newDownload, …)` returns one decision per file: approved, or rejected with a list of reasons.

5.2 Steps per file:
1. Skip files already registered in the media-file table (when filterExistingFiles).
2. Create a local item (LocalEpisode / LocalMovie) with path, size, whether the file is already inside the library path (**ExistingFile**), and whether there are other non-sample video files alongside it. The count of non-sample videos is computed only for scene sources.
3. Parse the file path (file info). ReleaseType = first non-Unknown among client, folder, file info **[Sonarr]**.
4. Run aggregators (section 6). If no episodes/movie result:
   - **[Sonarr]** PartialSeason "Partial season packs are not supported" when the file parse is a partial season; SeasonExtra "Extras are not supported" for season extras; otherwise InvalidSeasonOrEpisode "Invalid season or episode".
   - **[Radarr]** InvalidMovie / UnknownMovie.
5. Copy indexer flags from the tracked download; compute custom formats (section 6.5).
6. Evaluate **every** import specification. All rejection reasons are collected; there is no short-circuit. A spec that throws yields a DecisionError rejection.
7. AugmentingFailed (nothing could be parsed anywhere) → UnableToParse. Any other exception → Error "Unexpected error processing file".

5.3 A decision with at least one rejection is rejected. *Permanent* rejections cannot be overridden by waiting; *temporary* ones (for example Sample indeterminate, still unpacking, locked) may later pass.

---

## 6. Aggregation

Augmentation fills out the local item from several sources. Source priority generally: file name, folder name, client item name, media info, grab history release name.

6.1 **Basics.** Set size; SceneName (6.2); MediaInfo (read for files not already in the library, or whenever EnableMediaInfo is on, default true).

6.2 **SceneName.** 
- If there are no other video files and client info is not a full-season release: client release title (without extension).
- Else the file name if it looks like a scene name.
- Else the folder title when there are no other videos, folder info is not a full season and it looks like a scene name.
- Else none. SceneName is set only for scene sources.

6.3 **Episodes [Sonarr].** Prefer file info. If there are no other video files and the file name is not scene-like, prefer client or folder info — unless that info is a full season or absolute-numbered while the file's is not. Try the special-episode parse if file info is absent or yielded no episodes. Validate the episodes against the series type (standard / daily / anime).

6.4 **Quality.** Each augmenter returns optionally a source, resolution and revision, each with a confidence: Fallback < Default < Tag < MediaInfo. Augmenter order: file name (1), folder (2), client item (3), media info (4), grab-history release name (5). For source and resolution the highest confidence wins; ties keep the earlier augmenter. Revision: highest revision wins. Media-info resolution thresholds: width ≥ 3200 or height ≥ 2100 → 2160p; width ≥ 1800 or height ≥ 1000 → 1080p; width ≥ 1200 or height ≥ 700 → 720p; width ≥ 1000 or height ≥ 560 → 576p; lower tiers are not specified here (see Gaps).

The grab-history augmenter parses the title of the latest grab for the DownloadId; a quality detected from the name has confidence Tag, otherwise Fallback. It returns nothing if there is no client item or no grab.

6.5 **Language.** Start with the series' (movie's) original language. Augmenters (file name 1, folder 2, client item 3, media info 4) each return languages with a confidence; the most recent non-Unknown result overrides.

6.6 **Release group.** **[Sonarr]** first a non-full-season client info group, then a non-full-season folder group, then file, then client, then folder. **[Radarr]** client, then folder, then file.

6.7 **Release info.** Load the grabbed history for the DownloadId onto the item (release title, indexer, size, flags).

6.8 **Custom formats.** Computed against the file name the naming builder would produce *and* against the original (pre-rename) file name. The two scores are used by the upgrade spec.

---

## 7. Import specifications

All specs run for every file. Rejections are listed as *Reason — message*. A spec marked "skips existing" accepts when the file is already inside the library path (ExistingFile).

### 7.1 Shared by both apps

**FreeSpace — MinimumFreeSpace "Not enough free space".** Skips existing. Skipped when SkipFreeSpaceCheckWhenImporting is on (default off). Reads free space of the volume holding the series (movie) path. Rejects if free < file size + MinimumFreeSpaceWhenImporting (default 100 MB). Unknown free space or an error → accept.

**HasAudioTrack — NoAudio.** Only if media info is present: reject when it reports zero audio streams.

**NotUnpacking — Unpacking "File is still being unpacked".** Config DownloadClientWorkingFolders (default `_UNPACK_|_FAILED_`). For each configured name, walk the file's parent folders; if a parent name starts with it: on non-Windows reject; on Windows reject only if the file was last written within the past 5 minutes.

**AlreadyImported — EpisodeAlreadyImported / MovieAlreadyImported.** Needs a client item. For each episode (movie) that already has a file in the library, find the latest DownloadFolderImported and latest Grabbed history events for this DownloadId. Reject if imported and never grabbed, or imported after the latest grab. Accept if grabbed after the import (re-grab for an upgrade). **[Radarr]** applies only if the movie HasFile.

**Upgrade — NotQualityUpgrade, NotRevisionUpgrade, NotCustomFormatUpgrade, NotCustomFormatUpgradeAfterRename.** For each episode with an existing file (**[Radarr]** the single movie file), compare to the profile ordering:
- New quality strictly lower → NotQualityUpgrade.
- Same quality, DownloadPropersAndRepacks ≠ DoNotPrefer, new revision < existing revision → NotRevisionUpgrade.
- Same quality and new custom-format score < existing score → rejected. If the *original file name* score would exceed the existing score the reason is NotCustomFormatUpgradeAfterRename; otherwise NotCustomFormatUpgrade.
- Otherwise accept (including equal).

Example: library has Bluray-1080p score 100. Incoming WEBDL-1080p score 50, same profile order lower → NotQualityUpgrade. Incoming Bluray-1080p proper (revision 2) vs existing revision 1 → accepted as an upgrade.

**MatchesGrab — EpisodeNotFoundInRelease / MovieNotFoundInRelease.** Uses the grabbed release's recorded episode ids / movie ids. Rejects when the file maps to ones not in the grabbed set. Only applies when a grab exists.

**NotSample — Sample / SampleIndeterminate.** See section 8.

### 7.2 Sonarr only

**AbsoluteEpisodeNumber — MissingAbsoluteEpisodeNumber.** For anime series where the naming format requires an absolute number: reject if any episode lacks an absolute number and aired within the last day; older episodes are exempt (data may lag).

**EpisodeTitle — TitleMissing, TitleTba.** Skips existing. Setting EpisodeTitleRequired: Always (default), BulkSeasonReleases, Never. Applies only if the naming format uses the episode title. BulkSeasonReleases accepts when every episode shares one air date and fewer than 4 season episodes share it. Episodes aired more than 48 hours ago are exempt. Otherwise reject empty title (TitleMissing) or a title equal to "TBA" (TitleTba).

**FullSeason — FullSeason.** A single file whose parsed info says it is a whole season: reject, "Single episode file contains all episodes in seasons. Review file name or manually import".

**MatchesFolder — EpisodeUnexpected.** Compares the episodes parsed from the file name to those implied by the folder name (special seasons handled). Accept if there is no folder info or no file info. Reject episodes in the file not implied by the folder. Messages format episodes as "SxEE".

**SameEpisodesImport — ExistingFileHasMoreEpisodes.** Permanent. Reject when the file already on disk covers more episodes than the incoming file.

**SplitEpisode — SplitEpisode.** File name signals one part of an episode: reject, "Single episode split into multiple files".

**UnverifiedSceneNumbering — UnverifiedSceneMapping.** Reject if any matched episode got its numbers from an unverified scene mapping (TheXEM).

### 7.3 Radarr only

**NotMultiPart — MultiPartMovie.** Message "File is suspected multi-part file, Radarr doesn't support this". Triggers when the path has a cd, dvd, part or disc marker and another file in the same folder is identical apart from the marker value.

**GrabbedReleaseQuality** — informational; always accepts (removed in practice because of WEB-DL vs WEBRip naming mismatch).

**MatchesFolder** — a stub that always accepts.

Radarr has no episode-title, absolute, full-season, split-episode, scene-numbering or same-episodes specs.

### 7.4 Rejection reason catalogue

- **[Sonarr]** Unknown, FileLocked, UnknownSeries, DangerousFile, ExecutableFile, UserRejectedExtension, ArchiveFile, SeriesFolder, InvalidFilePath, UnsupportedExtension, InvalidSeasonOrEpisode, PartialSeason, SeasonExtra, MultiSeason, UnableToParse, Error, DecisionError, EpisodeAlreadyImported, MinimumFreeSpace, NoAudio, EpisodeNotFoundInRelease, EpisodeUnexpected, Sample, SampleIndeterminate, Unpacking, ExistingFileHasMoreEpisodes, SplitEpisode, UnverifiedSceneMapping, FullSeason, TitleMissing, TitleTba, MissingAbsoluteEpisodeNumber, NotQualityUpgrade, NotRevisionUpgrade, NotCustomFormatUpgrade, NotCustomFormatUpgradeAfterRename, NoEpisodes (manual import).
- **[Radarr]** Unknown, FileLocked, UnknownMovie, DangerousFile, ExecutableFile, ArchiveFile, MovieFolder, InvalidFilePath, UnsupportedExtension, InvalidMovie, UnableToParse, Error, DecisionError, MovieAlreadyImported, MinimumFreeSpace, NoAudio, MovieNotFoundInRelease, Sample, SampleIndeterminate, Unpacking, MultiPartMovie, NotQualityUpgrade, NotRevisionUpgrade, NotCustomFormatUpgrade, NotCustomFormatUpgradeAfterRename.

---

## 8. Sample detection

8.1 Always treated as *not a sample* (accept): `.flv` and `.strm` files. **[Sonarr]** also specials (season 0). **[Radarr]** also `.iso`, `.img`, `.m2ts`. Files already inside the library (ExistingFile) are exempt.

8.2 Otherwise obtain the file runtime (seconds) from media info, falling back to an ffprobe-style read.
- Runtime unavailable → **Indeterminate** → rejection SampleIndeterminate (temporary).
- Runtime 0 → Sample.
- Otherwise compare with the **minimum runtime** derived from the expected runtime in minutes:
  - expected ≤ 3 → 15 s
  - ≤ 10 → 90 s
  - ≤ 30 → 300 s
  - above 30 → 600 s
  Runtime below the minimum → Sample.

8.3 Expected runtime. **[Sonarr]** sum over matched episodes of (episode runtime if > 0, otherwise series runtime), defaulting to 45 when nothing is known. **[Radarr]** the movie runtime (default when unknown applies the same minimum table).

Worked example **[Sonarr]**: a double-episode file covers two 22-minute episodes. Expected 44 min → minimum 600 s. A 9-minute file (540 s) is a sample; a 41-minute file is not.

8.4 Note: the upstream versions inspected contain **no** duplicate-size heuristic. Media-Tron must not invent one; if wanted later it is a new feature.

---

## 9. Executing approved imports

### 9.1 Ordering and grouping **[Sonarr]**

1. Group approved decisions by series.
2. Order by quality (profile order, best first), then size descending for the initial pass; then process in order of lowest episode number ascending, then size descending.
3. If any episode id of a decision has already been imported *in this batch*, that decision's result is rejected with "Episode has already been imported".

### 9.1b Ordering **[Radarr]**

Group by movie, order by quality then size descending. Only one file per movie imports in a batch; others get "Movie has already been imported".

### 9.2 Per approved decision

1. Build the library file record: path, size, date added, scene name, release group, quality, languages, media info, indexer flags from the grab history; **[Sonarr]** release type from grab history if not Unknown.
2. **Copy-only?** Import mode Auto → copy only when the client item says CanMoveFiles = false. Move → false. Copy → true.
3. **New download** (came from a client) vs **existing**:
   - New download: set OriginalFilePath to the path relative to the client's output directory; run the upgrade routine (9.3).
   - Manual non-new import (file already in library path): remove DB records mapped to the same relative path with reason ManualOverride; no move.
4. Add the file to the media-file table.
5. Extras (section 14).
6. Publish EpisodeImportedEvent / MovieImportedEvent with old files list and the new-download flag. This drives history, notifications and metadata.

### 9.3 Upgrade routine (recycle then place)

1. Collect existing library files for the matched episodes (movie), de-duplicated by file id.
2. If any exist and the owning root folder is missing → throw RootFolderNotFound.
3. For each existing file: if it exists on disk, send to the recycle bin with a sub-folder equal to its path relative to the root folder; otherwise log a warning. Record a deleted-file entry containing the recycle path (for the event). Delete the DB row with reason Upgrade.
4. Move or copy the new file into place (9.4).

### 9.4 Placing the file

Destination path is produced by the naming builder (see naming spec) using the media file's quality, custom formats and original extension.

- EnsureFolder: find the best root folder for the series path; if none or it does not exist on disk → RootFolderNotFound. Create series, season (**[Radarr]** movie) folders as needed, applying folder permissions, publishing a folder-created event.
- Source must exist (else FileNotFound). Source equal to destination → SameFilename error.
- **Move** mode: transfer mode Move.
- **Copy** mode: HardLinkOrCopy if CopyUsingHardlinks (default **true**), otherwise plain Copy.
- Optional script import (UseScriptImport, default off): an external script may report MoveComplete, RenameRequested, RejectExtra, or DeferMove; MoveComplete means the script placed the file.
- After placement: set file date per FileDate (None default, LocalAirDate, UtcAirDate) **[Sonarr]**; **[Radarr]** uses its own release-date choices. Apply permissions if SetPermissionsLinux (default false, ChmodFolder 755).

### 9.5 Disk transfer rules

Transfer modes: Move, Copy, HardLink, HardLinkOrCopy (combined flags).
- Target exists and overwrite disabled → DestinationAlreadyExists.
- Source equals target, or target is under source → error.
- **Move** same parent: verified rename; case-only rename goes through a temp name; Btrfs prefers rename/reflink. CIFS across mounts: verified copy then delete source. Otherwise verified move. The size at destination must equal the source after transfer.
- **HardLink**: if linking fails and Copy was not also requested → error.
- **HardLinkOrCopy**: try hard link; on failure (cross-device, FS without links) fall back to a verified copy (reflink where supported).

Worked example: torrent client still seeding (CanMoveFiles false) in `/downloads/Show.S01E01…mkv`; library on the same volume. Mode Auto → Copy → HardLinkOrCopy with default config → a hard link is made, no extra disk used, the torrent keeps seeding. If the library were on another volume the link fails and a full copy is made.

### 9.6 Import failure mapping

- RootFolderNotFound → "Failed to import episode, Root folder missing." plus an import-failed event.
- DestinationAlreadyExists → "…Destination already exists." and queue a series (movie) rescan so the existing file is picked up.
- RecycleBinException → "…unable to move existing file to the Recycle Bin." plus an import-failed event.
- Any other exception → "Failed to import episode" (movie equivalent).
Rejected decisions are appended to the results with their rejection messages.

---

## 10. Recycle bin and deletion

10.1 `RecycleBin` setting (default empty). If empty, "recycle" means permanent delete.

10.2 Otherwise: create the sub-folder in the bin, then move the file. If a file with that name exists, append `_2`, `_3`, … before the extension. Set the moved file's last-write time to now (so cleanup counts from deletion). IO failure → RecycleBinException.

10.3 Cleanup: RecycleBinCleanupDays default **7**; 0 disables cleanup. Delete files whose last write is older than the threshold; then delete empty sub-folders. A scheduled task runs daily.

10.4 Empty the bin: delete everything inside. Delete-folder: move a whole folder into the bin.

10.5 **When files are deleted or recycled:**
- Upgrade replaces an existing file → old file recycled, row removed (reason Upgrade).
- User deletes an episode/movie file → recycled; row removed (reason Manual). Requires the root folder to exist and not be empty, otherwise a conflict error — this guards against an unmounted drive wiping the library.
- Series/movie deleted with "delete files" → folder recycled, unless another series' path is a parent of or equal to it.
- Source folder after a successful Move import → deleted only under ShouldDeleteFolder (4.5).
- DeleteEmptyFolders (default off) removes empty series sub-folders after deletion.
- ManualOverride replaces DB records without touching disk.

---

## 11. Manual import

11.1 Listing candidate files, by:
- **Series [Sonarr]** (or movie): existing library files plus unmapped files under the library path; or
- **Folder path**, optionally with downloadId (then the tracked download's OutputPath is used).

11.2 Series/movie resolution per file: folder name, file path, tracked download, or title lookup. With no known series and more than 100 files, parsing is skipped for speed.

11.3 SceneSource = the folder being imported is neither the series path nor under it.

11.4 **ReprocessItem**: the user supplies quality, languages, release group, episodes (movie). The service re-augments the item, then re-applies the user choices, then re-runs the decision engine so the UI shows current rejections. A season without episodes → NoEpisodes "Episodes not selected".

11.5 **Execute** builds decisions with **no rejections**. Specs are bypassed and the user's choices win. ExistingFile = file is under the library path; newDownload = not existing.

11.6 Events: untracked (no downloadId) imports publish UntrackedDownloadCompleted, grouped by series and season. Tracked: if ShouldDeleteFolder and CanMoveFiles, delete the output folder; when the imported count reaches the expected count (minimum 1) set state Imported and publish DownloadCompleted, which triggers client removal (3.6).

Worked example: a pack's rejected files show "EpisodeUnexpected". The user picks the episodes manually and runs import; every chosen file imports even though specs would have rejected it, and the tracked download becomes Imported once the expected count is met.

---

## 12. Failed download handling

12.1 **Detection** (FailedDownloadService.Check; only in Downloading or ImportBlocked state): if the item IsEncrypted or client status is Failed:
- No grab history for the DownloadId → warn "Download is encrypted / failed and wasn't grabbed by {app}, skipping automatic download handling." Do nothing else.
- Otherwise state → FailedPending.

12.2 **ProcessFailed** (state FailedPending, grab history exists):
- Message: "Failed download detected"; "Encrypted download detected" if encrypted; the client's own message if status Failed and a message exists.
- State → Failed.
- Publish DownloadFailedEvent with source "{App} Failed Download Handling", carrying series/movie, episode ids, release info, download id, message, and tracked download.
- The blocklist handler records the failed release (see history-and-blocklist spec).

12.3 **Manual mark-as-failed** (`MarkAsFailed(historyId, …, skipRedownload)`):
- Default message "Manually marked as failed".
- **[Sonarr]** a history item with no download id is acceptable only if it is a Grabbed item (otherwise throw). Throws if no grabbed history exists.
- **[Radarr]** silently does nothing when no grab exists.
- With a download id, collect all Grabbed history rows for that id (the given row first, de-duplicated). **[Sonarr]** publishes one failed event covering all episode ids. **[Radarr]** publishes one event with the single movie id.
- Radarr has no source argument.

12.4 **Auto-redownload** (RedownloadFailedDownloadService; handles DownloadFailedEvent last, after blocklisting):
- Skip if SkipRedownload set.
- Skip if AutoRedownloadFailed is off (default **true**).
- Skip if the grab source was InteractiveSearch and AutoRedownloadFailedFromInteractiveSearch is off (default **true**).
- **[Sonarr]** one episode → search that episode. Episode count equals all episodes in that season → season search. Otherwise search those episode ids.
- **[Radarr]** MoviesSearch if MovieId ≠ 0.
- The failed release is blocklisted first so the search does not pick it again.

Worked example: an NZB reports "encrypted". Check sets FailedPending; ProcessMonitoredDownloads publishes DownloadFailed ("Encrypted download detected"); the blocklist records the release; the client removes the item (RemoveFailedDownloads on); a new episode search runs and picks the next-best release.

12.5 **Ignore.** User marks a queue item ignored → DownloadIgnored recorded ("Manually ignored"); the item is no longer trackable. **[Sonarr]** only when the series is known.

---

## 13. Remote path mappings

13.1 A mapping has Host, RemotePath, LocalPath. Used when the client runs on another machine or container with different mount points.

13.2 Validation: Host required; RemotePath not empty and not starting with a space; LocalPath rooted, non-empty and existing as a directory; (Host, RemotePath) unique. Both paths are normalised to directory form (trailing separator).

13.3 **Remote → local** (applied to client item output paths): iterate mappings in stored order; first mapping whose Host equals the client's configured host (case-insensitive) and whose RemotePath is a prefix of the given path wins. The result is LocalPath plus the remaining suffix. If none matches, the path is unchanged.

13.4 **Local → remote**: the reverse, using LocalPath as the prefix. Used when sending a path to a client (for example blackhole watch folders, manual import hints).

13.5 The mapping list is cached ~10 seconds.

13.6 Health symptom: a path from the client that fails the local-path test (3.2 step 4) or does not exist leads to the "may need a Remote Path Mapping" warning.

Worked example: client host `seedbox`, mapping RemotePath `/data/complete/`, LocalPath `D:\Downloads\`. Client reports `/data/complete/Show.S01E01/` → mapped to `D:\Downloads\Show.S01E01\`. A client on another host reporting the same path is not remapped.

---

## 14. Extras (sub-files imported with the media file)

14.1 Enabled by ImportExtraFiles (default **false**). ExtraFileExtensions default `srt` (comma-separated, no dots).

14.2 Search the source file's folder; recurse if the import came from a folder (folder info present).

14.3 **Managers**, in order; the first able to handle a file claims it:
1. Subtitle manager (order 1). Subtitle extensions: .aqt .ass .idx .jss .psb .rt .smi .srt .ssa .sub .txt .utf .utf8 .utf-8 .vtt (must also be in the user's extension list).
2. Other-files manager (order 2), for anything else in the list such as `.nfo`.
3. Metadata consumers, which create their own files after import.

14.4 **Matching.** A candidate belongs to the video when:
- its name starts with the video file name (case-insensitive); or
- **[Sonarr]** its parsed season and episode numbers equal the video's; **[Radarr]** its parsed title and year equal the video's.
If nothing matched and the candidate list has subtitles, all of them are used provided the folder has at most 2 video files and exactly 1 non-sample video file.

14.5 **Destination name** for subtitles: library file base name + optional title + optional copy index + optional two-letter language code (not when Unknown) + language tags + original extension. Copy index is added only when more than one subtitle has the same language/tag group: " - N" if a title is present, ".N" otherwise.

14.6 **Other extras** (nfo, etc.): a second `.nfo` for the same video is skipped. **[Sonarr]** adds `.N` when multiple matches exist. **[Radarr]** adds no suffix.

14.7 **Transfer mode** for extras: Move normally; Copy or HardLinkOrCopy when the video was imported copy-only (per CopyUsingHardlinks). Overwrite allowed.

14.8 If a script import handled the media file, its reported extra files are imported and renamed to follow the media file name; otherwise (or when ShouldImportExtras is set) the extras service runs.

14.9 Metadata consumers create files (poster, nfo) after an import. These are batched and flushed on DownloadsProcessed so a season pack triggers one pass. Folder-created events create folder-level metadata. Series rename or rescan events move extras; MoveFilesAfterRename renames extras to follow the media file.

---

## 15. Configuration defaults (summary)

| Setting | Default |
|---|---|
| EnableCompletedDownloadHandling | true |
| AutoRedownloadFailed | true |
| AutoRedownloadFailedFromInteractiveSearch | true |
| CopyUsingHardlinks | true |
| RecycleBin | empty (permanent delete) |
| RecycleBinCleanupDays | 7 |
| DownloadClientWorkingFolders | `_UNPACK_|_FAILED_` |
| MinimumFreeSpaceWhenImporting | 100 MB |
| SkipFreeSpaceCheckWhenImporting | false |
| FileDate | None |
| EnableMediaInfo | true |
| ImportExtraFiles | false |
| ExtraFileExtensions | srt |
| DeleteEmptyFolders | false |
| SetPermissionsLinux | false |
| ChmodFolder | 755 |
| UseScriptImport | false |
| **[Sonarr]** EpisodeTitleRequired | Always |
| **[Sonarr]** UserRejectedExtensions | empty |
| **[Sonarr]** CreateEmptySeriesFolders | false |
| RescanAfterRefresh | Always |

---

## 16. Edge cases and invariants

16.1 No decision ever deletes a library file without first recycling it (or the bin is unset and it is a permanent delete by explicit config).

16.2 A Move import never deletes the source folder unless all remaining videos are samples and no large archives remain.

16.3 A tracked download in Imported, Failed or Ignored state is never re-imported unless the same DownloadId is grabbed again (cache invalidation 2.3.3).

16.4 A download imported twice (user retries after success) is stopped by AlreadyImported (7.1) unless a newer grab exists.

16.5 If a root folder is unreachable (unmounted drive), imports and deletions fail with RootFolderNotFound rather than writing to a mount-point stub.

16.6 Multiple files for the same episode in one pack: the best quality (then largest) is processed first, the rest are rejected with "already imported".

16.7 Season pack with a missing episode: the present episodes import, the download stays ImportBlocked with the "not imported or missing" message until the user intervenes or the missing files are supplied.

---

## 17. Gaps and undeterminable items

- The brief's "duplicate-size heuristic" for sample detection does not exist upstream; only the runtime-based test above was found.
- The lowest tiers of the media-info resolution mapping (below 576p) were not fully read.
- Radarr's aggregation augmenters are assumed to mirror Sonarr's (apart from episodes, release type and release-group order).
- Per-client `GetImportItem` behaviour (how each client rewrites path or status once completed) is not enumerated.
- Script-import behaviour is summarised only; exit-code protocol details are not specified.
- Radarr's FileDate options and exact event payload fields were not exhaustively verified.
