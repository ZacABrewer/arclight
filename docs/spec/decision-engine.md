# Decision Engine Behaviour Specification

Status: spec derived from reading the Sonarr (v4 line) and Radarr (v5 line) decision engines.
Audience: an engineer implementing the rule set in TypeScript without reading the upstream code.
Rules are described, not transcribed. Where Sonarr and Radarr differ the rule is tagged **[TV]**
or **[MOVIE]**; untagged rules apply to both. "Series" also means "movie" for **[MOVIE]** unless
stated.

Vocabulary: a *release* is an indexer result; a *decision* is the verdict on one release; a
*specification* (spec) is one check; a *rejection* is one failed check with a reason code, a
human message, and a type (permanent or temporary).

---

## 1. Pipeline overview

1.1 Input is a list of releases from an RSS sync, an automatic search, a user-invoked search
(including interactive search), or a pushed release. The release source is recorded on every
decision as one of: `rss`, `search` (automatic), `userInvokedSearch`, `interactiveSearch`,
`releasePush`. Some specs behave differently by source (section 10).

1.2 For each release, independently and in input order:
  1. Parse the release title (section 3). If it cannot be parsed, the decision is a single
     rejection `unableToParse` ("Unable to parse release") **only when a search criteria is
     present**; during plain RSS/push an unparseable release is silently dropped.
  2. Map the parsed info to a library item (section 3). No library match produces a single
     rejection (`unknownSeries` / `unknownMovie`; **[TV]** also `unknownEpisode` when the series
     matched but no episodes could be identified, and `matchesAnotherSeries` when the title
     matches a known scene alias of a series that is not in the library). These short-circuit:
     no other specs run.
  3. "Augment" the mapped release (fill in languages, release group, indexer flags from title
     and indexer data; keep as a hook).
  4. Compute the release's custom formats (against title, size, indexer flags, languages) and
     its custom-format score using the item's quality profile (6.2).
  5. Run the specifications (1.4).
  6. An exception inside a spec becomes a rejection `decisionError`; any other exception becomes
     `error` ("Unexpected error processing release"). A bad release never aborts the batch.

1.3 Decision classification (computed from the rejection list):
  - **Approved**: zero rejections.
  - **Temporarily rejected**: at least one rejection and *all* are temporary.
  - **Rejected**: at least one *permanent* rejection (even if temporary ones are also present).
  Approved and temporarily-rejected releases that have at least one mapped episode / a mapped
  movie are "qualified" and proceed to grab or pending (section 12). Rejected ones are only
  reported (shown in interactive search with their reasons).

1.4 Specification evaluation uses two priority tiers:
  - Tier 0 (default / parsing / database): every spec runs for every release; all rejections are
    collected (so the UI can show several reasons).
  - Tier 1 (disk): evaluated only if tier 0 produced **no** rejection. Members: free space (both
    apps) and **[TV]** deleted-episode-file. Rationale: disk access is expensive, so only do it for
    otherwise-good releases.
  Order inside a tier does not change the outcome, only the order of the rejection list; keep a
  stable documented order for UI determinism.

1.5 Rejection record: `{ reason: enum, message: string, type: permanent|temporary }`. Quoted
messages are the upstream wording; reason codes are the contract. Full code list in section 14.

1.6 Spec independence: no spec depends on another having run. Specs read only the mapped release,
the library item(s), settings and services (history, queue, pending, blocklist, disk).

---

## 2. Settings and profile fields the engine reads

| Name | Meaning | Default (upstream) |
|---|---|---|
| `downloadPropersAndRepacks` | `preferAndUpgrade` / `doNotUpgrade` / `doNotPrefer` | `preferAndUpgrade` |
| `maximumSize` (MB) | Global hard cap for any release; 0 = off | 0 |
| `minimumAge` (minutes) | Usenet-only: ignore releases newer than this | 0 (off) |
| `retention` (days) | Usenet-only: ignore releases older than this | 0 (off) |
| `enableCompletedDownloadHandling` (CDH) | Affects history/already-imported specs | true |
| `skipFreeSpaceCheck` | **[TV]** "when grabbing"; **[MOVIE]** "when importing" | false |
| `minimumFreeSpaceWhenImporting` (MB) | Free space that must remain after import | 100 |
| `autoUnmonitorPreviouslyDownloaded` | Used by deleted-file spec | false |
| `seasonPackUpgrade` **[TV]** | `all` / `any` / `percent` | `all` |
| `seasonPackUpgradeThreshold` **[TV]** | percent, used when mode is `percent` | 100 |
| `availabilityDelay` (days) **[MOVIE]** | Extra days after the minimum-availability date | 0 |
| `preferIndexerFlags` **[MOVIE]** | Use indexer flags as a sort tiebreak | false |
| `allowHardcodedSubs`, `whitelistedHardcodedSubs` **[MOVIE]** | Hard-coded-subtitle policy | false, empty |

Quality profile fields: `upgradeAllowed`, `cutoff` (quality or group id), ordered `items` (each a
quality or a named group of qualities, each with `allowed`), `minFormatScore`, `cutoffFormatScore`,
`minUpgradeFormatScore`, and `formatItems` (custom format to score). Size limits: **[TV]** live on
each profile item (`minSize`, `maxSize`, `preferredSize`, MB per minute, nullable); **[MOVIE]** on
the global quality definition for that quality. Media-Tron may use global per-quality definitions
(the **[MOVIE]** way) unless per-profile overrides are wanted; the algorithm is identical.

