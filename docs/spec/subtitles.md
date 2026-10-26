# Subtitles core: behaviour specification (Phase 3)

> Companion file: the per-provider catalogue lives in `subtitle-providers.md` (split to keep each spec under 900 lines).

Status: draft for implementation. Source of behaviour: Bazarr and its subliminal_patch fork. This is a clean-room description: it states what the system does, not how Bazarr is built. Per-provider details (endpoints, auth, quirks) are out of scope and live in a separate spec.

Conventions used here: rule ids are R<section>.<n>. "Item" means an episode or a movie. "Language code" means a lowercase two-letter code (alpha2) unless stated. Durations in the Media-Tron API are integer milliseconds, timestamps are ISO strings, sizes are bytes (per docs/CONVENTIONS.md). Where Bazarr uses hours, days or minutes in settings, the table in section 15 gives the unit; the stored value in Media-Tron should follow the convention and be converted at the edges.

Target module layout: `apps/api/src/modules/subtitles/` (profiles, wanted, history, blacklist, jobs) and `packages/subtitles` (scoring, naming, matching, provider pool, embedded reader). Zod schemas live in `packages/shared`.

---

## 1. Concepts and vocabulary

R1.1 A subtitle candidate is what a provider offers: provider name, provider subtitle id, language, forced flag, hearing-impaired (HI) flag, release info text, uploader, a hash-verifiable flag, an HI-verifiable flag, an is-pack flag, and optional framerate.

R1.2 A "requested language" is a triple: language, forced (yes/no), HI preference (see 2.4). The pool is asked for a set of requested languages for one item at a time.

R1.3 Subtitle identity on disk is (item, language, forced, HI). Two subtitles with the same triple cannot coexist for one item; saving one replaces the other.

R1.4 Internal language string form used in history, blacklist and missing lists: the language code, optionally followed by a colon and a suffix. "en" means normal, "en:forced" means forced, "en:hi" means hearing-impaired. Forced wins over HI (a subtitle is never both in this string form).

R1.5 A "score" is an integer. A "percent" is score divided by the maximum for the media type, times 100, rounded to 2 decimals. Thresholds are expressed as percent in settings and converted to integers at search time (R4.15).

R1.6 Media types: episode and movie. They differ in scoring tables, thresholds and settings, otherwise follow the same flow.

---

## 2. Language profiles

### 2.1 Shape

R2.1 A language profile has: id (integer), name, a list of items, a cutoff (an item id, or the special value 65535 meaning "any item"), must-contain list, must-not-contain list, an original-format flag (0 or 1), and an optional tag string.

R2.2 Each profile item has: item id (integer, unique inside the profile), language (two-letter code), forced ("True" or "False"), hi ("True", "False" or "Excluded"), audio_exclude ("True" or "False"), audio_only_include ("True" or "False").

R2.3 Legacy data used the HI values "only", "also", "never"; Bazarr migrated these to the two values "True" and "False". Media-Tron stores the three-valued form natively. On import of legacy profiles map only to True, also to False, never to Excluded (see Q1; the source only shows the two-value migration).

### 2.2 HI modes

R2.4 HI "False" (normal): the user wants a normal subtitle but accepts an HI one if no normal exists (the HI preference is "don't prefer"; HI results are allowed and the HI flag only matters for the +1 bonus, see R4.11).

R2.5 HI "True": the user requires an HI subtitle. The search runs in "force HI" mode: a candidate whose HI flag is verifiable and is not HI is skipped.

R2.6 HI "Excluded": the user requires a non-HI subtitle. The search runs in "force non-HI" mode: a candidate whose HI flag is verifiable and is HI is skipped. In manual search, HI results are hidden for that language.

R2.7 Mapping to search mode: item with hi "True" gives force-HI; hi "Excluded" gives force-non-HI; anything else gives don't-prefer. The mode is looked up from the profile item that matches the language AND the forced flag of the requested entry.

R2.8 Forced items are independent entries. A profile may hold "en normal" and "en forced" as two items. A forced item does not satisfy a non-forced item and vice versa.

### 2.3 Audio flags

R2.9 audio_exclude "True": do not want this language when the item's audio language equals it (example: do not fetch English subtitles for an English-audio episode). The item is removed from the desired list when the audio language matches.

R2.10 audio_only_include "True": only want this language when the item's audio language equals it. The item is removed from the desired list when the audio language does not match.

R2.11 The audio language of an item is the first audio language discovered by probing (see R7.9). If there is none, the value is the literal "None", which matches nothing.

### 2.4 Cutoff

R2.12 The cutoff names one profile item. Once a subtitle satisfying that item exists, the item is considered complete and nothing further is wanted for any other item in the profile. If cutoff is 65535, satisfying any one item completes the profile.

R2.13 Cutoff satisfaction is evaluated in section 3 (R3.8) and re-checked immediately before each language is searched (R5.4).

R2.14 Effect on upgrades: upgrades only consider language entries still desired by the profile (R8.4).

### 2.5 Must-contain and must-not-contain

R2.15 Both lists hold patterns matched case-insensitively against a candidate's release info text (the provider's release name or description). Bazarr treats entries as regular expressions; an invalid pattern is ignored. Media-Tron should accept either regex or plain substring entries, documented in the UI as "regular expression".

R2.16 Must-not-contain: a candidate is excluded if ANY pattern matches its release info.

R2.17 Must-contain: a candidate is excluded if ANY listed pattern does NOT match (every pattern must be present).

R2.18 Both rules are applied to the candidate list immediately after listing and before scoring, per provider, so excluded candidates never appear in manual search either.

### 2.6 Original format

R2.19 Original-format 1: keep the subtitle in the format the provider delivered (for example ass) instead of converting to SubRip, and do not force-normalize the content to SubRip when saving. 0: convert to SubRip (srt).

R2.20 Original-format also determines the extension chosen when a file is saved (R9.2) and whether sync will emit ass or srt.

### 2.7 Assigning profiles to items

R2.21 Items store a profile id or null. A null profile means "no subtitles wanted"; the missing list is empty (R3.9).

R2.22 When a series or movie is first inserted from Sonarr/Radarr (equivalent) sync, its profile is set to the default profile if the "default enabled" setting for that media type is true and the configured default profile id is non-empty and exists. Otherwise null. On later updates of an existing item the stored profile is kept.

R2.23 If the tag feature is enabled for the media type: after the default is applied, the item's tags are compared to the profiles' tag fields. If a profile's tag is found in the item's tag list, that profile is assigned (this also applies on updates, overriding a manual choice).

R2.24 If the remove-profile-tags setting is non-empty and the item has any tag from it, the profile is cleared to null. This runs after tag matching and wins.

R2.25 Series profile assignment applies to the series; every episode inherits it. Movies hold their own.

| Setting | Default | Meaning |
|---|---|---|
| serie_default_enabled | false | assign default profile on insert |
| serie_default_profile | empty | profile id |
| movie_default_enabled | false | same for movies |
| movie_default_profile | empty | profile id |
| serie_tag_enabled | false | match tags to profile tag |
| movie_tag_enabled | false | same for movies |
| remove_profile_tags | empty list | tags that clear the profile |

Example: profile 3 "Anime" has tag "anime". Series gets tag anime in Sonarr. With serie_tag_enabled the series is moved to profile 3 on next sync, even if the user had picked profile 1.

