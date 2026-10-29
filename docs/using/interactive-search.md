# Interactive search

Automatic search picks a release for you. Interactive search lets you see every release the indexers returned, why each one was accepted or rejected, and choose one yourself. Use it when automatic search found nothing, grabbed something you did not want, or when you simply want a specific release.

There are two places to do it:

- **Library interactive search**: for a series, a season, an episode or a movie that is already in your library. Arclight judges every release against that item's quality profile and rules.
- **The Search page** (**Search** in the left menu): a free-text search across all your indexers, like a manual search in an indexer's website. Admin only.

## Library interactive search

### Opening it

| Where | How |
| --- | --- |
| Series page | **Interactive search** button at the top (whole series), the **Interactive** button on a season row, or the interactive search button on an episode row. |
| Movie page | **Interactive search** button at the top. |
| Series or movie page, **Search** tab | Runs the same search and shows the results inline. |

Arclight asks every indexer that has interactive search enabled. This can take several seconds while it says "Searching indexers". If nothing comes back, the table says "No releases found. Every enabled indexer was searched."

### The table

| Column | What it shows |
| --- | --- |
| Source | The protocol: torrent or usenet. |
| Title | The release name. If the indexer gave a link, the title opens its info page. |
| Indexer | Which indexer returned it. |
| Age | How old the release is (days, hours or minutes). |
| Size | File size. |
| Peers | For torrents, seeders / leechers (`?` if the indexer did not say). A dash for usenet. |
| Quality | The quality Arclight read from the name. |
| Version | Only for items with several versions (for example 1080p and 4K). Shows which version slot the release would fill. |
| Formats | Custom formats that matched, and the total custom format score. |
| Decision | **Approved**, or a count of rejections such as "2 rejections". |
| Grab | **Grab**, or **Grab anyway** for a rejected release. |

Click a column header to sort. The default order puts approved releases first, then temporarily rejected, then rejected.

### Filtering the results

A search can return hundreds of releases (a popular movie often brings back 300 or more). The row of filters above the table narrows down what was already found, without searching the indexers again:

| Filter | What it does |
| --- | --- |
| Title contains | Every word you type must appear in the release name. Case and the dots, dashes and underscores in release names are ignored, so `part two 1080p` finds `Dune.Part.Two.2024.1080p.WEB-DL`. |
| Quality | Pick one or more qualities. Only the qualities in the results are listed, best first. |
| Indexers | Pick one or more indexers. |
| Protocol | Any protocol, Torrent or Usenet. Shown when the results hold both. |
| Decision | All decisions, Approved only, or Rejected only (rejected includes temporarily rejected). |
| Min size / Max size | Bounds in GB, decimals allowed (`0.5` for 500 MB). |
| Min seeders | Hides torrents with fewer seeders, or with an unknown count. Usenet releases have no seeders and are not affected. Shown when the results hold torrents. |

The right end of the row says how many releases are shown, for example "42 of 318 releases". **Clear** resets every filter. If the filters hide everything, the table says "No releases match these filters" with a **Clear filters** button. The filters start empty each time you open interactive search for another item. They work the same for music albums and audiobooks. On a phone each filter takes its own line.

### Rejections

Hover (or focus) the rejections chip to see every reason. Each rejection is one of two kinds:

- **Permanent**: this release will not be accepted as it is. For example the quality is not wanted in the profile, the file is too small, or the release is blocklisted.
- **Temporary**: checked again later, so it may become acceptable. For example it is younger than the minimum age, or a delay profile is still waiting for a better release. Temporarily rejected releases are shown in amber.

Common reasons you will see, in plain words:

