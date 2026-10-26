# Subtitle Providers: Behaviour Specification

Status: draft for implementation. Source of behaviour: the Bazarr provider layer (subliminal_patch and the subliminal base it extends), observed as of this repository snapshot. Nothing here is copied code; every rule is a statement of observable behaviour that a clean-room implementation must reproduce or deliberately diverge from (divergences are called out).

Audience: a TypeScript engineer writing providers without reading the original source.

Conventions used in this document:
- "Video" means the thing we want subtitles for: an Episode or a Movie, with the metadata fields described in section 1.2.
- "Record" means one candidate subtitle returned by a provider's listing step. "Content" means the downloaded subtitle bytes.
- Rule numbers are stable within a section (for example OSC-3 is rule 3 of the OpenSubtitles.com entry).
- Durations are the defaults of the throttling layer unless a provider says otherwise.
- Secrets: three providers ship or embed credentials upstream (OpenSubtitles.com application key, Napisy24 fallback account, BSPlayer anonymous login). This spec deliberately does not reproduce any of them. The implementation must take them from configuration or register its own application.

---

## 1. Common provider contract

### 1.1 Lifecycle and shape

1. A provider is a long-lived object created from its configuration (credentials, flags, paths). Construction validates configuration and raises a configuration error immediately when a mandatory setting is missing (API key, username/password, endpoint). A configuration error throttles the provider for 12 hours, so validation should happen before any network call.
2. initialize() prepares transport: create an HTTP session, set a User-Agent, restore cached tokens or cookies, and log in if needed. It is called once per search round before any listing. terminate() closes the session and any scratch state. An optional ping() answers "is this instance still usable"; the default is yes. OpenSubtitles.com answers no after 12 hours so the pool re-initialises it.
3. list(video, languages) returns zero or more Records for one Video and a set of wanted languages. It must never return Records for a language outside the requested set, and must not return Records for a video type it does not support.
4. download(record) fills the record's content in place (raw bytes) or leaves it empty. It does not return a value that callers rely on. Failure to obtain content is signalled by leaving content empty or by raising one of the exceptions in 1.7.
5. Each provider declares: the set of languages it can serve; the video types it supports (episode, movie, or both); and optionally a required hash name (a provider that can only work with a computed file hash declares it so callers compute it first).
6. Language sets are declared with variants. A provider that can serve forced or hearing-impaired (HI) subtitles must list those variants explicitly. The pool intersects wanted languages with each provider's declared set, so a provider that does not list "English forced" is never asked for it. A wanted "English HI" request is satisfied by a provider that declares English HI.
7. Providers run concurrently across the pool (optionally on a thread pool). Provider instances must be safe to use from one worker at a time; shared caches (token cache, show-id cache) must be safe across workers.

### 1.2 Video input fields providers rely on

Providers read these fields from the Video; any may be missing and each provider must degrade gracefully:

1. Common: file path and file name, file size, container-derived duration, frame rate (fps), release group, source (for example Web, Blu-ray, HDTV), resolution, video codec, audio codec, streaming service, edition, year, imdb id, tmdb id.
2. Episode: series title, alternative series titles (a list, often several), season, episode (may be a list for multi-episode files; providers that cannot handle lists use the smallest), episode title, series imdb id, series tvdb id (and tvdb id of the episode), original-series flag, anidb episode id, anilist id, absolute episode number, anidb season/episode offset.
3. Movie: title, alternative titles, year, imdb id, tmdb id.
4. Hashes: a map from hash name to value. Computed hashes are listed in 1.6.
5. Audio languages (list of ISO codes from the container, used by Embedded and Whisper).

### 1.3 The subtitle Record

Every Record carries at minimum:

1. A provider name and an id that is unique inside that provider. The pool de-duplicates by (provider, id). Providers that would otherwise collide (Whisper, Napiprojekt) must build ids from several fields.
2. A language, including its forced and HI flags. Forced and HI are properties of the language value, not separate columns.
3. A release info string (free text, may be multi-line) used for release matching and shown in the UI.
4. A page link (human-readable page, or download URL when there is no page).
5. A set of matches (see 1.4), filled by the provider at list time or on demand.
6. Optional: uploader, rating, download count, fps (needed for frame-rate checks), encoding hint, season/episode (for packs), "is pack" flag, machine-translated or AI-translated flag.
7. Two capability flags: hash-verifiable (the provider can actually prove a hash match; when false, any "hash" match flag is ignored by scoring) and HI-verifiable (the provider can really tell whether a subtitle is HI; when false the HI request is not trusted).
8. Content (bytes), filled only after download. The record also records a guessed text encoding after content is set.

### 1.4 Match flags and how providers compute them

The matches set is the vocabulary scoring uses. Valid flags: hash, series, title, year, season, episode, source, release_group, audio_codec, resolution, video_codec, streaming_service, edition, hearing_impaired, imdb_id, series_imdb_id, tvdb_id, series_tvdb_id, tmdb_id.

Rules:

1. Providers compute matches in one of four styles, which the catalogue names per provider:
   - Identity style: the provider searched by an external id, so it asserts title/series/year/season/episode as already matched (Gestdown, Subf2m, Subdl with id, SubSource, Animetosho, BSPlayer, Subtitulamos).
   - Text style: compare the subtitle's own title/series/year/season/episode fields to the video using normalised text equality (Addic7ed, Titlovi, TVSubtitles, SuperSubtitles).
   - Release style: run a release-name parser (guess season, episode, source, resolution, codecs, group, year, title from the release string) and compare guessed fields to the video (all providers add this on top).
   - Hash style: the provider proves identity by file hash (OpenSubtitles.com, Napiprojekt, Napisy24, BSPlayer, Embedded).
2. Release-group matching is tolerant: sanitise both sides (lower-case, strip punctuation), expand the video's release group through the equivalence table (for example a group and its known re-brands), and match if any equivalent appears as a substring of the subtitle's release text.
3. Id equivalence: if the provider asserts an imdb or tvdb id match, scoring treats series, year, season, episode and title as matched too. So do not also add them redundantly unless the provider has independent evidence.
4. A provider may add "hearing_impaired" to matches when the record's HI flag equals the requested HI value and the provider is HI-verifiable.
5. Release-name parsing can be partial: when the subtitle text names only part of a release (for example only a group), the parser must not flag absent fields as mismatches. "Partial" mode only adds flags it actually sees.
6. After the provider returns, the pool computes final scores: matches are post-processed (see 1.5) and summed with fixed weights. Providers never compute scores themselves, with one exception: LegendasDivx scores archive members to pick one (see its entry).

### 1.5 Scoring weights and equivalence rules (what providers feed)

Because providers only produce flags, the engineer needs the scoring table that consumes them.

1. Episode weights: hash 359, series 160, year 90, season 30, episode 30, source 25, release_group 20; audio_codec, resolution, video_codec, streaming_service, hearing_impaired, edition and the id flags weigh 1 each (and in practice id flags are folded via rule 3 of 1.4).
2. Movie weights: hash 179, title 60, year 40, source 30, edition 30, release_group 15; the small flags weigh 1.
3. The "hash" weight is defined as the sum of all other weights minus one, so a hash match alone ranks just below a perfect match on everything else. That is why a false hash claim is dangerous.
4. Hash is only kept if corroborated: for episodes, series/season/episode/source must also be among matches; for movies, video_codec/source must also match. Otherwise the hash flag is dropped before scoring. Providers that cannot verify a hash set should not claim it.
5. Source families: TV, Air, Disc-HD, Disc-SD, Web. Source is considered matching if the two sources fall in the same family. If source does not match, release_group is dropped (a group name only counts for the same kind of release).
6. Id equivalence (repeat of 1.4 rule 3): imdb id or tvdb id match implies series, year, season, episode and title.
7. A candidate is accepted when its score meets the user's minimum score for the media type; separately a pool-level HI/forced filter and a blacklist filter apply.

### 1.6 File hashes used by providers

1. OpenSubtitles-style hash: file size plus the sum of all 64-bit little-endian words in the first 64 KiB and last 64 KiB, truncated to 64 bits, rendered as 16 lowercase hex characters. Used by OpenSubtitles.com, BSPlayer and Napisy24. Only meaningful for files of at least 128 KiB; the implementation should skip it for smaller files.
2. Napiprojekt hash: MD5 of the first 10 MiB of the file, rendered as 32 hex characters. Only computed for files larger than 10 MiB; smaller files skip this provider's hash path.
3. Hashes are computed once per file by the host and passed in the Video's hash map. Providers read from the map by their own name and never hash files themselves, except that Embedded and Whisper read the file directly.
4. A provider that declares a required hash is skipped for a file where the hash could not be computed.

### 1.7 Exceptions and throttling

Providers signal failure with a small set of typed errors. The host catches them in the pool wrapper and throttles the provider (temporarily disables it) per the table. Unknown errors throttle for 10 minutes.

| Error | Meaning | Default throttle |
|---|---|---|
| Too many requests | rate limit hit | 1 hour |
| Download limit exceeded | daily quota used | 3 hours |
| Service unavailable | provider down/outage | 20 minutes |
| API throttled | provider asked us to slow down | 10 minutes |
| Parse response error | site layout changed/garbage | 6 hours |
| Timeout, connect timeout, read timeout | network | 1 hour |
| Proxy error | network | 1 hour |
| Configuration error | bad settings | 12 hours |
| Permission error | disk/permission | 12 hours |
| Authentication error | login rejected | 12 hours |
| Unknown | anything else | 10 minutes |

Per-provider overrides (all others use defaults):

