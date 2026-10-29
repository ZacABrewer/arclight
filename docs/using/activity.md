# Activity

Activity is where you watch Arclight work: what is downloading right now, what happened to past grabs, which releases are blocked, and what is waiting to be imported. You will mostly use it when a download looks stuck or a title has not shown up in your library yet. Activity is visible to administrators only. Find it in the left menu under **Activity**.

The sub-pages are **Queue**, **History**, **Blocklist**, **Pending**, **Cross-seeds**, **Transcode jobs** and **Manual import**.

## Queue

**Activity > Queue** lists everything that has been sent to a download client and has not finished importing. Releases you grab show up here while they download and then import. When nothing is there it says "Queue is empty".

### Columns

| Column | What it shows |
| --- | --- |
| Title | The release name, with how long ago it was added. |
| Quality | The quality read from the release name. |
| Prot | The protocol (torrent or usenet). |
| Client | Which download client holds it. |
| Progress | A progress bar. |
| Size | Total size. |
| Speed | Download and upload rate (when the client reports it). |
| Peers | Connected peers, with seeds in brackets, for example `4 (1)`. |
| ETA | Estimated time left. |
| Status | A colored chip that says why the item is or is not moving (see below). |

Click a column header to sort. Tick the boxes on the left to select several rows (the header box selects the whole page), then use the bar at the bottom: **Remove...**, **Retry import**, **Send now** (shown when some selected items have not been sent to a client yet), and, for clients that report a queue order, **Move to top**, **Move to bottom** and **Re-announce** (torrents).

By default the queue shows only downloads Arclight grabbed. Switch on **Show unknown** to also list downloads in your client that are not linked to a series or movie.

### Row buttons

| Button | What it does |
| --- | --- |
| Info | Expands a detail panel under the row: live numbers, a piece map, the peers list and a timeline. |
| Details | Built-in torrent engine only. Opens the torrent drawer (see below). |
| Send now | For an item that is "Waiting to send" (not yet in a client). Sends it now. |
| Import | Opens Manual import for that download. |
| Remove | Opens the remove dialog. |

### Removing a download

The remove dialog has three choices:

| Option | What it does |
| --- | --- |
| Remove from client | Deletes the download and its data from the download client. When the item was never sent, the dialog says "Not sent to a download client yet." |
| Add to blocklist | Stops this release from being grabbed again and searches for a replacement. |
| Skip redownload | Blocklists the release without searching for a replacement. |

### Status chips: why is it not moving?

Every queue row has one chip with a short label. Hover it (or focus it with the keyboard) to read the full sentence. The color tells you how serious it is: green is fine, grey is informational, amber is a warning, red is an error.