| Message (roughly) | What it means |
| --- | --- |
| `<quality> is not wanted in profile` | The quality profile does not allow this quality. |
| Custom Formats score is below the profile minimum | The release scores too low for the profile. |
| `<size>` is smaller than minimum allowed | Below the size limit for its quality (see [Media management](media-management.md) and [Quality profiles](quality-profiles.md)). |
| Not enough seeders | Fewer seeders than the indexer's minimum. |
| Release is blocklisted | You or Arclight blocked it before. See [Activity > Blocklist](activity.md#blocklist). |
| Release is already in the download queue | Already downloading. |
| Episode is not monitored | The episode is not monitored. |
| Episode has not aired yet | Single-episode releases before the air date are refused unless allowed. |
| Only N minutes old, minimum age is M minutes | Usenet minimum age setting. |
| Older than configured retention | Usenet retention setting. |
| Sample / Hardcoded subs found | The release looks like a sample, or has burned-in subtitles. |
| Waiting for better quality release | A delay profile is holding the grab. See [Activity > Pending](activity.md#pending). |
| Season pack upgrades only X of Y episodes | A season pack would only improve some episodes. |
| The quality or format already on disk is as good or better | Several "cutoff met" and "not an upgrade" messages. Nothing to gain. |

The wording comes from Arclight's decision engine, so you may see other messages for rarer cases.

### Grabbing a release

Click **Grab**. The release is sent to your download client and appears in [Activity > Queue](activity.md). The grab is attached to the series, episodes or movie you searched for.

A rejected release shows **Grab anyway** instead. Clicking it lists the rejections and asks you to confirm; the release is then grabbed and tracked like an approved one. Your profiles and rules are not changed. A release Arclight cannot match to the series, movie, album or book you searched for stays disabled: use the Search page below to force grab it.

#### Kept by choice

Arclight remembers that you overrode the rules. The grab is recorded in [Activity > History](activity.md) with a **Grabbed anyway** line listing the rules you overrode, and the file it brings in is marked **Kept by choice** in the item's **Files** tab (for an album or a book, on each of its files). Hover the marker to see the rules you overrode.

While a file is kept by choice, automatic searches (RSS sync, the missing and cutoff unmet searches, and the **Search** buttons) never replace it. Their releases are rejected with "Kept by your choice (grabbed anyway); upgrades are paused for this file", and the item is left off [Wanted > Cutoff unmet](wanted.md#cutoff-unmet). For music the whole album is paused, for audiobooks the whole book. Interactive search is not paused: you can still pick a better release by hand, and the new file replaces the kept one as usual.

To go back to normal upgrades, click **Allow upgrades again** next to the marker. For an album or a book this clears the marker on all its files.

Only permanent rejections count as an override. A release that only had temporary rejections (a delay or the minimum age, for example) would have been grabbed later anyway, so its file is not marked.

The import respects the override too: a release you grabbed anyway replaces the file it was grabbed for even when it is not better than that file (for example a smaller encode you chose on purpose), instead of being refused as "Not an upgrade for existing file".

## Why this release

Every time Arclight searches or reads RSS for an item, it keeps a record of each release it judged, and why. Use this to answer "why did it download that one?" or "why did it skip the one I wanted?".

- On a series or movie page, open the **Decisions** tab. You will see batches, newest first. Each batch is labeled with what triggered it: Search, RSS sync, Interactive search, Release push, or Pending re-check, plus the time.
- In **Activity > History**, open a Grabbed event and click **Why this release**. This shows the batch that led to that grab.
- Each row shows a rank, the release name, quality and score, **Approved** or the list of rejections (Permanent or "Temporary, checked again later"). The one that was grabbed has a **Grabbed** chip, and the best choice among approved releases has **Best match**. A batch shows how many releases were judged, how many approved and how many rejected, and links to the grab in History.

An empty tab says "No decisions logged yet." The log is pruned automatically; by default it keeps 14 days.

## The Search page

Open **Search** in the left menu. Use it to find a release by name, including things that are not in your library.

1. Type a title or release name and click **Search**. You can also use the top bar's search; library matches show as you type.
2. Optionally narrow it with the filters: **Type** (All types, TV, Movies), **Categories** and **Indexers** (only indexers with interactive search enabled are listed).
3. Results appear in a table with Title, Indexer, Age, Size, Peers (seeders / leechers for torrents, grabs for usenet), Quality, Formats, a rejection icon and actions. Use **Filter titles** and the protocol selector (Any protocol, Torrent, Usenet) to narrow the results afterwards. The heading shows "N of M results".
4. Use the download icon to get the .torrent or .nzb file, or open the magnet link. Use **Grab** to send it to your download client.

When you click **Grab** on this page, Arclight checks whether the release matches something in your library:

- If it matches, it is grabbed and tracked like any other grab.
- If it matches nothing, you are asked **Force grab?**. Force grabbing sends it to the default client for that protocol. It will show as unknown in the queue (turn on **Show unknown**) and will not be imported. Use this for things you manage by hand.

If a result has an alert icon, hover it to read the reasons listed for that result. For the full judgment against a specific item's profile, use the library interactive search above.

## Related

- [Wanted](wanted.md) - automatic searching and what is missing
- [Activity](activity.md) - the queue, history and blocklist
- [Quality profiles](quality-profiles.md) - why releases are accepted or rejected
- [Indexers](indexers.md) - enable interactive search per indexer
- [Troubleshooting: nothing found](../TROUBLESHOOTING.md#nothing-found)
