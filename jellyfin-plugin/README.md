# Arclight for Jellyfin

A Jellyfin server plugin that connects your existing Jellyfin to your [Arclight](https://github.com/ZacABrewer/arclight) server.

- **Sync to Arclight, from every Jellyfin app.** Playback, watched and favourite changes, new library items and Jellyfin user changes are sent to Arclight.
- **Request from Jellyfin.** Jellyfin Web search gets an "Arclight" section with titles you don't have yet. Each one has a Request button, and for series you can pick seasons and ask for 4K.
- **Status on item pages.** Movie, series, season and episode pages show chips such as "Requested by Sam", "Downloading 45% · ETA 12m", "Coming Mar 18" or "3 missing episodes", plus a "Request missing" button.
- **Watchlist, problem reports and language requests.** Item pages get buttons to add to your Arclight watchlist, report a problem, and request subtitles or an audio language (when Arclight allows it).
- **Discover and My requests.** A Discover page (Coming soon, Trending, Popular movies and series, Upcoming movies and series) and a My requests page with status, download progress and Cancel for pending requests.
- **Coming soon on the home screen.** A row of monitored movies and episodes releasing in the next 30 days.
- **Also on.** Item pages and the request dialog show where else a title streams, rents or sells in your region (data from JustWatch, via TMDB).
- **Quality labels.** Posters and item pages show 4K/1080p/720p/SD, Dolby Vision/HDR, Atmos/5.1, audio languages and file size, read from Jellyfin's own media info.
- **Arclight themes (opt-in).** Jellyfin Web can wear any theme pack installed on your Arclight server: colours, fonts and corners only.
- **Arclight intro (opt-in).** A 6-second Arclight intro before movies (and optionally the first episode of a session) for users with Cinema Mode on.

The Arclight API key never leaves the Jellyfin server. Browsers call this plugin with the user's own Jellyfin session, and the plugin adds the key when it forwards the call to Arclight.

License: GPL-3.0-or-later, the same as Jellyfin.

## What Jellyfin users can see and request

Every per-user call runs as the **linked Arclight account**, never as the Jellyfin account. A Jellyfin administrator is not an Arclight administrator: what they can see and request comes from their Arclight account only.

- **Content limits.** Titles above the account's content caps (maximum movie and TV certification, hide adult content) are left out of search, Discover and Coming soon. Opening one directly answers "This title is not available for your account". Requests, language requests and problem reports for such titles are refused. Status badges for titles that aren't in the library say nothing about them.
- **Request rights.** Request buttons only appear when the account may request that kind of title: its permissions, its request-type filter (for example "no series"), the 4K settings and its quota. Otherwise the card shows the reason, such as "Your account can't request series" or "You have reached your request limit". Quality profiles are only offered to accounts allowed advanced requests. Subtitle and audio requests only appear when the account may make them.
- **Other people's requests.** Who requested a title, and other users' requests, are only shown to accounts with View requests or Manage requests. My requests always lists only your own.
- **Accounts.** A Jellyfin account that isn't linked sees "Ask your admin to link your account in Arclight". A linked account whose Jellyfin user is disabled or deleted sees "Your Jellyfin account is disabled in Arclight". Accounts Arclight creates automatically get the default permissions and request types from Settings > Requests.
- **Parental controls (optional).** Turn on **Mirror Jellyfin parental controls** on the media server in Arclight, and Arclight copies each linked user's Jellyfin maximum parental rating into their Arclight content caps on every user sync. While that is on, manual edits in Arclight are overwritten. The rating mapping is in Arclight's media-server documentation.

## Arclight intro (Cinema Mode)

The plugin can play a short Arclight intro before playback, the same way Jellyfin plays trailers before a movie.

**Turn it on**

1. Dashboard > Plugins > Arclight > **Arclight intro (Cinema Mode)**: tick **Play the Arclight intro**. It is off by default.
2. Choose **Before movies** (on by default) and/or **Before episodes** (off by default). With **Only before the first episode of a session** (on by default), an episode only gets the intro when that user has had no intro in the last 3 hours, so binge-watching isn't interrupted. Sessions are tracked in memory and reset when Jellyfin restarts.
3. Pick **Intro quality**: 1080p (60 fps, 1.4 MB, default) or 720p (30 fps, 0.6 MB). Optionally tick users who should never get it.
4. Each user needs **Cinema mode** on in Jellyfin: Settings > Playback > Cinema mode. Jellyfin Web 12.4 has it on by default. It is a per-device client setting.

**How it works**

- The intro videos are embedded in the plugin. On first use they are written to `<Jellyfin data>/arclight/intro/`, and rewritten after a plugin update.
- The intro is registered once as a stand-alone video that belongs to no library. It never shows in libraries, search or Continue Watching.
- The plugin never forwards intro playback to Arclight, so it never shows up in Arclight's watch history.
- Jellyfin asks every intro provider and plays everything they return. This plugin adds one item and never removes trailers or other providers' intros. Jellyfin decides the order between providers, so if you also use trailers as intros, the Arclight intro may play before or after them.

**Which clients play intros**

- Verified: Jellyfin Web 12.4 (intro, then the movie).
- Verified that `/Items/{id}/Intros` returns the intro on Jellyfin 10.11.11 and 12.4.
- Not verified here: Jellyfin Media Player, Android, iOS and Android TV. They honour Cinema Mode when the app supports it; most use the same `/Intros` call.
- Third-party clients (Kodi, Infuse, Swiftfin and others) may ignore Cinema Mode.

The intro video and the plugin's catalog image are the Arclight owner's artwork, made for this project.

## Requirements

| Jellyfin | Plugin build | .NET |
| --- | --- | --- |
| 12.x (current stable) | `x.y.z.12` | net10.0 |
| 10.11.x | `x.y.z.11` | net9.0 |

The repository lists both builds. Jellyfin installs the newest one its version supports, so you don't need to choose.

You also need an Arclight server that Jellyfin can reach over the network, and an API key created in Arclight under **Settings > Media servers**.

## Install

1. In Jellyfin, go to **Dashboard > Plugins** and open the repository settings (**Repositories**, or **Manage repositories** from the catalog; the exact place moves a little between versions). Add a repository:
   - Name: `Arclight`
   - URL: `https://arclight.moviemethat.com/jellyfin/manifest.json`
2. Open the **Catalog**, find **Arclight** under General, and click **Install**.
3. Restart Jellyfin (**Dashboard > Restart**).
4. Go to **Dashboard > Plugins > Arclight** and enter:
   - **Arclight URL**: the address the *Jellyfin server* uses to reach Arclight, for example `http://arclight:7000` on a shared Docker network, or `https://arclight.example.com`.
   - **API key**: the key from Arclight **Settings > Media servers**.
5. Click **Test connection**, then **Save**.
6. In Arclight, link each Jellyfin user to their Arclight account. Until a user is linked, per-user features show "Ask your admin to link your account in Arclight".

Users who already have Jellyfin Web open must reload the page once to load the new UI.

### Manual install (no repository)

Download `arclight-jellyfin_<version>.<12|11>.zip` from the [GitHub Releases](https://github.com/ZacABrewer/arclight/releases?q=jellyfin-plugin) page. Unzip it into a folder named `Arclight_<version>` inside Jellyfin's `plugins` directory (for example `/config/plugins/Arclight_1.1.0.12` in the official Docker image), then restart Jellyfin. A plugin installed by hand does not update itself.

## Updates

Plugins installed from a repository update themselves. Jellyfin's scheduled task **Update Plugins** (Dashboard > Scheduled Tasks) runs at startup and every 24 hours. It installs the newest compatible version of any plugin whose **auto update** flag is on, and that flag is on by default for plugins installed from a repository (`"autoUpdate": true` in the plugin's `meta.json`, which you can toggle on the plugin's page). Jellyfin then asks for a restart to activate the update. Use **Run** on that task to update straight away.

How a release reaches you:

1. A maintainer pushes a tag `jellyfin-plugin-v<x.y.z>`.
2. `.github/workflows/jellyfin-plugin.yml` builds both ABI targets, publishes a GitHub Release with the zips and their MD5 checksums, appends the versions to `site/public/jellyfin/manifest.json` on `main`, and redeploys the website that serves the manifest.
3. The next run of **Update Plugins** on your server picks up the new version.

## What works where

| Feature | Jellyfin Web (browser) | Jellyfin Media Player, Android, iOS and other apps that show Jellyfin Web | Native apps (Android TV, Swiftfin, Kodi, Infuse, Roku, ...) |
| --- | --- | --- | --- |
| Playback, watched, favourite, library and user sync | yes | yes | yes |
| Arclight search results and requests | yes | yes* | no |
| Status badges, watchlist, report a problem, language requests | yes | yes* | no |
| Discover, My requests, Coming soon, Also on, quality labels, themes | yes | yes* | no |

Syncing runs on the server, so it works no matter which app played the item. The UI features are a script added to Jellyfin Web, so they show up only in clients that render Jellyfin Web. \*The official desktop, Android and iOS apps embed Jellyfin Web served by your server, so they normally get the UI too. Apps that bundle their own copy of the web client don't.

## How the web UI is added (and the trade-offs)

Jellyfin has no official way for plugins to add JavaScript to Jellyfin Web. The custom CSS setting under Branding takes CSS only. The usual options are:

| Approach | Pros | Cons |
| --- | --- | --- |
| **Rewrite index.html in the response (used here)** | Changes nothing on disk. Works with read-only web folders (Docker images, Windows Program Files, NixOS). Survives Jellyfin upgrades. Disappears when the plugin is removed. No extra plugin needed. | Only works when Jellyfin itself serves Jellyfin Web. Relies on Jellyfin running plugin startup filters, which this plugin's integration test checks on 12.4 and 10.11.11. |
| Patch `index.html` on disk at startup | Also works when another web server serves Jellyfin's web folder, and with aggressive caching proxies. | Needs write access to the web folder (often missing). Jellyfin upgrades overwrite it. Leaves an edit behind if Jellyfin is removed with the plugin still installed. |
| Depend on a third-party "file transformation" plugin | One shared mechanism for several plugins. | An extra plugin to install and keep compatible with each Jellyfin release. |

This plugin uses the first approach. At startup it registers a small ASP.NET Core middleware through `IStartupFilter`. When Jellyfin serves `/web/` or `/web/index.html` (including under a base URL such as `/jellyfin/web/`), the middleware inserts:

```html
<!-- arclight-jellyfin:begin --><script defer src="/Arclight/web/arclight.js?v=<version>"></script><!-- arclight-jellyfin:end -->
```

The second approach is available as an opt-in fallback, **Also write the script tag into index.html on disk**. It is undone when you turn it off or uninstall the plugin.

If injection can't happen at all, the plugin carries on as normal. Syncing and the `/Arclight` API keep working, and only the Jellyfin Web UI is missing. The plugin's settings page shows when `index.html` was last served with the script and when a browser last loaded the script, so you can tell whether injection is working. If your reverse proxy serves Jellyfin Web files itself, either turn on the on-disk fallback or add the tag above to the proxy's copy of `index.html`.

**Pages and links.** Discover and My requests are full-page views the script draws over Jellyfin's current page when the address contains `?arclight=discover` or `?arclight=requests`, for example `#/home?arclight=discover`. Jellyfin's router treats that as its normal home page, so this works in both shells without registering routes, and Back closes the view. Links are added in three places: the classic drawer's `.customMenuOptions` slot (10.11 default layout), the 12.x app bar next to Favorites and libraries (desktop), and the 12.x MUI drawer (narrow screens), cloned from Jellyfin's own entries so they match. The Coming soon row is inserted into the home sections. Quality labels are fetched for visible posters only (IntersectionObserver), batched (≤ 100 ids per call, 250 ms debounce) and cached, so browsing stays fast.

**Themes.** The palette button (12.x app bar or classic header) offers Server default, Off, Follow my Arclight theme, and every installed pack. The script adds `<link rel="stylesheet" href="/Arclight/Theme.css?theme=<pack>">`, swaps it live without a flash, and removes it for Off. "Follow" is re-resolved on every page load. Arclight generates the stylesheet from the pack's design tokens (see Arclight's THEMES.md, "Using themes in Jellyfin"). It changes colours, fonts, radii, borders and shadows only, never layout, and fonts come from Arclight itself, never a font CDN.

The script needs no build step and adds just one global, `window.__arclight`. It uses Jellyfin's own `emby-button`, `raised`, `button-submit`, `sectionTitle` and `.dialog` classes, so it follows the active theme. You can override its colours with `--arclight-*` CSS variables in **Dashboard > General > Custom CSS**. All strings sit in one table at the top of `arclight.js`, ready for translations (English for now).

## Privacy: what is sent to Arclight

Only to the Arclight URL you configure, and nothing to anyone else:

- **Events** (`POST /api/v1/jellyfin/events`): the Jellyfin server id. For each event: the type, a timestamp, the Jellyfin user id and user name, and the item's Jellyfin id, type, name, provider ids (TMDB, TVDB, IMDb and so on), series provider ids, season and episode numbers and runtime. Playback events add the position, client name, device name, play method and session id. User-data events add the played flag, play count, favourite flag and position. IP addresses, file paths, passwords and Jellyfin access tokens are never sent.
- **Per-user calls** (search, title details, requests, problem reports, language requests, watchlist, status): what the user typed or clicked, plus the header `X-Arclight-Jellyfin-User` so Arclight knows which linked account is acting.

- **Also on** asks Arclight (which asks TMDB) for the title's watch providers in the configured region. Labels and themes send nothing about the user: labels are computed inside Jellyfin, and theme files are fetched by pack id only.

Progress events are throttled to one per playback session per 60 seconds by default (always sent at once when playback pauses or resumes). Each kind of event can be switched off on the settings page.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Arclight URL | (empty) | `http(s)://host[:port][/path]` |
| API key | (empty) | Stored in `plugins/configurations/Jellyfin.Plugin.Arclight.apikey`, not in the plugin XML, so the Dashboard's plugin-configuration API never returns it. Kept across updates. |
| Send events / playback / watched / library / users | on | |
| Send events every N seconds | 10 | A batch also goes out early once 200 events are waiting. At most 500 events per request. |
| Progress at most every N seconds | 60 | |
| Maximum queued events | 5000 | The queue is in memory. When it is full, progress events are dropped first. |
| Load the script in Jellyfin Web | on | |
| Patch index.html on disk | off | Fallback, see above. |
| Search / requests / badges / watchlist / problem reports / language requests | on | Each toggle also turns off the matching `/Arclight` endpoint. |
| Discover / Coming soon / My requests / Also on / quality labels | on | Same: each toggle also turns off its endpoint. |
| Streaming services region | US | Two-letter region for "Also on". |
| Default Jellyfin theme | Off | Off, "Follow each user's Arclight theme", or any pack installed on Arclight. |
| Let users choose their theme | on | Adds a palette button to the header. The choice is stored per Jellyfin user in the plugin settings, so it follows them to every device. |
| Play the Arclight intro | off | Cinema Mode intro (see above). |
| Before movies / Before episodes / Only first episode of a session | on / off / on | |
| Intro quality | 1080p | 1080p or 720p. |
| Skip the intro for these users | (none) | |

If Arclight is unreachable or returns 5xx, 401, 403, 408 or 429, delivery retries with backoff starting at 5 seconds and doubling up to 5 minutes. Events stay queued meanwhile. Batches Arclight rejects as invalid (400, 404, 413, 422) are dropped and logged. Event handling never blocks Jellyfin, because handlers only add to the queue and a background task does the sending.

## Events

| Arclight event | Jellyfin source |
| --- | --- |
| `playbackStart`, `playbackProgress` (throttled), `playbackStop` | `ISessionManager.PlaybackStart` / `PlaybackProgress` / `PlaybackStopped`, one event per user in the session |
| `userDataSaved` | `IUserDataManager.UserDataSaved` for marking played or unplayed, favourites and ratings, playback finished, imports, and user-data edits. Progress saves are skipped because playback events already cover them. |
| `itemAdded` | `ILibraryManager.ItemAdded` for movies, series, seasons, episodes, albums, audiobooks and books (not virtual "missing" items). Jellyfin adds items before it fetches metadata, so an item without TMDB, TVDB or IMDb ids waits until `ItemUpdated` brings them, for up to 10 minutes. |
| `userCreated`, `userUpdated`, `userDeleted` | Jellyfin's `UserCreatedEventArgs` / `UserUpdatedEventArgs` / `UserDeletedEventArgs` event consumers, plus `IUserManager.OnUserUpdated`. Duplicates within 2 seconds are merged. |

`item.type` is Jellyfin's item kind (`Movie`, `Series`, `Season`, `Episode`, ...). Ids are sent as 32 lowercase hex characters (Jellyfin's "N" GUID format, no dashes), and that includes `X-Arclight-Jellyfin-User`.

