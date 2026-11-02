# Changelog

All notable changes to Arclight are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases are tagged `vX.Y.Z`.
Each release is a container image at `ghcr.io/zacabrewer/arclight`.

The Jellyfin plugin has its own version numbers; see [Arclight for Jellyfin](#arclight-for-jellyfin-plugin)
at the end of this file.

## [Unreleased]

### Changed
- The companion app is now called Arclight Admin (app ID `com.moviemethat.arclight.admin`). The name Arclight and the ID `com.moviemethat.arclight` go to a separate player app. Neither app is in the stores yet.
- Pairing QR codes now use `arclight-admin://pair?url=...`. Arclight Admin still reads older `arclight://pair` codes when you scan them inside the app.
- Phones report which app registered them. The server stores this and sends it to the push relay, which uses it to pick the right APNs topic. The relay accepts a list of topics in `APNS_TOPICS`. Registrations without an app ID go to Arclight Admin.

## [0.21.0] - 2026-11-02

### Added
- Built-in player (preview): a new `/player` portal that plays your music and audiobooks in the browser. It is off until an admin turns it on under Settings > Player, and each user needs access on their Users > Player tab. Movies, TV and podcasts are planned for later.
- Music browsing: albums, artists and playlists with filters, sorting and genre and letter jumps, plus search across music and audiobooks.
- Audiobooks: chapters, resume across devices, speed from 0.5x to 3.5x remembered per book, bookmarks with notes, and a sleep timer.
- Queue, mini-player and Now playing with shuffle, repeat, gapless playback and ReplayGain volume levelling. Keyboard shortcuts and media-key and lock-screen controls are included.
- Direct play where possible, with live transcoding when a file is above the bitrate limit. A format badge shows which one is in use.
- Remote streaming is off by default. Admins can allow it, set a remote bitrate cap and choose how long stream links last, and can set remote access and a bitrate cap per user.
- Jellyfin playback engine for the built-in player: under Settings > Player > Playback engine, admins can let a Jellyfin or Emby server stream and convert the audio. Arclight still checks access, limits and links first, and keeps the API key on the server. Files Jellyfin does not have play with Arclight's own engine, and the format badge shows "via Jellyfin" when Jellyfin is in use.

## [0.20.1] - 2026-11-02

### Fixed
- Phone top bar: on narrow screens the header now shows the Arclight mark instead of the full wordmark, so search, the command menu, the issue count and your avatar all fit without being cut off.

## [0.20.0] - 2026-11-02

### Added
- Season packs: Arclight understands multi-season, complete-series, partial-season, episode-range and anime batch releases, prefers packs that cover more of what you want, and imports only the episodes you want from a pack. Size limits are per episode, and interactive search shows what a pack covers.
- Archive unpacking: finished torrent downloads that only hold RAR, 7z or zip archives are unpacked before import. The archives stay for seeding. The queue shows the unpack progress.
- Fake-release and malware filter: downloads with executables, blocked file types, encrypted archives, no media file or a video too small to be real are removed, blocklisted with the reason and searched again. A new "Download rejected (unsafe)" notification tells you when it happens.
- Import lists: many new sources (TMDB companies, networks and discover, Trakt lists and charts, IMDb Top Rated, Letterboxd, MDBList, AniList, MyAnimeList, Kitsu, Simkl, Jellyfin and Emby favourites, and your own JSON or CSV URLs). Each list has its own sync interval, rating, vote and year filters, a "skip if on my streaming services" rule, a preview and an optional clean-up for titles that leave the list.
- Notifications: 18 new services, including Slack, Microsoft Teams, Matrix, Signal, Home Assistant, MQTT, Twilio and Apprise, and a more flexible webhook. Each connection can be filtered by media kind, quality and user, and each event can have its own message template with a live preview. Failed sends are retried, and a delivery log shows the last error.
- Personal notifications: every user, including request portal users, can add their own destinations and choose their own events.
- Plex watch history: Plex users, watch history and live playback (webhook or session polling) sync like Jellyfin and Emby.
- Playback stats: per-user and server-wide stats with watch time, top titles and genres, devices, direct play versus transcode and a weekday-by-hour chart. Users see their own under Profile > My stats.
- Year in review, as an image, with expiring share links you can revoke.
- An optional weekly "recently added" newsletter by email.
- Smart collections: rule-based collections (genre, years, studio, network, lists, rating, recently added, watch status) synced to Jellyfin and Emby, plus a Leaving Soon collection for titles your clean-up rules will remove.
- Single sign-on with OpenID Connect providers such as Authentik, Authelia, Keycloak, Pocket ID, Google or Microsoft, with account linking, automatic accounts and group-to-role mapping.
- Two-factor sign-in for local accounts (authenticator app with recovery codes) and passkeys, including passwordless sign-in with a passkey.
- Personal API keys for every user, with read, requests or admin scope, an expiry date and revoke.
- Sign-in through a trusted reverse proxy (forward-auth), off by default.
- Arclight can be served under a sub-path such as `/arclight` with `ARCLIGHT_BASE_PATH`.
- Podcasts (preview, off by default): subscribe by search, RSS link or Apple Podcasts link, import and export OPML, download episodes automatically with keep and clean-up rules, see episodes on the calendar and get new-episode notifications. Users can request podcasts in the portal.
- Ebooks and comics (preview, off by default): a Books section with metadata from several sources, monitoring by author, series or book, comic series with new-issue tracking, search through your indexers, format profiles, import and rename, calendar entries and requests. Kavita, Komga, Audiobookshelf and Calibre-Web can be refreshed after an import.
- Music: edition preferences (original, deluxe, remaster and more), per-track wanted, single-file albums with cue sheets, optional tag writing with cover art and ReplayGain, artist bios, an optional Soulseek source through your own slskd, and playlists from Spotify, Deezer, ListenBrainz and Last.fm that can be pushed to Jellyfin, Emby, Plex and Navidrome.

### Changed
- Recommended for you in the Jellyfin plugin also uses your Plex watch history when your own Plex token is set in your request settings.
- Stall recovery no longer removes private-tracker torrents that are still inside a hit-and-run window.
- The settings menu scrolls on its own on short windows, so every page (down to Updates) can be reached.
- The web and mobile apps use the Light Slice wordmark (the logo with the line through it). Small places keep the arrows-only mark.
- Arclight now advertises Jellyfin plugin 1.3.0.

## [0.19.0] - 2026-11-01

### Added
- Jellyfin plugin API: title details with cast, crew, creators, trailer, seasons and recommendations.
- Every Discover category for the plugin, including Recommended from your watch history, plus genre list and genre browse endpoints.

### Changed
- A series with only some seasons requested stays requestable for the rest.
- Arclight now advertises Jellyfin plugin 1.2.0.

## [0.18.2] - 2026-11-01

### Fixed
- Phone notifications no longer drop a retry when the push relay asks Arclight to slow down under load.

## [0.18.1] - 2026-11-01

### Added
- Startup intro in the companion app, with settings to turn the intro and its sound off. It plays on a cold start only, can be skipped, and respects reduced motion.
- Arclight intro videos (1080p and 720p) for Jellyfin Cinema Mode.

### Changed
- The plugin's Coming soon list leaves out releases that already have a file, and lists a movie once, at its next release.

## [0.18.0] - 2026-11-01

### Added
- Jellyfin watch history sync. Jellyfin stays the source; Arclight only reads. Per-user history, a catch-up sync every 10 minutes, live events from the plugin and an hourly user sync (new, renamed, disabled and deleted accounts).
- Optional per-server setting to mirror Jellyfin parental controls into Arclight content limits.
- Watch history page, history on profiles, a "Watched by" tab and Now playing.
- Retention rules based on who requested a title. Episode favourites count for their series on the watchlist.
- Arclight for Jellyfin, a plugin for Jellyfin 12.x and 10.11: request and browse Discover inside Jellyfin, status badges, watchlist, issues, subtitle and audio language requests, Coming soon, Also on, My requests, quality labels and opt-in themes. It is installed from a plugin repository at `https://arclight.moviemethat.com/jellyfin/manifest.json`.
- Plugin API under `/api/v1/jellyfin/` with its own plugin keys. Every per-user call acts as the linked Arclight account, so content limits, permissions, request types and quotas still apply.

## [0.17.3] - 2026-11-01

### Fixed
- Request portal header on phones: account actions move behind one menu button so the logo and title fit on one line.
- Poster card titles break between words only, and the year moves under the title on narrow cards.

## [0.17.2] - 2026-11-01

### Fixed
- Lists and the queue were unreadable on phones. Below 768 px tables now turn into cards, with the title on top and the other columns as small label and value pairs.
- Page header buttons get their own row on phones.

## [0.17.1] - 2026-10-31

### Fixed
- The Android app build failed to compile.

## [0.17.0] - 2026-10-31

### Added
- Arclight companion app for iOS and Android (Capacitor). Add your server by address or QR code, use several servers, biometric lock, share sheet "Request in Arclight". It shows your server's own web interface, so new server features need no app update.
- Mobile push notifications. Every web push notification also reaches your phones through a push relay that holds the Apple and Google credentials, so a self-hosted server needs none. The relay stores no notification content.
- Profile > Mobile app: pairing QR code and device list.
- Optional environment variables `ARCLIGHT_PUSH_RELAY_URL` and `ARCLIGHT_PUSH_RELAY=off`.

## [0.16.0] - 2026-10-31

### Added
- New brand: a double-chevron mark and Arclight lockups. The web app's icons, favicons and offline page use it.
- Public website at arclight.moviemethat.com with the full documentation, local search, a support page and legal pages. No cookies, analytics or third-party requests.
- TMDB attribution on System > Status and in the request portal footer.
- Launch checklists for the App Store and Google Play.

### Changed
- The FAQ no longer says Arclight lacks music and book management.

## [0.15.0] - 2026-10-31

### Added
- Per-user request type switches: movies, series, music, audiobooks, subtitles and audio languages. A switch that is off denies that type even if the permission allows it.
- Settings > Requests: default request types for new users, including accounts from media servers and Seerr.

## [0.14.1] - 2026-10-31

### Changed
- The tunnel guard now holds a learned safe rate instead of letting go once limits were well above use, so a VPN tunnel no longer saws between full and choked.

## [0.14.0] - 2026-10-30

### Added
- Built-in engine disk guard (on by default): lowers the download limit to what the disk can actually write while the write backlog builds.
- Magnet metadata timeout: a magnet nobody serves fails so Arclight can try another release.
- Maximum active hash checks setting.

### Changed
- Safer restarts: resume data is saved shortly after new pieces verify, and a restart after a crash re-hashes only half-written pieces.
- Compose files set `stop_grace_period: 30s`.

### Fixed
- A torrent the download client already has now counts as added instead of failing and being retried every minute (qBittorrent, Transmission, Deluge, rTorrent).
- A client that refuses one release no longer parks all grabs; the next release is tried.
- A 30-minute cool-down stops the same release being sent again straight after a replace or removal.
- Remove Completed only removes downloads Arclight grabbed.

## [0.13.3] - 2026-10-30

### Changed
- The tunnel guard also halves the peer connection cap and closes the slowest peers when a VPN tunnel chokes.
- The engine's block cache has one overall memory budget instead of 32 MiB per downloading torrent.

## [0.13.2] - 2026-10-30

### Fixed
- E-AC-3 transcodes asking for 7.1 now write 5.1, which is the most E-AC-3 holds.
- A failed ffmpeg job's message starts with the line that names the cause.

## [0.13.1] - 2026-10-30

### Security
- Updated dependencies to close all open Dependabot alerts (`@fastify/static`, `drizzle-orm`, `vitest`, `esbuild`).

## [0.13.0] - 2026-10-30

### Added
- Settings > Transcode tests each hardware backend with a real one-frame encode and shows why one is unavailable.
- "Fall back to software" setting for transcode jobs whose hardware start fails.
- Hardware transcoding guide.

### Changed
- The Docker image uses Jellyfin's ffmpeg, so Intel Quick Sync and VA-API (and NVIDIA NVENC) work when the GPU is passed to the container.
- The entrypoint adds the app user to the groups that own the GPU devices.

### Fixed
- Links from the app to the documentation and from health checks now land on the right entry.

## [0.12.0] - 2026-10-30

### Added
- Subtitle and audio language requests in the request portal, for titles already in the library.
- Wanted: Released, Upcoming and All filter, and a release date range on every list.
- Settings for searching unreleased items (user-started only) and a grace period after release.

### Changed
- Automatic searches never pick up unreleased items.

### Fixed
- An additional subtitle language that no provider answered for was recorded as present instead of not found.

## [0.11.0] - 2026-10-30

### Added
- Library health scan: finds missing, empty, corrupt, truncated and sample files, wrong audio language, album track gaps and audiobook part order. Runs weekly by default and throttled.
- Tags page (usage, rename, merge, delete) and tag rules with conditions, templates, dry-run previews and daily runs.
- Command palette actions, such as upgrade a title, pause all, run a task or switch theme.
- Universal search in the top bar across the library, settings, activity, requests, system, docs and Discover.
- Text search on every list in activity, wanted, requests, issues, system and settings.

## [0.10.1] - 2026-10-30

### Fixed
- The bulk Actions menu opens on every theme.

## [0.10.0] - 2026-10-29

### Added
- Bulk select and actions on every list.
- Interactive search filters (title, quality, indexer, protocol, size, seeders, decision).
- Indexer health table: failure rate, response times, results per query and last error.

### Changed
- "Grab anyway" is remembered on the imported file, and automatic upgrades pause for it until you choose "Allow upgrades again".
- Tooltips render on the page body, so modals and tables no longer clip them.

## [0.9.1] - 2026-10-29

### Added
- Theme packs can ship background images.

## [0.9.0] - 2026-10-29

### Added
- Import existing music and audiobooks: scan a root folder, match albums and books, and link files in place or move them.
- "Grab anyway" for rejected releases in interactive search, behind a confirmation.

### Changed
- Better audio file reading: composer as narrator, `.wma`, part folders and clearer titles from paths.

### Fixed
- Magnets nobody serves are now re-announced and then replaced.

## [0.8.0] - 2026-10-29

### Added
- Music and audiobook requests in Discover and the request portal, with new permissions to request each.
- Settings > Requests: default root folder and quality profile per media type.

## [0.7.1] - 2026-10-28

### Fixed
- Add buttons wait for a quality profile instead of doing nothing when pressed too early.

## [0.7.0] - 2026-10-28

### Added
- Audiobooks (preview, off by default): authors and books from Audible data, search and grab, import of single `m4b` and multi-part `mp3` books, and Audiobookshelf as a media server.

## [0.6.0] - 2026-10-28

### Added
- Music downloads (preview, off by default): search, grab and import albums, with audio quality profiles and manual import.

## [0.5.0] - 2026-10-28

### Added
- Music library (preview, off by default): artists, albums and tracks from MusicBrainz, monitoring, album editions and a scan of existing music folders. Turn it on in Settings > General > Features.

## [0.4.4] - 2026-10-28

### Fixed
- Removing a series or movie from the library no longer deletes its files or adds an import exclusion unless you ask. Query flags such as `deleteFiles=false` were being read as true.

## [0.4.3] - 2026-10-28

### Fixed
- Activity, Wanted, Subtitles and Library showed the page tabs twice. Only the top navigation remains.

## [0.4.2] - 2026-10-28

### Fixed
- The solver page now knows FlareSolverr does the work in Docker, instead of saying "No browser found".

## [0.4.1] - 2026-10-27

### Added
- Twenty more theme packs.

## [0.4.0] - 2026-10-27

### Added
- Syncable theme packs, chosen per user in Settings > UI or from the request portal. Admins set the default, can lock the choice and control syncing.
- The Sorbet theme.

## [0.3.21] - 2026-10-27

### Fixed
- Self-update works when Arclight runs behind Gluetun.

## [0.3.20] - 2026-10-27

### Fixed
- "Update now" answers within 20 seconds, so a reverse proxy no longer reports a 504 while the update carries on.

## [0.3.19] - 2026-10-27

### Fixed
- No boot loop on a NAS with slow disks. The plugin start timeout is now 5 minutes.

## [0.3.18] - 2026-10-27

### Fixed
- The container starts in seconds instead of minutes. The entrypoint no longer changes ownership of the whole application folder.

## [0.3.17] - 2026-10-27

### Added
- Wanted, Library and Profile mismatch show each item's last search, when the next one is due and its queue state.
- Library > Hygiene: delete all duplicates at once.

### Fixed
- Episodes with an air date but no air time count as aired.
- A failed remove in Activity says why and keeps the dialog open.

## [0.3.16] - 2026-10-27

### Added
- Tunnel guard (on by default with the VPN): measures delay through the tunnel and lowers the engine's rates when it chokes.

### Changed
- Built-in engine traffic is paced so a VPN tunnel is not flooded: limits on new connections and DHT upload, smaller uTP packets and batched small messages.

### Fixed
- One odd torrent no longer makes the whole qBittorrent list fail to parse.

## [0.3.15] - 2026-10-27

### Changed
- Tracker requests are capped at 24 in flight at a time, and dead UDP trackers are given up sooner.

## [0.3.14] - 2026-10-27

### Fixed
- A silent Gluetun in the same network no longer triggers the kill switch.

## [0.3.13] - 2026-10-27

### Changed
- Settings > Torrent Engine names `ARCLIGHT_TORRENT_ENGINE=0` when it keeps the engine from starting.

## [0.3.12] - 2026-10-27

### Fixed
- The torrent engine start at boot cannot be skipped silently after an earlier step fails.

## [0.3.11] - 2026-10-27

### Fixed
- Arclight survives a stalled Gluetun and keeps the last forwarded port.
- The torrent engine heals itself: it re-applies its binding and restarts if it is stuck.

## [0.3.10] - 2026-10-27

### Fixed
- Outgoing connection attempts are limited, so hundreds at once no longer flood a VPN tunnel.

## [0.3.9] - 2026-10-27

### Fixed
- Torrent downloads no longer exhaust memory. Disk writes apply backpressure, and buffers are exactly sized.

## [0.3.8] - 2026-10-26

### Added
- System > Debugging: a redacted debug report, a live snapshot, a read-only console and recent logs.

## [0.3.7] - 2026-10-26

### Fixed
- Cached blocks no longer keep large socket buffers alive.

## [0.3.6] - 2026-10-26

### Fixed
- The built-in engine's memory is bounded. Uploads are served one block at a time and verified pieces leave the cache.

## [0.3.5] - 2026-10-26

### Fixed
- The engine starts without waiting for every torrent to be re-checked.

## [0.3.4] - 2026-10-26

### Fixed
- Two-column form sections line up, and chips wrap only between words.

## [0.3.3] - 2026-10-26

### Fixed
- Importing history keeps the per-episode rows of a season pack.
- The import wizard tells you when the built-in engine is off instead of failing every torrent.

## [0.3.2] - 2026-10-26

### Fixed
- The built-in engine falls back to another port when the forwarded port is already taken.

## [0.3.1] - 2026-10-26

### Fixed
- The entrypoint repairs `/config` permissions on NAS shares and checks that it is writable before starting.

## [0.3.0] - 2026-10-26

### Added
- Portal-only users: the role `user` only gets the request portal.
- Admin lockdown, and the first admin is created at first launch.

## [0.2.0] - 2026-10-26

### Added
- Full stack import wizard for Sonarr, Radarr, Prowlarr, Bazarr, Overseerr or Jellyseerr, and qBittorrent.

## [0.1.0] - 2026-10-26

### Added
- First tagged release.

## Arclight for Jellyfin (plugin)

The plugin is released separately and tagged `jellyfin-plugin-vX.Y.Z`. Its full notes are in
[jellyfin-plugin/CHANGELOG.md](jellyfin-plugin/CHANGELOG.md).

### [Plugin 1.3.0] - 2026-11-02
- A Stats menu with My stats, Year in review and Server stats, and a Leaving Soon row on the Discover page.
- Needs an Arclight release newer than 0.19.0 for these. Older versions keep working without them.

### [Plugin 1.2.0] - 2026-11-01
- Title pages for titles you don't have yet: backdrop, cast, trailer, seasons, "Also on", request status and "More like this".
- A bigger Discover with Recommended for you, Trending, Popular, Top rated, In cinemas now, Upcoming, Airing today and On the air, genre chips and genre pages.
- Needs Arclight newer than 0.18.2 for these. Older versions keep working without them.

### [Plugin 1.1.0] - 2026-11-01
- Coming soon only lists what is not here yet.
- Optional Arclight intro in Cinema Mode before movies.
- New 16:9 catalog image.

### [Plugin 1.0.0] - 2026-11-01
- First release: playback and library events sent to Arclight, and requests, Discover, watchlist, issues, language requests, Coming soon, Also on, My requests, quality labels and opt-in themes inside Jellyfin.

[0.21.0]: https://github.com/ZacABrewer/arclight/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/ZacABrewer/arclight/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/ZacABrewer/arclight/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/ZacABrewer/arclight/compare/v0.18.2...v0.19.0
[0.18.2]: https://github.com/ZacABrewer/arclight/compare/v0.18.1...v0.18.2
[0.18.1]: https://github.com/ZacABrewer/arclight/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/ZacABrewer/arclight/compare/v0.17.3...v0.18.0
[0.17.3]: https://github.com/ZacABrewer/arclight/compare/v0.17.2...v0.17.3
[0.17.2]: https://github.com/ZacABrewer/arclight/compare/v0.17.1...v0.17.2
[0.17.1]: https://github.com/ZacABrewer/arclight/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/ZacABrewer/arclight/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/ZacABrewer/arclight/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/ZacABrewer/arclight/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/ZacABrewer/arclight/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/ZacABrewer/arclight/compare/v0.13.3...v0.14.0
[0.13.3]: https://github.com/ZacABrewer/arclight/compare/v0.13.2...v0.13.3
[0.13.2]: https://github.com/ZacABrewer/arclight/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/ZacABrewer/arclight/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/ZacABrewer/arclight/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/ZacABrewer/arclight/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/ZacABrewer/arclight/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/ZacABrewer/arclight/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/ZacABrewer/arclight/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/ZacABrewer/arclight/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/ZacABrewer/arclight/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/ZacABrewer/arclight/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/ZacABrewer/arclight/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/ZacABrewer/arclight/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/ZacABrewer/arclight/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/ZacABrewer/arclight/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/ZacABrewer/arclight/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/ZacABrewer/arclight/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/ZacABrewer/arclight/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/ZacABrewer/arclight/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ZacABrewer/arclight/compare/v0.3.21...v0.4.0
[0.3.21]: https://github.com/ZacABrewer/arclight/compare/v0.3.20...v0.3.21
[0.3.20]: https://github.com/ZacABrewer/arclight/compare/v0.3.19...v0.3.20
[0.3.19]: https://github.com/ZacABrewer/arclight/compare/v0.3.18...v0.3.19
[0.3.18]: https://github.com/ZacABrewer/arclight/compare/v0.3.17...v0.3.18
[0.3.17]: https://github.com/ZacABrewer/arclight/compare/v0.3.16...v0.3.17
[0.3.16]: https://github.com/ZacABrewer/arclight/compare/v0.3.15...v0.3.16
[0.3.15]: https://github.com/ZacABrewer/arclight/compare/v0.3.14...v0.3.15
[0.3.14]: https://github.com/ZacABrewer/arclight/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/ZacABrewer/arclight/compare/v0.3.12...v0.3.13
[0.3.12]: https://github.com/ZacABrewer/arclight/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/ZacABrewer/arclight/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/ZacABrewer/arclight/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/ZacABrewer/arclight/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/ZacABrewer/arclight/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/ZacABrewer/arclight/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/ZacABrewer/arclight/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/ZacABrewer/arclight/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/ZacABrewer/arclight/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/ZacABrewer/arclight/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/ZacABrewer/arclight/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ZacABrewer/arclight/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ZacABrewer/arclight/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ZacABrewer/arclight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ZacABrewer/arclight/releases/tag/v0.1.0
[Plugin 1.2.0]: https://github.com/ZacABrewer/arclight/releases/tag/jellyfin-plugin-v1.2.0
[Plugin 1.1.0]: https://github.com/ZacABrewer/arclight/releases/tag/jellyfin-plugin-v1.1.0
[Plugin 1.0.0]: https://github.com/ZacABrewer/arclight/releases/tag/jellyfin-plugin-v1.0.0