---

## 3. Wanted logic: missing-subtitle detection

R3.1 For each item, the system keeps a "missing" list: strings in the R1.4 form. It is recomputed whenever the item is (re)indexed (R3.10) or its profile changes.

R3.2 Inputs: the item's profile, its audio language, its indexed subtitles (embedded and external), and the language-equals setting.

### 3.1 Algorithm

R3.3 Step 1, desired list. Take every profile item. Drop those removed by audio_exclude (R2.9) or audio_only_include (R2.10). Each remaining entry becomes a requested string: language alone for normal, language:forced for forced, language:hi for HI "True".

R3.4 Step 2, actual list. Take indexed subtitles as strings in the same form. If use_embedded_subs is false, only external files (those with a path) count. If true, embedded tracks count too.

R3.5 Step 3, equivalence. The actual list is expanded with the language-equals map (R9.14). If the map says "es-MX equals es" then a found es-MX subtitle also counts as es.

R3.6 Step 4, matching rules between desired and actual:
- An exact match (language, forced, hi) satisfies.
- An existing HI subtitle satisfies a normal desired entry (HI "False") unless the entry's HI is "Excluded".
- An existing non-HI subtitle satisfies an "Excluded" entry.
- A normal subtitle does NOT satisfy an HI "True" entry.
- Forced never crosses over to non-forced.

R3.7 Step 5, missing = desired minus satisfied.

R3.8 Cutoff handling happens before step 5. If the cutoff is 65535, all profile items are cutoff candidates; otherwise only the one named item. If ANY cutoff candidate is satisfied, the missing list is the empty list. A cutoff candidate counts as satisfied when any of these holds:
- its audio_exclude is "True" and the audio language equals its language (it needs nothing);
- an exact (language, forced, hi) match exists;
- an equivalence-expanded match exists;
- the cutoff entry's HI is "False" and an HI subtitle of that language exists;
- the cutoff entry's HI is "Excluded" and a non-HI subtitle of that language exists.
A cutoff candidate whose audio_only_include is "True" while the audio language does not match is skipped (not considered at all).

R3.9 A show or movie with no profile gets an empty missing list. A null missing list (never computed) is treated as "unknown, reindex first" by the wanted job.

R3.10 Reindex triggers: item added or changed by sync (file path or file id changed), after any subtitle download, upload, deletion, extraction or mod, after the daily/weekly "index all subtitles" job, and by manual refresh.

Example A: profile = en normal, es normal, cutoff = es item. Item has embedded es track. Cutoff satisfied, missing = []. English is never searched.

Example B: profile = en HI "True". File has en.srt (non-HI). Not satisfied, missing = ["en:hi"].

Example C: profile = en HI "Excluded", file has en.hi.srt only. Not satisfied (an HI subtitle never satisfies Excluded), missing = ["en"].

Example D: audio is Japanese; profile items ja (audio_exclude True) and en. ja is dropped from desired; missing = ["en"] if no English exists.

### 3.2 Search eligibility (exclusion clause)

R3.11 Before an item is searched by a job, these exclusions apply: tags listed in the excluded-tags setting (sonarr/radarr sections), only_monitored (item monitored AND, for episodes, the parent series monitored), excluded series types (episode type selection such as anime), and exclude_season_zero for episodes.

R3.12 The same exclusion applies to the upgrade job (R8.5). It does NOT apply to manual search or manual upload.

R3.13 Files at or below MINIMUM_VIDEO_SIZE (20480 bytes) are not treated as videos by sync unless the strm feature is enabled and the path ends in .strm. Bazarr checks the size reported by the arr app first and falls back to the size on disk.

### 3.3 Embedded vs external

R3.14 Embedded tracks and external files are indexed separately (section 7) and both count towards "actual" when use_embedded_subs is true. Embedded tracks never have a path and are never deleted or replaced by downloads.

R3.15 The setting embedded_subs_show_desired (default true) is a UI preference: show desired embedded subtitles in the listing. It does not affect missing computation.

### 3.4 Search triggering

R3.16 Wanted-search job (R14): for each item with a non-empty missing list that passes eligibility, run the search flow once per missing language that passes the adaptive-search gate (section 3.5).

R3.17 Before each item the job checks provider availability (R13.11). If every enabled provider is throttled, the whole run aborts with a log "All providers throttled". It does not mark attempts.

R3.18 If the item's subtitle index is incomplete or its missing list is null, the item is reindexed first.

R3.19 After an arr import event (signalr-equivalent webhook/websocket), Media-Tron re-syncs that one episode or movie. If a new file was added or the path or file id changed, it recomputes missing and, if non-empty and the file exists on disk, queues an immediate search for that item (unless defer_search_signalr is true, in which case waiting for the scheduled run). If the path and file id are unchanged on update, search is deferred. If the file does not exist on disk yet, search is deferred to the scheduled run.

R3.20 Each successful result: re-store subtitle index, write history (action 1 automatic download), send a notification, emit an event for the UI.

R3.21 Note: Sonarr/Radarr in Bazarr's sync: the arr "sceneName" for the file is the release name used for matching (R5.12).

### 3.5 Adaptive backoff

R3.22 Settings: adaptive_searching (default true), adaptive_searching_delay (1w, 2w, 3w, 4w; default 3w), adaptive_searching_delta (3d, 1w, 2w, 3w, 4w; default 1w).

R3.23 State: per item, per language string, the system stores two timestamps: first attempt and last attempt. (Bazarr stores a list of [language, timestamp] entries, keeping only the first and last for each language.)

R3.24 Gate, evaluated per language per item per wanted run:
1. If adaptive_searching is off, or the language has no recorded attempt: search.
2. If now is earlier than first_attempt plus delay: search (still in the intensive window, every run searches).
3. Otherwise search only if last_attempt plus delta is at or before now.
A malformed or unparsable stored value means search.

R3.25 Recording: an attempt is recorded only when the search finished with nothing found AND providers were actually available (not all throttled). If the first attempt does not exist it is set; the last attempt is always updated. A found subtitle clears the language's attempts (the language leaves the missing list anyway).

R3.26 The backoff clock is time since the first attempt for that item and language. It is not based on the release date or age of the media.

Worked example (defaults, runs every 6 h): week 0 to 3, every run searches (about 84 runs). Week 3 onward, one search per week per language. A language first tried 1 January 00:00 is searched on every run until 22 January 00:00, then at most on 29 January, 5 February and so on.

R3.27 Manual actions (manual search, manual upload) ignore the gate. Upgrades have their own history-based rules (section 8) and also ignore the gate.

R3.28 Removing a language from a profile and re-adding it does not reset attempts unless the item file changes (reindex after replacement resets failedAttempts). Open question: Bazarr reset behaviour on file replacement is not fully verified; default: reset on file id change.

---

## 4. Scoring

R4.1 Scores are computed per candidate from a set of "matches" (string keys) and a table of weights. Scoring is not user-configurable in current Bazarr (stored overrides are deleted at startup). Implement as constants.

### 4.1 Weight tables