1. OpenSubtitles.com: too many requests 1 minute; download limit 6 hours; provider error 1 minute.
2. Addic7ed: download limit 3 hours; too many requests 5 minutes; IP blocked 1 hour.
3. Titlovi: too many requests 5 minutes.
4. LegendasDivx: too many requests 3 hours; download limit, IP blocked and search limit until local midnight in Lisbon plus one hour.
5. Whisper: connection error 5 minutes.
6. SubSource: API throttled 10 minutes; authentication error 1 hour; forbidden 15 minutes; too many requests 1 hour.
7. Subdl: provider error 1 hour; download limit until midnight GMT plus 15 minutes; API throttled 15 minutes.

Counted strikes (important and easy to miss):

1. Only "too many requests", "service unavailable", "API throttled", and the timeout family are counted. Everything else throttles on the first occurrence.
2. For counted errors, the provider is not throttled the first four times: each strike sleeps 5 seconds and the search proceeds. The fifth strike within a 120 second window triggers the throttle and resets the counter. A strike older than 120 seconds resets the counter to one.
3. Throttle state persists across restarts (written to settings). On every search round the host lifts expired throttles and skips unexpired ones. A provider removed from the enabled list is purged from the throttle table.
4. A "must blacklist" signal (raised by a provider when a downloaded subtitle is known bad) does not throttle: it adds the subtitle id to the blacklist for that media and language.

### 1.8 HTTP behaviours shared by providers

1. Retrying session: up to 3 attempts with a 5 second pause between them, for connection-level failures only, not for HTTP error codes.
2. Cloudflare-aware session: used by providers that sit behind a browser check (Titlovi, LegendasDivx, optionally others). It solves the JavaScript challenge, caches the clearance cookie keyed by host and user agent, and when a CAPTCHA is demanded it delegates to a pluggable "pitcher" (a manual or third-party solver). In Media-Tron treat this as an injectable component: providers ask for a "protected session" and the host decides how to satisfy the challenge. If the challenge cannot be satisfied, raise service unavailable.
3. Rate-limit header throttler: some providers return standard rate limit headers (remaining/reset/policy) or Retry-After on 429; the shared layer sleeps for short waits and raises "too many requests" for long ones.
4. Proxy and DNS: an optional global proxy and DNS-over-override come from environment-style settings; providers do not read these themselves.
5. Random user agents: several scrapers pick one of a large pool of browser user agents per session. Behaviour is not important; it only matters that the header is realistic and stable within a session.
6. Timeouts are per-call, typically 10 seconds for pages, 30 seconds for APIs, 15 seconds for subtitlecat.

### 1.9 Download pipeline (pool-level, after provider.download)

1. Retry: the pool attempts the download up to 3 times with 6 seconds between attempts, unless the provider raised a typed error (which aborts and throttles).
2. Validity: content must be non-empty; for text subtitles it must parse as a supported format. SRT is validated by parsing; if parsing fails, an automatic converter attempts to convert (for example from MicroDVD or a loose format). Invalid content is dropped and counts as a failed download (next candidate is tried).
3. Binary or archive payloads that are not subtitles (HTML error pages, zero bytes) must be rejected. Most providers detect an HTML response served instead of an archive and treat it as a quota or ban signal.
4. Normalisation: line endings converted to LF; the text re-encoded as UTF-8 after encoding detection (1.10).
5. Frame rate: where a provider supplies a subtitle fps and the video's fps differs materially, a few providers (LegendasDivx, Titulky) reject or flag it. The core can also apply a frame-rate conversion; this spec only records provider-level behaviour.
6. After a successful download the host records history, applies post-processing (mods like OCR fixes, HI removal), then writes the file.

### 1.10 Encoding and content validation

1. Detection order: declared encoding on the record (if any), byte-order mark, strict UTF-8 attempt, per-language legacy code pages (for example Windows-1250 for Polish, Czech, Hungarian; Windows-1251 for Cyrillic; Windows-1253 Greek; Windows-1254 Turkish; Windows-1255 Hebrew; Windows-1256 Arabic; GBK/Big5 for Chinese; Shift-JIS/EUC-KR for Japanese/Korean), then a statistical detector, then a tolerant markup-library fallback. The first that decodes without errors wins.
2. A few providers force an encoding because their payloads are wrong-labelled (Subtitulamos serves Latin-1 bytes for Spanish and English; Whisper outputs UTF-8; Animetosho files are UTF-8 text inside XZ).
3. Subtitle file types accepted when picking from an archive: SubRip, SubStation Alpha, Advanced SubStation Alpha, MicroDVD. Plain text and informational files (readme, nfo, txt) are ignored. OS junk entries (resource-fork folders, files beginning with a dot or "._") are skipped.
4. Reject content containing only advertising lines (some providers inject a watermark first and last cue); the pool does not strip them, but post-processing mods can.

### 1.11 Archives and pack handling

1. Providers that return zip or rar archives must sniff the real type by content, not by extension. Subdl and SubSource may serve rar under a zip name. 7z is not supported anywhere.
2. Choosing one file from an archive (shared "archive helper"):
   - Collect entries whose names end in a subtitle extension and are not OS junk.
   - If only one remains, take it.
   - For episodes: prefer an entry whose parsed season/episode equals the target; if the target episode is multi-episode, accept any.
   - Else, prefer an entry whose name is closest in similarity to the episode title.
   - Skip entries whose names contain "forced" unless forced is wanted (and prefer them when forced is wanted).
   - Classification into tiers: "matching" (episode confirmed), "unsure" (no episode number in the name), "fallback" (names contradict). Take from the best non-empty tier; within a tier prefer the one with the most overlap with the video's release name.
3. Multi-file season packs are flagged on the Record (is pack), and download must receive the target episode number.
4. Some providers pass an episode hint into the extractor (Titlovi pack, Subdl pack); others simply take the first (Subdl single, TVSubtitles raises if more than one file).
5. XZ (Animetosho) is a single-stream compression, not an archive: decompress and use as is.
6. A gzip-wrapped payload (BSPlayer) is decompressed and treated as raw subtitle text.

### 1.12 Language-code mapping

1. Internal language values use ISO 639-3 with optional country (Portuguese-Brazil, Spanish-Mexico, Chinese-Taiwan), optional script (Serbian Latin/Cyrillic) and the forced/HI flags.
2. Each provider has its own spelling: English names, two-letter codes, three-letter codes (639-2/B or 639-3), numeric ids, or localised names. The catalogue lists the quirks per provider.
3. Where a provider cannot represent a variant (for example it only has "Portuguese" and "Brazilian Portuguese"), the unrepresented variant is unsupported by that provider and must be omitted from its declared language set.
4. A configurable "language equals" table can map one language to another (for example treat Brazilian Portuguese as Portuguese) before provider calls; providers do not know about it.

---

## 2. Provider catalogue

Order follows ROADMAP Phase 3 priorities: the big API providers first, then scrapers, then special-case and local providers. Each entry has the same headings: settings, flow, queries, limits, metadata and matching, language quirks, anti-bot, quirks.

---

### 2.1 OpenSubtitles.com (id: opensubtitlescom)

**Settings and auth**
1. Required: username, password, and an application API key. The API key identifies the client application and is sent in a header on every request; this spec does not carry the Bazarr key, so Media-Tron must register its own application with the service.
2. Optional flags: use hash (default on), include AI-translated, include machine-translated.
3. Login exchanges username and password for a bearer token plus a base host name. The token and the host name are cached for 12 hours (shared across workers); the provider's ping reports "stale" after 12 hours.
4. VIP accounts are served from a host whose name starts with "vip"; for such hosts the bearer token is attached to every request. For non-VIP hosts the Authorization header is removed on API calls and used only for download.

**Flow**
1. Login (POST login with JSON credentials, no redirect following) returns token and base host. Cache both.
2. Optional title resolution: if the video has no imdb id (movie) or no series imdb id (episode), call the features endpoint with the lower-cased title. Pick the first result whose title (after a small naming-fix table, for example "Superman and Lois") equals the wanted title ignoring case and whose year equals the video year when the video has a year. The resolved feature id is cached for one week.
3. Search (GET subtitles) with query parameters; returns a JSON list under "data". Fail if the key "data" is absent.
4. Download is two steps: POST download with the file id and requested format "srt" to get a temporary link, then GET the link. The link may expire (HTTP 410).
5. The downloaded body is run through line-ending normalisation.

**Query capabilities**
1. Hash: moviehash (16 hex) when use-hash is on and the file hash exists.
2. Ids: imdb id (movie: as number with "tt" and leading zeros stripped), parent imdb id (series), parent feature id (resolved by title), feature id (movie resolved by title).
3. Episode: season_number and episode_number.
4. Languages: comma list of lower-case language codes, sorted. Codes are mostly two-letter but with site-specific spellings (below).
5. Flags: ai_translated exclude (when not including AI), machine_translated include (when including).
6. Parameters are sorted alphabetically before sending (matters only for caching).
7. If neither an imdb id nor a title id could be found, return an empty list without calling search.
8. Forced and HI are post-filters (the API returns them in the same listing): a returned item is "real forced" when its foreign-parts-only flag is true and it is not HI. If every wanted language is forced, keep only real-forced; if only some are forced, keep both; if none is forced, drop real-forced.

**Limits and errors**
1. Account-level daily download quota. An HTTP 406 carries counts (requests, remaining, reset time) and becomes "download limit exceeded" (provider override: 6 hours).
2. HTTP 429 becomes "too many requests" (override: 1 minute). HTTP 502 becomes "API throttled".
3. When "API throttled" is seen on a call, the provider waits 15 seconds and retries that call once.
4. HTTP 401: clear cached token and host, wait 1 second, log in again once, and retry. If already retried, raise authentication error. (Upstream quirk: after re-login the retried response is not returned to the caller, so the first search after a token expiry returns nothing. Media-Tron should return the retried response.)
5. HTTP 400 becomes configuration error with the server message. HTTP 403 becomes a generic provider error (key rejected). HTTP 410 becomes provider error "link expired". Other 5xx become provider error; any other non-200 becomes provider error.
6. Non-JSON or missing "data"/"link" keys become provider error; an empty body on the download link yields no content (not an error).
7. All network calls are wrapped in the generic retry helper: 3 attempts, 10 seconds between tries, except it never retries throttle, auth, configuration or quota errors.

