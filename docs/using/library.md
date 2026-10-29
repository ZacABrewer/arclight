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

### Bulk actions

Every library list can act on many items at once: the TV and Movies pages (all views), a series' episodes, the Music and Audiobooks pages, an artist's albums, an author's books, Collections, **Wanted** (Missing and Cutoff unmet), **Hygiene** and **Subtitles > Wanted**.

1. Press **Select** in the page header (on a series page **Select episodes**, on an artist page **Select albums**, on an author page **Select books**). Tables also have a checkbox on every row and a select-all box in the header.
2. Tick what you want. **Select all N** in the bar takes every item the list shows with its current filter. On paged lists (Wanted, Subtitles > Wanted) it takes every item on the list, not just the current page. On a series page, **Select season** next to a season ticks all of its episodes.
3. Pick an action in the bar at the bottom. At phone width the actions are folded into one **Actions** menu.

| Action | Where | What it does |
| --- | --- | --- |
| Search | TV, Movies, episodes, Music, Audiobooks, albums, books | Searches every selected item, like the Search button on its page. |
| Search missing | TV, Movies, episodes, Collections | Searches only the selected items that are monitored and have no file yet (the Wanted > Missing rules). |
| Search for upgrades | TV, Movies, episodes, Collections, Wanted > Cutoff unmet | Searches only the selected items whose file is below the quality profile's cutoff (the Wanted > Cutoff unmet rules). Items whose profile does not allow upgrades are skipped. |
| Search selected | Wanted > Missing, Subtitles > Wanted | Searches the selected items (or subtitles for the selected files). |
| Monitor / Unmonitor | everywhere except Hygiene and Subtitles | Turns monitoring on or off. Wanted only offers Unmonitor. |
| Profile | TV, Movies, Music, Audiobooks | Sets the quality profile. For TV and Movies this opens the profile change preview first. |
| Root folder | TV, Movies, Music, Audiobooks | Moves the items to another root folder. |
| Tags | TV, Movies, Music, Audiobooks | Adds or removes one tag. |
| Refresh | TV, Movies, Music, Audiobooks, Collections | Refreshes the metadata of every selected item. |
| Rename files | TV, Movies, episodes | Opens a preview of every file that does not match your naming settings. Untick the ones to leave alone, then **Rename**. |
| Add additional… | TV, Movies | Adds an audio or subtitle language (see below). |
| Map to best match | Hygiene > Orphans | Imports each selected orphan file into its best suggested match. Files without a usable match are skipped. |
| Delete | TV, Movies, Music, Audiobooks, books, Hygiene | Opens the delete dialog. It has the same **Delete files** option as deleting one item. |
| Delete files | episodes | Deletes the selected episodes' files from disk. The episodes stay in the library. |

Searches, refreshes and subtitle searches run in the background as one job, so you can leave the page. A toast tells you how many items went into the job and how many were skipped (for example, items already at cutoff when you asked for upgrades). The job appears in **System > Tasks**.

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

## Import existing music and audiobooks

If you already have a music or audiobook collection on disk, bring it in from **Library > Music** or **Library > Audiobooks** with **Import existing** (administrators; the feature must be turned on).

1. Pick the **Root folder**. Optionally pick a **Folder** inside it to scan only part of it. Click **Scan**. Large collections take a while; a progress bar shows how far it got.
2. Review the list. Each audiobook folder (or album folder) is one row, with its files, what Arclight read from the folder names and tags, the proposed match and a confidence. Folders already in the library are left out.
3. Click **Change** on a row to pick another match or search for one. A search accepts a title and author, an Audible ASIN or a MusicBrainz id.
4. Choose the **Quality profile** for any authors or artists the import adds, and **Keep in place** (the default: files stay where they are, with their names) or **Move and rename** (your naming settings apply).
5. Click **Import**. Each row then shows **Imported** or why it failed. You can fix the match and import a failed row again.

What the import does:

- It adds the author or artist when they are not in the library yet, with only the imported books or albums monitored. The rest of their catalogue is listed but not wanted, and nothing is searched.
- It understands the common layouts: `Author/Book`, `Author/Series/01 - Book`, `Author - Title`, a single `.m4b` or `.m4a` file, and books split over many `.mp3` files or `CD 1` / `Part 2` / `Disc 02` folders. For music it understands `Artist/Album (Year)` and `Artist - Album` with disc folders.
- Tags win over folder names. An ASIN tag (or `[ASIN]` in the path) or MusicBrainz ids in the tags give an exact match. Otherwise it searches by title and author or artist.
- Problems that would block a download, such as a total length that differs from the catalogue's, are shown as warnings here and do not stop the import.

Scans are kept until Arclight restarts.

## Related

- [Wanted](wanted.md) - what is missing and how it is searched
- [Interactive search](interactive-search.md) - pick a release yourself
- [Quality profiles](quality-profiles.md) - what "good enough" means
- [Media management](media-management.md) - naming, root folders, recycle bin and versions layout
- [Subtitles](subtitles.md)
- [Discover and requests](discover-and-requests.md)
- [Calendar](calendar.md)
- [Glossary](../GLOSSARY.md)

## Add another language (audio or subtitles)

Use **Add additional…** to add a language to a title without losing what it already has. It is on
a movie's and a series' details page, on each season and episode row, and in the Library bulk bar
(select several titles first). The dialog has two tabs, **Audio language** and **Subtitle
language**. Before you confirm, it shows a preview per title: which languages its files have now
and what will happen. Nothing is saved until you press **Confirm**. The details page shows the
title's audio and subtitle languages as chips; languages you added are marked, and you can remove
one there with its **×**.

**Subtitle language.** Pick one or more languages, each with its forced and hearing-impaired
setting (the same choices as a language profile). The languages are added to that title only;
the shared language profile is not changed, so other titles using it are not affected. Existing
subtitles stay. With **Search now** on, Arclight searches the subtitle providers straight away;
each title then reads *found*, *not found yet* (Arclight keeps looking on the normal subtitle
schedule) or *already has it*. If you tick **Generate with Whisper if no provider has it** and a
Whisper provider is set up under Settings -> Subtitles (it does not have to be enabled),
languages no provider has are generated from the audio. That is
slow, so it can still be running after the dialog closes. A language added this way is wanted even
when the title's language profile already counts as complete, and titles without a language
profile get subtitles for just the added languages.

**Audio language.** Pick one language. If a title's files already have it (from media analysis),
the preview says so and nothing is searched. Otherwise choose how to get it:

- **Find a release that has both.** Arclight looks for a multi-audio release that carries the
  new language plus every language the current file has, at the current quality or better (judged
  by the title's quality profile). The current file is replaced only after the new one has
  imported, and it goes to the recycle bin if you use one. The requirement is saved, so later
  upgrades also have to keep that language. Releases without it are rejected with "Missing
  required audio language", which you can see under the title's **Decisions** tab.
- **Add it as a separate version.** Arclight adds a version slot named after the language (for
  example "Spanish", or a name you type) that needs that audio, keeps the current file as the
  "Standard" version, and searches for the new one. Versions belong to the whole series, so on a
  season or episode this applies to every episode.

Arclight never merges audio tracks from different releases into one file. Two releases rarely
line up exactly (different cuts, intros, frame rates or lengths), so a borrowed track drifts out of
sync. That is why it replaces the whole file or keeps a separate copy instead.

Files whose audio has not been analysed yet (press **Analyze** in a title's Files tab, or run
`AnalyzeMedia` under System -> Tasks) count as not having the language. Searches started from the
dialog run as an `AdditionalLanguageSearch` task under System -> Tasks; anything grabbed goes
through the normal queue and shows in Activity. Each request and its outcome appear in the
title's **History** as "Additional language".

---