## Plugin API (`/Arclight/...`)

These endpoints are called by the web script, and any client may use them with a Jellyfin user token (`Authorization: MediaBrowser Token="..."`).

| Method and path | Forwards to Arclight |
| --- | --- |
| `GET /Arclight/ClientConfig` | (none) Returns which features are enabled. |
| `GET /Arclight/Search?q=&type=movie\|series\|all&page=` | `GET /api/v1/jellyfin/search` |
| `GET /Arclight/Title/{movie\|series}/{tmdbId}` | `GET /api/v1/jellyfin/title/:mediaType/:tmdbId` |
| `POST /Arclight/Request` `{ mediaType, tmdbId, seasons?, is4k? }` | `POST /api/v1/jellyfin/request` |
| `POST /Arclight/LanguageRequest` `{ kind, mediaType, tmdbId, seasonNumber?, language }` | `POST /api/v1/jellyfin/language-request` |
| `POST /Arclight/Issue` `{ mediaType, tmdbId, seasonNumber?, episodeNumber?, type, message }` | `POST /api/v1/jellyfin/issue` |
| `GET / POST / DELETE /Arclight/Watchlist` | `GET / POST / DELETE /api/v1/jellyfin/watchlist` |
| `GET /Arclight/Item/{jellyfinItemId}` | `POST /api/v1/jellyfin/status`. Returns `{ item: { id, type, mediaType, tmdbId, seasonNumber, episodeNumber }, status }`. The item must be visible to the caller. |
| `POST /Arclight/Status` `{ itemIds: [...≤100] }` | `POST /api/v1/jellyfin/status` |
| `GET /Arclight/Discover?category=trending\|popularMovies\|popularSeries\|upcomingMovies\|upcomingSeries&page=` | `GET /api/v1/jellyfin/discover` |
| `GET /Arclight/Upcoming?days=30` | `GET /api/v1/jellyfin/upcoming`, then movies and episodes this Jellyfin already has are removed (library index refreshed every 10 minutes; missing/virtual episodes stay). |
| `GET /Arclight/Providers/{movie\|series}/{tmdbId}` | `GET /api/v1/jellyfin/providers/...?region=<setting>` |
| `GET /Arclight/Requests?take=&skip=`, `DELETE /Arclight/Requests/{id}?kind=media\|language` | `GET /api/v1/jellyfin/requests`, `DELETE /api/v1/jellyfin/requests/:id` |
| (intro) | No endpoint of its own: an `IIntroProvider` that Jellyfin's `/Items/{id}/Intros` calls. |
| `GET /Arclight/Labels?ids=` (≤ 100) | (none) Computed from Jellyfin's media info, cached per item until the item changes; only items visible to the caller. |
| `GET /Arclight/Themes`, `POST /Arclight/Themes/Choice` `{choice}` | `GET /api/v1/jellyfin/themes` (+ `/userconfig` for "follow"); the choice is stored in the plugin. |
| `GET /Arclight/Theme.css?theme=<pack>`, `GET /Arclight/theme-fonts/{pack}/{file}.woff2` | `GET /api/v1/jellyfin/theme/:id.css`, `/theme-fonts/:id/:file`. Anonymous (stylesheet links carry no token), ids validated. The plugin caches each file for an hour (so Arclight sees at most one fetch per pack per hour); browsers revalidate the stylesheet on every load with ETag/304 and keep fonts for a week. |
| `GET /Arclight/web/arclight.js`, `arclight.css` | (none) Static, no authentication, contains no secrets. |
| `GET /Arclight/Admin/Status`, `POST /Arclight/Admin/ApiKey`, `POST /Arclight/Admin/TestConnection` | (none / `ping`) Administrators only. |