| Match key | Episode | Movie |
|---|---|---|
| hash | 359 | 179 |
| series | 160 | n/a |
| title | n/a | 60 |
| year | 90 | 40 |
| season | 30 | n/a |
| episode | 30 | n/a |
| source | 25 | 30 |
| edition | n/a | 30 |
| release_group | 20 | 15 |
| audio_codec | 1 | 1 |
| resolution | 1 | 1 |
| video_codec | 1 | 1 |
| hearing_impaired | 1 | 1 |
| streaming_service | 1 | 1 |

R4.2 Maximum score excluding hash: episode 360, movie 180. Check: episode = 160+90+30+30+25+20+1+1+1+1+1 = 360. Movie = 60+40+30+30+15+1+1+1+1+1 = 180. The hash weight is the maximum minus 1 (359 and 179), so a valid hash match, which stands for all other matches, scores one below the best non-hash score.

R4.3 Percent = score divided by the maximum (360 or 180), times 100.

### 4.2 Producing the match set (guess_matches)

The candidate's release info (and, for embedded or external files, the filename) is parsed with a release-name parser (guessit-equivalent) into attributes, and compared with the video (the item being searched). The video's attributes come from the filename, the arr scene name, the database, and probing (R5.10 to R5.13).

R4.4 Series match (episode): the sanitized candidate series title equals the sanitized video series title or any alternative series title of the video. Sanitize: replace hyphen, colon, parentheses, and dot with a space; delete apostrophe variants; collapse whitespace; lowercase.

R4.5 Title match (movie): sanitized candidate title equals the sanitized video title or any of its alternative titles.

R4.6 Episode title match (episode): the candidate's parsed episode title equals the video's episode title (sanitized). This adds the "episode"-title equivalence in R4.9 (it does not add a separate "title" weight for episodes since title is not an episode weight; it yields the episode match).

R4.7 Season and episode: season equal; episode equal. If the candidate guesses a multi-episode range, the lowest episode number is used. Year: equal years. For an original (not partial) series where the candidate string has no year, a year match is granted.

R4.8 Release group: compare after sanitizing (strip bracketed text, uppercase). A match when the groups are equal or both fall into one equivalence group:
- FRAMESTOR, W4NK3R, BHDSTUDIO
- LOL, DIMENSION
- ASAP, IMMERSE, FLEET
- AVS, SVA
If either side has several groups, any pair matching suffices.
If release_group matched but source did not, the release_group match is removed (a group name on a different source is untrustworthy).

R4.9 Source: both sides are mapped to a family and compared:
- TV: HDTV, SDTV, AHDTV, Ultra HDTV
- Air: SATRip, DVB, PPV, Digital TV
- Disk-HD: HD-DVD, Blu-ray, Ultra HD Blu-ray
- Disk-SD: DVD, VHS
- Web: Web
Families must be equal. An unknown source must be exactly equal.

R4.10 Exact-equality keys: video_codec, audio_codec, resolution (from screen size), and, as optional keys below, streaming_service and edition.

R4.11 Optional keys (streaming_service, edition, other): matched if both sides have a value and they are equal, OR both sides are absent. Consequence: a movie with no edition on either side earns the 30 edition points; any two items with no streaming service earn the +1.

R4.12 Hearing impaired: +1 when the user's HI preference equals the candidate's HI flag. The preference is only passed when the mode is "prefer" or "force HI" (that is, when HI is wanted). In don't-prefer mode no HI point is awarded either way.

R4.13 Framerate equality helper: 23.976, 23.98 and 24.0 are the same framerate. Used only when evaluating wrong-framerate flags on MicroDVD style subtitles.

### 4.3 Hash handling

R4.14 Candidate hash match means the provider matched the subtitle by the file's content hash (movie byte hash). It is only trusted when the provider declares its hash match verifiable.
- If the hash is verifiable and present in matches: it is valid only if ALL are also present — episodes: series, season, episode, source; movies: video_codec and source. Specials (season 0 style items) skip this validation. If valid, the match set is reduced to {hash} alone (score 359 or 179). If not valid, hash is removed from the set and the remaining matches score normally.
- If the hash is not verifiable but present: the hash is kept and the matches reduced to {hash}.

### 4.4 Equivalent matches

R4.15 Before summing, derived matches are added from identifiers:
| Provider gave | Adds |
|---|---|
| episode title matched (episode) | episode |
| series_imdb_id equal | series, year |
| imdb_id equal (episode id) | series, year, season, episode |
| tvdb_id equal (episode id) | series, year, season, episode, title (episode title) |
| series_tvdb_id equal | series, year |
| special, with title, series and year matched | season, episode |
| movie imdb_id equal | title, year |
The derived keys are added to the sum but are removed for the "original matches" used by the season/episode requirement in R5.8.

R4.16 compute_score returns two numbers: score (with the hash rule applied) and score_without_hash (sum of original matches plus equivalents, with hash removed). Both are used for sorting (R6.1).

R4.17 Minimum score as an integer: int(max times min_percent divided by 100) using truncation.
| Type | Setting | Default percent | Integer threshold |
|---|---|---|---|
| Episode | minimum_score | 90 | 324 of 360 |
| Movie | minimum_score_movie | 70 | 126 of 180 |

Examples (episode): series+year+season+episode+source = 160+90+30+30+25 = 335, at 93.06 percent: passes at 90. Series+season+episode+release_group+4 minor = 160+30+30+20+4 = 244: fails. Year missing is the commonest reason for failure.
Movie: title+year+source = 130, plus 4 small = 134. Passes 126. Title+year alone = 100 fails. Title+year+edition (both absent) = 130 passes: this is why the absent-edition rule matters.

R4.18 Is-pack candidates (season packs, multi-episode archives) carry is_pack and pack_data; no special scoring exists. The provider extracts the matching entry from the pack; the entry is then scored as a normal candidate. The filename "remove_crap" cleaner strips scene noise (tokens such as obfuscated, scrambled, nzbgeek, chamele0n, buymore, xpost, postbot, asrequested, plus trailing bracketed tags) from the video name before parsing, so these tokens never reduce the match.

---

## 5. Provider search flow

### 5.1 Pool construction

R5.1 One provider pool is cached per (media type, profile id) and refreshed on each call with current providers, their configs, the blacklist, the ban lists (R2.16, R2.17) and the language-equals map. The pool object is recreated every 12 hours.

R5.2 The provider set is the enabled providers minus those currently throttled (R13). If none remain the search returns "All providers are throttled" and no attempt is recorded.

R5.3 Provider order: the order configured in settings (enabled list order). It matters for sequential mode and for tie-breaks (R6.3). Roadmap order for Phase 3 defaults: OpenSubtitles.com, Subdl, Addic7ed, Podnapisi, Gestdown, Subf2m, Napisy24, Animetosho, embedded extraction, with Whisper last and optional.

R5.4 Before each language is searched, re-check that it is still missing (it may have been satisfied by a previous download in the same run, or cutoff reached).

### 5.2 Query inputs

R5.5 For every request, the video descriptor carries:
- Episode: series title (trailing "(YYYY)" removed), alternative series titles, season, episode, absolute episode number (anime), episode title, year (used as fallback only when the parsed filename has none), series tvdb id, series imdb id, episode imdb id, episode tvdb id, source, resolution, video codec, audio codec, release group, scene name, file size, framerate, file path, and hash set.
- Movie: title, alternative titles, year, imdb id, tmdb id, source, resolution, codecs, release group, scene name, size, fps, path, hash set.

