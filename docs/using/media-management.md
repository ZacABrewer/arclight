# Media management

Settings > Media Management is where you tell Arclight where your library lives (root folders), how imported files and folders are named, and what happens to a download when it finishes. Almost everyone visits it once during setup, and again if they want different file names. If you are brand new, the [first-run wizard](../getting-started/first-run-wizard.md) already sets a root folder for you.

Changes on this page are held until you press Save (an unsaved-changes bar shows how many you have). Some rows only appear when you switch on **Advanced** at the top of the page.

## Root folders

A root folder is a top-level folder that holds your library, for example `/data/media/tv` or `/data/media/movies` (the paths the Docker setup uses; your own paths may differ). When you add a series or movie, you pick which root folder it goes into.

1. Under **Root folders**, press **Add root folder**.
2. Browse to the folder and select it.
3. Choose the type, **Series** or **Movies**, and press **Add**.

Each row shows the free space left on that drive. The bar turns orange below 100 GB free. A red **Not reachable** chip means Arclight cannot see the folder (wrong path, drive not mounted, or a container volume that is missing); see [Empty root folder](../TROUBLESHOOTING.md#empty-root-folder).

Removing a root folder only makes Arclight stop using it. No files on disk are touched.

> Tip: in Docker, mount ONE share as `/data` (`${DATA_ROOT}:/data`) and keep downloads in `/data/downloads` and the library in `/data/media/tv` and `/data/media/movies`. Linux cannot hard-link across two different mounts, even when both are on the same disk, so separate mounts for downloads and library force a full copy on every import. With one mount, imports are instant hardlinks and seeding keeps working. See [Folders and hardlinks](../getting-started/folders-and-hardlinks.md).

## Naming

Turn on **Rename episodes** and/or **Rename movies** to have Arclight rename files as it imports them. Both are **off** by default; with renaming off, files keep the name they were downloaded with. The page shows a live sample under each format box, so you can see the result before you save.

### The format boxes

| Setting | Default | What it names |
|---|---|---|
| Standard episode format | `{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}` | Normal TV episodes |
| Daily episode format (Advanced) | `{Series Title} - {Air-Date} - {Episode Title} {Quality Full}` | Daily shows (talk shows, news) |
| Anime episode format (Advanced) | `{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}` | Anime series |
| Series folder format | `{Series Title}` | The folder for the whole series |
| Season folder format | `Season {season}` | The folder for each season |
| Specials folder format (Advanced) | `Specials` | The folder for season 0 |
| Movie format | `{Movie Title} ({Release Year}) {Quality Full}` | The movie file |
| Movie folder format | `{Movie Title} ({Release Year})` | The movie folder |

A format is plain text plus `{tokens}` in curly braces. A token that has no value for a file (for example no release group) disappears, together with any prefix or suffix you attached inside the braces, so `{ - Release Group}` gives ` - GROUP` or nothing.

### Common tokens

| Token | Gives you |
|---|---|
| `{Series Title}`, `{Series TitleYear}`, `{Series TitleThe}` | The title; the title with `(Year)`; the title with a leading "The" moved to the end |
| `{Series CleanTitle}` | The title with punctuation such as `&`, apostrophes and brackets removed |
| `{Series Year}`, `{Series TitleFirstCharacter}` | The year; the first letter (for A-Z folders) |
| `{season}` / `{season:00}` | Season number, optionally padded to 2 digits |
| `{episode}` / `{episode:00}` | Episode number, optionally padded |
| `{absolute:000}` | Absolute episode number (anime only) |
| `{Episode Title}`, `{Episode CleanTitle}` | The episode name |
| `{Air-Date}` | The air date as `2013-10-30` (use `{Air.Date}` for dots) |
| `{Season Title}` | The season name, where the metadata has one |
| `{Movie Title}`, `{Movie CleanTitle}`, `{Movie TitleThe}` | The movie title and variants |
| `{Movie OriginalTitle}`, `{Movie Certification}`, `{Movie Collection}` | Original-language title, rating, collection name |
| `{Release Year}` | Four-digit year |
| `{ImdbId}`, `{TmdbId}`, `{TvdbId}`, `{TvMazeId}` | External ids (`{TvdbId}` and `{TvMazeId}` for TV) |
| `{Quality Title}`, `{Quality Full}` | `WEBDL-1080p`; or the same with `Proper`/`REAL` added |
| `{Release Group}` | The release group |
| `{Original Title}`, `{Original Filename}` | The name the file came in with |
| `{Edition Tags}` | Movie edition such as `Director's Cut` |
| `{MediaInfo VideoCodec}`, `{MediaInfo AudioCodec}`, `{MediaInfo AudioChannels}`, `{MediaInfo Simple}`, `{MediaInfo Full}` | Details read from the file (needs analysis, see File management) |
| `{Version}` | The version tag when you keep several versions of one title (see Versions) |

How tokens behave:

- Case and separators do not matter for the token name: `{Series Title}`, `{series.title}` and `{SERIES_TITLE}` are the same token. Writing the name in lower case lower-cases the value, upper case upper-cases it, and writing `{Series.Title}` swaps spaces for dots in the value.
- A number after a colon limits the length of a title: `{Series Title:30}` keeps at most 30 characters and ends with `...`. A negative number keeps the end instead.
- A slash in a file format creates folders, for example `{Series Title}/Season {season:00}/{Series Title} - S{season:00}E{episode:00}`.
- For movies, tag wrappers such as `{imdb-{ImdbId}}` and `{edition-{Edition Tags}}` print the whole `{imdb-tt1234567}` text only when the inner value exists. This is the form Plex and Jellyfin use to match movies.
- The movie folder format cannot use tokens that come from the file itself (quality, release group, media info, original title).

Full rules and many more tokens are in the [naming spec](../spec/naming.md).

### Example

For the series "The Wire" (2002), season 1 episode 3 titled "The Buys", WEBDL-1080p, the default standard format produces:

`The Wire - S01E03 - The Buys WEBDL-1080p.mkv`

in the folder `The Wire/Season 1/`. Plex, Jellyfin and Emby read this layout without any extra help.

### Multi-episode style, illegal characters and colons

| Setting | Default | What it does |
|---|---|---|
| Multi-episode style | Prefixed range (S01E01-E03) | How one file holding several episodes is numbered. Other choices: Extend (S01E01-02-03), Duplicate (S01E01.S01E02), Repeat (S01E01E02E03), Scene (S01E01-E02-E03), Range (S01E01-03) |
| Replace illegal characters (Advanced) | On | Swaps characters that Windows and NAS shares dislike (`\ / ? *`) for safe ones. Off simply removes them |
| Colon replacement (Advanced) | Smart replace | How `:` in a title is handled. Choices: Delete, Replace with dash, Replace with space dash, Replace with space dash space, Smart replace (": " becomes " - ", a bare colon becomes "-"), Custom |
| Custom colon replacement | empty | The text to use when colon replacement is Custom. It cannot contain a colon or any of `\ / < > ? * | "` |

### Versions

If you keep more than one version of a title (for example a 1080p and a 4K copy), the **Versions** section controls the layout:

- **Side by side** (default): every version sits in the same folder. If your file format has no `{Version}` token, Arclight adds ` - <tag>` to the name.
- **One folder per version**: each version goes in a sub-folder named after its tag, inside the movie or season folder.

The section shows a sample path for both. To place the tag yourself, add `{Version}` to a file format.

## Importing

These settings sit under the **Importing** heading.

| Setting | Default | What it does |
|---|---|---|
| Episode title required | Always | Wait for the episode to have a real title before importing, when your format uses `{Episode Title}`. Other choices: Only for bulk season releases, Never. New episodes often have a placeholder title like "TBA" for a day or so. Episodes that aired more than 48 hours ago are never held back |
| Use hardlinks instead of copy (Advanced) | On | See the next section |
| Import extra files | Off | Also bring along files that sit next to the video, such as subtitles |
| Extra file extensions | `srt` | Comma-separated list, no dots, for example `srt,nfo`. Only used when Import extra files is on |
| Skip free space check (Advanced) | Off | Do not check free disk space before importing |
| Minimum free space (Advanced) | 100 MB | Refuse to import if less than this would remain on the drive |
| Stalled download after | 10 min | Flag a download as stalled if it receives no data for this long. 0 turns this off. Paused, queued and kill-switch-paused downloads are never flagged |

Two more import options exist in the stored settings but have no switch on this page: completed download handling and re-download of failed downloads. Both default to on. Arclight also treats folders whose names start with `_UNPACK_` or `_FAILED_` (the working folders some download clients unpack into) as "still being unpacked" and does not import from them.

When a download finishes, Arclight checks it (right episode or movie, not a sample, enough disk space, a real quality upgrade, and so on). If a check fails, the item stays in Activity as blocked; see [Import blocked or failed](../TROUBLESHOOTING.md#import-blocked-or-failed). The checks are described in the [import spec](../spec/import.md).

### Hardlink, copy or move

How a file reaches the library depends on whether the download is still needed:

| Situation | What Arclight does |
|---|---|
| The download client can hand the file over (it is finished and not seeding) | **Move** |
| The file must stay where it is (for example a torrent that is still seeding) and **Use hardlinks** is on | **Hardlink** if the library is on the same volume, otherwise a full **copy** |
| Same, with **Use hardlinks** off | Always a full **copy** |

A hardlink is a second name for the same data on disk, so the file appears in both places and uses space only once. It only works when the downloads folder and the library are on the same volume and, in Docker, under the same mount: with the standard layout both live under `/data`. Two separate mounts (for example `/downloads` and `/tv`) cannot be hard-linked even on one disk. If a hardlink is not possible Arclight falls back to copying, which works but doubles the space used while seeding. See [Folders and hardlinks](../getting-started/folders-and-hardlinks.md), [Hard links not possible](../TROUBLESHOOTING.md#hard-links-not-possible) and [Hardlinks not working](../TROUBLESHOOTING.md#hardlinks-not-working).

### Propers and repacks

| Setting | Default | What it does |
|---|---|---|
| Propers and repacks | Prefer and upgrade | How a PROPER or REPACK of a file you already have is treated. Choices: Prefer and upgrade, Do not upgrade automatically, Do not prefer |

## File management

| Setting | Default | What it does |
|---|---|---|
| Create empty series folders | Off | Create a missing series folder during a disk scan |
| Delete empty folders | Off | Remove empty series and season folders during a disk scan |
| Analyse video files (Advanced) | On | Read resolution, codecs, HDR, audio and subtitle tracks and runtime with ffprobe |
| Rescan folder after refresh (Advanced) | Always | Look for new files on disk after a metadata refresh: Always, After manual refresh, or Never |
| Change file date (Advanced) | None | Set the imported file's modified date to the Local air date, the UTC air date, or the Release date (movies) |
| Recycling bin | empty | A folder where deleted and replaced files go instead of being erased. Empty means files are deleted permanently |
| Recycling bin cleanup (Advanced) | 7 days | Files older than this are removed from the bin automatically. 0 keeps them forever |
| Set permissions (Advanced) | Off | Apply chmod and chown to imported files and folders (Linux) |
| chmod folder (Advanced) | 755 | Octal mode for new folders. Files get the same mode without the execute bits |
| chown group (Advanced) | empty | Group to give imported files and folders |

Notes:

- **Recycling bin.** Put it on the same volume as the library (for example `/data/media/.recycle`) so moving a file into it is instant. When a file is upgraded, the old one goes to the bin. If a file with the same name is already in the bin, Arclight adds `_2`, `_3` and so on.
- **Permissions.** On a NAS, the usual fix for "permission denied" is to run the container as the right user (PUID/PGID) rather than using these options. See [Permission denied](../TROUBLESHOOTING.md#permission-denied).
- **Analysis.** Arclight finds `ffprobe` on its `PATH`, or at the path in the `ARCLIGHT_FFPROBE` environment variable. Without it, media info tokens in file names come out empty and sample detection by runtime is unavailable.

## Transcode rules (optional)

Settings > Transcode holds rules that tidy or convert library files with ffmpeg. This is entirely optional and does nothing until you add a rule. A rule picks files by media type, by tag or quality profile, and by conditions (container, video codec, audio codec, HDR or SDR, height, bitrate, file size). It then does one of four things:

| Action | What it does |
|---|---|
| Remux | Copy every kept stream into an MKV or MP4 container, with no re-encoding |
| Transcode | Re-encode video (H.264, HEVC or AV1) and/or audio (AAC or E-AC-3), with a quality (CRF) and preset, and optional hardware encoding (VAAPI, QSV, NVENC or VideoToolbox) |
| Strip tracks | Keep only the audio and subtitle languages you list (untagged tracks are always kept) |
| Add audio track | Keep everything and add one compatibility audio track made from the first kept audio track |

Each rule can **Keep original** (keep the old file next to the result instead of sending it to the recycle bin), **Run after import** (queue matching files after every import), and have a **Time window** (server time) in which queued jobs may start. A job that has started inside the window runs to the end. Manual runs ignore the window. Jobs show up under Activity > Transcode jobs. ffmpeg must be installed, or its path set in `ARCLIGHT_FFMPEG`; the page warns if it cannot be found.

## Import lists

Settings > Import Lists adds series and movies to your library automatically from lists. Supported list types are TMDB (list, popular, collection, person, keyword), Trakt (list, popular, user), Plex watchlist, IMDb list, a generic RSS feed, and StevenLu's popular movies. Each list can add items automatically, can search for them as soon as they are added, and applies the root folder, quality profile and tags you choose for it. **Preview items** shows what a list would add without adding anything, and you can **Exclude** a title so lists never add it.

| Option | Default | What it does |
|---|---|---|
| Sync interval (hours) | 6 | How often each list is fetched (1 to 168) |
| Clean library level | Disabled | What to do with library items that are no longer on any enabled list: Disabled, Log only, Unmonitor, Remove from library, or Remove and delete files |
| Clean only tagged | empty | Only items with one of these tags are cleaned; empty means every item |

Be careful with the Remove choices. Start with **Log only** to see what would be affected.


### Bulk actions

Every card has a checkbox. Tick one or more and a bar appears at the bottom of the screen with "N selected", **Select all N** and the actions for the selection on Settings > Import Lists: **Enable**, **Disable**, **Test**, **Add tag**, **Remove tag** and **Delete**. Deleting asks first and says how many items it removes. Each item is handled on its own, so one that fails (for example a test that does not connect, or a profile still in use) does not stop the rest; a message lists what worked and why the others did not, and the failed items stay selected. On a phone the actions sit in one **Actions** menu.

## Related

- [Folders and hardlinks](../getting-started/folders-and-hardlinks.md)
- [Quality profiles](quality-profiles.md)
- [Download clients](download-clients.md) (including remote path mapping)
- [Library](library.md)
- [Subtitles](subtitles.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
- [Naming spec](../spec/naming.md) and [import spec](../spec/import.md) for the full rules