The proxy validates every input (media type, positive TMDB id, query length ≤ 200, page 1-500, season numbers, issue type `video|audio|subtitles|other`, message ≤ 5000 characters, language 2-64 characters, ≤ 100 item ids). It rebuilds request bodies from known fields only, so nothing the browser sends is passed through as-is. Arclight's JSON responses are passed through, including `403 { code: "not_linked" }`. A `401` from Arclight (wrong API key) is returned as `502 { code: "arclight_auth_failed" }`, because Jellyfin clients treat a 401 as "your Jellyfin session expired". API-key callers that have no Jellyfin user get `403 user_required`.

## Uninstall

**Dashboard > Plugins > Arclight > Uninstall**, then restart Jellyfin. Uninstalling deletes the stored API key file and removes the on-disk `index.html` patch if you had turned it on. The in-memory script injection stops as soon as the plugin is gone. To remove the plugin's settings too, delete `plugins/configurations/Jellyfin.Plugin.Arclight.xml`. Nothing is left in Arclight apart from what was already synced there.

## Development

```bash
cd jellyfin-plugin
dotnet test -p:JellyfinTarget=12        # unit tests, Jellyfin 12 (net10.0)
dotnet test -p:JellyfinTarget=10.11     # unit tests, Jellyfin 10.11 (needs the .NET 9 runtime)
bash scripts/build.sh 1.1.0             # build both targets, test, zip -> artifacts/
node scripts/manifest.mjs --release artifacts/release.json   # what CI does on a tag
```