**Metadata and matching**
1. Each item gives: file id (use the first file's id as the record id), language, forced flag, HI flag, release string, uploader name, page URL, feature title, year, season and episode numbers, hash-match flag, imdb comparison.
2. Matching: always add series (episodes) or title (movies) since the search is by id. Add season/episode when numbers equal. Add series_imdb_id or imdb_id when the returned parent/imdb id equals the video's. Add year when the imdb matched or the year equals. Add release_group when the guessed group from the release string equals the video's group (through the equivalence table). Add hash when the service reports a moviehash match. Add everything the release parser can see.
3. Capabilities: hash-verifiable and HI-verifiable are both true.

**Language quirks**
1. Wire codes differ from internal ones for three cases: Portuguese is requested as pt-PT; Chinese as zh-CN; Mexican Spanish as "ea". The reverse mapping is applied to results.
2. Supported languages come from the shared OpenSubtitles language table (about 100 languages), plus Spanish-Mexico, each with forced and HI variants.

**Anti-bot**: none. Plain JSON API over TLS with a user-agent header (default: the host application's name/version).

**Other quirks**
1. AI-translated and machine-translated items are excluded both in the request and again client-side (defence in depth), unless the flags are on.
2. Title lookup treats a miss as "no results", not an error.
3. The login response's base host can change; always read it from the cache or login response, never hard-code it.
4. Logging redacts the password and the last 8 characters of tokens. Implement the same.

---

### 2.2 Subdl (id: subdl)

**Settings and auth**
1. Required: API key. Optional: ai_translate (offer AI translation candidates; needs a paid plan), include_ai_translated (accept items the service marks as AI).
2. The key is sent as a query parameter on every call (search, download-side AI endpoints).

**Flow**
1. Search (GET subtitles on the API host) returns a page of results plus a total page count. Up to 2 pages are read (30 per page) for the first and primary search.
2. Download uses a separate download host: the item's relative URL is joined onto it. The body is normally a zip (sometimes a rar under a zip name). Direct (non-archive) files are allowed when the record is flagged direct.
3. The response may carry a "policy" object that tells the client to disable the provider, disable AI translation, disable fallbacks or unpacking, or cap pages at 1 or 2. Honour it: never allow more than 2 pages. Optionally log the policy message once per revision.
4. Per-item "unpack" metadata lists the files inside a pack with their episode numbers; when present the record can point straight at a single episode file.

**Query capabilities**
1. Always sent: client marker, comments on, releases on, unpack on, languages (comma list, sorted, converted to Subdl's names), 30 per page.
2. Ids: movies by imdb id, then by tmdb id as fallback; episodes by series imdb id. Without an imdb id the search uses the cleaned title as the film name. Titles are cleaned: characters that could break the query (angle brackets, braces, brackets, quotes, backticks, semicolons, slashes, backslashes) are replaced by spaces and whitespace is collapsed.
3. Episode search sequence (merged and de-duplicated by page link or name):
   - exact episode (season + episode, type TV);
   - absolute episode number alone, if the video has one that differs from the episode number;
   - season-only search (gets packs and season files), if the policy allows;
   - title-only search, only when everything above returned nothing, if the policy allows.
4. Movie search: by imdb id or name, then, if empty, by tmdb id (and in that case the match is tagged as id-based).
5. A failing sub-search (4xx about that one request, transport error) is absorbed so earlier results are kept; only account-level problems (bad key, quota, rate limit, outage) propagate.

**Limits and errors**
1. HTTP 402: provider error with the server's message (paid plan needed).
2. HTTP 403: authentication error when the body mentions key/auth/forbidden, otherwise API throttled.
3. HTTP 404: treated as per-request rejection (absorbed), except on the search endpoint where "resource not found" becomes service unavailable.
4. HTTP 429 body codes: daily limit or API download limit exceeded becomes download limit exceeded (reset at midnight GMT plus 15 minutes); "rate limit" waits (honour Retry-After, default 15, clamp to 0..60 seconds) and retries up to 6 attempts then raises API throttled; "service busy" waits (default 5 seconds) and retries up to 5 times.
5. Any other 5xx or unknown: provider error (1 hour throttle).
6. A bad link on a single download is logged and leaves content empty rather than throttling the provider.

**Metadata and matching**
1. Item fields: name (id), language, URL, release names (list), uploader/author, season, episode, full-season flag, episode range, HI/forced hints, AI flag, optional unpack file list.
2. HI and forced detection: explicit flags plus keyword scan of the release names and comments (HI keywords include hearing impaired, SDH, CC; an explicit "non-HI" wins; forced keywords: forced, foreign parts).
3. Episode matching: if matched by imdb id: series, series_imdb_id, year (if the video has one). If matched by title: series only. Episode matches if numbers equal; also if the absolute number equals; also if the item is a pack. Season matches if numbers equal, or if it is a pack with an absolute number, or if matched by absolute number.
4. Movie matching: by id: imdb_id, tmdb_id (if known), title, year; by title: title only.
5. Release-style matching is always added.
6. Hash-verifiable false; HI-verifiable true.

**Pack handling**
1. A pack is an item whose episode range or full-season flag covers multiple episodes. If unpack data exists and a file for the target episode is found, the record points at that file's URL and is treated as a single-episode record. Selection of that entry cross-checks the server's episode number with a number parsed from the file name (see rule): best when both agree; next when the name agrees and the server says nothing; acceptable when the server agrees and the name is silent; never when the name contradicts the server (the server is wrong about roughly 3-4 percent of packs).
2. Prefer an entry whose HI flag matches the pack's.
3. If no unpack entry works, download the whole archive and use the shared episode picker with target episode, absolute episode as fallback and episode title.
4. Episode range can also be parsed from release names like "E01-E10".

**AI translation (optional)**
1. Only when ai_translate is on, policy allows, and the API reports missing languages that are translatable, and the account is entitled. Offer virtual candidates (one per missing wanted language) copied from the best source subtitle (prefer English; prefer matching HI flag). Forced targets are not offered.
2. Download of such a candidate: POST a job with the source id, target language and optional season/episode; accept HTTP 200 or 202; poll the job (every 4 seconds, up to 5 consecutive poll failures) until the "download ready" flag or a deadline of between 90 and 180 seconds (twice the estimate, clamped); then fetch the result. Failure leaves content empty without throttling.
3. Quota exhausted or not entitled error codes pause AI offers for 15 minutes and log a notice once.

**Language quirks**: custom converter between internal languages and Subdl codes; includes script/country variants such as Brazilian Portuguese, and a Chinese split. Unknown service languages are skipped.

**Anti-bot**: none.

**Other quirks**
1. Two-page cap is deliberate to bound requests.
2. De-duplication key is the item's page link, falling back to name.
3. Not hash-verifiable; do not claim hash.

---

### 2.3 Addic7ed (id: addic7ed)

**Settings and auth**
1. Required: either username + password, or a raw cookie string (cookies override login). Optional: user agent override, VIP flag (raises the daily download cap), "random agents" flag (default off).
2. Cookie mode: set the cookies, check the control panel page; a 302 redirect means expired, raise authentication error ("cookies not valid anymore").
3. Password mode: reuse a cached session if the panel page does not redirect. Otherwise load the login page; if a reCAPTCHA is present, extract the site key (checkbox or invisible variants) and ask the pluggable pitcher to solve it (up to 3 tries with 4 second pauses; failure raises a generic error). Then POST credentials with "remember me". "relax, slow down" in the body is "too many requests"; "Wrong password" or "doesn't exist" is authentication error; anything other than a 302 retries (3 tries). Store the session and pause 2 seconds.

**Flow (episodes)**
1. Resolve show id. Build candidate names: the series, series with dots removed, "&" replaced by "and" and vice versa (all sanitised). Look in the cached show list (a scrape of the full shows page, cached one week; keys are sanitised names, also with year and country code suffixes, and the name stripped of its trailing year). Try country-qualified key, year-qualified key, then plain key. If not found and the last full refresh was over a day ago, refresh the list once and retry.
2. If the list fails entirely, fall back to the site search page (two endpoints tried, with a 4 second pause between them), accepting only a suggestion that exactly equals the search text.
3. Load the season page via the AJAX endpoint (show id, season, all languages) with referer and "XMLHttpRequest" headers.
4. Parse each table row: season, episode, title, language, version (release), status (skip rows whose status shows a percentage, meaning still in progress), HI marker, download link. Filter rows to the requested language set and exact episode number.
5. Titles tried in order: series name then up to 5 alternative series names; stop at the first that resolves a show id.

**Flow (movies)**
1. Search page for the title, parse the movies table, link must be a movie page; match on exact (sanitised) name and exact year. Id cached a week.
2. Load the movie page; parse each subtitle block: status, language, HI marker (image name), version (release), download link, uploader.
3. Filter by requested languages.

**Download**
1. Fetch the download link with the subtitle page as referer.
2. HTTP 304 becomes "too many requests". Empty text becomes empty content. A response whose content type is HTML means the daily quota is used: raise download limit exceeded.
3. Success normalises line endings.

**Limits**
1. Local quota counter: the number of downloads in the last 24 hours is tracked in cache; cap is 40 per day (80 for VIP). When the cap is already reached, raise download limit exceeded before downloading. After a successful download, if the new count reaches the cap, the provider also raises (upstream quirk: it raises even though the download worked; the content is already set, but the exception throttles the provider). Media-Tron should instead return the content and mark the provider as throttled for the remainder.
2. Throttle overrides: download limit 3 hours; too many requests 5 minutes; IP blocked 1 hour.
3. A single reinitialise-and-retry on any connection-level failure (wrapped on list and download).

**Metadata and matching**
1. Series equality (sanitised, alternatives included), season, episode, year (if the video's original-series flag is set and the subtitle has no year, or years equal), episode title equality, release group via equivalence, resolution and source by substring in the version text, other flags from release parsing (partial).
2. Movies only year is available from the page, plus title equality.
3. Optional "boost" feature: if the scoring table has a special Addic7ed boost weight and series, season, episode, year and source all match, add a boost flag. Also if release_group matches, source is added. (The boost is a Bazarr-specific scoring tweak; implement only if the scoring spec includes it.)
4. HI-verifiable true. Hash false.

**Language quirks**
1. The site uses English names with custom spellings: Catalan as "Català", Basque as "Euskera", Galician as "Galego", Portuguese-Brazil as "Portuguese (Brazilian)", Serbian Cyrillic and Latin as separate entries, Chinese as simplified and traditional (both map to Chinese; the traditional/simplified split is lost), Spanish as Latin America and Spain (both map to Spanish).
2. Declared set: about 43 languages plus Serbian Latin and Cyrillic, each with HI variant. No forced variant.

**Anti-bot**: reCAPTCHA on login via pitcher; browser-like headers with referer; cookies; optionally random user agent. Cloudflare may block the IP: treat 403/captcha pages as service unavailable/IP blocked.

**Other quirks**
1. Site throttles aggressively; space requests by at least 1 second in login and 4 seconds in search fallbacks.
2. Multiple episode numbers: the smallest is used.
3. Show list scrape must raise an error if empty ("no show ids found").

---

### 2.4 Podnapisi (id: podnapisi)

1. Status: **not present** in this snapshot. Upstream configuration migration code states that the Podnapisi settings section is deleted because "this provider doesn't exist anymore". There is no provider file, no converter and no throttle entry.
2. Consequence: this spec cannot describe its endpoints, authentication, query capabilities, limits, metadata mapping or language quirks. Anything written would be guesswork.
3. Roadmap guidance: the ROADMAP lists it for Phase 3. Treat it as blocked until someone supplies either a current API description or a maintained reference implementation. Do not implement from memory of the old site's XML feed; it may no longer exist.
4. Interface reservation: keep the provider id "podnapisi" in the registry and the settings schema as "deprecated, unavailable" so imported configurations that mention it do not break.
5. See Open questions Q1.

---

### 2.5 Gestdown (id: gestdown)

Gestdown is a community-run mirror of Addic7ed content exposed through a plain API keyed by TheTVDB ids.

**Settings and auth**: none. Fixed host. A simple "Bazarr" user agent is sent.

**Flow**
1. Resolve show: GET shows/external/tvdb/{series tvdb id}; 404 means not found (empty result). The response lists one or more shows (id plus its tvdb id).
2. For each wanted language and each returned show: GET subtitles/get/{show id}/{season}/{episode}/{language name}. The language name is produced by the same converter Addic7ed uses (English names with the Addic7ed spellings), called with only the three-letter code (so variants such as Portuguese-Brazil collapse to the base spelling and Serbian script cannot be asked for).
3. The response has a list of matching subtitles; each has id, download path, version text, qualities list, HI flag, and a "completed" flag. Skip items not completed.
4. Download: GET the absolute URL formed from the base host plus the path (follow redirects); the body is the subtitle itself.

**Query capabilities**: tvdb id only (no title search, no hash, no movies). Languages one at a time. HI is returned in the item and compared via the language value.

**Limits**
1. HTTP 423 (the service is still fetching the episode from its upstream) is retried up to 3 times, with 30 seconds between tries. After 3, the listing returns empty (not an error).
2. HTTP 404 for the show or episode is an empty result.
3. Non-JSON or missing fields is an empty result.
4. Other HTTP errors propagate and are throttled by default rules.

**Metadata and matching**
1. Always matched: title, series, season, episode, tvdb id (identity style).
2. If the show's tvdb id equals the video's series tvdb id, year is added.
3. Release-group match through version text split on commas (equivalence table); resolution if the video's resolution appears in the item's qualities; other flags from release parsing.
4. HI-verifiable true; hash false.

**Language quirks**: same set as Addic7ed (about 43 plus Serbian variants) with HI variants. Forced is not offered.

**Anti-bot**: none.

**Other quirks**
1. Episodes only.
2. The inner loop over shows has a "continue" that does not stop after a hit; it simply accumulates results across shows.
3. No content validation beyond the pool's.

---

### 2.6 Subf2m (id: subf2m)

**Settings and auth**: user agent is mandatory (blank raises a configuration error). Optional: verify TLS (default true). No credentials.

**Flow (HTML scraper)**
1. Search by title: GET the title-search page with the URL-encoded query; parse result links. For episodes, result entries look like "Show - Second Season (2019)" or "Show (First Season)"; for movies "Title (Year)".
2. Movies: normalise the title to lower case; keep entries whose year equals the video year; rank by text similarity to the title; take the top 3 paths. If none and the video has an imdb id, search again using the imdb id as the query text.
3. Episodes: convert the season number to an ordinal word (First to Twentieth, so seasons above 20 are not supported) and also the digit; accept entries whose season text equals either, or contains "complete"; rank by similarity (plus 0.1 when the year appears in the text); take the top 3 paths.
4. For each candidate path and each wanted language, GET {path}/{language slug}. Verify the page's imdb id (read from the header link) equals the video's imdb id (series imdb id for episodes). If the page has an imdb id that differs, skip; if it has none, accept (logged).
5. Each list item gives the release lines (one per list entry) and the uploader comment; plus the download page link.
6. Episodes: filter list items by the parsed season/episode; an item with a season but no episode counts as a pack; "complete series" counts as a pack for any season. A special "season X-Y" pattern is read directly. Guessing uses a cached release-name parse.
7. Stop after the first path that yields results (matching is "first productive path wins").
8. Download: GET the subtitle page; find the download button; GET it; open as zip/rar; for packs pick by episode number and episode title via the shared archive helper.

**Limits and errors**
1. The page fetch retries up to 3 times; 403 stops immediately; 404/503 wait 3 seconds and retry.
2. A missing download button or an invalid archive raises "API throttled" (10 minute default throttle).
3. No account quotas known.

**Metadata and matching**
1. Identity style: movie records start with title, year, imdb_id; episodes with title, series, year, season, episode, imdb_id. Release parsing adds the rest.
2. Hash false; HI not verifiable (HI cannot be told; HI wanted is not honoured).

**Language quirks**: a fixed table of 33 English language slugs (for example "farsi_persian", "brazillian-portuguese" with the site's own misspelling). Three-letter bibliographic codes (for example fre, ger, dut) are used internally to build language objects; the implementation must map to its own ISO scheme. Chinese, Korean, Ukrainian and many others are not offered.

**Anti-bot**: heavy browser-like header set (client hints, fetch metadata). Must be a plausible modern browser fingerprint. A 403 is treated as a block and produces an empty text; no CAPTCHA solving.

**Other quirks**
1. Episode title for archive pick is passed from video.title (the episode title).
2. A response parsed with an HTML parser that tolerates broken markup is required.

---

### 2.7 Napisy24 (id: napisy24)

**Settings and auth**: optional username and password. Upstream embeds a built-in fallback account when none is given; this spec does not reproduce it. Media-Tron requires the user to supply credentials or disable the provider (see Open questions Q4).

**Flow (single call; no download step)**
1. POST a form to the agent endpoint with action "CheckSub", user, password, file size, file hash (the OpenSubtitles-style hash), file name (basename only) and a preference flag.
2. The response text before a double-pipe separator is a status block: it starts with "OK-N" or "login error". After the separator is binary: a zip containing the subtitle.
3. Status meanings: OK-0 no subtitles; OK-1 no subtitles but video info returned; OK-2 found (zip follows); OK-3 found but not from the site's own database (ignored). "login error" raises authentication error. Any other text is logged and ignored.
4. For OK-2, the block carries pipe-separated "key:value" pairs including the imdb number and site id. The record's imdb id is built by left-padding the number to 7 digits and prefixing "tt".
5. The first entry of the zip becomes the content (line endings normalised). The download step does nothing because content is already present.

**Query capabilities**: hash, file size and file name only. Polish only. One request per wanted language (in practice one).

**Limits**: undocumented; HTTP errors propagate. No rate-limit parsing.

**Metadata and matching**: the record id is the hash. Matches: hash if the video's napisy24 hash equals it; imdb_id if equal. No release info is available (release info is empty). Hash-verifiable true; HI false.

**Language quirks**: Polish only, no variants.

**Anti-bot**: none (plain HTTP, not HTTPS, in the original; use HTTPS if the host supports it, else flag).

**Other quirks**
1. The provider declares a required hash: skipped when no hash.
2. Movies and episodes both; but as the match is by hash only, nothing else is asserted. Score relies on the hash weight plus corroboration rule 1.5.4 (so a file whose only match is hash will lose the hash flag unless corroborated; an implementation may add title/source flags when the imdb id matches).

---

### 2.8 Animetosho (id: animetosho)

**Settings and auth**: a "search threshold" integer (how many recent releases to inspect). Missing or zero raises a configuration error. No credentials.

**Flow**
1. Skip videos with no anidb episode id (the video must be an anime episode recognised by AniDB).
2. GET the feed API (JSON) with the anidb episode id. Keep only entries with status "complete", sort newest first (by timestamp), take the first N where N is the search threshold. Each entry is a torrent release with an id and title.
3. For each entry, GET the feed API again with that torrent id to read its file list. For each file with attachments, keep attachments of type subtitle.
4. For each subtitle attachment: build its storage URL from the attachment id formatted as 8 hex digits (folder) and the id again (file name) with an ".xz" suffix on the storage host. The attachment info gives a three-letter language (bibliographic form), a name, and a forced flag.
5. Download: GET the storage URL; verify the six-byte XZ magic header; otherwise raise provider error ("unidentified archive type"); decompress; the result is the subtitle text (often ASS).

**Query capabilities**: anidb episode id only. No title, no hash, no languages in the query (filtered client-side).

**Limits**: none documented; each search costs 1 + N requests (N = threshold), so keep N small.

**Metadata and matching**
1. Asserts title, series, tvdb id, season and episode (identity style, because the anidb episode id fixed those) and adds the release-parse of the attached file's original file name.
2. Record id = torrent id + ":" + URL (a torrent can ship several subtitles).
3. Hash false; HI false.

**Language quirks**
1. 17 base languages; Portuguese is split: if the attachment is Portuguese and its name contains "brazil" (case-insensitive) it is Brazilian Portuguese. Forced variants declared.
2. If the attachment omits language it defaults to English.

**Anti-bot**: none.

**Other quirks**
1. Episodes only (the declared type is a single type, not a pair; ensure the movie path is excluded).
2. Subtitles are frequently ASS/SSA; the post-pipeline must accept them.
3. Two sibling providers exist upstream (animetosho_xyz and tsukihime) with empty configs; out of scope here.

---

### 2.9 Jimaku (id: jimaku)

Japanese subtitles for anime, keyed by AniList.

**Settings and auth**: API key (required; sent raw in the Authorization header). Flags: name-search fallback (when no AniList id, search by name), allow archives, allow AI subtitles.

**Flow**
1. Build search: if the video has an AniList id, query entries/search with it. Else, if name fallback is on or the video is a movie, query by lower-cased name (for episodes, "series name" plus season number when season is above 1). Otherwise no search.
2. If a name search returns nothing, retry once with the "anime" restriction turned off (to find live-action).
3. Pick the entry whose AniList id equals the video's. If none, give up. If the entry is flagged a movie but the video is an episode, or the entry is unverified, log and continue (no hard stop).
4. For episodes of a non-movie entry, fetch entries/{id}/files with the episode filter. If the video's season is above 1 and the anidb offset is known, add the absolute offset to the episode number on the first try and fall back to the plain number on the retry; if there is no offset, retry with no episode filter and then prefer archives only (season packs).
5. Remove 7z archives (unsupported). Split remaining into archives and plain subtitle files. If there are only archives, allow them even when the "archives" setting is off. If the archive setting is off and plain files exist, drop archives.
6. Per file: skip AI-generated names (Whisper marks) when AI is off; skip files smaller than 500 bytes (corrupt); guess languages from the file name; skip if multiple languages detected; build a record with language Japanese.
7. Download: GET the file URL. Archives (zip or rar) go through the shared episode picker with the video's episode and episode title; plain files are used as is.

**Query capabilities**: AniList id, free text name, episode number. No hash, no imdb.

**Limits and errors**
1. HTTP 429: sleep 5 seconds and retry, up to 3 tries. (Upstream bug: the counter never increments so it can loop forever. Media-Tron must count attempts and then raise "API throttled".)
2. HTTP 401: authentication error. An "error" field in the body: service unavailable with the code. Empty list: none.
3. Entry search cached for the refiner expiry period; file listings cached for 1 minute.

**Metadata and matching**
1. Series matched by sanitised equality; season matched when the subtitle's video season is unset or equal; year; for movies title by equality (alternatives included). The "episode"/"movie" type itself is added as a flag. Release group matched from the file name's guessed group. An SRT extension earns an audio_codec flag (a quirk that makes SRT files outrank ASS slightly; reproduce only if the scoring spec wants it).
2. Hash false. HI false.

**Language quirks**
1. Declared: Japanese only. The file-name language parser is heuristic: look at the token before the extension, split on separators, ignore ass/srt, expand four-letter tokens into two two-letter codes, collapse shortcuts (jp, jap, chs, cht, zhi, cn) to Japanese or Chinese, and treat unknown tokens as Zulu (a sentinel meaning "foreign but unknown"). If more than one language is found and Japanese is among them, the file is multi-language and skipped; if Japanese is not among them, assume Japanese.
2. Tokens with digits or five or more letters mean "not a language token".

**Anti-bot**: none.

**Other quirks**: the video object is mutated (the episode number is rewritten to the adjusted absolute episode on success); avoid that side effect in Media-Tron, pass the adjusted number in the record instead.

---

### 2.10 Titlovi (id: titlovi)

South Slavic subtitles (Croatian, Bosnian, Serbian, Slovenian, Macedonian, English).

**Settings and auth**: username and password (required). Login against the Kodi plugin API returns a user id, a token and an expiry; cache the triple until expiry. HTTP 401 on login: "account not verified or API disabled".

**Flow**
1. Search: GET search with query (title), language list joined with "|", season (episodes only), imdb id (if known), token, user id, json flag. Result: a page of results and a page count; fetch up to pages 2 and 3 if available (so at most 3 pages).
2. Results are cached 3 hours by exact request.
3. Per item: language name, title string (may contain "aka" followed by an alternative title), release text, season, episode (0 means a season pack), year, rating, download count, link.
4. For episodes: drop items whose season differs; drop items whose episode differs unless the episode is 0 (pack).
5. Download: GET link. Rar or zip: if more than one file and the record is a pack, choose the entry whose name carries the target season/episode in either "01x02" or "s01e02" form; if more than one file and the language is Serbian (Latin or Cyrillic), choose by script marker in the file name (names containing "cyr"/"cir" are Cyrillic; others are Latin); else use the shared archive picker. Non-archive payload is used directly if valid, else "unidentified archive type".

**Limits**: HTTP 429 raises "too many requests" (override: 5 minutes). HTTP 401 at search or download raises authentication error. The Cloudflare-aware retrying session is used.

**Metadata and matching**
1. Text style: series/title by sanitised equality against the naming-fix table ("DC's Legends of Tomorrow" becomes "Legends of Tomorrow", "Marvel's Jessica Jones" becomes "Jessica Jones") or the alternative title; year; season; episode; release group via equivalence; plus release parsing.
2. Hash false. HI false.

**Language quirks**
1. Titlovi names: Bosanski, English, Hrvatski, Makedonski, Srpski (Serbian Latin), Cirilica (Serbian Cyrillic), Slovenski. Anything else raises a configuration error on conversion.
2. If both Serbian and Serbian Latin are requested, send only Serbian (the site's Srpski covers both).

**Anti-bot**: Cloudflare-aware session (JavaScript challenge solver).

**Other quirks**: it is in the upstream "forced off" list for forced-only search (cannot serve forced). The episode number for a pack record uses the asked-for episode.

---

### 2.11 LegendasDivx (id: legendasdivx)

Portuguese (Portugal and Brazil) subtitles.

**Settings and auth**: username and password (both or neither; a half-filled pair is a configuration error), and "skip wrong fps" (default true). Login is a forum form: load the login page, collect all form fields (including hidden tokens), add credentials, POST; require a session cookie. Only five named cookies are cached for reuse. Errors: no session id: authentication error; HTTP error with "bloqueado" in the body: IP blocked; other HTTP errors: too many requests; anything else: service unavailable.

**Flow**
1. Build the search by type:
   - Movie: query text is the imdb id if known, else the title.
   - Episode with series imdb id: use the episode-search mode (parameters: season, episode, imdb number without "tt").
   - Episode otherwise: query is the quoted series name with "S01E02", lower-cased and URL-encoded.
2. Language filter id appended per language: 28 for Portugal, 29 for Brazil. (Upstream quirk: the filter string accumulates across languages in a loop, so with two languages the second query has both filters. Media-Tron should build each query from scratch.)
3. One request per language with 1 second pauses. Parse the HTML page-by-page; a pager bar says how many matches exist; fetch up to 6 pages total (10 per page).
4. If the page says the subtitle was not found and the video is an episode, retry once with the episode part removed (season only).
5. A 302 redirect to login means the session expired: clear cookies, log in, retry once.
6. Each result box gives hits, language (from the flag image name), frame rate, description (free text containing the release and often the full file name), uploader, download link.
7. Download: GET the link; "daily download limit reached" in the body: download limit exceeded; open as rar or zip.
8. Archive member choice: ignore dot files and non-subtitle extensions (txt is excluded here); for episodes parse season/episode from the member name and require equality, else skip; score each remaining member by summing the scoring weights of its release-parse matches; take the highest score above zero.

**Limits**
1. The site shows a count of today's searches in a hidden comment on each page. When it reaches 145 (the real limit is 150), raise "search limit reached" (throttle until midnight Lisbon plus 1 hour).
2. Daily download cap: "download limit exceeded" with the same reset. IP blocked: same reset.
3. Too many requests: 3 hours.
4. Self-imposed pause of 8 seconds is declared as a throttle constant but the code sleeps 1 second between steps.
5. A single reinitialise on connection failure.

**Metadata and matching**
1. Text style over the description (sanitised substring tests): the video's file name stem in the description gives title (and for episodes series, season, episode); year as four digits; movie title and alternatives; episode title; series names; season as "s01"; episode as "e02"; series imdb id gives series, series_imdb_id, season, episode; release group; plus release parsing of the description.
2. Frame rate: parse the sub's frame rate; if the video's fps and the sub's fps are not "equal" (tolerance table for 23.976 vs 24 and 25 vs 25.0), mark wrong fps and, if skip-wrong-fps is on, return an empty match set (the record is effectively discarded). If the page has no frame rate the variable is undefined (upstream bug); Media-Tron should treat missing as unknown and keep the record.
3. "Exact match" flag (the whole file name appears in the description) is stored for ranking.

**Language quirks**: Portuguese (Portugal) and Portuguese (Brazil) only. Language is read from the flag icon file name containing "brazil" or "portugal"; other flags are skipped.

**Anti-bot**: Cloudflare-aware session; realistic headers with Origin and Referer pointing at the site; session cookie caching.

**Other quirks**
1. Listed in the upstream forced-off set (cannot serve forced-only).
2. The accumulating language filter, the 6-page cap and the undefined frame-rate bug are upstream defects flagged here so they are not copied.

---

### 2.12 SuperSubtitles (id: supersubtitles)

Hungarian and English subtitles from feliratok.eu.

**Settings and auth**: none. Random user agent plus a referer.

**Flow (episodes)**
1. Find the show id: GET the autocomplete endpoint with the series name; the response is JSON with names such as "Title (2016)" and ids. Compare the sanitised name against a guessit-style parse of the candidate (title + year), requiring year equality when the video has a year. Try progressively simpler names: the original, the version with apostrophes removed, then the longest single word.
2. GET the "xbmc" listing for show id, season and episode; if the episode listing is empty, GET again with season only (the site is flaky for packs hidden in season sets). The JSON is a map of entries; one subtitle appears once per compatible release, so group by subtitle id and collect release names.
3. Pack entries (season pack flag) get the asked-for episode number.
4. Language is Hungarian ("Magyar") or English ("Angol"); anything else is dropped. The language filter is applied client-side because the API cannot filter.
5. For each distinct subtitle, fetch the detail page once to read the series imdb id (cached per call).
6. Download: GET the URL; if it is an archive, pick by episode through the shared picker; else use the body as is.

**Flow (movies)**: GET the search page with the title, parse the table; for each row read the English title and year, the release (text in parentheses), language (from the small tag), download link, forced mark (a "szinkronoshoz" note, meaning "for the dubbed version", or "forced" in the link), uploader, and the imdb id from the detail page.

**Limits**: none documented. 2 second pause between multi-title searches. All requests 30 second timeout.

**Metadata and matching**
1. Text style: series equality; series imdb id equality adds series, series_imdb_id and year; year fallback for original series; movie: title in alternatives, imdb id adds imdb_id, title, year; release group via listing; if the release group matches, the resolution and source are checked in the same release text.
2. HI not verifiable. Hash false.

**Language quirks**: Hungarian, English; forced variants. Converter maps "hu"/"en".

**Anti-bot**: none (random user agent).

**Other quirks**
1. Upstream bug: the title loop returns after the first title regardless of success, so alternative titles are never tried. Media-Tron should continue to the next title when the first yields nothing.
2. Naming-fix table: "Star Trek: The Next Generation" becomes "Star Trek TNG"; a "Marvel's" prefix is dropped; "Loki (aka. Marvel's Loki)" becomes "Loki".
3. Result titles are filtered post-hoc: keep only those whose fixed title equals one of the requested titles.
4. Listed in the upstream forced-off set.

---

### 2.13 Subscene-like provider: SubSource (id: subsource)

Choice and reason: Subscene itself is not present in this snapshot (no provider, converter or settings). Of the three candidates (subsource, subscenter, subtitlecat), SubSource is the best stand-in: a currently maintained site with the same user experience as Subscene (pick a title, see all subtitles per language, download a zip) and a JSON API with a key. Subscenter is an old Hebrew-only wrapper, and Subtitlecat is a machine-translation aggregator (documented separately in 2.20). Subtitlecat is retained as an optional extra, not the Subscene successor.

**Settings and auth**: API key (required; sent as a query parameter on every call).

**Flow**
1. Resolve a title id: GET movies/search with either search type imdb (imdb id plus optional season) or search type text (lower-cased title). If an imdb search yields nothing, retry with text. Accept the first result whose title or alternate title contains any of the wanted titles (series name and alternatives, or movie title), and whose release year equals the video's year when the video has one. Cached 6 hours. Without an imdb id on the video, no title id is looked up and the provider returns nothing (upstream quirk; it only searches by imdb).
2. List subtitles: GET subtitles with language (lower-case English name), limit 100, title id, and for episodes season number and episode number. Results cached 1 hour.
3. Only the first wanted language is searched per call (upstream quirk: the API takes one language; a request with two languages silently drops all but one). Media-Tron should issue one call per language.
4. Per item: link (page), subtitle id, release info list, language, HI and forced flags (explicit flags or keywords in the commentary), contributors and uploader id.
5. Episodes: parse season and episode out of the release strings; accept when season equals and (episode unknown, meaning pack, or equal).
6. Download: GET subtitles/{id}/download (API key as query); body must be a zip; pick via the shared archive helper (episode number for packs). Archive responses are cached 15 minutes. A non-zip body yields empty content.

**Query capabilities**: imdb id, title text, season, episode. No hash.

**Limits and errors**
1. 400: API throttled ("invalid request parameters"). 401: authentication error. 403: forbidden (override 15 minutes). 429: too many requests (override 1 hour).
2. 429 handling: the server states reset time in headers (an absolute timestamp) or in the body as seconds; if the wait is at most 60 seconds, sleep and retry once; otherwise raise.
3. Connection errors: retry 3 times with 5 seconds.

**Metadata and matching**
1. Identity style: episodes: series and series_imdb_id (plus episode for packs); movies: title and imdb_id; release parsing adds the rest.
2. Hash false; HI-verifiable true.

**Language quirks**
1. English language names via converter: "Farsi_persian" for Persian, "Brazilian_portuguese", "Chinese_bg_code" (all Chinese; no simplified/traditional), "Espranto" (spelling), "Northen Sami". Unsupported names (Asturian, Dari, Montenegrin, Odia and more) are commented out as unmapped.
2. The reverse mapping resolves Persian to the "per" code.

**Anti-bot**: none (API). Previously the website blocked scrapers, hence the API.

**Other quirks**: the commentary field is the only source of HI/forced when explicit flags are absent; keep the keyword lists (HI: sdh, hi, cc, closed caption and decorated forms; non-HI override: "non hi", "hi remove" and similar; forced: forced, foreign).

---

### 2.14 YIFY Subtitles (id: yifysubtitles)

**Settings and auth**: none.

**Flow (scraper, movies only)**
1. Skip videos without an imdb id or that are episodes.
2. GET /movie-imdb/{imdb id} with no redirect following and a referer. 404 means no subtitles. Any other non-200 (redirect) also means no subtitles. Other errors raise.
3. Parse the table of subtitles: columns are rating, language (English name), release link, HI marker, uploader. Each row yields a record; exceptions per row are swallowed.
4. Sort by rating descending.
5. Download: GET the subtitle page (cached by hash of the page link), find the "download" anchor, GET it, require a zip, scan the entries for ".srt" or ".sub", take the first valid one.

**Query capabilities**: imdb id only. Languages filtered client-side.

**Limits**: none; HTTP errors propagate.

**Metadata and matching**
1. Always adds imdb_id (identity); release parsing of the release string with the video's hints.
2. Rating is carried for ordering. HI verifiable true (a marker exists).

**Language quirks**: about 38 English names; Portuguese Brazil is "Brazilian Portuguese"; "Farsi/Persian"; Chinese. HI variants are declared. No forced.

**Anti-bot**: browser-like header set with random user agent and "do not track". No CAPTCHA solver.

**Other quirks**
1. The row release text begins with the word "subtitle" and a newline, which is stripped; multi-line releases are joined with commas.
2. Row parsing failures are silent; add logging in Media-Tron.
3. SSA/ASS entries inside the zip are not accepted (only srt and sub).

---

### 2.15 Embedded Subtitles (id: embeddedsubtitles)

A local provider: it lists the subtitle streams already inside the video container and extracts them.

**Settings**
1. included codecs (default: ass, subrip, webvtt, mov_text; others rejected with a warning).
2. cache directory (scratch for extracted files); ffprobe and ffmpeg paths; extraction timeout (default 600 seconds).
3. hi fallback (default off): if the only subtitle in a language is HI, treat it as non-HI; likewise if all are HI.
4. unknown-as-fallback and fallback language (default "en"): streams with no language tag get the fallback language.

**Flow**
1. initialize creates the scratch directory. terminate deletes it.
2. list: ignore videos whose file does not exist or that previously failed probing (a process-level block list). Probe the container (ffprobe) once per path (memoised) and read all subtitle streams.
3. Filter: drop streams whose codec is not allowed. A stream with only a fallback language is dropped if another stream already exists with the same language and disposition.
4. Rebuild each stream's language with its forced and HI flags from the container's disposition. For Chinese streams, refine the variant: the container's language tag (hant, tw, hk, mo mean Traditional; hans, cn, sg mean Simplified) first, then keywords in the track title (big5, traditional, simplified, localised words).
5. Discard probably incomplete tracks: if the highest frame count among streams is known, drop non-forced streams with fewer than one third of that count.
6. Optional HI fallback (rule above).
7. Keep streams whose language is in the wanted set. Forced logic: if every wanted language is forced, keep only forced streams; accept generic or HI streams normally; accept forced streams only if forced is among the wanted flavours.
8. Each stream becomes a record: id is "{container path}_{stream index}", release info is "{video file name without extension}.{stream suffix}", extra release info holds a duration string from the track tag (fall back through language-suffixed tags, then the container).
9. Download: on first use per container, extract all permitted streams to the scratch directory with ffmpeg (names are an MD5 of the path plus extension; fallback to convert when copy fails), then read the one the record points to. A failed extraction raises an extraction error which the framework turns into a blacklist entry for that record.

**Capabilities**
1. Hash claim: matches always include hash (the subtitle is literally in the file). Hash-verifiable false in the capability flags, but the flag is added anyway so scoring ranks embedded tracks at the top. HI-verifiable true.
2. Languages: all two-letter languages the code table knows plus Portuguese-Brazil, Spanish-Mexico and Chinese-Taiwan, each with HI and forced variants.
3. Both episodes and movies.

**Limits**: none (local). Be mindful of CPU/disk: do the extraction once per file.

**Language quirks**: tag languages arrive in three-letter or two-letter forms and are normalised; unknown tags can be mapped by the fallback setting.

**Anti-bot**: n/a.

**Other quirks**
1. Image-based subtitle codecs (PGS, VobSub) are excluded by the codec list; OCR is out of scope.
2. Memoisation of the probe is process-wide (up to thousands of entries).
3. Multiple same-language streams are all returned; the user's scoring or the HI/forced rules decide.

---

### 2.16 Whisper AI (id: whisperai)

Generates subtitles by transcribing the audio with a user-run Whisper-compatible web service. It is the provider of last resort.

**Settings (all mandatory except where noted)**
1. endpoint (base URL of the web service; trailing slash removed), connection/response timeout, transcription timeout, ffmpeg path, ffprobe path (optional; defaults beside ffmpeg), pass-video-name flag (send the file path in the request), log level.
2. Missing any mandatory value raises a configuration error.

**Flow**
1. One record per wanted language, created without any network call. Record id is built from the video's original name, the task and the language (so several languages do not collide in the pool).
2. Decide the task: "transcribe" if the audio language equals the wanted language; "translate" otherwise; "error" if no audio language can be determined.
3. Audio language logic:
   - If the container has no audio language tags: extract audio and call the service's language detection endpoint; use the result (undetermined means an error record).
   - If tags exist: map them (Swiss German to German; undetermined to English). If the wanted language equals one of them, use it, and when several audio tracks exist remember which tag to select. If none equals the wanted language, translate from the first tag.
   - If any original tag is an ambiguous code (language families, "multiple", "undetermined", "sign languages", "no linguistic content", "miscellaneous", "artificial"), force a detection call and use its result.
4. Translation is only supported into English. A "translate" task for any other target language yields no record.
5. Release info reads like "transcribe English audio to English SRT".
6. Download: extract the chosen audio stream to mono 16 kHz 16-bit PCM using ffmpeg, compensating for audio start delay (probe the first packet's timestamp over a 30 second window; delays over 20 ms are corrected by prepending silence or trimming), and choosing the stream by language tag (ISO 639-2 spelling for ffmpeg; the first matching audio stream; else the first audio stream). POST the audio to the service's ASR endpoint with task, language (two-letter), output format srt and optionally the file path. The response body is the SRT.
7. If the audio language has no two-letter Whisper code: treat as English when the output is English, otherwise give up.

**Capabilities**
1. Languages: the ~100 languages Whisper supports (unmappable ones are skipped). Both video types. Forced and HI are not offered.
2. Matches: episodes add series, season, episode; movies add title. Nothing else. Hash-verifiable false.
3. Because the match set is small the score is low; Whisper is meant to win only when nothing else exists.

**Limits**
1. Time: transcription can run for many minutes; two timeouts: connect/response and transcription.
2. Connection errors are throttled for 5 minutes (override).
3. Audio extraction is memoised for the last two files (large buffers held in memory; Media-Tron should stream to the service instead of holding the whole WAV).

**Anti-bot**: n/a.

**Other quirks**
1. A failed ffmpeg run yields empty content and a log line, not a throttle.
2. Language detection results are memoised per file.
3. The service API follows the common open-source Whisper web service shape (asr and detect-language endpoints); confirm the target service in Open questions Q6.

---

### 2.17 BSPlayer (id: bsplayer)

**Status in the snapshot: disabled.** The list step returns nothing and the login and subdomain discovery at initialisation are commented out ("to prevent usage of this provider"). The rest of the code documents the protocol as it worked before.

**Settings and auth**: none (anonymous login with empty username and password and a fixed application id string).

**Historical flow (for reference only; do not implement as active)**
1. Discover a working API host: try up to 8 randomly ordered hosts from a fixed pool of 17 sub-domains, with 3 second timeouts.
2. SOAP/XML calls: logIn returns a token; searchSubtitles sends token, movie hash, file size, comma-joined language ids (the OpenSubtitles-style 3-letter codes), and imdb id ("*" if unknown); logOut at terminate.
3. A fixed 8 second sleep before every search (search throttle).
4. Each result item: id, download link, language, name, format. Download: GET the link with an old-browser user agent; a body of "500" means server error; the payload is gzip.
5. Retry policy: 5 attempts; on login failure re-discover a host; exhausted attempts raise "too many requests".

**Matching (historical)**: hash (always asserted), title/year (movie), title/series/season/episode/year (episode), plus parse of the file name. Hash-verifiable true.

**Languages**: Portuguese-Brazil plus 23 base languages (Arabic, Bulgarian, Czech, Danish, German, Greek, English, Finnish, French, Hungarian, Italian, Japanese, Korean, Dutch, Polish, Portuguese, Romanian, Russian, Spanish, Swedish, Turkish, Ukrainian, Chinese).

**Recommendation**: ship as a registered but disabled provider (always returns empty, never touches the network). Revisit only if the service is confirmed alive. See Q5.

---

### 2.18 TVSubtitles (id: tvsubtitles)

**Settings and auth**: none. Random browser user agent.

**Flow (scraper, episodes only; HTTP not HTTPS in the original)**
1. Resolve show id: POST the search form with the series name; parse suggestion links of the form "/tvshow-{id}.html" whose text looks like "Series (YYYY-YYYY)" with optional extra year or (US)/(UK) marker. Accept when the sanitised series name equals the wanted name (case-insensitive) and, if the video has a year, the first-air year equals it. Cached one week.
2. GET the season page: tvshow-{show id}-{season}.html; rows with episode links give a map from episode number (from the "SxE" text) to episode id. Cached for the episode expiry period.
3. For multi-episode videos use the smallest episode number. If the episode is not in the map, log and return empty.
4. GET episode-{episode id}.html and parse every subtitle block: language flag image (a two-letter-ish code with quirks), subtitle id, rip text, release text.
5. Filter by requested languages and episode equality. Titles tried in order: series then alternatives.
6. Download: GET download-{id}.html; the real link is assembled from several short strings in the page's script (the "s1=...", "s2=..." assignments joined together); GET that to receive a zip; require exactly one file inside, else provider error.

**Metadata and matching**
1. Text style: series (sanitised, alternatives), season, episode, year (original series without year or equal), release group via equivalence, plus release parse of the release and the rip fields, both in partial mode. Release info is "rip, release".
2. Hash false; HI not available.

**Language quirks**: site flag codes differ: br is Portuguese-Brazil, ua is Ukrainian, gr is Greek, cn is Chinese, jp is Japanese, cz is Czech; others use the two-letter code. Declared: Portuguese-Brazil plus 23 base languages (same list as BSPlayer).

**Limits**: undocumented; HTTP errors propagate. Season page fetch does not call raise-for-status (silent failure possible).

**Anti-bot**: none; random user agent.

**Other quirks**
1. The upstream "forced off" list includes it.
2. The download-link assembly depends on the script layout; add a parse-failure error ("cannot get download link") so layout changes surface.

---

### 2.19 Subtitulamos.tv (id: subtitulamostv)

**Settings and auth**: none (user agent from the environment or "Sub-Zero/2").

**Flow (JSON search plus HTML pages; episodes only)**
1. GET /search/query with the series name; JSON list of shows with names and ids. Consider only shows whose name equals the series name case-insensitively (no alternatives).
2. GET /shows/{id}; find the season in the season chooser; if not selected, follow its link. Same for the episode chooser. If either is missing, skip the show.
3. On the episode page, for each language container read the language name: contains "English" gives English; contains "Español" gives Spanish; others are skipped.
4. Each version block gives a release name and a download link; blocks without a download link (incomplete translations) are skipped.
5. Download: GET the link; force the response encoding to Latin-1 for decoding assumptions; use the bytes with line endings normalised; empty body leaves content empty.

**Metadata and matching**
1. Identity style: series, season, episode, year, title always asserted. Release group added if the video's group appears in the version text; plus release parse.
2. Hash false (explicitly not verifiable). HI false.

**Language quirks**: English and Spanish only; no Latin American Spanish distinction.

**Limits**: undocumented; 10 second timeouts; HTTP errors propagate.

**Anti-bot**: none.

**Other quirks**
1. Up to four sequential requests per search; cache show and season pages in Media-Tron.
2. The id of a record is its download link.
3. The Latin-1 forcing is a workaround for the site's wrong header; preserve behaviour only if bytes verify as Latin-1 text, else try UTF-8 (a safer improvement).

---

### 2.20 Napiprojekt (id: napiprojekt)

Polish subtitles by file hash, with an optional scraper for authored subtitles.

**Settings and auth**: three flags: hash only, only authors (skip anonymous or machine-made), only real names (author field must look like a human name). No credentials (the API takes empty user and password fields).

**Flow (hash path)**
1. Compute the Napiprojekt hash (MD5 of first 10 MiB; files over 10 MiB only).
2. GET the dl endpoint with parameters: version tag "dreambox", queue off, empty nick and pass, os "Linux", language (two-letter, upper case), file hash, and a derived second hash. The derived hash is a short checksum computed from the file hash with a fixed digit-weighting scheme (a few arithmetic steps over the hex digits; reproduce from the original algorithm in the base library, listed as an open item in Q7 because it is not restated here).
3. Response: if it begins with four bytes "NPc0", there is no subtitle. Otherwise the body is the subtitle text (the content is returned in the same request; download does nothing if content is present, else repeats the query).
4. Retried 3 times with 15 seconds between tries on non-fatal errors.

**Flow (scrape path; used unless hash-only)**
1. Only for Polish.
2. Find the site's title slug: POST the catalogue search with title, kind (episode 1, movie 2) and year. If the video has an imdb id, prefer the result block that links to that imdb title (asserts series/title, year, imdb id). Otherwise take the first title link, comparing normalised title to the video's title (title/series match) and asserting year if the video has one.
3. GET the listing page for that slug (with season-episode suffix for episodes). Each row has a hash link ("napiprojekt:{hash}"), size, length, author, added date, and hover text with resolution and fps. Author may be extracted from the hover text.
4. Apply author filters: "only authors" drops authors named none/auto/AI/robot/machine translation and similar words; "only real names" requires two capitalised words or an uppercase-initial pattern.
5. Each row becomes a record: id is the hash; release info reads "Autor: ... | resolution | fps | size | added | length"; matches from the title lookup plus season and episode for episodes.
6. Download: re-query by hash (as above).

**Matching**: hash if the video's napiprojekt hash equals; otherwise the identity flags from the title lookup.

**Capabilities**: Polish only. Both types. Hash-verifiable true for the hash path.

**Limits**: undocumented; retried calls only on non-fatal errors.

**Anti-bot**: none observed.

**Other quirks**
1. Hash path is skipped when only-authors or only-real-names is on and hash-only is off (the scrape path serves instead).
2. The scrape path uses regexes on hover text with Polish labels ("Autor", "Video rozdzielczość", "Video FPS"); layout changes break it silently.
3. Napiprojekt is in the upstream forced-off list.

---

### 2.21 Subtitlecat (id: subtitlecat) - optional extra

Not in the required 20, but it is part of the Subscene-like discussion (2.13) and is a registered upstream provider, so its behaviour is recorded briefly.

1. Settings: include machine-translated (default off). No credentials.
2. Flow: build up to three titles (primary plus alternatives). Search string is "Title SxxEyy" for episodes with season and episode, "Title Year" for movies. GET the site search page; parse a results table of releases with a "translated from X" annotation. Keep candidates whose guessed season/episode/year agree with the video and whose title overlaps at least half of the wanted words; stop at the first title that matches; otherwise fall back to the primary search's raw results. If machine translation is excluded, drop releases whose source language is not among the wanted ones. Take at most 5 candidates and fetch each detail page (15 second timeout).
3. Detail page: each language block has a download anchor whose id carries the two-letter language code. Languages whose code differs from the source language are machine translated (indistinguishable otherwise); skip them unless allowed; flag them in release info as "[machine translated]".
4. Download: GET the link; 404 is empty; the body is normalised.
5. Matching: release-parse in partial mode only; no identity flags. About 90 languages.
6. Anti-bot: random agent. No quotas known.

---

## 3. Comparison table

Legend: Auth: K = API key, U = username/password, C = cookies, T = token cache, - = none. Search keys: H = file hash, I = imdb, V = tvdb, A = anidb/anilist, T = title text, S/E = season/episode. Types: E = episode, M = movie. Flavours: F = forced declared, HI = HI declared. Style: ID = identity, TX = text, RL = release parse, HS = hash.

| Provider | Auth | Search keys | Types | Download | Forced | HI | Hash-verif | Style | Notable limit |
|---|---|---|---|---|---|---|---|---|---|
| OpenSubtitles.com | K + U + T (12h) | H, I, T, S/E | E, M | JSON then link | F | HI | yes | HS+ID+RL | daily quota (406); 429 |
| Subdl | K | I, tmdb, T, S/E | E, M | zip/rar, direct | F | HI | no | ID/TX+RL | daily quota; 2 pages |
| Addic7ed | U or C | T (show id), S/E | E, M | direct file | - | HI | no | TX+RL | 40 or 80 per day; captcha |
| Podnapisi | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | not present upstream |
| Gestdown | - | V, S/E | E | direct file | - | HI | no | ID+RL | 423 retry x3 |
| Subf2m | UA | T, I (verify) | E, M | zip/rar | - | no | no | ID+RL | scraper, 403 blocks |
| Napisy24 | U (optional) | H, size, name | E, M | in response | - | - | yes | HS | quota unknown |
| Animetosho | - | A (anidb ep) | E | xz | F | - | no | ID+RL | 1+N requests |
| Jimaku | K | A, T, episode | E, M | file or archive | - | - | no | ID+RL | 429 backoff x3 |
| Titlovi | U + T | T, I, S | E, M | zip/rar | - | - | no | TX+RL | 429 (5 min); CF |
| LegendasDivx | U + cookies | T, I, S/E | E, M | rar/zip | - | - | no | TX+RL | 145 searches/day; CF |
| SuperSubtitles | - | T, S/E | E, M | zip or file | F | - | no | TX+ID+RL | none known |
| SubSource (Subscene-like) | K | I, T, S/E | E, M | zip | F | HI | no | ID+RL | rate windows; 1 lang/call |
| YIFY | - | I | M | zip | - | HI | no | ID+RL | scraper |
| Embedded | - | local file | E, M | ffmpeg extract | F | HI | claimed | HS | CPU/disk |
| Whisper AI | endpoint | local audio | E, M | ASR service | - | - | no | ID (weak) | minutes per file |
| BSPlayer | (anonymous) | H, I | E, M | gzip | - | - | yes (historic) | HS | disabled upstream |
| TVSubtitles | - | T, S/E | E | zip (1 file) | - | - | no | TX+RL | scraper |
| Subtitulamos.tv | - | T, S/E | E | direct file | - | - | no | ID+RL | 4 requests/search |
| Napiprojekt | flags | H, T, S/E | E, M | in response | - | - | yes | HS+ID | undocumented |

Default throttles apply except where section 1.7 overrides.

---

## 4. Implementation notes for the TypeScript port

1. Model the Record as an immutable data object plus a content buffer slot; keep forced and HI inside the language type.
2. Put the throttling table, strike counter and persistence in the host, not in providers; providers only throw typed errors.
3. Make the "protected session" (Cloudflare-aware, cookie caching, CAPTCHA pitcher) a host-supplied dependency; Titlovi, LegendasDivx and Addic7ed require it.
4. Treat the per-site scrapers as fragile: each should ship fixtures of real pages (saved HTML or JSON) and contract tests that fail loudly with a parse-response error instead of returning empty results silently.
5. Do not copy upstream defects flagged above: OpenSubtitles retry result dropped, Jimaku endless 429 loop, LegendasDivx accumulating language filter and undefined frame rate, SuperSubtitles single-title return, Addic7ed raising after a successful download, SubSource single language per call, Subf2m ordinal-season cap, mutation of the video object in Jimaku.
6. Mark the following providers as lowest risk to build first: OpenSubtitles.com, Subdl, Gestdown, Animetosho, Embedded; highest operational risk: Addic7ed, LegendasDivx, Titlovi, Subf2m (anti-bot).
7. Suggested provider configuration schema keys (names only; values are the user's): opensubtitlescom.username, password, apiKey, useHash, includeAiTranslated, includeMachineTranslated; subdl.apiKey, aiTranslate, includeAiTranslated; addic7ed.username, password, cookies, userAgent, vip; subf2m.userAgent, verifySsl; napisy24.username, password; animetosho.searchThreshold; jimaku.apiKey, nameSearchFallback, archives, aiSubs; titlovi.username, password; legendasdivx.username, password, skipWrongFps; subsource.apiKey; embeddedsubtitles.includedCodecs, hiFallback, timeout, unknownAsFallback, fallbackLang; whisperai.endpoint, responseTimeout, transcribeTimeout, passVideoName, logLevel; napiprojekt.hashOnly, onlyAuthors, onlyRealNames; subtitlecat.includeMachineTranslated.

---

## 5. Open questions

1. Q1 Podnapisi: no source in this snapshot, and upstream states the provider no longer exists. Is there a current replacement API, or should the roadmap item be dropped? Until answered, nothing about its endpoints, auth or quotas is specified.
2. Q2 Subscene: the original site is absent. We chose SubSource as the stand-in. Confirm that is acceptable, or provide a reference for another successor.
3. Q3 OpenSubtitles.com application key: Media-Tron needs its own registered application key. Who owns that registration, and where is it stored?
4. Q4 Napisy24 fallback credentials: upstream uses a built-in account when users supply none. Not reproduced here. Decide: require user credentials, or negotiate a shared account.
5. Q5 BSPlayer: disabled upstream. Is the service alive? If yes, a protocol re-verification is needed; if no, ship as a stub.
6. Q6 Whisper: which web service shape is the target (the common open-source one with asr and detect-language endpoints)? Are other backends (cloud APIs) in scope? Output formats other than SRT?
7. Q7 Napiprojekt derived hash: the second hash parameter is computed by a small fixed algorithm in the base library; its exact arithmetic is not restated in this spec and must be taken from the original description (or captured from live traffic) before implementation.
8. Q8 Quotas not documented in code: Napisy24, Gestdown, Subf2m, YIFY, TVSubtitles, SuperSubtitles, Subtitulamos, Napiprojekt. We have no measured limits; these need empirical testing before choosing polite request rates.
9. Q9 Exact episode-hash weights and the Addic7ed boost: this spec states the consumed weights; confirm they belong in the scoring spec rather than here.
10. Q10 Per-language code tables: Subdl, OpenSubtitles.com and Subtitlecat language lists are large; the full wire-code tables should be generated from live service metadata rather than hand-typed.
11. Q11 Multi-episode files and absolute numbering: only Subdl, Jimaku and TVSubtitles have explicit rules; others use the smallest episode. Confirm the desired behaviour for double-episode files.
12. Q12 Cloudflare and CAPTCHA strategy for the "protected session": build in-house, require an external solver, or decline to support those providers?
13. Q13 Legal and terms-of-service review for scraper providers (Addic7ed, Subf2m, YIFY, TVSubtitles, SuperSubtitles, LegendasDivx, Subtitulamos, Subtitlecat) before shipping.
