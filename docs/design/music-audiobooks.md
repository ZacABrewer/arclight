# Music and Audiobooks: design

Status: accepted, 2026-10-28. Scope: two new media types in Arclight, **music** (Lidarr's job) and
**audiobooks** (Readarr's audiobook side). Ebooks (7020) are out of scope. Clean-room: upstream
projects are behaviour references only; `reference/` is not used.

## 1. Decisions

| Topic | Decision |
|---|---|
| Data model | **Parallel domain tables** (artists/albums/releases/tracks, authors/books/series) plus one new shared `audio_files` table. Root folders, tags, quality profiles, custom formats, delay/release profiles and quality definitions are **shared and extended**. Pipeline tables (history, blocklist, tracked downloads, pending, decisions, imported downloads) get four nullable columns each. |
| Media type | `MediaType` stays `series \| movie` (video). New `AudioMediaType = music \| audiobook` and `AnyMediaType` in `packages/shared/src/library.ts`. Only pipeline modules widen to `AnyMediaType`; video-only modules (subtitles, retention, scene mapping, additional languages, media analysis, transcode, cross-seed) stay as they are and early-return on audio. |
| Music metadata | MusicBrainz WS/2 JSON with a process-wide 1 req/s priority queue, required User-Agent and a persistent cache. Cover Art Archive for album art. Artist images from Wikidata/Commons (keyless); Fanart.tv when the user supplies a key. |
| Audiobook metadata | Audible catalog (search, bibliography) + Audnexus (canonical book/author/chapters by ASIN), OpenLibrary as fallback (ISBN, authors without Audible presence). Behind an `AudiobookCatalog` interface. Google Books not used. |
| Tag reading | `music-metadata` (npm, MIT, pure ESM) behind a `TagReader` interface, ffprobe fallback over the existing runner. |
| Parsing | New `parseMusicRelease` / `parseAudiobookRelease` / `parseAudioPath` in `@arclight/parser`; `parseRelease` untouched. The indexer category picks the parser. |
| Qualities | Audio entries in `QUALITIES` (ids 100–199 music, 200–249 audiobooks) with an `audio` descriptor. `quality_profiles.media_domain`. Nine new custom-format spec kinds. |
| Decision engine | Same engine/specs; `Specification.appliesTo` widens to domain sets; a few audio specs; a pure audio matcher. |
| Media servers | Jellyfin/Emby/Plex music refresh via the existing clients; **Audiobookshelf** as a new `MediaServerKind`. |
| Requests | Wave 4. |
| Compat | Lidarr-shaped subset only, optional, Wave 5, under `/lidarr/api/v1` (Lidarr's `/api/v1` collides with ours). No Readarr compat (retired upstream). |
| Rollout | `features.music` / `features.audiobooks` settings flags, off by default, kept permanently so video-only users can hide them. |

Defaults chosen for the open questions (changeable later):
- `music-metadata` is accepted as a dependency (speed and tag normalisation; ffprobe stays as fallback).
- Audible catalog on by default, with Audnexus/OpenLibrary fallbacks and a health check.
- New artists default to album-type profile "Studio albums" (Album + EP, no secondary types).
- Multi-disc: flat `1-01 - Title` by default; `Disc N/` subfolders optional.
- Audiobook folders without narrator or year by default (tokens available).
- Audiobookshelf: library-wide scan of the matching library (incremental, cheap).
- CUE + single-image rips go to manual import (splitting is Wave 5).
- Fanart.tv: the user supplies their own key.

## 2. Fit with the current architecture

- Modules register in `apps/api/src/app.ts`, providers first. New modules `music` and `audiobooks` register right after `library`; their refresh jobs live in `metadata` next to `RefreshSeries` / `RefreshMovie`.
- Cross-module flows only through `apps/api/src/wiring.ts` (grab → history, import → history + notifications, failed → blocklist → re-search, library commands). Each flow gets an audio branch keyed on `mediaType`.
- Packages stay pure: `@arclight/metadata` gains `musicbrainz/`, `coverart/`, `wikidata/`, `fanart/`, `audnexus/`, `audible/`, `openlibrary/`, `rate-limit.ts`; `@arclight/parser` gains `music.ts`, `audiobook.ts`, `audio-quality.ts`; `@arclight/organizer` gains music/audiobook builders; `@arclight/media-servers` gains `audiobookshelf.ts`; `@arclight/indexers` gains music/book search kinds; `@arclight/profiles-engine` gains audio spec kinds and default audio profiles.
- Contract first: new `packages/shared/src/music.ts`, `audiobooks.ts`, plus additions to `quality.ts`, `profiles.ts`, `indexers.ts`, `naming.ts`, `settings.ts`, `calendar.ts`, `history.ts`, `releases.ts`, `media-servers.ts`.

## 3. Why parallel tables

Generalising series/movies into `media_items` + `media_children` would rewrite every reader (about 81 files use the `'series' | 'movie'` union), fit the different hierarchies poorly (series→season→episode vs artist→album→release→track vs author→book with many-to-many series and co-authors), mix id kinds (TMDB int, MBID uuid, ASIN), and need one huge table-rebuild migration on live databases. Parallel tables are additive (`CREATE TABLE` / `ADD COLUMN`), keep natural unique keys, and let work packages run in separate modules. Pipeline tables already carry `media_type` + parent/child ids; audio follows that pattern with `artist_id` / `album_ids` and `author_id` / `book_ids`. Drizzle's `text(..., { enum })` is type-only on SQLite, so widening `media_type` values needs no SQL.

A new `audio_files` table rather than `media_files`: `media_files` has video-shaped columns and is queried by video modules (hygiene, media analysis, retention, subtitles), which would silently mishandle audio rows.

## 4. Data model and migrations

Next migration is `0018`. Each wave's WP-A owns that wave's migration and is the only package that runs `pnpm db:generate`.

### 4.1 Shared (0018)

| Table | Change |
|---|---|
| `root_folders.media_type` | Enum widens to `series \| movie \| music \| audiobook` (TS only). `requireRootFolder` checks the type. Separate roots per type. |
| `quality_profiles` | `+ media_domain text NOT NULL DEFAULT 'video'` (`video \| music \| audiobook`); the service rejects cross-domain assignment. |
| `quality_definitions` | Rows for audio quality ids (MB per minute). |
| `audio_files` (new, `library/schema.ts`) | `id, media_type, artist_id→artists cascade, album_id→albums cascade, author_id→authors cascade, book_id→books cascade, path UNIQUE, relative_path, size_bytes, date_added, mtime, quality json, release_group, scene_name, codec, container, bitrate_kbps, sample_rate_hz, bit_depth, channels, duration_ms, disc_number, track_number, part_number, chapter_count, tags json, media_info json`; indexes on album_id, book_id, artist_id, author_id. |
| `audio_import_exclusions` (new) | `id, media_type, foreign_id, title, year`, unique `(media_type, foreign_id)` (`import_exclusions.tmdb_id` is NOT NULL). |
| `metadata_cache` (new, `metadata/schema.ts`) | `provider, key, body json, etag, fetched_at, expires_at`, PK `(provider, key)`; pruned 30 days after expiry. |

### 4.2 Pipeline columns (0018)

On `tracked_downloads`, `history`, `blocklist`, `pending_releases`, `release_decisions`, `imported_downloads`: `+ artist_id integer, + album_ids text json, + author_id integer, + book_ids text json`, indexes on artist_id/author_id for history and blocklist. `release_search_state` / `release_search_results` gain `media_type` values `album` and `book` (TS only). `HistoryTarget`, `ItemRef`, `GrabHistoryInput`, `BlocklistCandidate`, `MatchCriteria`, `SearchTarget`, `TrackedDownload` gain `{ mediaType: 'music'; artistId; albumIds }` and `{ mediaType: 'audiobook'; authorId; bookIds }` members. `blocklistScopeFor` scopes to the artist or author.

### 4.3 Music (0018, `modules/music/schema.ts`)

| Table | Columns |
|---|---|
| `artists` | `id, mb_artist_id UNIQUE, name, sort_name, clean_name (idx), disambiguation, artist_type, status ('continuing'\|'ended'), overview, genres json, images json, links json, aliases json, path UNIQUE, root_folder_path, quality_profile_id, album_type_profile_id, monitored, monitor_new_albums ('all'\|'none'\|'future'), tags json, added, last_refreshed, next_refresh_at` |
| `album_type_profiles` | `id, name UNIQUE, primary_types json, secondary_types json, release_statuses json`; seeded "Studio albums" (default: Album + EP) and "Everything". Decides which release groups become album rows. |
| `albums` | `id, artist_id→artists cascade, mb_release_group_id UNIQUE, title, clean_title, disambiguation, primary_type, secondary_types json, release_date, year, overview, genres json, images json, ratings json, monitored, any_release_ok default true, selected_release_id, added, last_refreshed`; idx `(artist_id)`, `(monitored, release_date)` |
| `album_releases` | `id, album_id→albums cascade, mb_release_id UNIQUE, title, status, country, date, labels json, catalog_number, barcode, formats json, medium_count, track_count, duration_ms, media json, disambiguation` |
| `tracks` | `id, album_id→albums cascade, album_release_id→album_releases cascade, mb_track_id, mb_recording_id (idx), medium_number, absolute_number, track_number, title, duration_ms, artist_credit, has_file, audio_file_id (idx)`; unique `(album_release_id, medium_number, track_number)`. Only the selected release's tracks are stored; switching re-fetches and re-links by recording id, then position. |

Default release choice: official → preferred countries (setting) → preferred format (Digital Media, then CD) → most common track count → earliest date. With `any_release_ok`, an import may switch to a better-fitting release.

Monitoring: `MusicMonitorOption = all | future | missing | existing | latest | first | none` (like `applyMonitorOption`). `monitor_new_albums` decides what refresh does with new release groups. Statistics `AlbumStatistics {trackCount, trackFileCount, totalTrackCount, sizeOnDisk, percentOfTracks}` and `ArtistStatistics` computed in SQL; `getLibraryStatistics` gains artist/album/track-file/author/book counts. Missing: monitored, released, `trackFileCount < trackCount`. Cutoff unmet: lowest track-file quality or format score below the profile cutoff.

### 4.4 Audiobooks (0019, `modules/audiobooks/schema.ts`)

| Table | Columns |
|---|---|
| `authors` | `id, asin UNIQUE NULL, ol_author_id UNIQUE NULL, name, sort_name, clean_name (idx), overview, images json, genres json, aliases json, path UNIQUE, root_folder_path, quality_profile_id, monitored, monitor_new_books ('all'\|'none'\|'inSeries'), languages json, tags json, added, last_refreshed, next_refresh_at` |
| `books` | `id, author_id→authors cascade, asin UNIQUE NULL, isbn13, ol_work_id, region, title, subtitle, sort_title, clean_title (idx), author_credits json, narrators json, publisher, language, release_date, year, runtime_minutes, format_type ('unabridged'\|'abridged'\|'dramatized'), overview, genres json, images json, chapters json, ratings json, monitored, has_file, path, added, last_refreshed`; idx `(author_id)`, `(monitored, has_file)`, `(release_date)` |
| `book_authors` | `book_id, author_id, role`, PK `(book_id, author_id)` |
| `book_series` | `id, asin UNIQUE NULL, name, clean_name, overview` |
| `book_series_entries` | `series_id→book_series cascade, book_id→books cascade, position text, position_sort real, is_primary`, PK `(series_id, book_id)` |

Missing: monitored, released, no files. Cutoff on the book's files (one release; lowest wins).

## 5. Metadata

### 5.1 Music

`packages/metadata/src/musicbrainz/client.ts`, following the TMDB transport pattern (Zod-validated, injectable `FetchLike`, typed `MetadataError`), base `https://musicbrainz.org/ws/2/`, `fmt=json`.
- User-Agent `Arclight/<version> ( <project url> [contact email from settings] )`; refuse to construct without one.
- Rate limit: process-wide token bucket in `packages/metadata/src/rate-limit.ts`, 1 req/s per provider, priority queue (UI lookups before background refresh), 503/429 backoff with jitter honouring Retry-After. A custom base URL (self-hosted mirror) may raise the rate; the default host is locked at 1 req/s.
- Calls per artist: `/artist/{mbid}?inc=aliases+genres+url-rels`; `/release-group?artist={mbid}&type=album|ep|single&limit=100&offset=n`; per kept album `/release?release-group={mbid}&inc=media&limit=100`; selected release `/release/{mbid}?inc=recordings+artist-credits+media+labels`. Adding an artist returns at once and starts a visible `ArtistAdd` job; tracks of monitored albums first, unmonitored albums lazily.
- Search: `/artist?query=` and `/release-group?query=releasegroup:"…" AND artist:"…"`.
- Cover Art Archive as URL patterns (`https://coverartarchive.org/release-group/{mbid}/front-500`), placeholder on 404.
- Artist images: MusicBrainz url-rels → Wikidata P18 → Commons thumbnail; Fanart.tv `/v3/music/{mbid}` when `musicMetadata.fanartApiKey` is set.

### 5.2 Audiobooks

| Source | Keyless | Narrators | Runtime | Abridged | Series + position | ASIN | Bibliography |
|---|---|---|---|---|---|---|---|
| Audnexus (`api.audnex.us`) | yes | yes | yes | yes | yes | yes | no (lookup by ASIN, author name search) |
| Audible catalog (`api.audible.<tld>/1.0/catalog/products`) | yes (unofficial) | yes | yes | yes | yes | yes | yes |
| OpenLibrary | yes | rarely | no | no | weak | rarely | yes |

`AudiobookCatalog` interface; default implementation: Audible catalog for search/bibliography, Audnexus for canonical records and chapters, OpenLibrary fallback. Same identifiers as Audiobookshelf and Plex's Audnexus agents. Settings `audiobookMetadata`: `audibleRegion` (us, uk, ca, au, de, fr, it, es, jp, in), `audnexusBaseUrl`, `openLibraryFallback`, `languages`. Rate limits: Audnexus 1 req/s, OpenLibrary 1 req/s (with UA), Audible 2 req/s; configurable, shared bucket, honour 429.

### 5.3 Caching and jobs

In-memory TTL cache (as TMDB) plus `metadata_cache` with ETag. TTLs: MB artist 7 d; release-group browse 1 d (active) / 7 d; release with tracks 30 d; Audnexus book 7 d; Audible search 1 d; OpenLibrary 30 d.

Jobs (`modules/metadata/jobs.ts`): `RefreshArtists` every 6 h, budgeted (~20 min of calls), ordered by `next_refresh_at` (+1 d if a release in the last 90 days or upcoming, +7 d continuing, +30 d ended); `RefreshAuthors` every 12 h (+7 d, +1 d with a future monitored book); ad-hoc `ArtistAdd` / `AuthorAdd`; daily `MetadataCacheCleanup`. `MusicRefresher` / `AudiobookRefresher` next to `MetadataRefresher`, wired into `libraryCommands` (`artistIds`, `authorIds`).

## 6. Parsing (`@arclight/parser`)

```ts
parseMusicRelease(raw: string): ParsedMusicRelease
parseAudiobookRelease(raw: string): ParsedAudiobookRelease
parseAudioPath(path: string, domain: 'music' | 'audiobook'): ...
```
Reuse `prepare`, `stripExtension`, `parseReleaseGroup`, `parseReleaseHash`, `parseRevision`.

`ParsedMusicInfo`: artist, album, year, isVariousArtists, edition, releaseTypeHint (EP, Single, Live, Compilation, Soundtrack, Bootleg), isDiscography, discographyYears, catalogNumber, media (`CD | WEB | Vinyl | SACD | Cassette | DVD | BD | Unknown`), discCount, scene, hasLog, logScore, hasCue, audio. `ParsedAudioQuality`: codec (`FLAC | ALAC | MP3 | AAC | Vorbis | Opus | WAV | AIFF | APE | WavPack | DSD | Unknown`), bitrateKbps, vbrPreset (`V0 | V1 | V2 | APS | APX`), bitDepth, sampleRateHz, quality (QUALITIES id + detectionSource).

Fixture shapes: `Artist - Album (2020) [FLAC 24bit-96kHz]`, `[24-96 WEB FLAC]`, `[MP3 320]`, `[V0]`, `(320kbps)`, `[AAC 256]`; scene `Artist-Album-WEB-2020-GROUP`, `Artist-Album-(CAT123)-2CD-FLAC-2020-GRP`, `VA-Title-…`; media `(Vinyl 24-96)`, `[CD FLAC]`, `{SACD ISO}`, `[Log 100%] [Cue]`; packs `Discography (1990-2020)`, `Studio Albums 1990-2010`, `The Albums Collection`, `Complete Discography`, `5 Albums`.

`ParsedAudiobookInfo`: authors[], title, subtitle, series, seriesPosition (string; ranges for packs), narrators[], year, formatType, container (`m4b | m4a | mp3 | flac | opus | unknown`), bitrateKbps, asin, isbn, isPack, language, retail. Shapes: `Author - Title (Unabridged) [m4b]`, `Author - Series 03 - Title`, `Author - [Series #3] - Title (2015) 64kbps`, `Title - Author - Narrator`, `(read by …)`, `narrated by …`, `[ASIN B0…]`, `{Narrator}`, `Series Books 1-5 [mp3]`.

Fixtures `packages/parser/fixtures/music.json`, `audiobook.json` (`{input, expected}`), run by the fixture report; target ≥ 98% before Wave 2 ships.

## 7. Qualities, profiles, custom formats

`QualityDefinition.audio?: { codec; lossless; minKbps?; maxKbps?; vbr?; bitDepth?: 16 | 24 }`; `mediaTypes` widens; audio entries use `source: 'unknown'`, `resolution: 0`.

| Music | Audiobooks |
|---|---|
| 101 MP3-Low (<160), 102 MP3-192, 103 MP3-VBR-V2, 104 MP3-256, 105 MP3-VBR-V0, 106 MP3-320 | 201 AB-MP3-Low (<64), 202 AB-MP3 (64–127), 203 AB-MP3-High (≥128) |
| 110 AAC-Low, 111 AAC-256, 112 AAC-320, 115 Vorbis, 116 Opus | 210 AB-AAC-Low (<64, m4a/m4b), 211 AB-AAC (≥64) |
| 130 ALAC, 131 FLAC, 132 Lossless-Other (APE, WavPack), 133 PCM | 212 AB-Opus, 220 AB-Lossless |
| 140 ALAC-24bit, 141 FLAC-24bit, 150 DSD | |

Guard: `qualitiesByWeight()`, `buildItems()`, profile routes and `compat/quality.ts` filter by domain; audio never appears in video profiles or the Sonarr/Radarr compat output. Default sizes (MB/min): MP3-320 2.2–2.6, V0 1.4–2.4, FLAC 3.5–12, FLAC-24 8–40, AB-AAC 0.25–1.5, checked against album duration / book runtime.

Profiles seeded on first enable — music: Lossless (cutoff FLAC), Hi-Res (FLAC-24bit), High-quality lossy (MP3-320, V0, AAC-256+; cutoff MP3-320), Any (FLAC); audiobooks: Standard (AB-MP3+, AB-AAC; cutoff AB-AAC), M4B only, Any. The profile UI gets a domain selector.

New `CustomFormatSpec` kinds: `audioCodec`, `audioBitrate`, `bitDepth`, `sampleRate`, `audioSource` (cd, web, vinyl, sacd, cassette, other), `ripLog` (requireLog, minScore, requireCue), `fileLayout` (single, multi), `formatType`, `narrator` (pattern). Existing `releaseTitle`, `releaseGroup`, `edition`, `size`, `indexerFlag`, `year` apply; `releaseType` gains `discography`, `multiAlbum`, `bookPack`. `ReleaseEvaluation.audio?`; audio specs evaluate false without it. The UI lists only formats matching a profile's domain.

## 8. Indexers, search, decisions

- Indexer settings (JSON) gain `musicCategories` (default `[3000, 3010, 3040]`) and `audiobookCategories` (default `[3030]`); validation "at least one category in any list". `IndexerCapabilities.searching` adds `musicSearch` and `bookSearch`. `SearchRequest` adds `{ kind: 'music'; query?; artist?; album?; year?; label? }` (`t=music`) and `{ kind: 'book'; query?; author?; title? }` (`t=book`), mapped in `newznab-common/query.ts`; the category list follows the request kind.
- Search plans (`releases/audio-search.ts`), stopping after the first query with approved results: album — `music` search, `{artist} {album}`, album without edition brackets, VA → `{album}`; artist — per wanted album plus `{artist}` once; book — `book` search, `{author} {title}`, `{title}` (3+ significant words), `{asin}`; author — per wanted book plus `{author}`. `SearchTarget` and `/command/search` gain `albumIds`, `artistId`, `bookIds`, `authorId`. Jobs `MissingAlbumSearch`, `MissingBookSearch`, `CutoffUnmetAudioSearch` reuse `release_search_state` backoff. Wiring adds `ArtistSearch`, `AlbumSearch`, `BookSearch`.
- RSS uses the union of enabled domains' categories (a domain is enabled when its flag is on and it has a monitored item). `hintFromCategories` → `domainFromCategories()` returning `series | movie | music | audiobook | auto` (3030 audiobook; other 3xxx except 3020 music). `decideOne` routes to `decideAudio()` for audio; for `auto` the audio parsers run only with an audio codec/container marker and a failed video parse, and need a library hit.
- Matcher (`releases/audio-matcher.ts`, pure) over `AudioLibrarySnapshot`, using `cleanTitle`/`numeralTitle` plus `&`/and folding and leading "The". Music: artist by clean name/alias (VA → album-only), album by clean title without edition words, year ±1 (reissues accepted when unique), criteria win ties → `AlbumMatch`; discographies map to albums within `discographyYears` passing the album-type profile. Audiobooks: ASIN exact; else author + title (subtitle optional) or series + position → `BookMatch`.
- Engine: `appliesTo` becomes `'video' | 'series' | 'movie' | 'audio' | 'music' | 'audiobook' | 'all'` (rename `both` → `video`, then reclassify). Reused as `all`: qualityAllowed, customFormatMinimumScore, maximumSize, sizeLimits (per minute × duration), minimumAge, retention, minimumSeeders, indexerTags, indexerBlocked, releaseProfiles, monitored, alreadyImported, recentGrabHistory, queue, upgradeAllowed, upgradeDisk, properInRss, repackSameGroup, blocklist, indexerReleaseFilter, delay, pendingPushed, searchItem, freeSpace. Video only: language, requiredAudioLanguages, sample, raw, hardcodedSubs, series specs, availability. New: `albumReleased`, `discographyPack` (needs `releases.allowDiscographyPacks` and `minPackWanted`, default 2, unless interactive), `bookPack`, `formatTypeMatch`, `bookLanguage`, `audioSizePlausible`. Album current quality = lowest track-file quality; packs upgrade only albums where strictly better. `compareDecisions` / `prioritize` reused.

## 9. Import

`TagReader` (`imports/audio/tags.ts`) returning `AudioTags { title, artist, albumArtist, album, date, trackNo, trackOf, discNo, discOf, mbRecordingId, mbReleaseId, mbReleaseGroupId, mbArtistId, asin, isbn, narrator, series, seriesPart, codec, container, bitrateKbps, sampleRateHz, bitDepth, channels, durationMs, chapters? }`. `music-metadata` primary (in-process, ~1–5 ms/file, normalised tags, m4b chapters), ffprobe fallback on parse error and as the source of truth for duration disagreements.

Music import (`imports/audio/music-import.ts`): scan audio extensions (`.flac .mp3 .m4a .aac .ogg .opus .wav .aiff .ape .wv .dsf .dff`) plus extras (`.cue .log` covers `.lrc .txt`); group by MB release-group id → album/album-artist tags → folder; match each group to a release (target from the grab's `album_ids` or a library lookup) scoring track-count fit, title similarity, duration delta (±7 s or ±3%), disc/track numbers, recording-id bonus; accept above `audio.trackMatchThreshold` (0.8), switching `selected_release_id` if `any_release_ok`. Import specs reused (absolutePath, freeSpace, notUnpacking, sameFile, alreadyImported, upgrade) plus `trackMapping`, `incompleteAlbum` (warn; album stays wanted), `cueImage` (→ manual import), `mixedReleases`. Transfer with `transferFile` (hard link/copy/move, recycle bin). **No retagging** (it breaks hard links and seeding). One `audio_files` row per file, linked from `tracks.audio_file_id`. Bus `import imported` with `mediaType: 'music'` → history, notifications, media-server refresh.

Audiobook import (`imports/audio/audiobook-import.ts`): one book = one folder or file group, ordered by disc tag → track tag → natural filename sort; total duration within ±5% of the runtime (configurable); narrator mismatch is a warning; parts renamed with `{Part:00}` (`renameAudiobookParts`, default on); optional `writeAbsSidecars` (`desc.txt`, `reader.txt`, `cover.jpg`).

Naming (`@arclight/organizer`, `shared/naming.ts`): builders `buildArtistFolder`, `buildAlbumFolder`, `buildTrackFileName`, `buildAuthorFolder`, `buildBookFolder`, `buildBookFileName`; tokens `{Artist Name}`, `{Artist CleanName}`, `{Album Title}`, `{Album Type}`, `{Release Year}`, `{medium:0}`, `{track:00}`, `{Track Title}`, `{Track ArtistName}`, `{Quality Title}`, `{Author Name}`, `{Series Title}`, `{Series Position}`, `{Book Title}`, `{Book Subtitle}`, `{Narrator}`, `{Part:00}`.

| `NamingConfig` field | Default |
|---|---|
| renameTracks | false |
| artistFolderFormat | `{Artist Name}` |
| albumFolderFormat | `{Album Title} ({Release Year})` |
| trackFormat | `{track:00} - {Track Title}` |
| multiDiscTrackFormat | `{medium:0}-{track:00} - {Track Title}` |
| multiDiscStyle | `prefix` (or `subfolder`: `Disc {medium}/`) |
| renameAudiobooks | false |
| authorFolderFormat | `{Author Name}` |
| seriesBookFolderFormat | `{Series Title}/Book {Series Position} - {Book Title}` |
| bookFolderFormat | `{Book Title}` |
| bookFileFormat | `{Book Title}` |
| bookPartFormat | `{Part:00} - {Book Title}` |

Layouts: `Artist/Album (Year)/01 - Title.flac` (multi-disc `1-01 - Title.flac`); `Author/Series/Book 3 - Title/Title.m4b` or `Author/Title/01 - Title.mp3`. `namingSamples` gains music and audiobook samples.

## 10. Media servers and Audiobookshelf

`MediaServerKind` adds `audiobookshelf`; `MediaKind` adds `music | audiobook`. Library type mapping: Jellyfin/Emby `music` → music, `books` → audiobook; Plex `artist` → music (path decides for audiobooks); Audiobookshelf `mediaType: 'book'` → audiobook. `packages/media-servers/src/audiobookshelf.ts` (Bearer token): `info()` `GET /status`; `libraries()` `GET /api/libraries`; `refreshLibrary({path})` `POST /api/libraries/{id}/scan` on libraries whose folder contains the path; `listItems('audiobook')` paged `GET /api/libraries/{id}/items`; `findItems({asin, isbn})` client-side. Not a login provider. After audio imports, wiring refreshes servers whose library type and locations match; Plex `matchSections` maps music → `artist`. `ProviderIds` gains `mbReleaseGroupId`, `mbArtistId`, `asin`, `isbn` (availability, Wave 4).

## 11. Requests (Wave 4)

`media_requests` rebuild (drizzle `__new_` pattern): nullable `tmdb_id`, `foreign_id text`, `type` widened to `album | artist | book | author`; `album_requests` like `season_requests`; quotas per type; keyless discover (ListenBrainz top/fresh release groups, MusicBrainz new releases, Audible best sellers/new releases per region); availability via section 10.

## 12. UI (`apps/web`)

Follows `apps/web/src/arclight` and the theme tokens; nav and tabs gated by the feature flags.

| Area | Additions |
|---|---|
| `nav.ts`, `router.tsx` | Library → Music (`/library/music`), Audiobooks (`/library/audiobooks`); Add New gains both |
| `pages/library/music/` | `artist-index.tsx`, `artist-details.tsx` (albums grouped by type, monitor toggles, search/refresh), `album-details.tsx` (edition picker, track table with file + quality, interactive search), `add-artist.tsx` |
| `pages/library/audiobooks/` | `author-index.tsx`, `author-details.tsx` (books by series with positions), `book-details.tsx` (narrators, runtime, abridged chip, chapters, files), `series-details.tsx`, `add-author.tsx`, `add-book.tsx` (title, author, ASIN or ISBN) |
| Shared | Reuse `details-kit.tsx`, `media-files-table.tsx` (audio columns), `interactive-search.tsx` (album/book criteria), `decisions/` |
| Wanted | Albums and Books tabs (missing, cutoff unmet) |
| Calendar | `CalendarItem` adds `album` and `book` (release dates); ICS includes them |
| Activity | "Artist – Album" / "Author – Book" labels with a media-type chip; manual import audio mode (track mapping table) |
| Settings | Root folders per type and audio import options; Naming tabs Music/Audiobooks with preview; profile domain selector; audio CF spec editors; indexer category pickers; metadata (MusicBrainz base URL/contact/rate, Fanart key, Audible region, Audnexus URL, OpenLibrary toggle); Audiobookshelf server kind; feature flags |
| API clients | `api/music.ts`, `api/audiobooks.ts`; i18n under `music.*`, `audiobooks.*` |

## 13. Compat (Wave 5, optional)

Lidarr subset at `/lidarr/api/v1`: `system/status`, `artist`, `album`, `queue`, `history`, `wanted/missing`, `calendar`, `command` (AlbumSearch, ArtistSearch, RefreshArtist), `qualityprofile`, `rootfolder`, `tag`, in `modules/compat/routes-lidarr.ts`. Tdarr needs nothing; no Readarr shape.

## 14. Touched modules

library (audio_files, root-folder checks, statistics); metadata (music/audiobook services, refreshers, jobs, cache, settings); indexers (categories, caps, search kinds); releases (matcher, specs, plans, `decideAudio`, scheduled audio searches); imports (audio scan, tags, importers, manual import audio mode, rescans); history, blocklist, download-clients (widened targets/columns); notifications (`MediaInfo.mediaType`, "Artist – Album [FLAC]", "Author – Title (narrated by X)"); media-servers (ABS kind, library types); calendar, stats, metrics, backup, config-export (new tables/sections); library-hygiene (orphan scan over audio roots, Wave 2).

## 15. Waves and work packages

Each wave ships behind its flag. WP-A lands first (contracts + migration); the rest run in parallel. Only WP-A edits `packages/shared/src/*` and `*/schema.ts` in its wave.

**Wave 1 — music library (no acquisition).** Add an artist from MusicBrainz, see albums and tracks, monitor, rescan an existing music folder into `audio_files`, statistics, calendar album dates, read-only wanted.

| WP | Scope | Files |
|---|---|---|
| 1A | Contracts, audio QUALITIES + domain filters, settings sections, root-folder enum, all 0018 tables and pipeline columns | `packages/shared/src/{library,music,quality,settings}.ts`, `apps/api/src/modules/music/schema.ts`, `library/schema.ts`, `metadata/schema.ts`, `db/schema.ts`, `apps/api/drizzle/0018_*.sql`, `packages/profiles-engine/src/defaults.ts` |
| 1B | Rate limiter, MusicBrainz/CAA/Wikidata/Fanart clients + fixtures | `packages/metadata/src/{rate-limit.ts,musicbrainz/*,coverart/*,wikidata/*,fanart/*}`, `packages/metadata/fixtures/musicbrainz/*` |
| 1C | Music module (service, routes, monitoring, statistics, wanted), `MusicRefresher`, `RefreshArtists`/`ArtistAdd`, cache store | `apps/api/src/modules/music/*`, `modules/metadata/{music-service,music-jobs,cache}.ts`, `app.ts`, `wiring.ts` |
| 1D | `TagReader`, audio scan, track matcher, `rescanArtist` | `apps/api/src/modules/imports/audio/*`, `apps/api/package.json`, tiny tagged audio fixtures |
| 1E | Web: Music tab, artist/album pages, add artist, settings (root folders, metadata), calendar items | `apps/web/src/pages/library/music/*`, `nav.ts`, `router.tsx`, `api/music.ts`, calendar renderer, settings pages, i18n |

**Wave 2 — music acquisition.** RSS and search find, decide, grab, track, import, rename, refresh Plex/Jellyfin; history/blocklist/re-search for albums.

| WP | Scope |
|---|---|
| 2A | `parseMusicRelease`, `audio-quality.ts`, `parseAudioPath`, fixtures; audio CF specs; default music profiles |
| 2B | Indexer domain categories, caps, `t=music`, RSS union, `domainFromCategories` |
| 2C | `audio-matcher.ts`, `audio-specs.ts`, `audio-search.ts`, `decideAudio`, `appliesTo` widening, scheduled album searches, `/command/search` fields, wiring adapters |
| 2D | Music importer + specs, organizer builders/tokens, history, notifications, media-server refresh |
| 2E | Web: album interactive search, wanted Albums, activity labels, naming tab, profile domain, CF audio editors, indexer categories |

**Wave 3 — audiobooks.** 3A contracts + 0019 + Audnexus/Audible/OpenLibrary clients; 3B audiobooks module (authors, books, series, refresher, jobs, wanted); 3C `parseAudiobookRelease`, audiobook qualities/profiles, book matcher/specs, `t=book` plans; 3D audiobook importer, sidecars, organizer book builders, Audiobookshelf client + settings kind; 3E web (Audiobooks tab, author/book/series pages, add flows, wanted Books, settings, ABS form).

**Wave 4 — requests and availability.** `media_requests` rebuild (0020) and audio request service; availability via Plex/Jellyfin/ABS ids; portal discover (ListenBrainz, Audible lists) and request UI; notification and Discord formats.

**Wave 5 — ecosystem (optional).** Lidarr compat; `migrate` readers for Lidarr and Readarr databases; import lists (ListenBrainz, Last.fm, MusicBrainz collections, Hardcover); Gazelle-API indexers; CUE splitting via ffmpeg; optional retag on copy; image cache.

### Tests

No live calls: every client takes `FetchLike`; recorded responses in `packages/metadata/fixtures/{musicbrainz,audnexus,audible,openlibrary,coverart}/*.json`, personal data stripped. Rate limiter on a fake clock. Parser JSON fixture tables. Profiles-engine table tests per spec kind and domain-filter tests (audio never in video defaults or compat). Decision engine: audio snapshot builders in `releases/test-support.ts`, table tests per audio spec and pack case, all existing video tests unchanged. Import: `createTestDb` + temp dirs + tiny tagged audio fixtures (deluxe vs standard, multi-disc, incomplete, m4b chapters, multi-part mp3, hard links). Media servers: fake HTTP servers including Audiobookshelf. Web: component tests per page. **Live indexer/tracker testing only through the VPN test stack.** MusicBrainz/Audnexus live smoke checks are manual and rate-limited.

## 16. Risks

| Risk | Mitigation |
|---|---|
| MusicBrainz 1 req/s makes cold adds slow | Lazy tracks, budgeted refresh, persistent cache, priority queue, optional mirror |
| Audible catalog is unofficial | Interface, Audnexus/OpenLibrary fallbacks, fixture contract tests, `AudiobookMetadataUnavailable` health check |
| Audnexus uptime | Configurable base URL, long TTLs, degrade to Audible fields |
| Edition/track matching errors | Threshold + manual import, any-release switching, recording ids, duration tolerances, fixture corpus |
| Huge, partly wanted discography packs | `minPackWanted`, size plausibility, partial import, packs off by default |
| Audiobook category ambiguity | Per-indexer categories; matcher needs a library hit; decision log shows the domain |
| Union widening leaks into video code | Separate `AudioMediaType` / `AnyMediaType`; compiler finds exhaustive switches |
| Audio qualities leaking into video | Domain filters with tests |
| Retagging breaks seeding | No retagging in Waves 1–4 |
| Parallel migration conflicts | One schema owner per wave |
| Many music users rely on Gazelle trackers | Wave 5; Torznab via Jackett-style proxies until then |
