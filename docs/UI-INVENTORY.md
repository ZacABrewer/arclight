# Media-Tron UI Inventory

Every screen, tab, list, dialog and component the application needs. This is the design
brief for the Tron Legacy pass (Phase 5) and the checklist for functional completeness.
Status: ✅ built (functional, unstyled) · 🔧 partial · ⬜ not built.

## 1. Application shell

- **Sidebar navigation** (collapsible; drawer on mobile) ✅
- **Top bar**: global search (`/` shortcut), live-connection indicator, VPN status pill, queue/activity badge, health badge, user menu ⬜ (search + connection ✅)
- **Global search results** page/overlay: library matches + "add new" suggestions ⬜
- **Toasts** (success/error/progress) ✅, **modal dialog** primitive ✅, **drawer** (details side panel) ⬜
- **Error boundary** page, **404** page ✅
- **First-run setup wizard** (admin account → TMDB key → root folders → download client → indexer → VPN → done) ⬜
- **Login** page, **logout**, **session expired** ⬜
- **Theme**: Tron Legacy tokens (colour, glow, grid, motion), light-grid variant for daytime ⬜
- **Keyboard shortcuts** help sheet ⬜
- **Command palette** (quick actions: add series, search, run task) ⬜ (nice-to-have)

## 2. Dashboard ✅ (will be redesigned)

- Health summary card with findings list
- Activity strip: downloading now (progress), recently imported, upcoming (next 24h)
- VPN card: connected/IP/country/forwarded port 🔧 (in progress)
- Library stats: series/movies/episodes/files/size, disk free per root folder
- Scheduled jobs table with "Run now"; recent runs table
- Requests awaiting approval (admin) ⬜
- Indexer/download-client status chips ⬜

## 3. Library

### 3.1 Library index ✅
- Tabs: **TV** / **Movies** (route per tab)
- Views: **poster grid**, **table**, **overview list** (poster + synopsis) 🔧 (grid+table ✅)
- Toolbar: search-as-you-type, sort menu, filter menu (monitored, missing, status, profile, tags, quality), view switch, poster size slider, select-mode toggle
- Bulk editor bar: monitor/unmonitor, set profile, set root folder (move files option), add/remove tags, delete, refresh, search
- Empty state ("add your first series")

### 3.2 Add new ✅
- TMDB search results list (series + movies, type filter)
- Result card: poster, year, status, network/studio, overview, "already in library" badge
- **Add dialog**: root folder, quality profile, monitor option, series type, season folder, tags, minimum availability (movies), search on add, path preview
- "No TMDB key" notice → Settings
- Import existing library from folder (bulk match) ⬜

### 3.3 Series details ✅ 🔧
- Header: fanart backdrop, poster, title/year, status, network, runtime, genres, ratings, certification, profile, path, size on disk, next/previous airing, monitored toggle
- Action bar: refresh & scan, search monitored, preview rename, edit, delete, manual import
- Tabs: **Seasons & episodes**, **Files**, **History**, **Search (interactive)**, **Subtitles** ⬜, **Requests** ⬜
- Season accordion: season poster, monitored toggle, progress, season search, season pack search, episode table (number, title, air date, quality, status chip, file, actions: search auto/interactive, toggle monitored, details)
- **Episode details drawer**: summary, file + media info, history, search results ⬜
- **Edit series dialog** ✅; **Delete dialog** (delete files / add exclusion) ✅
- **Interactive search modal**: release table (age, title, indexer, size, peers, quality, languages, formats, score, rejections tooltip, grab button), filters, protocol badges 🔧

### 3.4 Movie details ✅ 🔧
- Header as above plus release dates (cinema/digital/physical), collection link, availability
- Tabs: **Overview**, **Files**, **History**, **Search**, **Subtitles** ⬜, **Requests** ⬜
- Edit / delete dialogs ✅; collection view ⬜

### 3.5 Collections ⬜ (movies grouped by TMDB collection, monitor whole collection)

## 4. Discover & Requests (Phase 4) ⬜

- **Discover home**: configurable sliders (trending, popular, upcoming, by genre, by network/studio, Plex/Jellyfin watchlist, "because you watched")
- **Discover movies / Discover TV**: infinite grid with filters (genre, year, rating, language, provider)
- **Title page** (not yet in library): poster, overview, cast, trailers, similar, recommendations, **Request button** (season picker for TV, 4K/alternate profile target), status badge (available/requested/pending/partially available)
- **Person page**: credits grid
- **Requests** admin list: pending/approved/declined/available tabs, per-row approve/decline/edit (profile, root, tags), requester, requested seasons, bulk approve
- **My requests** (user): status timeline
- **Issues**: list, issue detail with comments thread, status (open/resolved), report-issue dialog from a title page
- **Users**: list, user detail (permissions matrix, quotas, linked media-server account, notification agents), invite/import users from Jellyfin/Plex
- **Override rules** editor (auto-approve/route by user, genre, language, keyword)
- **Watchlist** page (synced from media server)

## 5. Calendar ✅ 🔧
- Month view, week view ⬜, agenda view, day view ⬜
- Filters: unmonitored, tags, type (TV/movie), movie date kind (cinema/digital/physical)
- Item chips with status colours; click → item popover
- iCal feed dialog (URL + token, regenerate)

## 6. Wanted
- **Missing** ✅: table (series/episode or movie, air date, status), filters, search selected/all, monitored toggle
- **Cutoff unmet** 🔧: same with current quality vs cutoff

