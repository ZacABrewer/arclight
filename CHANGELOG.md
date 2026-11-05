# Changelog

All notable changes to Arclight are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and releases are tagged `vX.Y.Z`.
Each release is a container image at `ghcr.io/zacabrewer/arclight`.

The Jellyfin plugin has its own version numbers; see [Arclight for Jellyfin](#arclight-for-jellyfin-plugin)
at the end of this file.

## [Unreleased]

### Fixed
- **Music picks up where you left off:** reopening the phone app resumes the song at the place it stopped. The place is now saved with the queue as you listen and when the app goes to the background, not only when the queue changes.
- **Seeking after a reopen:** on mobile data (or any transcoding quality) the slider, lock screen and car controls can seek again. Transcoded streams cannot jump inside the file, so the app reopens the stream at the new place.
- **No leftover player card:** a queue that played to its end no longer comes back as a paused card after the app is closed and reopened.
- **iOS release guide:** Background Modes is set in the app, not on the App ID page; added what to do when the App Store name is taken.

## [0.27.0] - 2026-11-04

### Added
- **Discover on TV:** rows of trending, popular and upcoming movies and shows. Each title shows whether it's in your library, partly there, on its way or already requested, and you can request it (all seasons or just the missing ones) with the remote. The tab appears for users who may request.
- **My requests on TV:** each request with its status (waiting for approval, on its way, ready to watch, declined) and the date, and you can cancel one that's still pending.

### Changed
- TV shows one focus ring around the selected item instead of a doubled outline.

### Fixed
- In the Android app, artwork from a server on a plain `http://` address (for example a home network IP) didn't load, so lists showed blank posters. Artwork now loads on any server address.

## [0.26.0] - 2026-11-04

### Added
- A redesigned TV app. Home has a loading placeholder, a Try again card when rows fail (it also reloads the featured title) and an empty-library screen. Movies and TV shows are a 6-across poster grid with sorting, and My List has type chips and badges. Show pages lift the current episode and mark watched ones, and show the season count; the More panel follows the new design. Search with no matches offers "Did you mean" and a QR code to request the title from your phone.
- TV Settings > **Network & server**: the server address, a timed connection test and Downloads.
- A restyled video player on Android phones and TVs: an info line with the stream badges, how it plays and the clock; a buffering ring with the stream rate after a short stall; and a redesigned Up Next card.
- "Are you still watching?" after 3 episodes in a row that played by themselves, with Keep watching and Back to Home.
- When a video can't play, the player shows why, with **Try again** and **Back**, instead of closing.
- The Audio & Subtitles panel slides in from the side, notes tracks that need a converted stream, and has a **Subtitle size** setting (Small, Medium, Large) that is saved to your profile.
- **Phone video player:** play / pause, −10 and +10 now sit large in the middle of the screen, and a double tap on the left or right half skips back or forward 10 seconds (keep tapping to skip further).
- The new player text is translated into German, Spanish, French and Dutch.

### Changed
- TV scrolling is smoother, and the focus ring is thinner and follows the lifted tile. Tile titles wrap to two lines.
- On TV, moving into a Settings section lands on its first option, and Left goes back to the section list.

### Fixed
- On phones, the music mini player and the now-playing pill stayed on screen after a video started or the queue ended, with nothing playing. They now hide until audio plays again; the queue is kept.
- TV: the featured title's text showed through the header after scrolling down Home.
- TV: text and focus rings were cut off at the edges of rows and tiles.
- Prompt buttons in the player no longer cut off their labels; on a narrow screen they stack.

## [0.25.0] - 2026-11-03

### Added
- Activity > **Now playing**: every stream that is playing right now, refreshed every 5 seconds. It shows who is watching (user and profile), what (title, episode, track or chapter), the device and app (web, phone or TV), the IP address and whether it is local or remote, how it plays (direct, remux or transcode, the HLS quality, bitrate and encoder) and the position, playing or paused. View only, for admins. The list is kept in memory, so it starts empty after a restart.
- The Android and TV app gives up on a video that will not start instead of spinning forever. With no picture after 25 seconds (60 for a converted stream), or 60 seconds stuck buffering, it asks once for a safe converted stream (H.264 with stereo AAC, up to 1080p) at the same position; if that fails too it closes and says the video could not load.

### Fixed
- Search found nothing when the words did not match the title's punctuation, for example `spiderman` for *Spider-Man*, `schindlers` for *Schindler's List* or `shield` for *Agents of S.H.I.E.L.D.* The TV keyboard has no apostrophe or hyphen, so on TVs these titles could not be found at all. Search now ignores case, accents and punctuation, lets a word run across the title's word breaks, finds partial last words (`star wa`) and does not need "the", "a" or "and". Shows can also be found by an episode title, and movies by original title or year.
- Admin search on a large library could miss a title that sorted past the first 200 rows; music and audiobook search had the same limit. Every word of the search now narrows the database query.
- The web player's search page says the search failed, with a Retry button, instead of "No matches" when the server could not be reached.
- The Arclight Android/TV app for 0.24.0 was first published with the 0.23 screens inside (Settings showed app version 0.23.0). It was replaced the same day; release builds now refuse to build when the bundled screens are not the app's version.

## [0.24.0] - 2026-11-03

### Added
- Video that does not stutter. Whatever Arclight has to repack or convert now goes out as an adaptive (HLS) stream of 6-second pieces cut at keyframes, with a quality ladder (Original, 1080p, 720p, 480p, 360p). **Auto** starts at a quality the connection and the server can keep up with, moves up or down as they change, and switches from direct play to HLS by itself if direct play keeps stalling. Seeking, going back and changing quality happen in place, without starting a new stream.
- The server checks capacity before it starts a stream and only offers a quality it can convert at least 1.3 times faster than real time. It uses Intel Quick Sync or VA-API when they work, with a software fallback. 4K is only offered once its speed has been measured on your server, so a low-power CPU never gets a 2160p conversion it cannot keep up with. The video badge shows the stream, for example `HLS · 1080p · QSV`.
- Settings > Player: **Video streaming** (Adaptive or Single stream), **Video segment cache** (default 100 GB, kept in `/config/cache/player/hls`), **Video segment folder** (to move the cache to another volume) and **Remote video bitrate limit** (default 8 Mbps for movies and episodes watched away from home). `scripts/hls-nas-probe.sh` measures what your hardware can do; see the hardware transcoding guide.
- hls.js in the web player and Media3 HLS in the Android app, both with stall guards. Older apps keep getting a single stream.
- A Netflix-style profile picker on the web, phones and TVs: a round **Add profile** tile at the end of the row and a pencil **Manage profiles** button that turns the tiles into edit mode. An account with one profile has no picker, so Add profile is also in the avatar menu and under Settings > Profiles.
- Player address: Settings > Player > Player address gives the player extra paths (such as `/watch`) and its own hostnames (such as `watch.example.com`), like the request portal. Each hostname has a **Player only** switch that keeps the admin pages away. TV sign-in, QR codes and Copy link use it. See the new player address guide.
- Sync tags to Jellyfin, Emby and Plex: Settings > Media servers > Sync tags copies Arclight's tags (set by hand or by tag rules) to Jellyfin and Emby item tags and to Plex labels, for all tags or a chosen list, with an optional prefix. Use it for Jellyfin parental controls, for example allowing a child's account only items tagged `arclight:kids`. Includes Preview, Sync now and a nightly pass. Arclight only touches tags it added itself. Plex labels are best-effort.
- Recap detection: Arclight now finds "Previously on" recaps and offers Skip Recap. Turn it off under Settings > Player > Detect recaps.
- Encrypted backups: set a backup passphrase under System > Backups > Settings.
- New settings: `ARCLIGHT_TRUSTED_PROXIES`, `ARCLIGHT_CORS_ORIGINS`, `ARCLIGHT_SECRETS_AT_REST` and `ALLOW_ROOT` (see Security and Upgrade notes).
- Store readiness for the Arclight player app: an iOS privacy manifest, an iOS version taken from the release, a manual store-upload workflow and store review notes.

### Changed
- Account menu in the player: **Request portal** shows for every user who may request (and opens the configured portal address), and **Open Arclight** only for admins and accounts with app access.
- Cards in the player no longer have play buttons, finished books get a "Finished" badge, and continue-listening tiles play instead of opening the book.
- Intro detection also finds intros with dialogue over the music, and detected times snap to a nearby black frame or silence.
- The web Music and Audiobooks pages follow the new player design, and a phone in landscape uses the wide header.
- On a TV, pressing Up from the chips lands on the active tab in the header.
- The phone Home screen says why it could not load.
- Live video slots are counted per device, so a phone and a TV of the same person no longer replace each other's video.
- Docker: a new install refuses to start as root unless `ALLOW_ROOT=1` is set (installs that already run as root keep starting, with a warning). Gluetun and FlareSolverr are pinned to release tags, the VPN compose files need `GLUETUN_API_KEY`, and the agent compose file publishes on 127.0.0.1 by default.
- A native install needs ffmpeg 6.0 or newer.

### Fixed
- The Android app page kept running behind the video screen.
- Skip and up next now drop only after the controls fade out.
- TV full-screen panels and the profile editor sit above the stage header and cover the whole screen.
- The player-off page no longer loops on a player hostname without an address, and Back to Arclight leaves a player hostname.
- Profile initials are readable on light themes, and the current track and chapter use a text-safe accent colour.
- Tag sync counts use correct plurals, back-to-back passes are counted, and Remove unlocks only the tag locks Arclight added.
- `ARCLIGHT_SETTING__updates__*` and config files now reach the updates settings.
- The Docker image builds again (a line continuation was missing in the Jellyfin key step).
- Signed links no longer reach app logs: Capacitor debug logging is off in every build.

### Security
Every finding of a full audit of the server, web app, apps, Jellyfin plugin and Docker setup is fixed. What you may notice:
- Sign-in limits are shared by every way of signing in (login, media server, HTTP Basic, second step, app and TV codes, password changes): per account and address, per address, and a growing delay per account of at most 5 minutes. Answers carry `Retry-After`. Passkeys are not affected.
- Forwarded headers (`X-Forwarded-For` and friends) are read only from trusted proxies, set by `ARCLIGHT_TRUSTED_PROXIES`. The default is loopback and private networks, which covers a proxy on the same machine, your LAN or a Docker network. Before, every proxy was trusted. If your proxy reaches Arclight from a public address, set its address.
- Only Arclight's own address, the Application URL, portal hostnames and `ARCLIGHT_CORS_ORIGINS` may use your sign-in from a browser. The live-update connection checks its origin and drops ended sessions.
- Security headers on every page: a Content-Security-Policy, frame protection, `nosniff` and a referrer policy; HSTS and Secure cookies on the host of an https Application URL.
- App tokens (the player app, paired devices) must re-enter the password with `POST /api/v1/app/reauth` before changing settings, importing config and other sensitive actions; it lasts 10 minutes. Arclight Admin signs in with a session cookie, so it is not affected. Personal API keys of Requests scope can no longer use command routes or create custom-script notifications.
- The password is asked again (when your sign-in is older than 10 minutes) before creating API keys, passkeys or an authenticator app, and the Admin API key box shows only its last four characters until Show (each reveal is audited).
- Stored secrets (API key, two-factor secrets, settings, indexer, download client, notification and VPN credentials, media-server tokens, phone relay secrets, Year in review share links) are sealed in the database with AES-256-GCM. Set `ARCLIGHT_SECRETS_AT_REST=0` to opt out. Database, logs, backups and `secrets.key` are owner-only.
- Year in review share links are stored hashed; links shared before the upgrade keep working.
- Outbound requests (webhooks, push, podcasts, catalogue files, indexer proxies, subtitles, metadata, update checks) go through a guarded fetch that refuses local and reserved addresses, checks every redirect, pins DNS and caps response sizes. Requests Arclight makes to itself never skip sign-in.
- Downloaded files are treated as untrusted: ffmpeg and ffprobe only open files and pipes, archives and subtitles are size-limited, Soulseek and import paths stay inside their folders, and updates pull the exact image digest that was checked.
- Torrent engine: peer bans last 1 hour and double on repeat up to 24 hours, web-seed pieces are checked before they are written, the blocklist applies at every peer entry point, and uTP, handshakes, trackers and metainfo have limits.
- The remote engine agent has failed-auth back-off, an optional TLS mode and a scoped token.
- Admins signed in on a portal-only hostname can no longer reach admin settings there, and paired devices unused for 90 days are signed out.
- Apps: Android and iOS tighten cleartext traffic (https first, a one-time notice for a home network, the host name typed to confirm plain http to the internet), tokens are kept in the iOS Keychain and Android Keystore, pairing links ask for confirmation, the Android Auto media service only serves system or Play-installed hosts (including Google Assistant), and Arclight Admin gives server pages only the native calls it needs.
- Jellyfin plugin and themes: theme CSS cannot load external resources, `javascript:` links are refused, and Test connection no longer echoes the key.
- Push relay: registrations are limited per network and per day. Third-party images and GitHub actions are pinned, and the Gluetun control server requires its key on every route.

### Upgrade notes
- One database migration runs on first start. Stored secrets are also sealed once; keep `secrets.key` in your backups.
- Before downgrading to an older version, start 0.24 once with `ARCLIGHT_SECRETS_AT_REST=0`.
- If you run your own push relay, redeploy it (migration `0003_registration_days.sql`).
- If your reverse proxy reaches Arclight from a public address, set `ARCLIGHT_TRUSTED_PROXIES`. For a dashboard on another origin, set `ARCLIGHT_CORS_ORIGINS`.
- The VPN compose files need `GLUETUN_API_KEY` (run the helper script). `PUID=0` on a new install needs `ALLOW_ROOT=1`.
- Apps that sign in with an app token ask for your password the first time they change settings.

## [0.23.0] - 2026-11-03

### Added
- Households and profiles: up to 12 profiles under one login, with a "Who's watching?" picker on the web, phones and TVs, profiles you can add from the TV, optional 4-digit PINs (a lockout after 5 wrong tries that gets longer each time), and Kids limits (the stricter of the account's and the profile's applies). Progress, Continue Watching, My List, playlists and player settings are kept per profile. The account owner keeps requests and admin features. Manage profiles under Settings > Users > Manage > Profiles.
- My List in the player, separate from the request watchlist.
- A redesigned player on the web, phones and TVs: the new Cinema theme, a top navigation bar on TV, a vertical touch layout on phones (with a landscape version and a mini player), a rotating featured hero, and quality, audio and TMDB rating chips in the info line (never over posters).
- Video player: a pause screen with the overview and "Ends at" time, scrub thumbnails with chapter marks, an episodes panel and an up-next countdown, and skip intro, recap and credits buttons. Title pages have a menu with Mark watched and Versions.
- Server: intro and credits detection by comparing audio across a season (nightly and after imports), with times you can edit per season, and scrub thumbnails made on first play or nightly. New Settings > Player > Scrub thumbnails and intros.
- Arclight app: the Arclight intro plays once when the app opens, never again in that run and never before videos (turn it off in Settings).

### Changed
- The Android app shows its real version, and its version code follows the release (2300 for 0.23.0).
- Episodes in the player show the series name, with the season, episode and episode title below it.
- Continue Watching shows one card per show.

### Fixed
- The app reports an unreachable server after about 9 seconds instead of 45.
- Remote presses in the first seconds of a video no longer pause it.
- Signed links are removed from app logs.

## [0.22.0] - 2026-11-02

### Added
- Arclight player app for Android and iOS (`com.moviemethat.arclight`), not in the stores yet. It plays your music and audiobooks with native audio, keeps playing in the background and on the lock screen, downloads albums and books for offline use (Wi-Fi only by default), and sends progress made offline when it reconnects. It works with Android Auto and CarPlay, casts to Chromecast and AirPlay, and signs in by scanning a QR code from the web player.
- Server: device sign-in for the player app, a batch progress endpoint for progress saved offline, and a "Sign in a phone" QR code in the web player.
- Movies & TV in the built-in player, now its home. Browse movies and shows with continue watching, next up and recently added, open movie and show pages with versions, seasons and episodes, and mark things watched. The video player picks direct play, remux or transcode for each device and shows why, and has audio and subtitle choice, chapters, skip intro and credits, up next with auto-play, resume, picture-in-picture, full screen and keyboard shortcuts.
- Arclight app: movies and shows play in a native full-screen video player on Android, and the same app runs on Google TV and Android TV with a layout for the remote. A TV signs in with a code you confirm from a phone or computer (Sign in a TV, `/player/link`). Download it at `arclight.moviemethat.com/tv` (TV) or `/android` (phone); see the Arclight app guide.
- Server: Movies & TV playback. A session API picks direct play, remux to MP4 or transcode per device (with the reasons), live streams use Intel QSV/VAAPI with a software fallback and HDR tone-mapping, text subtitles are served as WebVTT, and there are browse, home, artwork and "mark watched" routes. New Settings > Player options: Movies & TV on/off and live video slots. TV sign-in with a code (`/app/device-codes`).

### Changed
- The companion app is now called Arclight Admin (app ID `com.moviemethat.arclight.admin`). The name Arclight and the ID `com.moviemethat.arclight` go to a separate player app. Neither app is in the stores yet.
- Pairing QR codes now use `arclight-admin://pair?url=...`. Arclight Admin still reads older `arclight://pair` codes when you scan them inside the app.
- Phones report which app registered them. The server stores this and sends it to the push relay, which uses it to pick the right APNs topic. The relay accepts a list of topics in `APNS_TOPICS`. Registrations without an app ID go to Arclight Admin.

### Fixed
- Browsers and apps on another address can now send PUT, PATCH and DELETE requests through CORS. Before, only GET, HEAD and POST were allowed, which blocked saving playback progress and the queue from the apps.

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

[0.27.0]: https://github.com/ZacABrewer/arclight/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/ZacABrewer/arclight/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/ZacABrewer/arclight/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/ZacABrewer/arclight/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/ZacABrewer/arclight/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/ZacABrewer/arclight/compare/v0.21.0...v0.22.0
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