Delay profile fields: `enableUsenet`, `enableTorrent`, `preferredProtocol`, `usenetDelay`,
`torrentDelay` (minutes), `order`, `bypassIfHighestQuality`, `bypassIfAboveCustomFormatScore`,
`minimumCustomFormatScore`, `tags`.

Release profile fields: `enabled`, `required[]`, `ignored[]`, `indexerIds[]`, `tags[]`,
`excludedTags[]`; **[TV]** additionally `airDateRestriction`, `airDateGracePeriod` (hours),
`allowSeasonPackWithoutAllEpisodesAired`.

---

## 3. Matching a release to a library item

This section specifies the *matching* that feeds the engine. The title parser itself has its own
spec (`packages/parser`).

### 3.1 Series matching [TV]

3.1.1 Special episodes first. If the title does not parse, or parses as "possibly a special" (a
season-0 release identified only by an episode title), try to resolve it as a special: find the
series (the search criteria's series if indexer-supplied TVDB/TVRage/IMDb id equals it; else by
title; else by an inexact "series title contained in release title" lookup choosing the leftmost,
then longest, match; else by indexer-supplied ids), then look for a season-0 episode whose title
matches the release title. If found, synthesise parsed info for it (season 0, that episode,
flagged `special`). If the series uses scene numbering and the parse is "SxxE00" style, prefer
scene-number lookup of that special instead.
3.1.2 If still unparsed, try parsing as a "season title without number" (e.g. anime "Series Name
Complete") and treat it as a season pack.
3.1.3 Series lookup order (first hit wins):
  1. Scene mapping (alias table) for the parsed title+season. If a search is running for series S
     and the mapping's TVDB id equals S, use S (match type "alias"); else look up by the mapped
     TVDB id. If the mapping points at a series not in the library, reject
     `matchesAnotherSeries` instead of `unknownSeries`.
  2. If a search is running: compare the cleaned parsed title to the searched series's cleaned
     original title, then its cleaned title (match type "title"). Else compare indexer-supplied
     TVDB id, then (only if no TVDB id supplied) TVRage id, then IMDb id to the searched series
     (match type "id").
  3. Otherwise cleaned title across the library; then every alternate title the parser produced
     (all alternates must resolve to the same series, else no match); then title-without-year plus
     year; then alias plus year; then indexer-supplied ids in order TVDB, TVRage (only if no
     TVDB), IMDb (only if no TVDB).
3.1.4 "Cleaned title": lowercase; strip diacritics; remove punctuation and whitespace; drop the
standalone words `a`, `an`, `the`, `and`, `or`, `of`; replace `%` with `percent`; a title made
only of digits is kept verbatim. Example: "The Walking Dead!" and "walking dead" both clean to
`walkingdead`.
3.1.5 Year disambiguation: a title carrying a year matches a library series with that exact
title+year first.

### 3.2 Episode matching [TV]

Zero mapped episodes means rejection `unknownEpisode`.

3.2.1 Season number mapping. Start with the parsed season. A scene mapping may offset it (scene
calls it season 3, TVDB season 2). If the series uses a non-official season order (DVD/absolute),
mappings are ignored and scene numbering is not applied.
3.2.2 A daily-format release (air date in the name) for a non-daily (standard) series maps to
nothing (warn).
3.2.3 Season pack (no episode numbers): all episodes of that season. If the series uses scene
numbering and the numbers came from a scene source, look up by scene season first, then normal
season. Multi-season pack (S01-S03): union of every season's episodes, each shifted by the offset
the mapping gave the first season.
3.2.4 Daily releases: find the episode by air date (and part number for split-day shows); episodes
in the search criteria are consulted first.
3.2.5 Absolute numbering (anime), per absolute number:
  - special: season-0 episode with that absolute number;
  - scene source: if the title has a scene season mapping, use scene numbering for that season;
    else if the parsed season > 1 and no episode numbers given, season+absolute; else
    scene-absolute lookup, but if that yields more than one episode, discard it (ambiguous);
  - fall back to the series-wide absolute number.
3.2.6 Standard numbering, per parsed episode number in the mapped season: if the series uses scene
numbering and the source is scene, look in the search criteria's episodes by scene season/episode
first, then library scene numbers (one scene episode may map to several real episodes);
otherwise exact season+episode, criteria's episodes first. Missing numbers are skipped.
3.2.7 A release flagged "special" with a non-zero mapped season maps to nothing.
3.2.8 Examples:
  - `Show.S02E05E06.1080p.WEB-DL` with S2E5 and S2E6 in library: both episodes.
  - `Show.S02.1080p.BluRay`: every S2 episode (including future-airing ones; see 4.18).
  - `Show.2024.03.15.720p.HDTV` for a daily series: the episode airing 2024-03-15.
  - `[Group] Anime - 125 [1080p]` for an anime: absolute 125 resolves to e.g. S05E07.
  - `Show.S01E01E02` where S01E02 is not in the library: maps to E01 only.

### 3.3 Movie matching [MOVIE]

3.3.1 Lookup order (first hit wins):
  1. Indexer-supplied IMDb id (ignore blank/"0"), then TMDb id. Accepted only if the parsed year
     is absent (< 1800) or equals the movie's year or secondary year, so a bad indexer id on a
     remake is not trusted. Match type "id".
  2. If a search is running, the candidate is the searched movie. It matches by title when any
     parsed title (cleaned) equals the movie's cleaned title, original title, any alternative
     title or translation (arabic/roman numerals equivalent: "Part 2" == "Part II") and the year
     rule holds. Failing that, indexer TMDb or IMDb id equal to the searched movie.
  3. No search running: library-wide title(+year) lookup. Order: movie title or original title;
     then "other titles" (numeral variants); then alternative titles; then translations; each step
     filtered by year when the parsed year is present. If the result is ambiguous (more than one
     distinct movie) there is no match.
3.3.2 No parsed year: title alone. With a year, the year is mandatory.
3.3.3 Several title forms in one release name ("Original AKA English") are all tried.
3.3.4 Example: `Dune.Part.Two.2024.2160p.WEB-DL` matches library "Dune: Part Two" (2024).
`Dune.2021.1080p` does not. `Blade.Runner.1982` picks the 1982 movie over the 2017 one; without a
year both match and the result is ambiguous: no match.

---

## 4. Release-intrinsic specs

Each entry: rule, type (P permanent / T temporary), examples. All are tier 0 unless stated.

### 4.1 Quality allowed by profile (P)
Find the release's quality in the item's quality profile (directly or as a group member). Reject
`qualityNotWanted` ("{quality} is not wanted in profile") if the containing entry is not allowed.
Example: profile allows WEBDL-1080p and Bluray-1080p only; release is HDTV-720p: rejected.

### 4.2 Custom-format minimum score (P)
If the custom-format score is below `minFormatScore`, reject `customFormatMinimumScore`. Equal is
accepted. Example: min 0, formats {x265: -100}: score -100, rejected. With no matching formats the
score is 0: passes a min of 0, fails a min of 1.

### 4.3 Language (P) [MOVIE only]
The profile has one `language`. `Any`: accept. `Original`: release languages must include the
movie's original language, else `wantedLanguage` ("Original Language (X) is wanted, but found
Y"). Otherwise release languages must include the wanted language. **[TV]** has no language spec
in v4; language is enforced via custom-format scores plus `minFormatScore`. Media-Tron should
offer language as custom-format conditions and optionally a profile-language shortcut.
Example: wanted German, release tagged English: rejected. German+English multi: accepted.

### 4.4 Global maximum size (P)
`maximumSize` 0: accept. Release size 0 (unknown): accept. Else reject `maximumSizeExceeded` if
size > maximumSize MB. Equal passes.

### 4.5 Per-quality size limits (P)
  1. Size 0 (unknown): accept. **[TV]** also accept specials.
  2. Runtime in minutes:
     - **[MOVIE]** movie runtime; if 0 use 110 for the whole check (so `unknownRuntime` cannot
       fire for movies; do not emit it).
     - **[TV]** sum over the release's episodes of (episode runtime if > 0, else series runtime).
       If series runtime is 0 and the release is in the first real season, and every episode with
       an air date aired within 24 hours of the pilot (or the release publish date when the pilot
       has no air date), assume 45 minutes per episode. If the total is still 0 reject
       `unknownRuntime` ("Runtime of all episodes is 0, unable to validate size until it is
       available").
  3. Find the quality's definition (**[TV]** the profile item, group member when grouped;
     **[MOVIE]** the global definition).
  4. Min: if `minSize` (MB/min) is set, required = minSize * runtime MB; reject
     `belowMinimumSize` if size is strictly smaller. minSize 0 never rejects.
  5. Max: `maxSize` null or 0 = **unlimited**, skip. Else maximum = maxSize * runtime; reject
     `aboveMaximumSize` if strictly larger.
  6. MB are mebibytes (1,048,576 bytes).
Examples:
  - [MOVIE] Bluray-1080p min 17.1, max 2000 MB/min, 120 min: window 2052 MB to 240,000 MB; a
    1.5 GB release is `belowMinimumSize`.
  - [TV] 24-minute episode, WEBDL-720p min 2, max 130: window 48 MB to 3120 MB.
  - [TV] double-episode of two 45-min episodes: runtime 90, limits double.
  - [TV] new series with unknown runtime: S01E01 releases get 45 min assumed if the pilot aired
    today; an S03E01 release is rejected `unknownRuntime`.
`preferredSize` is not used to accept/reject, only for ordering (11.7).

### 4.6 Sample (P)
Reject `sample` if the title contains "sample" (case-insensitive substring) and size < 70 MB.

### 4.7 Raw disc (P)
Reject `raw` if the title looks like an untouched disc: "Disc/Disk N ... Blu-ray", "<res> Full
Blu-ray", or DVD-R/DVD5/DVD9/MDVD forms; or the indexer-reported container is `vob`/`iso` ("Raw
DVD release") or `m2ts` ("Raw Bluray release"). Rejected: `Movie.2015.1080p.Full.Blu-ray`,
`Show.S01.Disc.1.Bluray`, `Movie.DVD-R`, `Show.DVD9`. Not rejected: `Movie.2015.1080p.BluRay.x264`.

### 4.8 Protocol enabled (P)
Take the best delay profile for the item's tags (7.1). If the release is usenet and usenet is
disabled there, or torrent and torrent disabled: reject `protocolDisabled`.

### 4.9 Usenet minimum age (T)
Usenet only. `minimumAge` 0: accept. Reject `minimumAge` if release age in minutes < minimumAge.
Torrents exempt. Temporary: the release is parked pending.

### 4.10 Usenet retention (P)
Usenet only. `retention` > 0 and age in whole days (floor) > retention: reject `maximumAge`
("Older than configured retention"). Retention 1500: published 1600 days ago rejected; 1500
accepted.

### 4.11 Torrent minimum seeders (P)
Torrent releases whose indexer exists. If seeders is known and below the indexer's
`minimumSeeders`: reject `minimumSeeders`. Unknown seeders or deleted indexer: accept.

### 4.12 Indexer tag match (P)
If the release's indexer has tags, the item must carry at least one; else reject `noMatchingTag`.
No indexer tags, unknown indexer, or indexer id 0: accept.

### 4.13 Blocked (failing) indexer (T)
If the indexer is disabled by failure backoff (`disabledTill` in the future) reject
`indexerDisabled` ("Indexer X is blocked till T due to failures, cannot grab release."). Cache the
lookup ~15 s.

### 4.14 Required indexer flags (P) [MOVIE only]
Torrent indexers may require flags (freeleech, internal...). Empty list: accept. Otherwise accept
if the release carries *any* required flag; else reject `requiredFlags`. Non-torrent or missing
indexer: accept.

### 4.15 Hard-coded subtitles (P) [MOVIE only]
If `allowHardcodedSubs` or no hard-coded marker in the title: accept. Otherwise accept only if the
marker text contains (case-insensitive) one of the comma-separated whitelist entries (blank
entries ignored); else reject `hardcodeSubtitles`.

### 4.16 Release profile required / ignored terms (P)
Applicable profiles: enabled, tags intersect the item's tags (or profile has none), excluded tags
do not intersect the item's tags, and indexer list empty or containing the release's indexer.
  1. Every applicable profile with a non-empty `required` list needs at least one term matching
     the title, else `mustContainMissing`. Multiple profiles are ANDed.
  2. Every applicable profile with a non-empty `ignored` list: any term matching rejects
     `mustNotContainPresent`.
A term is a plain case-insensitive substring, or, if written in `/pattern/` slash notation, a
case-insensitive regular expression. Cache compiled matchers.
Examples: required ["x265","HEVC"]: `Show.S01E01.1080p.WEB-DL.x264` rejected; with `HEVC`
accepted. Ignored ["/\bCAM\b/"]: `Movie.2023.CAM.x264` rejected.
Preferred-term scoring was removed upstream; use custom formats only.

### 4.17 Air-date restriction (P) [TV]
Among applicable release profiles pick the one with `airDateRestriction` on and the largest grace
period (hours). None: accept. For every episode: no air date rejects `beforeAirDate` ("No air date
available"); release publish date earlier than airDate + grace rejects. UTC.
Example: grace 2 h, airs 20:00 UTC, published 21:30: rejected; 22:00: accepted.

### 4.18 Full-season pack must have aired (P) [TV]
For a season pack, reject `fullSeasonNotAired` if any mapped episode has no air date or airs more
than 24 hours in the future. Skipped when applicable release profiles exist and the most
restrictive one (any profile with `allowSeasonPackWithoutAllEpisodesAired` false wins) permits it.
Example: finale in 3 days rejected; aired yesterday accepted; in 12 hours accepted.

### 4.19 Multi-season packs (P) [TV]
Reject `multiSeason` ("Multi-season releases are not supported") when the parse spans several
seasons. Matching (3.2.3) supports them; the spec rejects. Make it a setting; default reject.

### 4.20 Split episodes (P) [TV]
Reject `splitEpisode` when the parser flagged a split episode ("Part 1 of 2").

### 4.21 Ambiguous scene numbering (T) [TV]
If the scene mapping used has an origin beginning `mixed`, reject `ambiguousNumbering`. Origin
`unknown` is logged only. No mapping: accept.

### 4.22 Anime revision upgrade needs same group (P) [TV]
Anime series only, and not `doNotPrefer`. For each existing file: if the release is a revision
upgrade of it (6.4): existing group blank -> `unknownReleaseGroup`; release group blank ->
`unknownReleaseGroup`; groups differ -> `releaseGroupDoesNotMatch`. A v2 from a different fansub
is a different encode, not a fix.

### 4.23 Same-episodes grab (P) [TV]
If any existing file for the mapped episodes also contains an episode not in this release, reject
`existingFileHasMoreEpisodes`. Prevents replacing S01E01-E02.mkv with an E01-only file.

### 4.24 Minimum availability (P) [MOVIE]
Skipped for user-invoked searches. Availability date by `minimumAvailability`:
  - `announced`/TBA: always available.
  - `inCinemas`: the in-cinemas date if known; if unknown fall through.
  - `released` (and fall-through): earlier of digital and physical dates if both exist, whichever
    exists if one, else in-cinemas + 90 days, else never.
Available means now >= date + `availabilityDelay` days (not added for always/never). Otherwise
reject `availability`.
Examples: `released`, digital 2025-03-01, physical 2025-04-15: available 2025-03-01. `released`,
no digital/physical, cinemas 2025-01-10: available 2025-04-10. No dates: never.

### 4.25 Monitored (P)
  - **[TV]** If the search criteria allows unmonitored (manual search), accept. Reject
    `seriesNotMonitored` if the series is unmonitored. Single mapped episode unmonitored:
    `episodeNotMonitored`. Multi-episode with any unmonitored episode: `episodeNotMonitored`.
  - **[MOVIE]** Skipped for user-invoked searches; reject `movieNotMonitored` if unmonitored.

### 4.26 Deleted episode file (T, tier 1) [TV]
Only when `autoUnmonitorPreviouslyDownloaded` is on and only for RSS/push. If a mapped episode has
a file record whose file is missing on disk, reject `episodeNotMonitored` ("Episode is not
monitored") so RSS doesn't undo a manual deletion. Temporary because the missing file may be a
transient mount problem.

### 4.27 Free space (P, tier 1)
Skip setting on: accept. Measure free space at the item's path (series folder / movie folder);
unknown or missing directory: accept. **[TV]** cache 5 s per path. Remaining = free - release size.
Reject `minimumFreeSpace` if remaining <= 0, or remaining < `minimumFreeSpaceWhenImporting` MB.
Uses full release size, not net of the file being replaced.
Example: 50 GB free, 49.95 GB release, min 100 MB: remaining 50 MB: rejected.

---

## 5. History, queue and disk-state specs

### 5.1 Already imported (P)
Prevents re-grabbing a release whose recorded quality differs from the probed imported quality.
Skipped when CDH is off. For each mapped episode **[TV]** / the movie **[MOVIE]** that has a file:
  1. Take the most recent `grabbed` history event; none: continue.
  2. Find a `downloadFolderImported` event with the same download id; none: continue.
  3. If grabbed quality equals imported quality: continue.
  4. Torrent whose uppercase info-hash equals the grab's download id: `alreadyImportedSameHash`.
  5. Title equals (case-insensitive) the grab's source title: `alreadyImportedSameName`.
Example: grabbed `Show.S01E01.1080p.WEB` as WEBDL-1080p, file probed WEBDL-720p; the same release
reappearing in RSS is rejected by step 5.

### 5.2 Recent grab in history (P) — RSS/push only
Skipped entirely when a search criteria exists. For each mapped episode / the movie:
  1. Take the most recent history event of any type; if not `grabbed`, accept.
  2. `recent` = under 12 hours old. If not recent and CDH is on, accept.
  3. Compute custom formats of that event's source title, then cutoff-not-met and `isUpgradable`
     (section 6) comparing the grabbed item to the new release.
  4. If the grab already meets the cutoff: `historyRecentCutoffMet` if recent, else
     `historyCdhDisabledCutoffMet`.
  5. Else map `isUpgradable`: `none` continue; `betterQuality` -> `historyHigherPreference`;
     `betterRevision` -> `historyHigherRevision`; `qualityCutoff` -> `historyCutoffMet`;
     `customFormatCutoff` -> `historyCustomFormatCutoffMet`; `customFormatScore` ->
     `historyCustomFormatScore`; `minCustomFormatScore` -> `historyCustomFormatScoreIncrement`;
     `upgradesNotAllowed` -> `historyUpgradesNotAllowed`.
**[TV]** the first rejecting episode wins; **[MOVIE]** `none` accepts immediately.
Example: 10 minutes ago we grabbed WEBDL-1080p with cutoff WEBDL-1080p. RSS shows Bluray-1080p:
rejected `historyRecentCutoffMet`; the download is in flight and must not be raced.

### 5.3 Queue duplicate / upgrade over queue (P)
For every queue item for the same series sharing an episode **[TV]** / same movie **[MOVIE]**:
  1. Skip tracked state `failedPending`.
  2. Compute the queued item's custom formats from title and size.
  3. If it already meets the cutoff (6.5, using the candidate as the new quality for the revision
     rule): `queueCutoffMet`.
  4. Else `isUpgradable(queued -> candidate)`; non-`none` maps to `queueHigherPreference`,
     `queueHigherRevision`, `queueCutoffMet`, `queueCustomFormatCutoffMet`,
     `queueCustomFormatScore`, `queueCustomFormatScoreIncrement`, `queueUpgradesNotAllowed`.
  5. If the candidate is a pure revision upgrade over the queued item and
     `downloadPropersAndRepacks` is `doNotUpgrade`: `queuePropersDisabled`.
Any rejecting queue item rejects the candidate. A lower-quality queued item does not block a
better candidate. Exact duplicates are blocked by step 4 (equal quality, revision and score).

### 5.4 Upgrade allowed by profile (P)
For each existing file: compute its custom formats (stored release name/scene name, size, media
info) and `isUpgradeAllowed` (6.6). False: `qualityUpgradesDisabled`. No file: accept.

### 5.5 Upgrade over the file on disk (P)
No file: accept.
Single/multi-episode **[TV]** and **[MOVIE]**: for each existing file:
  1. File already meets the cutoff (6.5): `diskCutoffMet`.
  2. Else `isUpgradable(file -> release)`: `none` continues; others map to `diskHigherPreference`,
     `diskHigherRevision`, `diskCutoffMet`, `diskCustomFormatCutoffMet`, `diskCustomFormatScore`,
     `diskCustomFormatScoreIncrement`, `diskUpgradesNotAllowed`.
**[TV]** every file must pass; a release replacing E01 (upgradable) and E02 (not) is rejected.
**[TV] full-season pack:**
  1. N = episodes in the pack. Episodes without a file count as "upgraded".
  2. No episode has a file: accept.
  3. For each episode with a file: skip if it already meets the cutoff; count as upgraded when
     `isUpgradable` is `none`.
  4. Percent = upgraded/N*100. Mode `any`: >= 1 upgraded. `all`: 100%. `percent`: >= threshold.
  5. Else `diskNotUpgrade`.
Example: 10 episodes, 4 missing, 3 below cutoff and improvable, 3 at cutoff. Upgraded = 7 (70%):
`all` rejects; `any` accepts; `percent` threshold 60 accepts.

### 5.6 Proper handling in RSS (P) — RSS/push only
Skipped when a search criteria exists or `doNotPrefer`. For each existing file: if the release is a
revision upgrade of it (6.4): `doNotUpgrade` -> `propersDisabled`; file added more than 7 days ago
(from today's midnight) -> `properForOldFile`.

### 5.7 Repack needs same release group (P)
Only releases the parser marks as repack (not "PROPER"). Skip on `doNotPrefer`. For each existing
file: if a revision upgrade: `doNotUpgrade` -> `repackDisabled`; file group blank or release group
blank -> `repackUnknownReleaseGroup`; groups differ (case-insensitive) ->
`repackReleaseGroupDoesNotMatch`. A repack of a different quality is not a revision upgrade and is
not examined. Contrast 4.22: anime applies the same-group rule to all revisions.

### 5.8 Blocklist (P)
Reject `blocklisted` if blocklist matching hits (see history-and-blocklist spec):
  - Torrent with info-hash: any entry for that item with the same hash (case-insensitive).
  - Torrent without hash: entry for that item with same title, torrent protocol, and (entry
    indexer blank or same indexer).
  - Usenet: entry for that item with same title, usenet protocol, same indexer (or blank entry
    indexer), and identical publish date.
Scoped to the library item.

---

## 6. Quality comparison and upgrade logic

Pure functions in `packages/`, with table-driven tests. Used by 5.2-5.5, 7.2 and import.

### 6.1 `isUpgradable(profile, current, currentFormats, new, newFormats)`
Returns `none` (acceptable upgrade) or a reason. In order:
  1. `qc` = new vs current quality by profile position (6.3).
  2. `qc > 0` and quality cutoff not met for current (6.5): `none`.
  3. `qc < 0`: `betterQuality`.
  4. `rc` = revision compare (6.4).
  5. Mode not `doNotPrefer` and `rc > 0`: `none`.
  6. Profile does not allow upgrades: `upgradesNotAllowed`.
  7. Mode not `doNotPrefer` and `rc < 0`: `betterRevision`.
  8. `qc > 0` (cutoff already met): `qualityCutoff`.
  9. Qualities equal. `newScore <= currentScore`: `customFormatScore`.
  10. `currentScore >= cutoffFormatScore`: `customFormatCutoff`.
  11. `newScore < currentScore + minUpgradeFormatScore`: `minCustomFormatScore`.
  12. `none`.
A higher revision at equal quality returns `none` at step 5, before the upgrades-allowed check, so
propers upgrade even when upgrades are disabled (unless `doNotPrefer`).
Examples (order HDTV-720p, WEBDL-720p, WEBDL-1080p, Bluray-1080p; cutoff WEBDL-1080p; upgrades on;
cutoffFormatScore 100; minUpgradeFormatScore 1):
  a. HDTV-720p -> WEBDL-1080p: `none`.
  b. WEBDL-1080p -> Bluray-1080p: cutoff met, no revision gain, `qualityCutoff`.
  c. WEBDL-1080p -> WEBDL-720p: `betterQuality`.
  d. WEBDL-1080p v1 -> v2: `none`; under `doNotPrefer` equal scores give `customFormatScore`.
  e. Same quality, scores 50 -> 120, min increment 10: `none`. Current 150: `customFormatCutoff`.
  f. Upgrades off, HDTV-720p -> WEBDL-1080p: cutoff is the first allowed quality, so it is met:
     `upgradesNotAllowed`.

### 6.2 Custom-format score
Sum of the profile's score for every matched custom format (unlisted formats count 0). For a file:
computed from stored release/scene name, size, media info, languages, group. For history and
queue items: from source title and size, recomputed with the item's current profile.

### 6.3 Position comparison
A profile is an ordered list of entries (single quality or group). Position = index of the entry
containing the quality; group members share it. For decisions, qualities in one group compare
equal (rank within a group with custom formats). With `respectGroupOrder` (size lookup, preferred
size) the sub-index is a tiebreak. A quality not found has position 0.

### 6.4 Revision compare
A revision has `version` (1 original, 2 PROPER/REPACK...), `real` count, and `isRepack`. Compare
`real` first, then `version`. "Revision upgrade" = exactly the same quality enum and a strictly
higher revision. A v2 WEBDL over a v1 WEBRip is not a revision upgrade. REAL PROPER (real 1, v2)
over PROPER (real 0, v2) is.

### 6.5 Cutoff checks
`qualityCutoffNotMet(profile, current, new?)`: cutoff = profile cutoff if upgrades allowed, else
the first allowed quality. True if current position < cutoff position, or if `new` is given and is
a revision upgrade of current (so a cutoff-met file can still be replaced by a proper).
`customFormatCutoffNotMet(profile, formats)`: score < (cutoffFormatScore if upgrades allowed else
minFormatScore). `cutoffNotMet` = either. Item is "done" only if both are satisfied; this is also
the "cutoff unmet" wanted-list definition.

### 6.6 `isUpgradeAllowed`
`isQualityUpgrade` (new position/revision greater) and `isFormatUpgrade` (new score strictly
greater). Revision upgrade: true. Either upgrade: return profile `upgradeAllowed`. Neither: true
(non-upgrades are rejected by other specs).

---

## 7. Delay profiles and pending

### 7.1 Choosing a delay profile
Ordered list; the best for an item is the first by order whose tags intersect the item's tags or
that has no tags. A default catch-all always exists. Cache ~30 s.

### 7.2 Delay spec (T)
Skipped for user-invoked searches (including interactive). Otherwise:
  1. `delay` = profile delay (minutes) for the protocol; 0: accept.
  2. Proper bypass: release on the preferred protocol and improves only the revision of an
     existing file: accept. **[TV]** requires `preferAndUpgrade` and an equal-quality
     higher-revision release for any episode's file. **[MOVIE]** requires the file's
     `isUpgradable` to be `none` and a revision upgrade.
  3. `bypassIfHighestQuality`: quality position >= the profile's last allowed position and on the
     preferred protocol: accept.
  4. `bypassIfAboveCustomFormatScore`: score >= `minimumCustomFormatScore` and on the preferred
     protocol: accept.
  5. If a pending release for the same item(s) is older than the delay: accept.
  6. Release age (minutes) < delay: `minimumAgeDelay` ("Waiting for better quality release").
Example: torrent delay 60, usenet 0, preferred usenet. A torrent published 20 minutes ago is
parked; re-evaluated at 60 minutes. A Bluray-2160p torrent at the profile's top quality still
waits because torrent is not the preferred protocol.

### 7.3 Pending spec (T)
Not for RSS or user-invoked releases. If any release is pending for the same series with an
overlapping episode **[TV]** / same movie **[MOVIE]**: `minimumAgeDelayPushed`. A pushed or
searched release must not jump a delayed one.

### 7.4 Pending lifecycle
Temporarily rejected releases are stored with reason (`delay`, `downloadClientUnavailable`,
`fallback`) and become eligible at publish date + max(protocol delay, usenet minimum age). A job
re-runs decisions when their time arrives. Pending releases are removed when something is grabbed
for the item, when the item is deleted, or when profiles change (triggering re-evaluation). When
several pending releases cover one item, only the best is `delay`; the rest are `fallback`.

---

## 8. Search-only specs

8.1 Correct item (P): `wrongSeries` / `wrongMovie` if the mapped id differs from the searched id.
8.2 Requested episode (P) [TV]: `wrongEpisode` if none of the mapped episodes is requested.
8.3 Season search (P) [TV]: parsed seasons (or mapped season if none) must include the searched
season, else `wrongSeason`.
8.4 Single-episode search (P) [TV]: wrong season -> `wrongSeason`; a season pack -> `fullSeason`;
episode list without the searched number -> `wrongEpisode`. Anime episode search: any full-season
pack is `fullSeason` unless the search is a season search.
8.5 Season pack preferred for old seasons (P) [TV]: for multi-episode searches on standard series
whose indexer has `seasonSearchMaximumSingleEpisodeAge` > 0: a non-pack release that maps to
episodes is rejected `notSeasonPack` if the newest air date among the searched episodes of that
season is more than N days ago. Single-episode searches are exempt.

---

## 9. Spec ordering summary

Tier 0: release-intrinsic (4.x except 4.26/4.27), history/queue (5.x), delay/pending (7.2, 7.3),
search (8.x). Tier 1: 4.26 and 4.27.
Temporary rejections (complete list): usenet minimum age, blocked indexer, delay, pending-pushed,
ambiguous scene numbering **[TV]**, deleted episode file **[TV]**. Everything else is permanent.

---

## 10. Source behaviour

| Source | Behaviour |
|---|---|
| RSS / push | search specs accept; history (5.2), proper (5.6), deleted-file (4.26) run |
| Automatic search | 5.2, 5.6, 4.26 accept (criteria present); monitored and delay enforced |
| User-invoked search | delay, pending, **[MOVIE]** monitored and availability accept |
| Interactive search | as user-invoked; rejections are displayed and the user may override and grab |

---

## 11. Best-release ordering

Qualified decisions are grouped per series **[TV]** / movie **[MOVIE]**, each group sorted
best-first; decisions with no mapped item are appended after, unsorted. The sort is stable; the
first non-zero comparison decides.

Order **[MOVIE]**: quality, format score, protocol, indexer priority, indexer flags, peers, usenet
age, size. Order **[TV]**: quality, format score, protocol, episode count, episode number, indexer
priority, peers, usenet age, size.

11.1 Quality: profile position (higher better); unless `doNotPrefer`, revision breaks ties.
Group members tie.
11.2 Format score: higher better.
11.3 Protocol: the release matching the best delay profile's `preferredProtocol` wins.
11.4 Episode count [TV]: a season pack beats a non-pack. Otherwise anime: more episodes better;
non-anime: fewer episodes better.
11.5 Episode number [TV]: lower smallest episode number better.
11.6 Indexer priority: lower number better (1 beats 25).
11.7 Indexer flags [MOVIE], only if `preferIndexerFlags`: +2 each for freeleech, double-upload,
internal, PTP approved, PTP golden; +1 half-leech; higher better.
11.8 Peers (both torrent): compare round(log10(seeders)) (0 if missing or <= 0), then
round(log10(peers)). 20 vs 25 seeders tie; 5 vs 80 seeders differ.
11.9 Usenet age (both usenet), higher better: under 1 hour = 1000; within 24 hours = 100; within
7 days = 10; older = negative round(log10(age in days)).
11.10 Size: rounding unit 200 MB. If `preferredSize` (MB/min) is set and runtime is known
(**[TV]** summed episode runtime with series fallback; **[MOVIE]** movie runtime), score = negative
of |size - preferred*runtime| rounded to 200 MB (closest wins). Otherwise score = size rounded to
200 MB (biggest wins). Ties keep input order. Example: preferred 40 MB/min, 120 min => 4800 MB;
4.6 GB (distance 200) beats 6.5 GB (distance 1800).

---

## 12. Acting on decisions

12.1 Qualified decisions, sorted, are processed one at a time:
  1. If any episode (or the movie) is already part of a grabbed decision in this batch: skip.
  2. Temporarily rejected: add to pending with reason `delay`; if an overlapping release is already
     grabbed or pending in this batch, reason `fallback`.
  3. If the protocol's download client already failed in this batch: pending
     `downloadClientUnavailable`.
  4. Otherwise grab. Outcomes: grabbed; release unavailable at the indexer -> rejected; client
     unavailable/auth failure -> pending `downloadClientUnavailable` and mark that protocol failed
     for the batch; any other error -> skip.
12.2 Net: one release per episode set per run, the best; if the best is delayed, lesser ones are
fallbacks, not grabbed (delay means "wait for the better").
12.3 Examples:
  - WEBDL-1080p usenet and Bluray-1080p torrent (preferred usenet, torrent delay 30 min, 5 min old):
    Bluray sorts first, is pending, the WEBDL becomes fallback; nothing grabbed until the delay
    ends.
  - Same quality: 3 seeders vs 400 seeders on equal priority: the 400-seeder wins; equal seeders,
    priority 1 beats 25.
  - [TV] season pack and ten single episodes of equal quality and score: pack sorts first, is
    grabbed, each single is skipped as covered. If the pack scores lower the singles sort first
    and the pack is skipped as covered.

---

## 13. Edge cases to preserve

13.1 Unknown size (0), unknown seeders: accept. Unknown runtime: **[TV]** reject (4.5), **[MOVIE]**
110 minutes.
13.2 Boundaries are strict as described; "equal passes".
13.3 Protocol by enum, never file extension.
13.4 Dates UTC; "recent" = 12 h; "old file" = added before midnight 7 days ago.
13.5 CDH off changes 5.1 and 5.2. Media-Tron runs with CDH always on, so 5.2 step 2 reduces to
"not recent => accept"; keep `historyCdhDisabledCutoffMet` reserved.
13.6 Several rejections may accumulate; show all. A permanent one makes the decision `Rejected`, so
a delayed-and-blocklisted release is not parked.
13.7 Tier 1 specs never appear next to other rejections.
13.8 **[TV]** de-duplicate existing files by file id when episodes share a multi-episode file.
13.9 Queue/history custom-format scores are recomputed with the current profile; profile changes
alter decisions retroactively.
13.10 Unknown quality position is 0; profiles must contain every quality, allowed or not.

---

## 14. Rejection reason codes

Common: `unknown`, `unableToParse`, `error`, `decisionError`, `minimumAgeDelay`,
`minimumAgeDelayPushed`, `historyRecentCutoffMet`, `historyCdhDisabledCutoffMet`,
`historyHigherPreference`, `historyHigherRevision`, `historyCutoffMet`,
`historyCustomFormatCutoffMet`, `historyCustomFormatScore`, `historyCustomFormatScoreIncrement`,
`historyUpgradesNotAllowed`, `noMatchingTag`, `propersDisabled`, `properForOldFile`,
`belowMinimumSize`, `aboveMaximumSize`, `unknownRuntime`, `alreadyImportedSameHash`,
`alreadyImportedSameName`, `indexerDisabled`, `blocklisted`, `customFormatMinimumScore`,
`minimumFreeSpace`, `maximumSizeExceeded`, `minimumAge`, `maximumAge`, `sample`, `protocolDisabled`,
`qualityNotWanted`, `qualityUpgradesDisabled`, `queueHigherPreference`, `queueHigherRevision`,
`queueCutoffMet`, `queueCustomFormatCutoffMet`, `queueCustomFormatScore`,
`queueCustomFormatScoreIncrement`, `queueUpgradesNotAllowed`, `queuePropersDisabled`, `raw`,
`mustContainMissing`, `mustNotContainPresent`, `repackDisabled`, `repackUnknownReleaseGroup`,
`repackReleaseGroupDoesNotMatch`, `minimumSeeders`, `diskHigherPreference`, `diskHigherRevision`,
`diskCutoffMet`, `diskCustomFormatCutoffMet`, `diskCustomFormatScore`,
`diskCustomFormatScoreIncrement`, `diskUpgradesNotAllowed`.
TV only: `unknownSeries`, `unknownEpisode`, `matchesAnotherSeries`, `seriesNotMonitored`,
`episodeNotMonitored`, `wrongEpisode`, `wrongSeason`, `wrongSeries`, `fullSeason`,
`unknownReleaseGroup`, `releaseGroupDoesNotMatch`, `fullSeasonNotAired`, `multiSeason`,
`existingFileHasMoreEpisodes`, `ambiguousNumbering`, `notSeasonPack`, `splitEpisode`,
`diskNotUpgrade`, `beforeAirDate`.
Movie only: `unknownMovie`, `movieNotMonitored`, `wrongMovie`, `availability`, `hardcodeSubtitles`,
`wantedLanguage`, `requiredFlags`.

---

## 15. Suggested TypeScript shape (non-normative)

- `packages/decision` (pure): `decide(release, context): Decision`; `context` injects profile,
  delay profile, history, queue, pending, blocklist, free-space reader and clock so every spec is
  unit-testable.
- Spec: `{ id, tier: 0|1, type: 'permanent'|'temporary', appliesTo: 'tv'|'movie'|'both',
  evaluate(subject, info): Accept | Reject(reason, message) }`; a registry array defines order.
- `compareDecisions(a, b, ctx)` per section 11, used with a stable sort.
- Export `isUpgradable`, `cutoffNotMet`, `isRevisionUpgrade`, `isUpgradeAllowed` separately; the
  import pipeline reuses them.
- Property tests: equal quality/revision/score never upgrades; a higher score at equal quality is
  an upgrade iff it clears `minUpgradeFormatScore` and the cutoff; sorting is stable.

---

## 16. Not fully determined from the sources

- The title parser, scene-mapping data source and the "augment" step are outside this spec.
- Indexer failure-backoff schedule (feeds 4.13) and per-indexer seeder defaults belong to the
  indexer spec.
- Year extraction and release-group parsing are parser territory.
- Whether size limits are per profile or global is left to Media-Tron (section 2).
- The pending re-evaluation job interval was not derived in detail; use about one minute, bounded
  by each release's eligibility time.
- Movie multi-title matching relies on the parser's list of alternative title forms; behaviour on
  ambiguous multiple-movie matches was inferred as "no match".
- Custom-format condition evaluation is specified in the profiles spec, not here.