R5.6 Language set: the missing languages for the item mapped to requested triples (R1.2), minus any not supported by a given provider. Bazarr searches each missing language separately (one request set per language) so the HI mode and minimum score logic is per language.

R5.7 Hashes (R5.9) and ids are provider-specific inputs; a provider uses what it understands.

### 5.3 Concurrency

R5.8 If multithreading is on (default true), all eligible providers are queried in parallel with one worker per provider, otherwise sequentially in order. The setting concurrent_jobs (default min(4, CPU count)) bounds background jobs overall, not provider calls.

R5.9 Hashing: file hashes are computed only for files larger than 10485760 bytes. Hash types: OpenSubtitles-style 64-bit hash (used by providers that accept it), and a few site-specific hashes. Hashing is skipped when skip_hashing is true or when all providers are throttled. Hash computation should be lazy and cached per file.

R5.10 A provider is skipped for a request if its supported video type does not include the media type, or it supports none of the requested languages (after language-equals mapping on its side).

R5.11 Provider failure handling: an exception goes to the throttle handler (section 13); a provider that returns "none" (as opposed to an empty list) is discarded from the pool for the pool's lifetime (until recreation after up to 12 hours or restart). A timeout on one provider does not delay results from others beyond the pool timeout (open question).

### 5.4 Video refinement

R5.12 The video object is built in layers:
1. Parse the file name with a release-name parser, with hints for the type.
2. Merge a second parse of the arr scene name: only fill fields still missing.
3. Refiners, in order: database (arr metadata), ffprobe (stream info), arr history (only for specific providers that need the info URL), anidb, anilist.
Database refiner: ids, titles, alt titles, season/episode, year (fallback), plus source/resolution/codecs only if not already set. ffprobe refiner: resolution, video codec, fps, first audio codec, and set of audio languages from cached probe data. use_scenename (default true) enables scene name merge.

R5.13 Result: a single video descriptor reused for every provider; do not mutate per provider.

### 5.5 Post-list filtering

R5.14 After a provider lists candidates, in order: drop those in the blacklist (matching provider and subtitle id, section 10), drop by ban list (R2.16, R2.17), drop duplicates by (provider, id).

R5.15 Language-equals: if configured, providers return codes in the equals-map "from" form (for example es-MX); these are converted to the "to" form for scoring and storage, with flags: "en@hi" format means English HI, "es-MX@forced" forced Mexican Spanish.

---

## 6. Selecting the winner

R6.1 Candidates for the requested language are sorted by (score, score_without_hash), both descending.

R6.2 Walk the sorted list:
1. Skip a candidate whose language was not requested.
2. Stop at the first candidate whose score is below the minimum (R4.17). Everything after is lower.
3. Skip if a subtitle for this language was already downloaded in this run.
4. In force-HI or force-non-HI mode, skip a candidate whose HI flag is verifiable but which does not have the hearing_impaired match (the match is only present when HI equals the preference).
5. For episodes, require season and episode in the ORIGINAL matches (before equivalents) plus either series or imdb_id; waived when the candidate's hash is not verifiable. This blocks wrong-episode subtitles that scored high from equivalents alone.
6. Download (R6.5). On success stop (only one per language).

R6.3 Ties: when score and score_without_hash tie, the order is stable on the pool's listing order, which follows provider order (R5.3) and then the provider's own returned order. Open question: Bazarr relies on sort stability, no explicit tie-break. Default: preserve provider order.

R6.4 Whisper fallback: if no subtitle was downloaded for the language, the fallback is allowed (use_whisper_fallback for movies, use_whisper_fallback_series for series, both default false) and the whisper provider is enabled, generate one from audio and save it. The fallback ignores the minimum score; it is recorded with provider "whisperai".

### 6.1 Download step

R6.5 Download of a chosen candidate: up to 3 tries with a 6 second sleep between tries. Connection and timeout errors throttle the provider and retry. A "bad archive" or "must be blacklisted" error throttles and returns failure for this candidate (the next candidate is then tried). Any other error throttles, discards the provider from the pool, and returns failure.

R6.6 After a successful download: validate (parse as SubRip, otherwise convert with a subtitle toolkit; MicroDVD uses subtitle fps, else provider fps if 10 or more, else media fps; invalid content fails the candidate), then normalize.

R6.7 Normalize: re-encode to UTF-8 and use LF line endings, unless utf8_encode is false (default true). Encoding detection order:
1. The provider's declared encoding, if it decodes.
2. UTF-8 and BOM variants.
3. Language-specific lists: Chinese (cp936, gb2312, gbk, big5 and similar), Japanese (shift-jis, cp932, euc-jp), Thai (tis-620, cp874), Arabic and Persian (windows-1256), Hebrew (windows-1255), Turkish (windows-1254), Greek (windows-1253), Central European (windows-1250, iso-8859-2), Cyrillic (windows-1251, iso-8859-5), Serbian (depends on script), default Western (windows-1252, iso-8859-15 and others).
4. A statistical detector.
5. A last-resort markup/unicode dammit style detector.
Then text fixing (mojibake repair) with uncurling of quotes disabled and full-width character fix disabled.

R6.8 Mods (subtitle content modifiers) apply on save: configured in subzero_mods (default empty; list of mod names such as remove_HI, remove_tags, OCR_fixes, fix_uppercase, color, common). Mod catalogue is an open question (section 16).

### 6.2 Score reporting

R6.9 The saved subtitle remembers its score and its matches; history stores score, score_out_of, matched and not_matched lists. If the hash matched, the stored matches are trimmed to hash and hearing_impaired; not-matched is empty. Otherwise not_matched = scored keys of the table minus the matches.

R6.10 Message format for logs and notifications: "<Language>[ HI| forced] subtitles <downloaded|upgraded|manually downloaded> from <provider> with a score of <percent>%."

---

## 7. Embedded subtitle handling

### 7.1 Reading tracks

R7.1 Setting use_embedded_subs (default true). Probing tool: embedded_subtitles_parser, ffprobe (default) or mediainfo. Output is cached per file (use_ffprobe_cache default true), keyed by file; the cache is refreshed when file size or modified time changes.

R7.2 Each embedded subtitle track yields: stream index (track id), language (three-letter code from the container tag, mapped to two-letter), forced flag (container disposition or title containing "forced"), HI flag (disposition hearing-impaired or title hints such as SDH, CC, HI), codec name.

R7.3 Ignore options, all default false: ignore_pgs_subs (image based PGS), ignore_vobsub_subs (image based VobSub), ignore_ass_subs (ASS/SSA). A track with an ignored codec is not indexed and does not satisfy wanted.

R7.4 Only tracks with a language the system supports are indexed. Tracks with undefined language ("und") are skipped unless default_und_embedded_subtitles_lang is set, in which case that language is assumed.

R7.5 Index storage per item: language, forced, hi, track id, path = null, size null. Stale entries (tracks no longer present) are deleted on reindex.

R7.6 Image-based tracks (PGS, VobSub, DVB) count toward wanted when not ignored, but cannot be extracted (R7.10).

### 7.2 Audio language probing

R7.7 The ffprobe refiner also yields the audio languages. The first audio stream language becomes the item's audio language (R2.11). With parse_embedded_audio_track false (default) the audio language from the arr metadata is used; with true, the probed track list is used.

