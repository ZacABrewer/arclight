# @arclight/subtitles

The pure subtitle layer for Phase 3. It covers languages, query building, scoring, selection, provider clients, throttling, archive handling, encoding normalisation, file naming and post-processing command descriptors. It has no database and no HTTP server. The `apps/api` subtitles module owns persistence (profiles, wanted, history, blacklist, throttle table), jobs and routes.

Specs: `docs/spec/subtitles.md` and `docs/spec/subtitle-providers.md`.

The only runtime dependencies are the workspace packages (`@arclight/parser`, `@arclight/shared`) and zod. HTTP uses native `fetch`. The package has its own zip reader (store and deflate through `node:zlib`), gzip support through `node:zlib`, and its own XZ/LZMA2 decoder in `src/xz.ts`. Encoding detection uses the ICU `TextDecoder`.

## Public API (src/index.ts)

| Area | Exports |
|---|---|
| Types | `Language`, `LanguageTag`, `WantedLanguage`, `SubtitleQuery`, `SubtitleCandidate`, `SubtitleFile`, `SubtitleProvider`, `ProviderError` (codes: auth, rate-limited, daily-limit, unreachable, bad-response, not-found, captcha, config, api-throttled, unsupported, must-blacklist) |
| Languages | `LANGUAGES` (full ISO 639-1 table with 639-2/B, 639-2/T and 639-3 codes), `parseLanguageTag`, `languageName`, `toAlpha2`, `toAlpha3`, `languageString` |
| Query | `buildQuery({ mediaType, file: MediaFile-like, title, ids…, languages })`: parses the file name, fills gaps from the scene name, then from quality and mediaInfo |
| Hashes | `computeOpenSubtitlesHash(path)`, `openSubtitlesHash(size, head, tail)`, `computeNapiprojektHash`, `computeFileHashes` |
| Scoring | `EPISODE_SCORES`, `MOVIE_SCORES`, `minimumScore` (324/360, 126/180), `computeMatches`, `score`, `scoreCandidate`, `selectCandidates`, `chooseBest`, `passesReleaseFilters`, `matchReport` |
| Search | `SubtitleSearcher` (`search`, `manualSearch`, `download`, `searchAndDownload`), `prepareSubtitle` |
| Throttle | `ThrottleTracker`: strike counting (5 in 120 s), exponential backoff, daily limit until midnight UTC, per-provider overrides, serialisable entries |
| Archives | `extractSubtitle`, `readZip`, `writeZip`, `gunzip`, `xzDecompress`, `pickEntry` (season-pack episode picker). rar and 7z raise `ArchiveError('unsupported-archive')` |
| Formats | `detectFormat`, `convertToSrt` (ASS/SSA, VTT, MicroDVD), `isValidSrt`, `looksHearingImpaired` |
| Encoding | `decodeSubtitle` (tries BOM, then declared encoding, strict UTF-8, language code pages, a statistical pick, and finally windows-1252), `toUtf8` |
| Naming | `nameSubtitleFile(mediaPath, tag, {forced, hi}, style)` gives `Movie.en.srt`, `Movie.en.forced.srt`, `Movie.en.hi.srt`/`.sdh`/`.cc`, `Movie.pt-BR.srt`, or `Movie.srt` with singleLanguage. Also `parseSubtitleFileName` |
| Post-processing | `buildFfsubsyncCommand`, `buildAlassCommand`, `shouldSync`, `buildPostProcessCommand` (placeholders plus `ARCLIGHT_*` env vars), `shouldPostProcess` |

## Providers

| Id | Class | Inputs | Status |
|---|---|---|---|
| opensubtitlescom | `OpenSubtitlesComProvider` | hash, imdb, tmdb, title (+S/E) | Implemented: JWT login with a 12 h cache, `/subtitles`, `/download` link, quota (`lastQuota`), 401 re-login. The `/features` title-id lookup is not implemented; it falls back to `query`. |
| subdl | `SubdlProvider` | imdb, tmdb, title (+S/E) | Implemented: 2-page cap, policy object, the episode search sequence, zip download. The unpack list and AI translation are not implemented. |
| addic7ed | `Addic7edProvider` | title + S/E (episodes), title + year (movies) | Implemented: show-list cache, season ajax page, movie page, referer download, 40/80 per-day counter. A login reCAPTCHA reports `captcha` because there is no solver. |
| podnapisi | `PodnapisiProvider` | title (+S/E, year) | Best effort against the JSON advanced search. The API shape is unverified because upstream removed the provider. |
| gestdown | `GestdownProvider` | series tvdb id + S/E | Implemented, including the 423 retry. Episodes only. |
| animetosho | `AnimetoshoProvider` | anidb episode id | Implemented: feed lookup, torrent attachments, `.xz` storage. The searcher decompresses the `.xz`. |
| jimaku | `JimakuProvider` | anilist id, name | Implemented. Japanese only. Season > 1 with an AniDB offset falls back to archives. |
| yifysubtitles | `YifySubtitlesProvider` | imdb (movies) | Implemented by HTML scraping. |
| subf2m | `Subf2mProvider` | title, imdb verification | Implemented by HTML scraping. A Cloudflare challenge reports `captcha`. |
| napisy24 | `Napisy24Provider` | OpenSubtitles hash + size | Implemented. Polish only, and the user must supply credentials (the upstream fallback account is not reproduced). |
| embeddedsubtitles | `EmbeddedProvider` | local file | Uses an injected `probe`. `buildSubtitleExtractArgs` produces ffmpeg argv, and an injected `runFfmpeg` performs extraction. Bitmap codecs are never offered. |
| whisperai | `WhisperProvider` | local file | Posts audio to an external Whisper-ASR web service (`/asr`, `/detect-language`). `buildAudioExtractArgs` produces the ffmpeg argv for extraction. |

## Limitations

- No CAPTCHA or Cloudflare solving. Captcha-walled providers throw `ProviderError('captcha')`, which throttles them for 12 h.
- rar and 7z archives are refused. Zip64 and encrypted zips are not supported.
- The XZ decoder supports the LZMA2 filter only (no BCJ or delta filter) and skips integrity checks.
- Encoding detection has no mojibake repair step.
- The searcher never spawns processes. Probing, extraction, sync and custom scripts return argv or env descriptors for the api module to run.
- Throttle state lives in memory. The api module persists `ThrottleTracker.list()` and restores it with `initial`.
