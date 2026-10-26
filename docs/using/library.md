# Library

The Library is the list of every TV series and movie Arclight manages for you. Add a title, tell Arclight which quality you want, and it finds the releases, downloads them, renames them and files them in your media folders. This page explains how to add titles, what "monitored" means, how the details pages work, how to keep more than one version (for example 1080p and 4K), and the cleanup tools: Retention, Hygiene and Scene mapping.

In the left menu the **Library** group has **TV**, **Movies**, **Collections**, **Add new**, **Retention** and **Hygiene**. Retention and Hygiene are for administrators only.

## TV and Movies pages

**Library > TV** and **Library > Movies** show everything you have added. Use the **Library type** switch at the top to jump between series, movies and collections.

- **View**: **Posters** (a grid, with a **Poster size** slider), **Table** or **Overview**. Your choice is remembered in your browser.
- **Sort by**: Title, Date added, Year, Size on disk or Progress. Click again to flip the direction.
- **Filter by title**: type to narrow the list.
- **Filters**: Monitored and unmonitored / Monitored / Unmonitored, **Any profile** (a quality profile), **Any tag**, **Any status**, and **Missing files**. **Clear filters** resets them.
  - Series statuses are Continuing, Ended and Upcoming. Movie statuses are TBA, Announced, In cinemas and Released.
- **Progress**: for a series, the number of episodes on disk out of the number that exist so far.

A new install shows "No series yet" or "No movies yet" with a button to **Add series** or **Add movie**, or to **Import folder** if you already have files on disk.

### Changing several titles at once

Tick the box on two or more posters or rows. A bar appears with:

| Button | What it does |
| --- | --- |
| Monitor / Unmonitor | Turns monitoring on or off for all selected titles. |
| Profile | Sets the quality profile. |
| Root folder | Moves the titles to another root folder. |
| Tags | Adds or removes one tag. |
| Delete | Opens the delete dialog (see below). |

## Add new

Open **Library > Add new** (or the **Add series** / **Add movie** button).

1. Type a title into **Search TMDB** (for example "The Expanse") and use the **Result type** filter if needed. Results come from TMDB. Titles already in your library link to their page.
2. Click a result. The add dialog opens.
3. Fill in the form (below) and click **Add series** or **Add movie**.

If you see "TMDB has no API key", click **Add TMDB key**, which takes you to **Settings > General**. Searching does not work without a key.

