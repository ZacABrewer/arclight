# Podcasts

Arclight can follow podcasts. It reads each podcast's RSS feed, downloads new episodes into a podcast folder and tells your media server to pick them up. Podcasts have their own section in the menu, their own settings and their own folder. They are separate from music and audiobooks, and they never use indexers or download clients: episodes are fetched straight from the podcast's own feed.

Video feeds work if the podcast offers them in its RSS feed. YouTube channels are not supported.

## Turning podcasts on

Podcasts are off until an admin turns them on:

1. Open **Settings > General > Features** and switch on **Podcasts**.
2. Open **Settings > Podcasts** and set the **Root folder**. Each podcast gets its own folder inside it. Use a folder your media server can see (see [Media servers](#media-servers)).

When the feature is on, **Podcasts** appears in the menu, podcast episodes appear on the [Calendar](calendar.md), and request-portal users can suggest podcasts from **Discover > Podcasts**.

## Subscribing

Open **Podcasts > Add podcast**. There are three ways to subscribe.

| Tab | How it works |
| --- | --- |
| Search | Search by title or author. Arclight uses [Podcast Index](https://podcastindex.org) when its key and secret are set in **Settings > Podcasts**, otherwise the iTunes (Apple Podcasts) directory. Pick a result to preview it, then **Subscribe**. |
| RSS URL | Paste the feed address. An Apple Podcasts link (`https://podcasts.apple.com/.../id123456789`) works too: Arclight looks up the feed behind it. **Preview** shows the title and the latest episodes before you subscribe. |
| OPML | Most podcast apps can export your subscriptions as an OPML file. Pick the file or paste its contents, then **Import**. The result lists what was added, what you already had and what failed (for example a feed that no longer exists). |

When you subscribe, Arclight reads the whole feed, so every episode is listed straight away. It downloads only the newest few (the **Backlog** setting, 3 by default). After that, new episodes are downloaded as they appear in the feed.

### Private feeds

Paid and members-only podcasts often give you a personal feed address with a password or token in it, for example `https://user:password@feeds.example.com/show.xml` or `https://feeds.example.com/show.xml?token=...`. Paste it as it is. Arclight keeps the full address and sends the credentials to that feed, but masks them (`********`) everywhere it shows the address, in the logs and in notifications. The podcast page shows a **Private feed** badge.

When you export OPML, private feeds are left out unless you ask for them, so you can share the file safely.

## The podcast library

**Podcasts** shows your subscriptions as a grid or a list, with episode counts, how many are downloaded and how many are waiting. Use the filter to see podcasts with feed problems or unmonitored ones. **Refresh all** checks every feed now. **Export OPML** downloads your subscriptions.

Open a podcast to see its details and episodes:

- **Following / Not following** turns the podcast's monitoring on or off. Unmonitored podcasts are still refreshed, so new episodes are listed, but nothing is downloaded automatically.
- **Refresh** checks the feed now. The page shows when it was last refreshed and when the next refresh is due. If the last refresh failed, the error is shown.
- **Edit** changes the podcast's own settings (below), its tags and the feed URL. Change the feed URL when a podcast moves and its old feed does not redirect.
- **Unsubscribe** removes the podcast and its episode list. Tick the box to delete the downloaded files too.
- Links to the podcast's website and its "Support the show" (funding) pages appear when the feed has them.

**Podcasts > Episodes** lists the episodes of every podcast together. You can search, filter by status and by played or unplayed, and select several episodes to download, mark played or unplayed, delete their files or skip them.

### Episode status

| Status | Meaning |
| --- | --- |
| Available | In the feed, not downloaded. Use the download button to get it. |
| Wanted | Waiting to download. |
| Downloading | Being downloaded now. |
| Downloaded | The file is in the podcast folder. |
| Failed | The download failed. Arclight tries again, up to three times. |
| Deleted | The file was deleted, by hand or by the retention settings. It is not downloaded again unless you ask for it. |

### Played episodes

Mark an episode played or unplayed by hand, or let your media server do it: once a day Arclight reads which episodes users finished in Jellyfin, Emby or Audiobookshelf (servers with **Library refresh** on in **Settings > Media Servers**) and marks them played. The played state is what **Delete played episodes** uses.

## Per-podcast settings

Every podcast has its own copy of these settings. New subscriptions start from the defaults in **Settings > Podcasts > Defaults for new podcasts**. To change one podcast, use **Edit** on its page.

| Setting | What it does |
| --- | --- |
| Download new episodes | New episodes found by a refresh are downloaded automatically. If a feed suddenly shows a lot of old episodes (a back catalogue added later), those are listed but not downloaded. |
| Backlog | When subscribing, also download this many of the newest episodes. 0 downloads none. |
| Keep the newest | Keep only this many downloaded episodes. Older files are deleted. Empty keeps all. |
| Delete played episodes | Delete a downloaded episode this many days after it was played. Empty never deletes. |
| File choice | Which file to download when an episode offers several (Podcasting 2.0 alternate enclosures): the feed's own file, audio only, video when offered, the smallest or the largest. |
| Write tags | Write title, podcast, date, description, season and episode tags into the file (ID3 for MP3, MP4 tags for M4A). Needs ffmpeg, which the Docker image includes. |
| Embed cover art | Embed the artwork in the file and save `cover.jpg` in the podcast folder. |
| Keep chapters | Save Podcasting 2.0 chapters next to the episode (`.chapters.json`) and embed them in the file when tags are written. |
| Keep transcripts | Save Podcasting 2.0 transcripts next to the episode (`.vtt`, `.srt`, `.json`, `.html` or `.txt`). |

## Settings > Podcasts

| Setting | What it does |
| --- | --- |
| Root folder | Where podcast folders are created. |
| Folder format | The podcast folder name. Default `{Podcast Title}`. |
| Episode format | The episode path inside the podcast folder, without the extension. Default `{Episode Year}/{Episode Date} - {Episode Title}`, which gives for example `The Example Hour/2025/2025-03-03 - A New Season.m4a`. |
| Refresh every | How often feeds are checked (15 minutes to 7 days, default 60 minutes). |
| Respect feed TTL | A feed that asks to be checked less often (its `<ttl>`) is checked on its own schedule. |
| Downloads at once | How many episodes download at the same time (1 to 5). |
| Proxy | An http or socks5 proxy from **Settings > Indexer Proxies**, used for feeds and downloads. A podcast with the same tag as a proxy uses that proxy instead. |
| Podcast Index key and secret | Free from [podcastindex.org](https://api.podcastindex.org). Without them, search uses iTunes. |
| iTunes country | The Apple Podcasts store used for iTunes search, for example `us` or `gb`. |

Tokens for the folder and episode formats: `{Podcast Title}`, `{Podcast Author}`, `{Episode Title}`, `{Episode Date}` (YYYY-MM-DD), `{Episode Year}`, `{Episode Month}`, `{Episode Day}`, `{Season}`, `{Episode Number}`. Use `/` to make subfolders. A `/` inside a title becomes `-`, so an episode called "Part 1/2" does not create a folder. Two episodes that would get the same file name (same date and title) are kept apart with a short code added to the second one.

## How feeds are checked

- Arclight asks the feed server whether anything changed since the last check (ETag and Last-Modified). If not, nothing is downloaded, which keeps checks light for you and the podcast host.
- When a podcast moves, Arclight follows it: a permanent redirect or an `<itunes:new-feed-url>` tag in the feed updates the stored address on its own.
- A feed that answers "gone" (HTTP 410) is marked **Feed gone** and is no longer checked automatically. A feed that fails for another reason is marked **Feed error** and tried again at the next refresh.
- Feeds that are not valid RSS or Atom (for example a web page) are reported as errors instead of being read.

## Calendar

Podcast episodes appear on the [Calendar](calendar.md) on their publish date, for podcasts you follow, and in the iCal feed as "Podcast - Episode title" events. Use the media filter to show only podcasts.

## Notifications

Two events can be turned on per connection in **Settings > Notifications** (see [Notifications](notifications.md)):

- **New podcast episodes**: new episodes found in a feed (not sent when you subscribe).
- **Podcast episode downloaded**: an episode was saved, with its size and path.

## Feeds on your local network

Feeds, episode files, artwork, chapters and transcripts are fetched from the public internet only: an address on your local network (localhost, private and link-local addresses, and names such as `nas`, `nas.lan` or `box.local`) is refused, on the first request and on every redirect. A feed's publisher decides where its episode files and redirects point, so this keeps a feed from making your server download from your own network.

The exception is a feed an **admin** adds by a local name or address, for example a self-hosted feed at `http://nas.lan:8080/feed.xml`: Arclight may then reach that one host (any port) for the feed and its files. Other local hosts stay blocked for that feed. Use the local name or address in the feed URL; a public name that only resolves to a local address on your network is treated as public and refused.

Episode files must arrive as audio or video (or a generic binary type such as `application/octet-stream`); a text, JSON or XML answer is not kept as an episode.

## Suggestions from the request portal

Request-portal users can suggest a podcast from **Discover > Podcasts**: they search the directory or paste a feed address, add an optional note and press **Suggest**. Anyone allowed to request music, audiobooks or anything at all can suggest podcasts, unless an admin turned **Podcasts** off in that user's request types (**Settings > Users**, see [Discover and requests](discover-and-requests.md)). Users who may auto-approve are subscribed straight away.

A suggested feed must be on the public internet. If the address cannot be read, the person sees one general message ("that address could not be read as a podcast feed") rather than the error the server got.

Admins and request managers review suggestions in **Podcasts > Suggestions**. **Approve** subscribes with the default settings. **Decline** takes an optional reason, which the person sees. People can withdraw their own pending suggestions.

## Media servers

After episodes are downloaded or deleted, Arclight asks the media servers that have **Library refresh** on (**Settings > Media Servers**) to rescan the podcast folder (see [Media servers](media-servers.md)):

- **Audiobookshelf** has podcast libraries. Point one at the podcast root folder and Arclight rescans it.
- **Jellyfin and Emby** have no podcast library type. Add the podcast root folder to a music library (or a mixed library), and Arclight refreshes the library that contains it.
- **Plex**: add the folder to a music library. Arclight refreshes that section.

Playing episodes is up to your media server or podcast app. Arclight does not include a player.