R7.8 default_und_audio_lang: when audio language is undefined, assume this language (default empty, no assumption).

R7.9 Options use_original_language, auto_use_original_language, force_audio belong to sync, see R12.

### 7.3 Extraction

R7.10 On request (manual extract, or the embedded provider in the search flow), a track is copied out with ffmpeg stream copy (no re-encode). Only text formats are extractable: ASS (extension .ass), SubRip (.srt), WebVTT (.vtt). Image-based tracks raise "bitmap subtitles not supported" and are reported without retry.

R7.11 The extracted file follows the naming rules (section 9) and target folder, then chmod is applied, the item is reindexed, and history action 7 (embedded extraction) is written with a fake score equal to the maximum.

R7.12 Embedded provider settings: included_codecs (list), hi_fallback (use an HI track when no normal exists), timeout 600 seconds, unknown_as_fallback (use unknown-language tracks), fallback_lang "en" (language assumed for those).

R7.13 Scoring of embedded extraction: treated as a perfect match (maximum score) and therefore passes any threshold; precedence relative to downloads is by provider order. Open question: whether extracted embedded subtitles preempt downloads is controlled in Bazarr by its position in the enabled providers list; default: embedded first when enabled.

---

## 8. Upgrade logic

R8.1 Settings: upgrade_subs (default true), upgrade_frequency in hours (6, 12, 24, 168, 876000; default 12; 876000 means never), days_to_upgrade_subs (0 to 30; default 7), upgrade_manual (default true).

R8.2 Candidate history events: actions 1 (automatic download) and 3 (upgrade); with upgrade_manual also actions 2 (manual download), 4 (manual upload), 6 (translation). Action 5 (sync) and 7 (embedded extraction) and 0 (delete) are never upgrade candidates.

