# Search and commands

Two boxes let you reach anything in Arclight from any page:

- the **search bar** at the top (press **/**) finds things: titles, settings, downloads, requests;
- the **command palette** (press **Ctrl+K**, or **Cmd+K** on a Mac) does things: search for upgrades, refresh, approve requests, switch theme.

Both use the same forgiving matching: case, accents and punctuation do not matter, and you can shorten words ("upg" for "upgrades", "dn prt" for "Dune: Part Two"). Exact and prefix matches are listed first.

On a phone, the top bar has a search icon and a keyboard icon. Each opens its box full screen.

## Universal search

Type in the search bar at the top. The results come in groups, your own things first and Discover last:

| Group | What it finds |
| --- | --- |
| Actions | Commands from the palette that match what you typed ("refresh severance"). Commands that need a confirmation, or a title still to pick, continue in the palette. |
| Library | Series, movies, episodes, artists, albums, authors and books, with poster and status (monitored, missing, downloaded). |
| Settings | Every settings page, found by its name or by what is on it ("qbittorrent" finds Download clients, "naming" finds Media management). Also your named items: indexers, download clients, notifications, import lists, quality profiles, custom formats, users and tags. |
| Activity | Downloads in the queue and recent history entries. |
| Requests and issues | Requests and issues by title. |
| System | Scheduled tasks and the System pages (tasks, logs, backups, updates). |
| Docs | The in-app help pages. |
| Pages | Every other page you can open. |
| Discover | Titles not in your library, from TMDB, and artists (MusicBrainz) and authors (Audible) when Music or Audiobooks is on. Admins get **Add**, everyone else **Request**. Also "Find people named…" and, for admins, "Search indexers for…". |

Settings pages, docs and commands appear as soon as you type. The library, settings items, activity and requests follow a moment later in one request. The Discover lookups wait until you have typed at least three characters and stopped for a moment.

Each group shows five rows. **See all N** opens the rest of that group. Use the arrow keys to move through the rows, **Enter** to open one and **Esc** to close.

What you see depends on your account. Family members and friends using the request portal only see their own requests and issues. People given read-only app access see only the areas they were given (for example the library). Settings, users, tags, tasks and the queue are for admins only.

Selecting a settings item, such as an indexer, opens its settings page.

## Command palette

Press **Ctrl+K** (or **Cmd+K**), or tap the keyboard icon on a phone. Type a command, optionally followed by a title:

- `upg dune` finds **Search for upgrades → Dune**;
- `refresh severance` finds **Refresh metadata → Severance**;
- `add movie Blade Runner` opens **Add new** with "Blade Runner" already in the search box;
- `approve all` finds **Approve all pending requests**.

If you pick a command that needs a title but did not type one, the palette asks for it. Commands that change many things at once ask **Confirm** first. Press **Enter** to run it, or **Backspace** to go back.

With nothing typed, the palette shows:

- **This page**: on a movie, series, artist, author or book page, its commands come first and need no title ("Search for upgrades" searches the page you are on);
- **Recent**: the last five commands you ran (stored in this browser only);
- **Commands**: every command.

Type **?** to list every command, tasks, themes and pages included.

The outcome shows as a notification. Long-running work (searches, refreshes, renames, health checks, tasks) runs as a job, which you can follow in **System > Tasks**.

### Commands for a title

These take a title from your library. The palette only offers a command for the kinds of titles that support it.

| Command | Works on | What it does |
| --- | --- | --- |
| Open | Movies, series, artists, authors, books | Opens the title's page. Typing just a name does this. |
| Search for upgrades | Movies, series | Searches for better releases of files below the profile's cutoff. |
| Search | Movies, series, artists, authors, books | Automatic search for what is missing, like the Search button on the title's page. |
| Interactive search | Movies, series | Opens the release list so you can pick one. |
| Refresh metadata | Movies, series, artists, authors | Reloads the title's details. |
| Monitor / Unmonitor | Movies, series, artists, authors, books | Turns monitoring on or off. |
| Rename files | Movies, series | Renames the files to your naming format. Asks first. |
| Check health | Movies, series, artists, authors, books | Starts a [health check](health-scan.md) of the title's files. |
| Analyze media files | Movies, series | Re-reads codec, resolution and audio details with ffprobe. |

### Other commands

| Command | Who | What it does |
| --- | --- | --- |
| Add series / Add movie / Add artist / Add author | Admins | Opens **Add new** on that kind, with the rest of what you typed in the search box. Artist and author need Music or Audiobooks turned on. |
| Search indexers | Admins | Opens the indexer search with what you typed. |
| Search all missing | Admins | Searches every missing movie and episode. Asks first. |
| Search all cutoff unmet | Admins | Searches upgrades for every movie and episode below its cutoff. Asks first. |
| Approve all pending requests | Admins and request managers | Approves every pending request. Asks first. |
| Pause all torrents / Resume all torrents | Admins | Pauses or resumes every torrent in the built-in torrent engine. Only shown while the engine is on. Asks first. |
| Show stalled downloads | Admins | Opens the queue filtered to downloads with a warning (stalled, no peers, import blocked). |
| Import files manually | Admins | Opens Manual import. |
| Run task: *name* | Admins | Runs any scheduled task now, such as RSS Sync or Backup. |
| Switch theme: *name* | Everyone (when the admin allows choosing) | Switches to an installed theme and saves it to your account. Each theme is light or dark on its own; there is no separate light/dark switch. |
| *Section › Page* | Everyone | Opens any page you can see in the menu, every settings page included. |
| Request a title | Everyone | Opens Discover (the request portal for non-admins). |
| Show keyboard shortcuts | Everyone | Opens the shortcut sheet. |

The palette only lists commands your account may run. A family member using the request portal sees navigation, themes and the request command, but no library or admin commands.

The palette never runs what you type. Your text only picks one of the commands above and, where a command takes one, a title or a name.

## Related

- [Library](library.md)
- [Activity](activity.md)
- [Health scan](health-scan.md)
- [System](system.md)