No .NET SDK installed? Use `docker run --rm -v "$PWD:/src" -w /src mcr.microsoft.com/dotnet/sdk:10.0 bash scripts/build.sh 1.1.0`.

### Integration test

`integration/run.mjs` starts a **throwaway** Jellyfin container (`arclight-jf-test`, port 18096, temporary `/config`) and a fake Arclight (`integration/fake-arclight.mjs`, port 18097) that records every call. It then:

1. completes the setup wizard over the API, copies the plugin into `/config/plugins` and restarts Jellyfin;
2. configures the plugin;
3. generates a 5-second movie with the container's ffmpeg and adds a library;
4. creates, updates and deletes a user, marks the movie played and favourite, and reports playback;
5. calls every `/Arclight` endpoint;
6. checks the `index.html` injection, the script and the settings page;
7. asserts what the fake Arclight received, then removes the container.

```bash
bash scripts/build.sh 1.1.0
node integration/run.mjs --zip artifacts/arclight-jellyfin_1.1.0.12.zip --image jellyfin/jellyfin:12.4
node integration/run.mjs --zip artifacts/arclight-jellyfin_1.1.0.11.zip --image jellyfin/jellyfin:10.11.11
```

Add `--keep` to leave the container running for manual testing. Never point the script at a real Jellyfin server.

### Layout

```
jellyfin-plugin/
  plugin.json                  plugin identity (fixed GUID a0751e21-86da-4afd-8e35-7da8b087febc), manifest metadata
  CHANGELOG.md                 release notes, copied into the manifest
  Directory.Build.props        JellyfinTarget=12|10.11 -> framework, package version, targetAbi
  src/Jellyfin.Plugin.Arclight/
    Plugin.cs, PluginServiceRegistrator.cs
    Configuration/             settings, API key store, dashboard page
    Events/                    mapping, throttle, queue, sender, Jellyfin subscriptions
    Api/                       /Arclight controller, input validation
    Arclight/                  HTTP client for Arclight
    Web/                       index.html injection, arclight.js, arclight.css
  tests/                       xUnit
  scripts/                     build.sh, package.mjs (zip + MD5 + meta.json), manifest.mjs
  integration/                 run.mjs, fake-arclight.mjs
```