R8.3 An event is an upgrade candidate when all hold:
1. Its timestamp is newer than now minus days_to_upgrade_subs.
2. Its score is below score_out_of minus 3 (a perfect score, or one within 3 points of perfect, is not upgraded). A null score with action 6 also qualifies.
3. It is the latest event for its (video path, language string) pair since the last delete event (action 0).
4. The language is still in the item's profile (R8.4).
5. The history record's video path equals the item's current path.
6. The subtitle file still exists on disk at the recorded path, and the file is the one recorded.
7. It was not already upgraded (no other history row's upgradedFromId points to it).
8. The item passes the exclusion clause (R3.11).

R8.4 "Language still desired" for upgrades: forced items give "xx:forced"; HI "True" gives "xx:hi"; HI "Excluded" gives "xx"; otherwise both "xx" and "xx:hi" are acceptable. A downloaded "en:hi" for an HI "False" entry is therefore upgradable to either.

R8.5 The upgrade search uses the profile's HI requirement; HI is dropped from the request unless the profile requires HI "True". Upgrade runs abort if providers are throttled.

R8.6 Minimum score for an upgrade: the candidate must beat the stored score by margin. Bazarr sets forced_minimum_score = old score + 1 and then uses int(that) + 1 as the integer threshold, so the new score must be at least old + 2. Example: stored 300 requires a new score of at least 302. The normal minimum (R4.17) is also required.

R8.7 On success: delete the old subtitle file first, save the new one, write history action 3 with upgradedFromId set to the replaced event id (the original or previous id in the chain), send "upgraded" message (R6.10).

R8.8 Upgrade hearing mode: an upgrade of a forced subtitle only considers forced candidates; a normal subtitle is upgraded with normal/HI as allowed by R8.4.

R8.9 Upgrade run interval: upgrade_frequency hours; the job lists candidates then processes them in bounded concurrency, aborting when all providers become throttled.

---

## 9. Naming, location and permissions

### 9.1 File names

R9.1 Subtitle path = video base name, a dot, the language, an optional tag, and the extension: `<video base>.<lang>[.<tag>]<ext>`.
- lang: the two-letter code, or with regional or script variants the longer IETF-style code (for example pt-BR, zh-Hans, zh-Hant). Three-letter codes are used only when no two-letter exists. Bazarr's custom language names for Portuguese Brazilian (pob) and Chinese traditional (zht) normalize to pt-BR and zh-Hant for filenames in Media-Tron (open question: exact Bazarr output is a custom basename; default as stated).
- tag: "forced" if forced; else the hi extension if HI; else none. Forced wins.
- hi extension: setting hi_extension, one of hi, cc, sdh; default hi.
- ext: .srt by default; original-format keeps the provider format (.ass, .vtt and so on).

R9.2 single_language (default false): when true the language component is omitted entirely and the name is `<video base>.<ext>`. Only valid when the profile has one language; Media-Tron should warn if more.

Examples:
| Video | Request | File |
|---|---|---|
| Show.S01E01.mkv | en normal | Show.S01E01.en.srt |
| Show.S01E01.mkv | en HI | Show.S01E01.en.hi.srt |
| Show.S01E01.mkv | en forced | Show.S01E01.en.forced.srt |
| Show.S01E01.mkv | pt-BR | Show.S01E01.pt-BR.srt |
| Movie.2020.mkv | es, hi_extension=sdh, HI | Movie.2020.es.sdh.srt |
| Movie.2020.mkv | any, single_language=true | Movie.2020.srt |

### 9.2 Target folder

R9.3 general.subfolder: current (next to the video, default), absolute (a fixed folder, subfolder_custom holds the path), relative (a subfolder name under the video folder, subfolder_custom holds the name). The folder is created if missing; if creation fails the video folder is used.

R9.4 When looking for existing subtitles (indexing), both the video folder and the custom location are scanned.

### 9.3 Saving

R9.5 Save procedure for each chosen subtitle:
1. Skip if a subtitle for the same language was already saved in this call.
2. HI heuristic on SubRip content: if the text contains square or curly bracketed cues or music symbols (and parentheses count too except for Arabic and Persian) the HI flag is set true, which changes the tag and the history language string. The remove_HI mod clears the flag again.
3. Compute the path (R9.1).
4. Create the target folder, delete any existing file at the path, write the modified content.
5. Apply chmod if enabled (non-Windows only).
6. Extra formats: if more formats are configured the file is also written with the changed extension.
7. A UnicodeError while saving blacklists that subtitle (R10.4).

R9.6 chmod: chmod_enabled (default false) and chmod (default octal 0640). Not applied on Windows. Re-applied after the post-processing command (R11.9).

R9.7 Deleting subtitles via the UI deletes only files with subtitle extensions, writes history action 0, reindexes and notifies. Mods applied to an existing file go through the same save path; remove_HI renames the file (removing the hi tag).

R9.8 External subtitle discovery (indexing):
- Extensions: .srt .sub .smi .txt .ssa .ass .mpl .vtt.
- Matched by file name root equal to the video base name.
- After the root, tokens are parsed: language code (IETF), and tags forced, normal, default, embedded, embedded-forced, custom, hi, cc, sdh. Forced is true if "forced" appears; HI is hi, cc or sdh.
- Chinese variant keywords: simplified (chs, sc, zhs, hans) and traditional (cht, tc, zht, hant, big5) plus CJK words.
- Strict mode (default) requires the exact root; loose allows a looser prefix match.
- If no language is in the name, guess it from content, but not for files larger than 1 MiB (MAXIMUM_SUBTITLE_SIZE). HI by the bracket heuristic.
- "und" is skipped. Unchanged files (same size) are reused without re-reading. Files that disappeared are deleted from the index.

R9.9 Language equivalence: language_equals is a list of "from:to" strings; formats such as "es-MX", "en@hi", "es-MX@forced". Applies in missing computation (R3.5) and in provider results (R5.15).

---

## 10. Blacklist

R10.1 A blacklist entry holds: id, language string, provider, item reference (episode id plus series id, or movie id), provider subtitle id, timestamp.

R10.2 Matching key is (provider, subtitle id) only; it is global across items in the filtering step (R5.14). In practice Bazarr stores the item for display, and filters by provider and id.

R10.3 Entries never expire. Removal is manual: delete one entry or delete all.

R10.4 Entries are added when: the user blacklists a downloaded subtitle (this also deletes the file, writes history action 0 and triggers a new search), a provider raises must-get-blacklisted for a candidate, or saving raises a unicode error (the specific subtitle if known, otherwise the whole batch).

R10.5 A blacklisted candidate is never offered in automatic or manual search results.

R10.6 Blacklisting a subtitle in the UI: adds the entry, deletes the file from disk, reindexes, and the item returns to the wanted list so the next run finds a different candidate (subject to adaptive backoff for non-manual runs).

R10.7 The language string stored in the entry uses the R1.4 form.

---

## 11. Post-processing and sync

### 11.1 Sequence after save

R11.1 After a subtitle is saved (download, upgrade, manual download, upload) the pipeline is:
1. Sync (R12) if enabled and eligible.
2. Post-processing command (R11.2) if enabled and eligible.
3. Notifications to the arr app (so it rescans), to Plex or Jellyfin (library refresh), to the external webhook/notification providers, unless dont_notify_manual_actions applies for manual actions.
4. Reindex and history write.

R11.2 Post-processing settings: use_postprocessing (default false), postprocessing_cmd (the command line), use_postprocessing_threshold (series; default 90), use_postprocessing_threshold_movie (default 70). The percent comparison: the command runs when the threshold toggle is off, OR when the subtitle's percent is below the threshold. (The threshold is therefore an upper bound: perfect matches skip post-processing.)

R11.3 Execution: the command line is split into arguments like a shell would, but run without a shell. Placeholders are substituted per argument. An argument that is a placeholder whose value is empty is dropped from the argument list. stdout and stderr are logged. Failures are logged and do not abort the pipeline.

R11.4 Placeholder variables:
| Placeholder | Value |
|---|---|
| {{directory}} | folder of the video file |
| {{episode}} | full path of the video file (movies too) |
| {{episode_name}} | video file name without extension |
| {{subtitles}} | full path of the saved subtitle |
| {{subtitles_language}} | language name in English |
| {{subtitles_language_code2}} | two-letter code, with suffix such as :forced or :hi |
| {{subtitles_language_code3}} | three-letter code, same suffix rule |
| {{subtitles_language_code2_dot}} | two-letter code with ":" replaced by "." |
| {{subtitles_language_code3_dot}} | three-letter code with ":" replaced by "." |
| {{episode_language}} | audio language name |
| {{episode_language_code2}} | audio two-letter code |
| {{episode_language_code3}} | audio three-letter code |
| {{score}} | percent score |
| {{subtitle_id}} | provider subtitle id |
| {{provider}} | provider name |
| {{uploader}} | uploader |
| {{release_info}} | release info text |
| {{series_id}} | Sonarr series id (empty for movies) |
| {{episode_id}} | Sonarr episode id, or Radarr movie id for movies |

R11.5 Manual upload supplies: score 100, subtitle id "1", provider "manual", uploader "user", release info "unknown".

R11.6 Example: command `/usr/local/bin/notify.sh "{{episode_name}}" {{subtitles_language_code2}} {{score}}` with video Show.S01E01.mkv, a forced English subtitle at 97.5 percent runs the script with arguments Show.S01E01, en:forced, 97.5.

R11.7 For Media-Tron, restrict by design: allow the command only from admin settings, run with a timeout (default 60 s; open question), never through a shell, and log exit codes.

R11.8 Since the command runs after sync and before notifications, the notification sees the final file.

R11.9 After the command finishes, chmod is applied again to the subtitle path.

### 11.2 Sync (timing correction)

R11.10 Tool: audio-based sync (ffsubsync) is the only engine in Bazarr. alass is not used by Bazarr; Phase 3 of the Media-Tron roadmap names ffsubsync/alass. Default: implement ffsubsync first, alass behind the same interface, optional (open question).

R11.11 Settings and defaults:
| Key | Default | Meaning |
|---|---|---|
| use_subsync | false | enable |
| use_subsync_threshold | false | limit by series score |
| subsync_threshold | 90 | percent for series |
| use_subsync_movie_threshold | false | limit for movies |
| subsync_movie_threshold | 70 | percent for movies |
| debug | false | keep debug output |
| force_audio | false | force the first audio track as reference |
| use_original_language | false | choose reference audio matching the original language |
| auto_use_original_language | false | same, automatically |
| checker.blacklisted_providers | empty | providers whose subtitles are never synced |
| no_fix_framerate | true | do not let the tool change the framerate |
| gss | true | golden-section search for the framerate ratio |
| max_offset_seconds | 60 (60, 120, 300, 600) | largest offset to try |
| quality_min_score | 0.0 (0.0 to 1.0) | skip if the tool's quality is lower |
| quality_max_offset_seconds | 30 (5, 10, 15, 20, 30, 45, 60) | skip if the offset is larger |
| quality_max_framerate_deviation | 0.1 (0.05, 0.1, 0.15, 0.2, 0.3) | skip if the framerate scale deviates more |

R11.12 Eligibility: sync runs when enabled, the subtitle is not forced, the provider is not in the blacklisted-providers list, and the threshold is off or the percent is at or below the threshold (note: at or below, unlike post-processing's strictly below).

R11.13 Process: the tool is given the video (or a chosen reference audio stream) and the subtitle. Voice activity detection uses WebRTC if available, else a fallback detector. Output encoding is the same as the input. Output is written to a temporary file named `<name>.synced.srt` (or .ass), which replaces the original on success; on failure the original remains.

R11.14 Reference audio: with force_audio the first audio track a:0 is used; with use_original_language (or the auto variant) the track whose language equals the item's original language is used if one exists; otherwise a:0 or default.

R11.15 When no_fix_framerate is false, the quality settings apply: if the tool reports a quality, offset or framerate deviation beyond the limits the result is discarded and the original subtitle is kept.

R11.16 History: action 5 with the message "<Language> subtitles synchronization ended with an offset of X seconds and a framerate scale factor of Y." where X and Y come from the tool's report.

R11.17 Manual sync from the UI (subtitle context menu) runs the same code with the manual flag, ignores thresholds, and may pass a manual reference stream.

R11.18 Subtitle mods and translation are post-save tools; translation (action 6) uses a translator backend (gemini, lingarr, google) with default_score 50 recorded as the score. Out of scope for Phase 3 core; keep the history code reserved.

---

## 12. Manual search and upload

### 12.1 Manual search

R12.1 Manual search lists candidates for one item, without minimum score filtering, so users can pick below-threshold results.

R12.2 Language set: built from the profile (all profile languages with forced/HI variants). If the profile only has normal items (no forced or HI), all languages are shown; for languages marked HI "Excluded", HI results are hidden.

R12.3 For episodes, candidates must have series, season and episode matches (as in R6.2 step 5), waived when the hash is unverifiable.

R12.4 Sorted by (score, score_without_hash) descending (R6.1).

R12.5 Each row carries: score as percent with two decimals, original score (orig_score), score_without_hash, forced, language, hearing_impaired, provider, a cache key, url, original_format (profile flag), matches list, dont_matches list (keys not matched), release info lines (a list), uploader.

R12.6 Rows are cached server-side for one hour (3600 s) under a random UUID cache key; the download request supplies the key.

### 12.2 Manual download

R12.7 Manual download: look up the cache key (invalid or expired after 1 hour returns an error asking to search again). Reject an HI subtitle for an HI-excluded language. Set the hi and forced flags on the object, apply mods, save, and run the standard processing pipeline with the manual flag. History action 2; score is the candidate's score; message says "manually downloaded".

R12.8 dont_notify_manual_actions (default false) suppresses notifications for manual actions.

### 12.3 Manual upload

R12.9 Manual upload takes a file from the user, plus language, forced and HI flags. Steps: build the language; validate the content (SubRip or convertible); apply mods; if utf8_encode, re-encode as UTF-8; save in the original format (when profile original_format is 1) or SubRip; run sync (if enabled and applicable); run the post-processing command with score 100 (R11.5); history action 4 with fake score = maximum for the media type; reindex.

R12.10 Upload does not require the language to be in the profile; the file lands in the normal naming path and shows as an indexed external subtitle.

---

## 13. Throttling and backoff

### 13.1 Concept

R13.1 When a provider call fails, the provider is "throttled" until a computed time. Throttled providers are skipped in all searches and downloads until the time passes. Throttle state is per provider (not per language or per item).

R13.2 State is persisted so it survives restarts: a map from provider to (exception name, until-timestamp, description). Bazarr writes this to a text file; Media-Tron should use a database table. Entries are removed when they expire or when the provider is disabled.

### 13.2 Default durations by error class

| Error class | Default duration |
|---|---|
| Too many requests (rate limit) | 1 h |
| Download limit exceeded (daily quota) | 3 h |
| Service unavailable | 20 min |
| API throttled | 10 min |
| Response parse error | 6 h |
| Timeouts (request, socket, connect, read) | 1 h |
| Configuration error | 12 h |
| Permission error | 12 h |
| Proxy error | 1 h |
| Authentication error | 12 h |
| Any unknown exception | 10 min |

R13.3 Per-provider overrides exist; the provider spec owns them. Examples to show the mechanism: one provider uses 1 minute for rate limits, 6 h for download limits and 1 minute for generic provider errors; another uses 3 h for download limits, 5 minutes for rate limits and 1 h for blocked IPs; a local Whisper provider uses 5 minutes for connection errors. Daily-limit overrides may instead reset at a wall-clock time (midnight in a specific zone, for example Prague, Lisbon plus 60 minutes, or GMT plus 15 minutes). The throttle table must therefore allow either a duration or a "next reset time" rule per (provider, error class).

R13.4 Strike counting: for rate-limit, service-unavailable and API-throttled errors (matched by class name), a throttle is applied only after 5 strikes within a 120 second window. Each earlier strike just sleeps 5 seconds in the calling task and lets the request retry. The counter resets after the throttle is applied (and when the window lapses).

R13.5 Authentication, configuration, payment-required: throttle at once for the full duration (12 h default). Re-saving the provider settings or pressing "reset" clears them (R13.8).

R13.6 Blacklist-style error: when a provider says a specific subtitle must never be downloaded, a blacklist entry is created (R10.4) with language string "xx", "xx:forced" or "xx:hi" and the provider is NOT throttled.

R13.7 Until-time computation: now plus the duration (ms internally). The stored until value is an ISO timestamp.

R13.8 Reset: "reset throttled providers" clears all entries, or only authentication, configuration and payment-required entries when the only_auth_or_conf_error option is on (used after editing provider credentials).

R13.9 UI/status: list each throttled provider with the error name, description and "retry at" time.

### 13.3 Availability

R13.10 Provider availability = enabled providers minus the throttled. If the result is empty the status is "All providers are throttled".

R13.11 Wanted and upgrade jobs check availability before each item and stop the whole run when empty; searching does not record attempts (R3.25).

### 13.4 Anti-captcha and network

R13.12 Anti-captcha: general.anti_captcha_provider is one of none, anti-captcha, death-by-captcha, captchaai; each has its own key section. Providers that can face captchas use the configured solver; if none is set, the provider fails with an error that throttles it. Media-Tron: expose the setting; implementation optional (open question: default none).

R13.13 Proxy: standard proxy environment variables (HTTP and HTTPS proxy and a no-proxy list) apply to all provider traffic. disable_all_providers_ssl_verify (default false) turns off certificate checks for providers.

R13.14 PROVIDERS_FORCED_OFF exists in Bazarr as an unused constant; ignore.

R13.15 Pool-level discard (R5.11) is separate from throttling: it removes a provider for the pool lifetime, without persisting.

Worked example: a provider returns "too many requests" four times in 90 seconds: each time the task sleeps 5 seconds and the request is retried. The fifth strike within 120 seconds throttles it for 1 hour (unless overridden). A subsequent wanted run skips it until the time passes, then tries it normally.

---

## 14. History

R14.1 Every state-changing subtitle action writes a history row. Fields: id, action (integer), description (the message from R6.10 or a custom message), language (R1.4 string), provider, score, score_out_of, item ids (series id, episode id or movie id), provider subtitle id (subs_id), subtitle path, timestamp (ISO), video path, matched list, not_matched list, upgradedFromId.

R14.2 Action codes:
| Code | Event | Notes |
|---|---|---|
| 0 | Deleted | subtitle removed by user or blacklist; terminates upgrade chains |
| 1 | Automatic download | wanted job or arr import event |
| 2 | Manual download | from manual search |
| 3 | Upgrade | upgradedFromId set |
| 4 | Manual upload | provider "manual", fake maximum score |
| 5 | Sync | message with offset and framerate factor |
| 6 | Translation | score may be null (or default_score 50) |
| 7 | Embedded extraction | fake maximum score |

R14.3 Score fields: score is the integer score, score_out_of the maximum (360 or 180). Percent is derived. Fake-score events set both equal.

R14.4 History is queryable by item, by action, by date range, and by provider. It also serves as the base for upgrades (section 8).

R14.5 Upgrade chain integrity: never delete rows; "deleted" is a new row with action 0.

R14.6 An item's history is retained when the item is removed from the library only if the retention setting allows (open question; default: keep for 30 days after removal then purge).

---

## 15. Scheduled jobs and settings

### 15.1 Jobs

R15.1 Scheduler properties: each job has at most one running instance, missed runs coalesce into one, a misfire grace of 15 seconds applies, and interval jobs start at a random point within 75 to 100 percent of their interval to avoid thundering herds at boot.

| Job | Schedule | Notes |
|---|---|---|
| Sync with Sonarr-equivalent (series library) | every series_sync minutes, default 60 | in Media-Tron this is the internal library change feed, not polling an external app |
| Sync with Radarr-equivalent (movies) | every movies_sync minutes, default 60 | same |
| Full library update | daily at hour 4 by default (full_update "Daily", full_update_day 6, full_update_hour 4) | also Weekly or Manually |
| Index all existing episode subtitles | cron: daily at 4, or weekly on a day, or never | rescans disk for external and embedded |
| Index all existing movie subtitles | same | |
| Search for missing series subtitles | every wanted_search_frequency hours, default 6 | allowed 6, 12, 24, 168, 876000 |
| Search for missing movie subtitles | every wanted_search_frequency_movie hours, default 6 | same |
| Upgrade previously downloaded subtitles | every upgrade_frequency hours, default 12 | |
| Cache maintenance | every 24 h | provider and ffprobe cache cleanup |
| Health check | every 6 h | |
| Backup | weekly by default (day 6, hour 3) or daily | |
| Update and announcements check | every 6 h or 3 h | |

R15.2 "Never" is expressed as an interval of 876000 hours, or a cron schedule far in the future. In Media-Tron use an explicit "disabled" state instead.

R15.3 Jobs share a worker pool limit concurrent_jobs, default min(4, CPU count). Wanted search, upgrade, indexing, sync and extraction jobs are queueable; each one is visible in a jobs list with name, state and progress.

### 15.2 Settings keys and defaults

| Key | Default | Notes |
|---|---|---|
| minimum_score | 90 | percent, episodes |
| minimum_score_movie | 70 | percent, movies |
| use_scenename | true | merge scene name |
| single_language | false | omit language from file names |
| utf8_encode | true | |
| use_embedded_subs | true | |
| embedded_subs_show_desired | true | UI only |
| ignore_pgs_subs / ignore_vobsub_subs / ignore_ass_subs | false | |
| adaptive_searching | true | |
| adaptive_searching_delay | 3w | 1w, 2w, 3w, 4w |
| adaptive_searching_delta | 1w | 3d, 1w, 2w, 3w, 4w |
| wanted_search_frequency | 6 | hours |
| wanted_search_frequency_movie | 6 | hours |
| upgrade_subs | true | |
| upgrade_frequency | 12 | hours |
| days_to_upgrade_subs | 7 | 0 to 30 |
| upgrade_manual | true | |
| chmod_enabled / chmod | false / 0640 | |
| subfolder / subfolder_custom | current / empty | |
| hi_extension | hi | hi, cc, sdh |
| subzero_mods | empty | |
| language_equals | empty list | |
| multithreading | true | |
| skip_hashing | false | |
| concurrent_jobs | min(4, CPU) | |
| use_whisper_fallback / use_whisper_fallback_series | false / false | |
| serie_default_enabled / serie_default_profile | false / empty | |
| movie_default_enabled / movie_default_profile | false / empty | |
| serie_tag_enabled / movie_tag_enabled | false / false | |
| remove_profile_tags | empty | |
| default_und_audio_lang | empty | |
| default_und_embedded_subtitles_lang | empty | |
| parse_embedded_audio_track | false | |
| embedded_subtitles_parser | ffprobe | or mediainfo |
| use_ffprobe_cache | true | |
| dont_notify_manual_actions | false | |
| enable_strm_support | false | |
| defer_search_signalr | false | wait for scheduled run after import |
| only_monitored | false | per arr section |
| excluded_tags / excluded_series_types / exclude_season_zero | empty / empty / false | per arr section |
| anti_captcha_provider | none | |
| disable_all_providers_ssl_verify | false | |
| use_postprocessing / postprocessing_cmd | false / empty | |
| use_postprocessing_threshold / _movie | 90 / 70 | |
| use_subsync and the sync keys in R11.11 | see R11.11 | |
| whisper endpoint / timeout | http://127.0.0.1:9000 / 3600 | |

R15.4 Constants: MINIMUM_VIDEO_SIZE 20480 bytes, MAXIMUM_SUBTITLE_SIZE 1 MiB (1048576 bytes), hash minimum file size 10485760 bytes, pool lifetime 12 h, manual cache lifetime 3600 s, download tries 3 with 6 s sleep, strike window 120 s with 5 strikes and 5 s sleep.

R15.5 Settings keys in Media-Tron are stored under the subtitles module with the names above in camelCase; durations in ms, thresholds as 0 to 100 integers.

---

## 16. Open questions (with defaults)

Q1 Legacy HI mapping (R2.3). Default: only to True, also to False, never to Excluded on import of old profiles. Native model uses the three values.

Q2 Tie-break for equal scores (R6.3). Default: provider order, then provider's own order. Unverified whether Bazarr guarantees this.

Q3 Pool timeout for a slow provider (R5.11). Default: 30 s per provider request, 60 s per download; slow providers are dropped from that search without a throttle unless they repeatedly time out (timeouts throttle for 1 h per R13.2).

Q4 Backoff reset on file replacement (R3.28). Default: reset when the file id or path changes.

Q5 Post-processing timeout (R11.7). Default: 60 s, kill on expiry, log.

Q6 alass (R11.10). Bazarr has none. Default: implement ffsubsync only; reserve an engine interface for alass.

Q7 Mods catalogue (R6.8). The set of subtitle mods (common fixes, remove HI, remove tags, OCR fixes, fix uppercase, colour, reverse RTL, offset and others) was not itemised. Default: ship common, remove_HI, remove_tags, fix_uppercase first; the rest later.

Q8 Language naming for Portuguese Brazilian and Chinese variants in file names (R9.1). Default: pt-BR, zh-Hans, zh-Hant. Verify against Plex/Jellyfin parsing.

Q9 Embedded extraction precedence (R7.13). Default: embedded first when enabled, since it scores the maximum.

Q10 Translation (R11.18). Out of scope for Phase 3; reserve action 6.

Q11 API surface of Bazarr (list endpoints, bulk actions) not read. Default: Media-Tron defines its own REST routes under `/api/v1/subtitles` following docs/CONVENTIONS.md.

Q12 Mass download modules (bulk search on a whole series or season from the UI) not read. Default: same as wanted job but ignoring adaptive backoff and the eligibility clause.

Q13 Season pack handling inside providers (R4.18). Default: provider extracts the matching episode and returns it as a normal candidate; no scoring exception.

Q14 History retention (R14.6). Default: keep forever; remove with the item after 30 days.

Q15 Which providers use which hash and which ids is provider-spec territory.

---

## 17. Acceptance checklist (derived)

R17.1 Given a profile with en normal and es forced and a freshly imported episode with no subtitles, the wanted list contains en and es:forced, and after an import event the search runs for each without waiting for the schedule (unless deferred).

R17.2 A candidate with series, season, episode, year and source matched (335 of 360) is accepted at the default threshold; one lacking year (245) is not.

R17.3 A valid hash with all prerequisites scores exactly 359 (episode) and its percent is 99.72 (359 over 360) rounded to two decimals.

R17.4 An upgrade requires old + 2; a stored 358 is never upgraded since 358 is within 3 of 360.

R17.5 Five rate-limit errors in 120 seconds throttle a provider for one hour; four do not.

R17.6 Blacklisted candidates never appear in either automatic or manual results.

R17.7 File names follow the table in section 9 for each combination of forced, HI, hi_extension and single_language.

R17.8 A thrown error in post-processing or sync never leaves a half-written subtitle: the original file or the saved download is kept.
