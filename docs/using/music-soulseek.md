# Music: Soulseek through slskd

Arclight can use Soulseek as an extra source for music, next to your indexers and download clients. It does this through [slskd](https://github.com/slskd/slskd), a Soulseek client that runs as its own service and has a web API. You run and configure slskd yourself. Arclight only talks to its API: it searches, queues files, and imports them once they finish.

This is off by default. It only shows while music is turned on.

Soulseek is a peer-to-peer network. Other users see your IP address, and slskd shares the folders you tell it to share. Run slskd behind your VPN, as you would any other peer-to-peer client (see [VPN](vpn.md)). Only download what you are allowed to.

## Setting it up

1. Install slskd and log it in to the network. Follow its own documentation.
2. In slskd's configuration, add an API key under `web.authentication.api_keys`.
3. In Arclight, open **Settings > Download Clients** and scroll to **Soulseek (slskd)**.
4. Fill in the fields below, press **Test**, then **Save**.

| Setting | What it does |
|---|---|
| Enable Soulseek | Turns the feature on. Default: off |
| Host, Port, Use SSL, URL base | Where Arclight reaches slskd. The default port is 5030. In Docker, use slskd's container name, not `localhost`. Set URL base only when slskd sits behind a reverse-proxy path |
| API key | One of the keys from step 2. It is stored like other secrets and shown masked |
| Downloads folder | slskd's downloads folder **as Arclight sees it**. slskd usually runs in its own container, so this is the path where that folder is mounted in Arclight's container. Without it, finished downloads cannot be imported |
| Import mode | **Copy** leaves slskd's files where they are, so you can keep sharing them. **Move** removes them after the import |
| Search time | How long slskd collects answers for one search (5 to 120 seconds, default 15) |
| Longest peer queue | Peers that have no free upload slot and a longer queue than this are skipped (default 50) |
| Give up after | A download that makes no progress for this many hours is marked failed (default 24) |
| Search wanted albums automatically | Every 6 hours, searches up to 5 missing albums and grabs the best accepted folder for each. Default: off |

**Test** checks the address and key, and says whether slskd is logged in to the network. It never saves anything.

## Searching for an album

While Soulseek is on, an admin sees two more buttons on an album's page:

- **Search Soulseek** opens a list of matching folders, best first. Change the query and search again if nothing fits.
- **Soulseek auto** searches and grabs the best accepted folder straight away. If no folder is good enough, nothing is grabbed and a message says why.

Each result is one peer's folder. Disc folders such as `CD1` and `CD2` count as one album. Arclight matches the folder's files against the tracks of the album's selected edition. It uses the same matcher and **Track match threshold** as normal imports (Settings > Media Management > Audio import). Then it judges the folder by the artist's quality profile.

A folder is **accepted** when none of these apply:

| Reason | Meaning |
|---|---|
| Quality not allowed by the profile | The folder's quality is not in the artist's quality profile |
| Not an upgrade over the files on disk | You already have every track, and the folder is not better than the worst of them |
| Too few tracks | Not enough of the album's tracks are in the folder |
| Missing wanted tracks | Some tracks are set as not wanted, and the folder lacks one of the wanted ones |
| Peer queue too long | See **Longest peer queue** above |
| Mixes lossless and lossy files | Some files are FLAC (or another lossless format) and some are MP3 (or another lossy one) |

A folder's quality comes from the file extension, bitrate and bit depth that the peer reports. A folder is only as good as its worst file. Ranking puts accepted folders first, then higher quality, more matched tracks, a better match, a free upload slot, a shorter queue and a faster peer.

You can grab a folder that was not accepted. Arclight queues only the folder's audio files that matched a track.

## After a grab

The download shows in the **Soulseek downloads** list in the same settings section. Arclight checks slskd every 2 minutes:

| Status | Meaning |
|---|---|
| Queued | slskd has the files queued, locally or with the peer |
| Downloading | At least one file is transferring. The bar shows progress across all files |
| Importing | Every file finished. Arclight is importing the folder |
| Imported | The album was imported like any other music download (naming, tags, cover art) |
| Failed | A transfer failed with nothing left to wait for, it stalled, no downloads folder is set, or the import found nothing. The message says which |

**Remove** cancels any transfers that are still running in slskd and removes the entry. Tracks that were already imported stay in the library.

Imports go through the normal music importer. A grab that does not match well enough lands in [Activity](activity.md) > Manual import, the same as any other music download.

Folder and file names come from the peer, so Arclight never trusts them as paths. A name of `.` or `..`, an empty name or a drive letter becomes `_`. Arclight only imports folders strictly inside the downloads folder. In **Move** mode it only removes a folder that is emptied by the import and also strictly inside the downloads folder; it never removes the downloads folder itself.

## When something goes wrong

| Symptom | What to check |
|---|---|
| Test says it cannot reach slskd | Host, port, SSL and URL base. From Arclight's container, slskd's port must be reachable |
| Test says the API key was refused | The key must match one in slskd's `web.authentication.api_keys` |
| Test passes but says "not logged in" | slskd is running but not connected to Soulseek. Check its own log and login |
| Search finds nothing | Try a shorter query (just the album title). Peers may be offline, so try again later |
| Downloads finish but fail with no files | **Downloads folder** does not point at slskd's downloads folder as Arclight sees it |
| Downloads stay queued | The peer has a long queue or went offline. Lower **Longest peer queue**, or remove the download and pick another folder |

## Related

- [Download clients](download-clients.md)
- [Music: cue sheets, tags and covers](music-cue-and-tagging.md)
- [Quality profiles](quality-profiles.md)
- [Wanted](wanted.md)
- [VPN](vpn.md)
