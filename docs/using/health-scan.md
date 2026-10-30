# Library health scan

The health scan looks for files in your library that are broken or wrong, explains each problem in plain language, and lets you fix them one at a time or in bulk. It covers movies, episodes, music tracks and audiobook files.

Open **Library > Hygiene** (administrators) and choose the **Health** tab. Every movie, series, album and book page also has a **Health** tab that shows only that item's problems, with a **Check now** button.

## What it checks

| Problem | Severity | What it means |
| --- | --- | --- |
| Missing | error | The file is in the library but is no longer on disk. |
| Empty file | error | The file is 0 bytes. The download or copy probably failed. |
| Unreadable | error | The file exists but cannot be opened or read (permissions, disk errors). |
| Won't parse | error | ffprobe cannot read the file. The container is probably corrupt. |
| Decode errors | warning, or error with 10+ errors or when ffmpeg fails | ffmpeg reported errors while decoding. Playback may stutter, freeze or stop. |
| Truncated | warning | The file plays for much less than its runtime: the movie or episode runtime, the track length, or the book length (all parts together). "Much less" is below 75% by default. Music tracks must also be at least 10 seconds short. |
| Sample | warning | A video whose name says "sample", or one under 5 minutes for an item of 20 minutes or more. |
| No audio | error | The file has no audio track. |
| No video | error | A movie or episode file without a video track. |
| Wrong language | warning | None of the audio languages the quality profile wants are present, or an audio language you asked for with **Add additional...** is missing. `Original` in a profile means the item's original language. A profile with no languages, or with `Unknown`, accepts anything. Audio tracks without a language tag are not judged. |
| No track number | info | A music file without a track number in its tags. |
| Track gaps | warning | An album's track numbers skip numbers (for example 1, 2, 4), per disc. |
| Part order | warning, or error when parts are missing | An audiobook's parts have gaps, a part number twice, or file names that sort differently from the part numbers. This is only checked when the files carry part numbers. |

Track gaps, part order and the book-length check belong to the album or book, not to one file. You can re-check or ignore them, but not replace or delete them; search the album or book from its page instead.

### Quick and deep decode checks

The decode check runs ffmpeg and throws the output away; only errors are kept.

- **Quick** (default) decodes 10 seconds at the start, the middle and the end of each file. A file shorter than 40 seconds is decoded whole.
- **Deep** decodes every frame of every file. It finds more, but on a NAS it is CPU-heavy and slow. Turn it on deliberately, ideally with a time window.

Without ffprobe only missing, empty and unreadable files are found. Without ffmpeg, decode errors are not checked. The page shows a notice in both cases. The Docker image includes both.

## Running scans

- **Scheduled**: the **HealthScan** job runs weekly by default, on Sunday at 03:00. In **Scan settings** you can choose daily, weekly or off (on demand only). When a time window is set, the scan starts at the window start instead.
- **Whole library, now**: **Run health scan** in the page header.
- **One item**: **Check now** on the item's **Health** tab.
- **A selection**: select findings and choose **Re-check**.

Whole-library scans **resume**: a file whose size and modified time have not changed since its last check is skipped. After the first full pass, later scans only check new and changed files, so they are short. Switching from quick to deep checks every file again once. Checks of chosen items and re-checks always check the files again.

### Keeping the NAS responsive

The defaults are set so a scan does not get in the way.

| Setting | Default | Effect |
| --- | --- | --- |
| Files at a time | 1 | How many files are checked in parallel (up to 4). |
| Low priority | on | On Linux, ffmpeg and ffprobe run through `nice -n 19` and `ionice -c 3` when the container has them. Elsewhere, or without them, the commands run normally. |
| Time window | off | When on, scheduled scans only run between the two times (a window may cross midnight) and stop when it ends. The next scheduled run carries on where the last one stopped. Scans you start yourself ignore the window. |
| Truncated below | 75% | The share of the expected runtime below which a file counts as truncated. |
| Check audio languages | on | Turns the wrong-language check for movies and episodes on or off. |
| Notify | on | Sends a notification after a scan that found new problems. |

If Arclight restarts during a scan, the next run resumes where it stopped.

## The Health view

- **Summary**: how many files have been checked, the last scan, the number of open problems, and one tile per problem type. Click a tile to show only that type.
- **Filters**: status (open, ignored, fixed, all), problem type, severity and media type.
- **Table**: the item (with a link to its page), the file path, the problem with its explanation, and when it was last checked. **Fix** on a row opens the actions; the checkboxes select rows for the bulk bar.

A problem that is no longer found on the next check is marked **fixed** and kept for 30 days. A problem that comes back opens again.

## Fixing problems

| Action | What it does |
| --- | --- |
| Replace | Blocklists the release the file came from (when the import history knows it, movies and episodes only), deletes the file (to the recycle bin when one is set in **Media management**), and starts one search for a replacement for every affected item. Asks for confirmation. |
| Re-check | Checks the files again now. |
| Ignore | Hides the problem. It stays hidden until the file changes (its size or modified time); if the problem is still there after that, it opens again. **Stop ignoring** opens it now. |
| Delete file | Deletes the file (to the recycle bin when one is set) and removes it from the library. Nothing is searched for. Asks for confirmation. |

All four work on one finding (the **Fix** menu) or on a selection (the bulk bar).

## Notifications

After a scan that found new problems (or problems that came back), Arclight sends a **Health scan found problems** notification listing the first ten, with a link to the Health view. Connections receive it when **On Health Issue** is turned on for them. Switch it off under **Scan settings > Notify**.

## Related

- [Library](library.md): the Hygiene page (orphans, duplicates, empty folders).
- [Media management](media-management.md): the recycle bin.
- [Notifications](notifications.md).
- [API](../API.md#library-health-scan): the endpoints.