## 7. Activity
- **Queue** ✅: live table (title, item, quality, protocol, client, progress bar, ETA, size, status + status messages popover, tracked state), filters, remove dialog (remove from client / blocklist / skip redownload), bulk remove, manual import button for stuck items, "import blocked" reasons
- **History** ✅: paged table, event type filter, date range, per-item details drawer (release data, indexer, client, scores), "mark as failed", "redownload"
- **Blocklist** ✅: table, remove, clear all, add manually
- **Pending releases** (delayed by delay profiles): list with countdown, grab now, remove ⬜ (API exists)
- **Manual import** wizard: path picker → file list with auto-mapping → map series/season/episodes or movie, quality, language, release group → import mode (move/copy) → results ⬜ (API exists)

## 8. Subtitles (Phase 3) ⬜
- **Wanted subtitles** (series tab / movies tab): item, missing languages, last search, search
- **Subtitle history**: downloaded/upgraded/deleted/blacklisted events
- **Subtitle blacklist**
- Per-item **Subtitles tab** (in series/movie details): languages present (embedded vs external, forced/HI), manual search modal (provider, score, matches, download), upload dialog, delete, sync tool
- **Language profiles** editor (languages, forced/HI mode, cutoff, must-contain/must-not)
- **Providers** settings: list, add/edit with credentials, throttle status, test
- **Subtitle settings**: naming, sync (ffsubsync/alass), post-processing scripts, embedded handling, upgrade window, search frequency

## 9. Indexers (Phase 2 expands)
- **Indexer list** (cards/table): name, protocol, enabled flags, priority, status/backoff, last RSS, add/edit/delete/test/test all ✅ (in Settings today; promoted to a top-level section)
- **Add indexer** chooser: Torznab/Newznab ✅; native definitions catalogue with search by name/type/language ⬜
- **Indexer editor**: schema form, categories tree picker, seed settings ✅
- **Cross-indexer manual search** page: query + type + category filters → release table with grab/download .torrent 🔧 (API exists)
- **Indexer stats**: queries/grabs per indexer, response times, failures (charts) ⬜
- **Proxies** (FlareSolverr, HTTP/SOCKS): list + editor ⬜
- **External apps sync** (push indexers to a separate Lidarr etc.): optional ⬜

## 10. Settings
- **Media management** ✅: naming (formats with live samples, multi-episode style, colon replacement), root folders table (+ path picker), file management (recycle bin, permissions, hardlinks, free space), importing, propers/repacks, extras
- **Profiles** ✅: quality profiles (cards + editor with reorder/groups/cutoff/format scores/language), delay profiles (reorderable), release profiles
- **Quality** ✅: definitions with size sliders
- **Custom formats** ✅: list, editor with spec builder, test box, import/export JSON
- **Indexers** ✅ (see §9) and **Indexer settings**: minimum age, retention, max size, RSS interval, flags ⬜
- **Download clients** ✅: list, editor, test, remote path mappings, completed download handling, failed download handling, **built-in client** settings (listen port, limits, ratio/time, interface binding, queueing, encryption, DHT/PEX) ⬜
- **Import lists** (Trakt/TMDB lists/Plex watchlist/IMDb): list, editor, exclusions ⬜
- **Notifications** ✅: connections list, editor with event flags + schema form, test
- **Metadata** (TMDB key, language, region, image prefs) ✅ (under General)
- **VPN** 🔧: provider selector (gluetun / WireGuard on Windows / interface binding), fields, live status, test, kill-switch toggle
- **General**: host/port/URL base, SSL, auth method/users, API key (show/regenerate), proxy, logging level, analytics, backups (schedule, list, restore, download), updates (branch/mechanism) 🔧
- **UI**: theme (Tron/dark/light), first day of week, time/date formats, language, poster size ⬜
- **Tags** manager ⬜
- **Security**: users/roles (admin, user), sessions, API keys ⬜

## 11. System
- **Status** ✅: version, uptime, runtime, paths, disk space per root, about/links
- **Tasks** ✅: scheduled jobs + run now; run history
- **Health** ✅: findings with wiki links, recheck
- **Logs** 🔧: table with level filter, search, follow; log files list + download
- **Backups**: list, create, restore, delete, download ⬜
- **Updates**: current/available, changelog ⬜
- **Events/audit**: who did what (requests, settings changes) ⬜

## 12. Shared components (design system)
- Buttons (primary/secondary/danger/ghost/icon), toggle, checkbox, radio, select, multi-select with chips (tags), number input with units, slider (size limits), path picker (filesystem browser tree), date/time picker
- Table (sortable, selectable rows, sticky header, virtualised for 10k episodes), paginator, filter bar, column chooser
- Poster/backdrop image with lazy load + fallback, progress bar (episode/download), status chip set (missing/wanted/downloaded/unaired/queued/imported/failed/warning), protocol badge (torrent/usenet), quality tag, custom-format tags with score
- Cards (indexer, client, notification, profile), accordion (seasons), tabs, drawer, modal, popover/tooltip, toast
- Schema-driven form (field types incl. password mask, advanced toggle, test button) ✅
- Empty states, loading skeletons, error panels
- Charts (indexer stats, disk usage) ⬜
- Tron-specific: glow treatment, grid background, scanline/noise overlay, identity-disc progress ring for downloads, light-trail progress bars, "derezz" delete animation

## 13. Mobile / PWA ⬜
- Bottom tab bar (Library, Activity, Requests, Calendar, More), swipe actions on queue rows, push notifications for requests/availability