| Chip | Color | What it means | What to do |
| --- | --- | --- | --- |
| Downloading | green | Data is arriving. | Nothing. |
| Waiting to send | grey | Chosen but not yet handed to a client. | Wait, or use **Send now**. |
| Fetching metadata | grey | A torrent is still getting its file list from peers. | Wait. |
| Checking files | grey | The client is checking data already on disk. Also shown while the built-in engine starts up. | Wait. |
| Moving files | grey | The client is moving finished files. | Wait. |
| Queued | grey | Waiting for a free download slot in the client. | Wait, or raise the client's active-download limit. |
| Paused | grey | Paused in the client. | Resume it in the client or the torrent drawer. |
| Paused - VPN kill switch | red | The built-in engine paused everything because the VPN is down. It resumes on its own when the VPN reconnects. | See [Paused by VPN kill switch](../TROUBLESHOOTING.md#paused-by-vpn-kill-switch). |
| No peers | amber | The torrent has no connected peers yet. | See [No peers](../TROUBLESHOOTING.md#no-peers). |
| Stalled | amber | No new data for the number of minutes set under "Stalled download after". | See [Stalled](../TROUBLESHOOTING.md#stalled). |
| Disk full | red | The download volume does not have enough free space to finish. | Free some space. |
| Client unreachable | red | The download client did not answer. | Check the client under **Settings > Download Clients**. |
| Missing from client | amber | The client no longer reports this download (someone removed it there). | Remove it from the queue and search again. |
| Warning | amber | The client or Arclight reported a problem. Hover for the message. | Read the message. |
| Failed | red | The client reported a failure, or the download failed. | See [Download stuck](../TROUBLESHOOTING.md#download-stuck). |
| Completed | green | Download finished. | Nothing, import follows. |
| Waiting for import | grey | Finished, waiting for the import job. | Wait a couple of minutes. |
| Importing | grey | Files are being moved or linked into the library. | Wait. |
| Import blocked | amber | The import hit a problem. Arclight keeps retrying it. | See [Import blocked or failed](../TROUBLESHOOTING.md#import-blocked-or-failed). |

The checks run in a fixed order, so a download paused by the kill switch is shown as "Paused - VPN kill switch" even though the client itself only says "paused". A download is only marked stalled when it is not paused, queued, checking, or held by the kill switch.

Arclight retries pending imports on its own every 2 minutes. **Retry import** (on selected rows) runs that job right away.

### The stall timer

**Settings > Media Management** has a field called **Stalled download after**. It is in minutes, default 10, maximum 1440, and 0 turns it off. A download that receives no data for that long gets the Stalled chip and a "Stalled" entry in its timeline. Paused, queued and kill-switch-paused downloads are never flagged.

### Banner above the queue

When the built-in engine or the VPN has a problem, a banner appears above the table:

- **Downloads are paused by the VPN kill switch.** The engine is locked down. The banner shows the reason, since when, and how many torrents will resume on their own.
- **The VPN is down.** Shown when the VPN is enabled but not connected.
- A warning that the kill switch paused downloads 3 or more times in the last hour, which means the VPN connection or its status checks are unstable.

See [VPN](vpn.md) for the settings behind these.

### The Info panel and timeline

Click **Info** on a row to see:

- **Live**: download and upload rate, connected peers and seeds, swarm size (seeds and leechers the trackers report), ratio, TCP and uTP peer counts and encrypted peers. Which of these appear depends on the client. The built-in engine fills them all, qBittorrent most, usenet clients only the rates.
- A pieces bar (built-in engine) showing how many pieces you have.
- **Left** and **ETA**, and **Last data** when the item is stalled.
- **Timeline**, newest first, one line per event: Waiting to be sent, Sent to download client, Download started, Metadata received, Paused, Resumed, Stalled, Moving again, Download completed, Import started, Imported, Import blocked, Import failed, Removed, Error.
- **Peers**: client name, address, connection badges and rates.

### Torrent drawer (built-in engine)

For downloads in the built-in torrent engine, **Details** opens a side drawer with tabs:

| Tab | What it shows |
| --- | --- |
| General | State, progress, size, transferred, ratio, rates, ETA, peers and swarm, pieces, save path, category, added and completed dates, and whether the torrent is private. |
| Peers | Every connected peer: address, client, source, flags, connection, progress and rates. |
| Trackers | Each tracker URL, tier, state, peers, seeds and leechers, and the next announce time. Trackerless torrents say "Trackerless (DHT / PEX only)." |
| Files | Each file with its size, progress and a priority selector: Skip, Normal, High, Max. |
| Web seeds | HTTP sources, when the torrent lists any. |
| Limits | A download and upload limit for this torrent only, plus per-peer limits. Leave a field empty or 0 for unlimited, then click **Save limits**. Also a **Super-seeding** switch (only useful when you are the first seeder). |

Drawer buttons: **Pause** or **Resume**, and **Recheck** (verify the files on disk).

Engine-wide settings (speed limits, ports, VPN binding) live in **Settings > Torrent Engine**; see [Download clients](download-clients.md).

> Coming soon: queue priority (choosing which downloads go first). This page will be updated when it ships.

> Coming soon: automatic recovery of stalled downloads and "try another release". This page will be updated when it ships. Today a stalled download is flagged but not replaced on its own. To get another release, remove it with **Add to blocklist** ticked, which searches for a replacement.

## History

**Activity > History** records what happened to every grab. Filter by **Event type** (All events, or one type) and choose **Newest first** or **Oldest first**.

| Event | Meaning |
| --- | --- |
| Grabbed | A release was sent to a download client. |
| Download folder imported | The download was imported into the library. |
| Download failed | The download failed. |
| File deleted | A library file was removed. |
| File renamed | A library file was renamed. |
| Download ignored | The download was ignored. |
| File transcoded | A library file was remuxed or transcoded in place. |

Click a row to open its details: source title, date, quality, languages and download id. Buttons in the details:

- **Mark failed**: only for Grabbed events. The release is blocklisted and, unless disabled, a replacement is searched for.
- **Redownload**: searches again for the episode or movie. Disabled if the event is not linked to one.
- **Why this release**: shows the reasoning behind the grab. See [Interactive search](interactive-search.md#why-this-release).

Tick rows to act on several at once: **Mark failed** (asks first, with the count) and **Search again**. Events that do not allow it, such as marking an import as failed, are listed as failed in the result message; the others still go through. History records cannot be deleted.

## Blocklist

**Activity > Blocklist** holds releases that failed or were rejected manually. Arclight will not grab a blocked release again. The list shows the reason. You can:

- **Add to blocklist** by hand: choose a series or movie, type the release name exactly as the indexer lists it, and give a reason.
- Select entries and remove them (it asks first, with the count). Removed releases can be grabbed again by the next search.
- **Clear all** empties the whole blocklist (it asks first).

## Pending

**Activity > Pending** holds releases that are waiting instead of being downloaded, either because a delay profile says to wait ("Waiting for preferred protocol") or because the download client is unavailable. Columns include Reason, Delay profile and "Grabs in". **Grab now** skips the wait. The remove button discards the release. Tick several rows to **Grab now** or **Delete** them together. See [Quality profiles](quality-profiles.md) for delay profiles.

## Cross-seeds

**Activity > Cross-seeds** lists releases the cross-seed feature found on other trackers and is seeding: client, info-hash, save path, state and any message. It stays empty ("No cross-seeds yet") until a search finds the same release on another tracker. The list is read-only, so it has no bulk actions. Configure it under **Settings > Cross-seed**.

## Transcode jobs

**Activity > Transcode jobs** lists remux and transcode work: the file path, trigger (a rule or Manual), status, progress, when it was queued and any message. Cancel a job with the cancel button on its row, or tick several and press **Stop** (it asks first). Jobs that already finished are reported as not stopped. Configure rules under **Settings > Transcode**.

## Manual import

**Activity > Manual import** is for files Arclight did not import by itself. It is a short wizard, and nothing moves until you confirm.

1. Pick a source: a download that "Needs import", or choose a folder.
2. Review **Files found**. Every video file under the source is listed, except ones already in the library.
3. Map each file to a series and episodes, or to a movie. You can also set season, quality, release group, languages and version.
4. Choose the **Import mode**: **Copy or hardlink** (hardlinks when the library is on the same disk, otherwise copies; the original stays in place, so seeding continues; hard links need downloads and library under one shared mount, see [Folders and hard links](../getting-started/folders-and-hardlinks.md)) or **Move** (moves the files into the library; the download client loses them).
5. Confirm, then read the import results.

You can jump straight here from a queue row with the **Import** button.

## Related

- [Wanted](wanted.md) - what Arclight is still looking for
- [Interactive search](interactive-search.md) - grab a release yourself
- [Download clients](download-clients.md) and [VPN](vpn.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
- [Glossary](../GLOSSARY.md)