If you already have files on disk, use **Import folder**, which opens [Activity > Manual import](activity.md#manual-import).

### The add form

| Field | Default | What it does |
| --- | --- | --- |
| Root folder | none | Where the title is stored. Pick one, or **Browse** to add a new root folder. Titles go into `<root folder>/<Title (Year)>`; the **Destination** line previews the path. A root folder marked inaccessible cannot be used. |
| Quality profile | none | Which qualities are accepted and when to stop upgrading. See [Quality profiles](quality-profiles.md). |
| Monitor (series) | All episodes | Which episodes to monitor right away (see below). |
| Series type (series) | Standard | Standard, Daily or Anime (see below). |
| Season folders (series) | on | Put each season in its own folder. |
| Monitored (movies) | on | Search for the movie once it is available. |
| Minimum availability (movies) | Released | Announced, In cinemas or Released. When a movie is wanted. See [Wanted](wanted.md#missing). |
| Language profile | Default | Which subtitle languages you want. See [Subtitles](subtitles.md#language-profiles). |
| Tags | none | Optional labels. |
| Search on add | off | Searches for missing episodes or the movie right away. |

The add dialog does not offer multiple versions. Add the title first, then use **Edit** to add versions (see "Multiple versions").

## What monitored means

"Monitored" is Arclight's word for "I want this". Only monitored items are searched for, grabbed, upgraded and shown on the Calendar by default. Unmonitored items stay in your library but Arclight leaves them alone.

For a series there are three switches that work together:

| Level | Where | Effect |
| --- | --- | --- |
| Series | Switch at the top of the series page, or **Monitored** in **Edit** | Master switch. If off, no episode of the series is searched for, even if the episode itself is monitored. |
| Season | Switch on each season row | Convenience: turns every episode of the season on or off together. |
| Episode | Switch on each episode row | Whether this one episode is wanted. |

An episode is wanted only when both the series and the episode are monitored. The Wanted page, the Calendar and the automatic searches all follow this rule. Specials (season 0) are never monitored automatically; switch them on yourself if you want them.

For a movie there is a single **Monitored** switch.

### Monitor options (series)

The **Monitor** field in the add form decides the starting state of the episodes:

| Option | What it monitors |
| --- | --- |
| All episodes | Every episode except specials. |
| Future episodes | Episodes that have not aired yet (and episodes with no air date). |
| Missing episodes | Episodes with no file on disk. |
| Existing episodes | Episodes that already have a file. |
| First season | Only season 1 (the lowest season number). |
| Latest season | Only the newest season. |
| Pilot episode | Only episode 1 of the first season. |
| None | Nothing. The series is added unmonitored. |

### Monitor new seasons

In the series' **Edit** dialog, **Monitor new seasons** decides what happens when TMDB later lists a new season: **All new seasons** (the default for every option except None) or **None**. New episodes of a season you already monitor inherit that season's setting.

## Series types

| Type | Use it for | What changes |
| --- | --- | --- |
| Standard | Normal shows named S01E02. | Standard episode naming and matching. |
| Daily | Talk shows and news that air every day and are named by date. | Releases are matched by air date, and the daily naming format is used. |
| Anime | Anime with absolute episode numbers. | Absolute numbering is used when matching, and the anime naming format is used. |

Naming formats live in **Settings > Media Management**; see [Media management](media-management.md).

## Details pages

Click a poster or row to open the title.

### Series page

The top shows the artwork, network, genres, seasons, runtime and status, the monitor switch, the quality profile, the series type, tags, and facts: **Path**, **Size on disk**, **Episodes** (on disk / total) and **Next airing**.

Buttons at the top:

| Button | What it does |
| --- | --- |
| Search monitored | Searches for every monitored, missing episode now. |
| Interactive search | Lists every release so you can choose. See [Interactive search](interactive-search.md). |
| Refresh | Re-reads the metadata (episodes, air dates, artwork) from TMDB. |
| Refresh & scan | Does the above, then re-reads the folder on disk for new or removed files. |
| Manual import | Imports files by hand for this series. |
| Edit | Opens the edit dialog (below). |
| Delete | Opens the delete dialog (below). |

Tabs:

| Tab | What it shows |
| --- | --- |
| Seasons & episodes | Each season with its monitor switch, a progress bar, **Search season** and **Interactive** buttons, and a table of episodes (monitor switch, number, title, aired date, status, size, row actions). Click an episode for details, history, decisions and to delete its file. |
| Files | Every media file with its quality and media info (video, audio, subtitles, from ffprobe). **Analyze** re-reads a file's streams. You can delete a file from here. |
| History | Grabs, imports and failures for this series. |
| Decisions | Why Arclight accepted or rejected releases. See [Interactive search](interactive-search.md#why-this-release). |
| Search | Interactive search inline. |
| Scene mapping | Rules for releases that number the series differently (below). |
| Subtitles | See [Subtitles](subtitles.md). |
| Requests | Who requested this title (see [Discover and requests](discover-and-requests.md)). |

Episode status chips tell you at a glance: have it, downloading, missing, upcoming, or unmonitored.

### Movie page

The movie page has the same buttons (**Search movie**, **Interactive search**, **Refresh**, **Refresh & scan**, **Manual import**, **Edit**, **Delete**) and shows the release dates (In cinemas, Digital, Physical), minimum availability, size, quality of the file and, if it belongs to one, its collection. The tabs are **Files**, **History**, **Decisions**, **Search**, **Subtitles** and **Requests**.

### Editing a title

**Edit** opens a dialog:

| Field | Applies to | What it does |
| --- | --- | --- |
| Monitored | both | Master monitor switch. |
| Monitor new seasons | series | All new seasons or None. |
| Quality profile | both | Changing it can make files fall below or above cutoff; see [Wanted](wanted.md). |
| Language profile | both | Subtitle language profile. |
| Series type | series | Standard, Daily or Anime. |
| Season folders | series | Whether seasons get their own folder. |
| Minimum availability | movies | Announced, In cinemas or Released. |
| Path | both | The folder Arclight records for the title. Changing it only updates where Arclight looks; it does not move files on disk, and two titles cannot share a path. |
| Tags | both | Labels. |
| Versions | both | Extra copies (below). |

Save with **Save changes**.

### Deleting a title

**Delete** opens a dialog. By default it only removes the title from Arclight. Two options:

- **Delete files and folder from disk**: also deletes the title's folder and everything in it. A red warning shows the path. This cannot be undone through Arclight, so double-check it.
- **Add to import exclusions**: import lists and requests will not add this title again.

## Multiple versions (1080p and 4K)

By default Arclight keeps one file per episode or movie. With **versions** you can keep several copies on purpose, each with its own quality profile, for example a 1080p copy for tablets and a 4K copy for the living-room TV.

1. Open the title and click **Edit**.
2. Find **Versions** and click **Add version**.
3. Give each version a **tag** (for example `1080p` and `4K`) and pick its **Quality profile**.
4. Leave each version on **Wanted**, or set **Not wanted** to keep its file but stop searching.
5. Click **Save changes**.

Good to know:

- Up to 8 versions per title. Tags must be unique (not case sensitive), up to 32 characters, and cannot contain `\ / < > : ? * | "`.
- "Each wanted version is searched and upgraded against its own profile. Files without a version belong to the first one."
- The first time you add versions to a title that already has a file, the existing file stays in the first version.
- Saving with no versions goes back to one file per episode or movie.
- When a release arrives, Arclight puts it in the version whose profile fits best. In interactive search the **Version** column shows which slot it would fill.
- Version badges appear in the Files tab, in the interactive search table (**Version** column) and in the **Versions** column on the Wanted lists.
- Where the files go is set in **Settings > Media Management > Versions**. **Version layout** is **Side by side** (all versions in the item folder, with the tag added to the file name, for example `Movie (2020) - 4K.mkv`) or **One folder per version** (a subfolder named after the tag). You can also put the **Version token** in your file format to place the tag yourself. See [Media management](media-management.md).
- Requests can create a 4K version for you: see [Discover and requests](discover-and-requests.md).

## Collections

**Library > Collections** groups movies that belong to the same TMDB collection (for example a trilogy). Each card shows how many movies you have ("N of M on disk · K in library"). It needs a TMDB key.

Open a collection to see which movies are in your library and which are not ("Not in library"). **Monitor collection (N missing)** adds the missing movies as monitored, using the root folder, quality profile and minimum availability you choose, and can **Search for each movie right away**. It needs a movie root folder under **Settings > Media Management**; a message tells you if there is none. You can also add a single movie from the collection with its **Add** button.

## Retention

**Library > Retention** (administrators) is for freeing disk space automatically. Rules look at your library and, once a title has been watched or has gone stale, stage it for unmonitoring or deletion. Nothing disappears without a waiting period during which you can keep it.

Watch history comes from your media servers. In **Settings > Media Servers**, switch on **Retention** for each Jellyfin, Emby or Plex server whose watch history should count. See [Media servers](media-servers.md).

### Rules

Click **Add rule**. A rule has:

| Field | Default | What it does |
| --- | --- | --- |
| Name | none | Must be unique. |
| Enabled | on | Turns the rule on or off. |
| Media type | none | Movies or series. A rule applies to one. |
| Scope | Whole library | The whole library, items with certain tags, or items under certain root folders. |
| Conditions | none | One or more, and all must hold. See below. |
| Action | Unmonitor | **Unmonitor** (stop searching), **Delete files** (move the files to the recycle bin and unmonitor, so they are not downloaded again) or **Delete from library** (remove the title and its folder, optionally adding an import exclusion). |
| Grace period | 7 days | Days between staging a title and applying the action. 0 applies on the sweep that stages it. 0 to 3650. |
| Keep if requested within | off | Skips titles someone requested in the last N days. |
| Keep movies that belong to a collection | off | Movies only. |
| Dry run | on | "Stage and report, never apply on its own." |

Conditions you can combine:

| Condition | Default | Meaning |
| --- | --- | --- |
| Watched by every user | none | Everyone with an enabled account on the media server watched it. |
| Watched by any user | none | At least one user watched it. |
| Watched by these users | none | Every listed user watched it (matched by name). |
| Added more than N days ago | 90 | Time since it was added to the library. |
| Not watched in N days | 180 | Nobody played it in this time, and it was added longer ago than that. |
| Larger than | 50 GB | The files take more space than this. |

A series counts as watched when every episode on the server is played.

Because **Dry run** starts on, a new rule only reports. Turn it off when you trust the results.

### Sweeping and candidates

A job called **RetentionSweep** runs daily at 03:30. It stages matching titles as **Candidates** with the reason and waits for the grace period to pass before applying the rule. A summary shows rules, candidates and how much space they would free.

Use **Sweep now (dry run)** for a preview of what would match, without staging or applying anything.

Each candidate has a status: **Waiting**, **Kept**, **Applied** or **Failed** (retried on the next sweep). Buttons per row:

- **Keep**: pins the title ("Pinned by an admin") so it is never applied. **Unpin** reverses it.
- **Apply now**: applies the action immediately. This ignores the grace period, the pin and dry run. Deleted files go to the recycle bin when one is set under **Settings > Media Management**.
- **Remove**: drops the candidate. Nothing in the library changes.

## Hygiene

**Library > Hygiene** (administrators) finds files on disk that Arclight does not know about, plus waste.

| Tab | What it finds |
| --- | --- |
| Orphans | Video files under your root folders that do not belong to any library item. |
| Duplicates | Several copies of the same episode or movie, or files with identical content. |
| Empty folders | Folders with nothing in them. |

A scan runs weekly (job **OrphanScan**, Monday 02:00). Click **Scan now** for an immediate one; the page shows **Last scan**, and results refresh when it finishes.

For orphans, **Map...** opens a dialog to pick the movie or series and episodes the file belongs to, and import it (**Import mode**: copy or move; files already inside the item's folder are registered where they are). The dialog shows how the filename was parsed ("Parsed as") and offers a best-match suggestion. Duplicates show **Keep** for the one to keep and **Delete others**, or you can delete a single copy. Empty folders can be deleted.

Files go to the recycle bin when one is set. If a library copy is deleted, its media file entry is removed with it.

## Scene mapping

Some releases number a series differently than TMDB does (for example a long anime split into seasons, or a title with another name). On a series page, the **Scene mapping** tab lets you teach Arclight how to translate. Without it these releases may be rejected or matched to the wrong episode.

Rules are of three kinds:

| Kind | Use it when |
| --- | --- |
| Season | A scene season (and optionally an episode) maps to a library season and episode, or to an absolute number. You can set an anchor episode; later episodes keep the same offset until the next rule. |
| Absolute number | A scene absolute number maps to a library episode or absolute number. |
| Title alias | Release groups use another name for the series. Optionally restrict it to a scene season and set which library season those releases land in. |

Click **Add rule**, fill in the fields (hints appear under each), and save. You can add a **Comment**. Rules that come from the community feed are labeled **Read-only** and cannot be edited; your own are labeled **Manual**. The feed is synced daily (job **SceneMappingSync**, 05:23).

After changing rules, **Apply to existing files** matches the series' existing files again under the current rules. Files that now map to other episodes are re-linked (the files themselves are not touched) and the folder is rescanned. A summary shows files checked, re-linked, unchanged and skipped. **Rescan** only re-reads the folder.

## Related

- [Wanted](wanted.md) - what is missing and how it is searched
- [Interactive search](interactive-search.md) - pick a release yourself
- [Quality profiles](quality-profiles.md) - what "good enough" means
- [Media management](media-management.md) - naming, root folders, recycle bin and versions layout
- [Subtitles](subtitles.md)
- [Discover and requests](discover-and-requests.md)
- [Calendar](calendar.md)
- [Glossary](../GLOSSARY.md)
