# Download clients and the torrent engine

Download clients are the programs that actually fetch a release once Arclight has picked it. Arclight has its own BitTorrent engine built in, and that is the default and recommended client: it is already set up in every supplied Docker file. As alternatives it can also drive qBittorrent, Transmission, Deluge, rTorrent, SABnzbd, NZBGet, or its own engine running on another machine. This page covers Settings > Download Clients (adding and configuring clients, categories, remote path mappings) and Settings > Torrent Engine (the built-in engine's settings). Everyone needs at least one client. With the built-in engine you will not need to configure much: the defaults work. External clients are optional.

## Where things live

| What | Where |
|---|---|
| Add, edit, test, delete clients; remote path mappings | Settings > Download Clients |
| Engine-wide settings of the built-in engine | Settings > Torrent Engine |
| "Act as remote engine" switch for other Arclights | Bottom of Settings > Download Clients |
| VPN binding and kill switch | Settings > VPN, see [VPN](vpn.md) |
| What is downloading right now | Activity > Queue, see [Activity](activity.md) |

## Which client should I use?

Start with **Built-in** (first in the list when you add a client). Pick another client only if you already run it, want a usenet client, or need a different setup.

| Client | Protocol | Notes |
|---|---|---|
| Built-in | Torrent | Arclight's own engine, running inside Arclight. The default and recommended choice: nothing else to install. Works with the VPN kill switch and with private-tracker protection |
| Remote Engine | Torrent | The same engine on a seedbox or another machine. See [Remote engine](../REMOTE-ENGINE.md) |
| qBittorrent | Torrent | Optional. WebUI API v2, qBittorrent 4.1 or newer. The Docker files ship it behind the compose profile `qbittorrent` (`docker compose --profile qbittorrent up -d`) |
| Transmission | Torrent | Transmission 2.80 or newer, over its JSON RPC |
| Deluge | Torrent | Deluge 1.3 or 2.x through the Web UI. Categories use the Label plugin |
| rTorrent | Torrent | 0.9.6 or newer over XML-RPC (web server or ruTorrent) |
| SABnzbd | Usenet | 1.0 or newer, 3.0 or newer recommended |
| NZBGet | Usenet | NZBGet 16 or newer, over JSON-RPC |

On first start Arclight adds a "Built-in" client for you if no client exists (setting "Auto-register client" in the Torrent Engine page). You can run several clients at once; each release goes to a client of its protocol.

## Adding a client

1. Go to Settings > Download Clients and press **Add download client**.
2. Pick a client type.
3. Fill in the form, press **Test**, then save. Test checks the connection, the login, the version, and warns about things like a missing category. **Test all** on the main page tests every client.
4. Change nothing else if the test is green. Press **Show advanced** only for the extra options listed below.

### Searching your clients

A search box sits above the client cards once there is at least one. Every word you type has to match somewhere (in any order), case does not matter, and dots, dashes and underscores count as spaces. The count next to the box shows how many match ("2 of 9"), **Select all** then selects only the matching items, and Escape or **Clear search** shows everything again. The search is kept in the address (`?q=`). It matches the name, the kind (qBittorrent, SABnzbd, Built-in…), the protocol and where the client lives (host and port, Remote Engine URL or the built-in save path). Remote path mappings are not filtered.

### Bulk actions

Every card has a checkbox. Tick one or more and a bar appears at the bottom of the screen with "N selected", **Select all N** and the actions for the selection: **Enable**, **Disable**, **Test**, **Add tag**, **Remove tag** and **Delete**. Deleting asks first and says how many items it removes. Each item is handled on its own, so one that fails (for example a test that does not connect, or a profile still in use) does not stop the rest; a message lists what worked and why the others did not, and the failed items stay selected. On a phone the actions sit in one **Actions** menu. Remote path mappings have checkboxes too, for deleting several.

### Settings every client has

| Setting | Default | What it does |
|---|---|---|
| Name | - | Your label |
| Enable | On | Use this client for grabs and for tracking its queue |
| Client Priority (advanced) | 1 | 1 is the highest, 50 the lowest. When several clients handle the same protocol, higher priority is preferred; equal priorities are used in rotation |
| Remove Completed (advanced) | On | After a download Arclight grabbed is imported, remove it from the client together with its files once it is allowed to be removed (for torrents: the seeding goal is met). Each removal is logged and shows on the download's timeline. Downloads Arclight did not grab (added by hand, by another app, or kept in qBittorrent by a migration) are imported but never removed |
| Remove Failed (advanced) | On | Remove failed downloads from the client |
| Tags (advanced) | none | Only use this client for series and movies with at least one of these tags. Empty means everything |

An indexer can also name a specific client (see [Indexers](indexers.md)); that choice wins.

### Torrent clients: qBittorrent, Transmission, Deluge, rTorrent

| Setting | Default | What it does |
|---|---|---|
| Host | localhost | Hostname or IP of the client. In Docker use the container name or the NAS address, not `localhost` |
| Port | qBittorrent 8080, Transmission 9091, Deluge 8112, rTorrent 8080 | Web interface or RPC port |
| Use SSL | Off | Connect over HTTPS |
| URL Base (advanced) | qBittorrent and Deluge: empty. Transmission: `/transmission/`. rTorrent ("URL Path"): `RPC2` | Path prefix for reverse proxies or custom RPC paths. rTorrent: `plugins/rpc/rpc.php` for ruTorrent |
| Username, Password | empty | Login. Deluge has a password only (a fresh Deluge uses `deluge`). Leave both empty if authentication is bypassed. Passwords are never shown again after saving |
| Category (Transmission, Deluge, rTorrent: "Label") | `arclight` | Arclight adds its torrents with this category and only tracks torrents in it. Keep it dedicated |
| Post-Import Category (advanced) | none | Move the torrent to this category after import, so it leaves the tracked set |
| Directory (Transmission, rTorrent; advanced) | none | Download directory as the client sees it. Empty uses the client's own default |
| Recent Priority / Older Priority | Last (Transmission, Deluge, qBittorrent); Normal (rTorrent) | Queue position for content released within 14 days (recent) or earlier (older). Options: Last or First; rTorrent offers Off, Low, Normal, High |
| Initial State (qBittorrent) | Started | Started, Paused or Force Started (ignores qBittorrent queue limits) |
| Add Paused (Transmission, Deluge, rTorrent) | Off | Add torrents paused |
| Sequential Order, First and Last First (qBittorrent, advanced) | Off | Download pieces in order, or first and last pieces first |
| Content Layout (qBittorrent, advanced) | Default | Use qBittorrent's layout, the original layout, create a subfolder, or do not create a subfolder |

For qBittorrent in Docker (started with `docker compose --profile qbittorrent up -d`; host `localhost` in the VPN layouts, `qbittorrent` without a VPN, port 8080) with the standard one-share layout, open qBittorrent Options > Downloads and set the default save path to `/data/downloads`, with the same share mounted at `/data` in both containers. Both then see identical paths, hard links work, and no remote path mapping is needed.

Deluge labels may only contain letters, digits, `_`, `-` and `.`, and are stored in lowercase.

### Usenet clients: SABnzbd and NZBGet

| Setting | Default | What it does |
|---|---|---|
| Host, Port, Use SSL, URL Base | localhost, SABnzbd 8080, NZBGet 6789, off | Same as above |
| API Key (SABnzbd) | empty | The full API key from SABnzbd Config > General (not the NZB key). Preferred over a username and password |
| Username, Password | SABnzbd: empty (legacy login, advanced). NZBGet: `nzbget` and empty | NZBGet: the ControlUsername and ControlPassword from NZBGet Settings > Security |
| Category | `arclight` | The category Arclight assigns. Leave empty to use none |
| Post-Import Category (advanced) | none | Move the item to this category after import |
| Recent Priority / Older Priority | SABnzbd: Default. NZBGet: Normal | Queue priority. SABnzbd: Default (the category's priority), Paused, Low, Normal, High, Force. NZBGet: Very Low, Low, Normal, High, Very High, Force |
| Add Paused (NZBGet) | Off | Add downloads paused |

### Built-in client settings

The Built-in client row holds the options that can differ per client. Engine-wide ones are on the Torrent Engine page (below).

| Setting | Default | What it does |
|---|---|---|
| Category | `arclight` | Category for Arclight's torrents |
| Post-Import Category (advanced) | none | Category to move a torrent to after import |
| Download Folder | empty | Root folder. Downloads go to `<root>/<category>`. Empty uses the engine downloads folder from Settings > Torrent Engine |
| Category Folders (advanced) | none | Per-category folder overrides. A category without an entry uses `<root>/<category>` |
| Initial State | Started | Started or Paused when added |
| Seed ratio limit (advanced) | empty | Stop seeding at this ratio for new torrents. Empty uses the engine default |
| Seed Time Limit (minutes) (advanced) | empty | Stop seeding after this long. Empty uses the engine default |
| Super seeding | Off | Turn on super-seeding (BEP 16) for new torrents |
| Upload limit, Download limit | empty (unlimited) | KiB/s per torrent, for new torrents |
| Peer upload limit, Peer download limit | empty (unlimited) | KiB/s per peer connection, for new torrents |

The limit fields are saved with the client and applied to every torrent it adds from then on. They are stored settings of the client; they do not change torrents already added.

### Remote Engine client

Drives the engine agent on a seedbox or another Arclight. Setup, the agent's environment variables and how pull mode works are in [Remote engine](../REMOTE-ENGINE.md). The client's fields:

| Setting | Default | What it does |
|---|---|---|
| Agent URL | `http://localhost:7879` (template) | `http://seedbox:7879` for the standalone agent, or `http://other-arclight:7878/api/v1/engine-agent` for another Arclight |
| Token | empty | The agent's `AGENT_TOKEN`, or the other Arclight's API key. Never shown again after saving |
| Category | `arclight` | Category on the agent |
| Post-Import Category (advanced) | none | Category after import |
| Pull Mode | Off | Copy finished downloads from the agent over HTTP (resumable, SHA-256 checked) into the local folder before importing. Off means the agent shares storage with Arclight |
| Local Download Folder | empty | Pull mode: where finished downloads are copied |
| Copy Limit (KiB/s) (advanced) | empty (unlimited) | Pull mode: throttle for copying |
| Follow VPN Port (advanced) | Off | Apply this Arclight's VPN forwarded port to the agent. Only for an agent behind the same VPN connection |

To make this Arclight usable as an agent for another one, turn on **Act as remote engine** in the Remote engine panel on Settings > Download Clients. The panel shows the endpoint address to enter on the other side. The other instance signs in with this instance's API key (Settings > Security) as the token.

## Remote path mappings

Settings > Download Clients > **Remote path mappings**. Usually not needed. With the standard one-share Docker layout, every container mounts the same share at `/data`, so the client and Arclight already see identical paths (`/data/downloads/...`). Add a mapping only when the client reports file paths that Arclight cannot open as written, typically a client on another machine or a container with a different mount. Setting qBittorrent's default save path to `/data/downloads` (Options > Downloads) is the simplest way to avoid mappings.

| Field | What it means |
|---|---|
| Host | The client host exactly as written in the client's Host field (for the built-in engine, `localhost`; for a Remote Engine, the host name in the agent URL) |
| Remote path | The folder as the client reports it, for example `/downloads/` (a client with its own mount) |
| Local path | The same folder as Arclight sees it, for example `/data/downloads/` |

Example: a qBittorrent that still uses its own `/downloads` mount reports `/downloads/Show`, but Arclight sees that folder as `/data/downloads/Show`. Add a mapping `/downloads/` to `/data/downloads/`. The better fix is to mount the same folder at the same path in both containers; see [Folders and hardlinks](../getting-started/folders-and-hardlinks.md). If a download finishes but never imports, see [Remote path mapping is wrong or missing](../TROUBLESHOOTING.md#bad-remote-path-mapping) and [Import blocked or failed](../TROUBLESHOOTING.md#import-blocked-or-failed).

## Categories

A category (or label) is how Arclight tells its own downloads from yours. Arclight only tracks items in its category, so a dedicated one (the default is `arclight`) keeps your other torrents out of the queue and out of imports. Post-Import Category moves finished items elsewhere after Arclight imports them. The built-in client also lets you give each category its own save folder (Category Folders).

## Settings > Torrent Engine

These settings apply to the built-in engine only. The top of the page shows live status: engine state (Starting, Running, Lockdown, error), listening port, bound address, connected peers, DHT nodes, encrypted peers, uTP connections, VPN binding and torrent counts. Changes are saved with the page's save bar.

| Setting | Default | What it does |
|---|---|---|
| Enable engine | On | Run the built-in torrent engine. Off stops all torrents |
| Auto-register client | On | On first start, add a "Built-in" download client when none exists |
| Listen port | 6881 | Port for incoming peer connections (TCP) and DHT (UDP). A port forwarded by the VPN takes precedence; the status shows both |
| Max connections | 200 | Peer connections across all torrents (1 to 5000) |
| Max connections per torrent | 50 | Peer connections per torrent (1 to 1000) |
| Download limit | 0 (unlimited) | Global download limit in KiB/s |
| Upload limit | 0 (unlimited) | Global upload limit in KiB/s |
| DHT | On | Find peers through the distributed hash table. Never used for private torrents |
| Peer exchange (PEX) | On | Exchange peers with connected peers. Never used for private torrents |
| Max active downloads | 3 | Torrents downloading at once. -1 is unlimited; the rest wait in the queue |
| Max active seeds | 5 | Torrents seeding at once. -1 is unlimited |
| Default seed ratio | empty (unlimited) | Stop seeding at this ratio |
| Default seed time | empty (unlimited) | Stop seeding after this many minutes |
| Bind to VPN | On | When the VPN integration is enabled, bind every socket to the VPN tunnel and pause all torrents while it is down. See [VPN](vpn.md) |
| Tunnel guard | On | With the VPN on, slow the engine and cut its peer connections when the tunnel starts to choke, so the VPN stays up. See [Tunnel guard](#tunnel-guard) |
| Disk guard | On | Hold downloads to what the disk can write while received data piles up waiting for it. See [Disk guard](#disk-guard) |
| Max simultaneous checks | 2 | Torrents whose files are hashed at the same time (1 to 16). The rest wait in queue order. See [Data checks](#data-checks) |
| Magnet metadata timeout | 60 | Minutes of active time a magnet may wait for its metadata before it fails (0 to 10080). 0 waits forever. See [Magnets without metadata](#magnets-without-metadata) |
| Downloads folder | empty | Default download folder. Empty means `/data/downloads` when a `/data` folder exists (the standard Docker layout; older installs keep `/downloads`), otherwise a `downloads` folder next to your config folder. The page shows the folder actually used |
| Peer encryption | Preferred | Preferred: try encrypted first, fall back to plain. Required: encrypted only, fewer peers can connect. Disabled: plain only, peers that insist on encryption cannot connect |
| TCP | On | Accept and open TCP peer connections |
| uTP | On | Accept and open uTP peer connections on the UDP port |
| IPv6 | On | Also listen on IPv6 and use IPv6 peers when available |
| Web seed connections | 4 | Concurrent HTTP requests to web seeds per torrent (0 to 32). 0 turns web seeds off |

If you switch both TCP and uTP off, the page warns that no peer can connect. The Resume data folder (fast-resume data and saved `.torrent` files, inside your config folder) is shown but cannot be changed.

### Peer port, DHT, encryption: what to leave alone

- **Peer port.** With the VPN integration on and a provider that forwards ports (Proton), Arclight uses the forwarded port and ignores Listen port. Without a forwarded port you can still download, but fewer peers will reach you; see [VPN](vpn.md).
- **DHT and PEX** matter only for public torrents. Private trackers disable them for their torrents, and Arclight respects that.
- **Encryption.** Leave it on Preferred. Required cuts off peers that cannot encrypt; Disabled cuts off peers that require it.

### Seeding goals

Seeding is when you keep uploading after the download finishes. What Arclight does today:

1. A torrent added through the built-in client uses the client's seed ratio and seed time limits, or the engine defaults when those are empty. An indexer's own seed ratio and seed time (see [Indexers](indexers.md)) are sent along when a release is grabbed from it.
2. When a goal is met (ratio reached, or time elapsed), the engine pauses the torrent. It does not delete it.
3. With **Remove Completed** on, Arclight removes a download it grabbed, together with its files, once it is imported and its goal is met. The library keeps working when it was imported as a hardlink or copy. Each removal is logged and shows on the download's timeline. Torrents Arclight did not grab (added by hand, by another app, or kept in qBittorrent by a migration) are never removed, even when they sit in Arclight's category and get imported.
4. For tracked private-tracker accounts, the hit-and-run rule (Indexers > Tracker account) keeps a finished torrent from being removed too early. See [Indexers](indexers.md).
5. With both limits empty, torrents seed until you remove them.

> Coming soon: per-download limits editable from the queue. This page will be updated when it ships. For now, limits can be set per client for new torrents (see the Built-in client table above).

### Grabs that repeat themselves

- **Already in the client.** When a client already has the torrent Arclight sends, the grab counts as done: Arclight tracks the existing torrent and does not add it again. qBittorrent, Transmission, Deluge, rTorrent and the built-in engine all work this way. If qBittorrent has the torrent in another category, Arclight leaves it there and says so on the queue item.
- **Same release removed a moment ago.** After a download is replaced, removed from the queue, removed after its import, or removed in the client itself, Arclight does not send the same release again for 30 minutes. The client may still be deleting the old files, and a new download in the same folder would lose its files. With **Try another release**, the search picks a different release even when the blocklist box is unticked.
- **Loop guard.** If the same release goes to the same client more than 3 times in an hour, Arclight holds further grabs of it: first for 15 minutes, then twice as long each time, up to 6 hours. The log says when the hold starts.
- **Refused by the client.** A client that refuses a release (for example an invalid torrent) fails that release, and Arclight tries the next one. Only an unreachable client parks the grab and retries it a few minutes later.

### qBittorrent settings Arclight changes

Arclight leaves qBittorrent's global settings alone (ratio and seeding-time limits and their action, active torrent and upload limits, global speed limits). The only global changes it makes are these:

- **Listen port**, only with the VPN port sync on, so qBittorrent follows the forwarded port.
- **Alternative speed limits** switch on and off with the built-in engine's slow mode and schedule, when **Mirror to qBittorrent** is on (Settings > Torrent Engine). Arclight only switches off alternative limits that it switched on itself. Turn the mirror off if you manage qBittorrent's alternative limits yourself.

Per torrent, Arclight sets the category, the save path, and the ratio and seeding-time limits from the indexer's seed settings when a torrent is added.

### Tunnel guard

Behind a VPN on a NAS, a busy engine can fill the tunnel until the VPN container's own health check fails and it restarts the tunnel. Many NAS kernels have no WireGuard module, so gluetun runs WireGuard in userspace, which runs out of packets per second before it runs out of bandwidth. Hundreds of peers keep the tunnel full of small packets at any speed.

Every 3 seconds the guard times a small connection through the tunnel. The time above the lowest one in the last 15 minutes is how long packets wait in the tunnel. The guard keeps that wait under 150 ms:

- **Over 400 ms, over 800 ms in total, or no answer (choking):** the download and upload limits drop to 60% of what flows at that moment, and the guard remembers 85% of that speed as the tunnel's **ceiling**. The peer connection cap is halved (never below 40, and never above your Max connections), closing the peers that move the least data, and at most 8 connection attempts may be in progress, 3 new ones per second. After a cut it waits one check before cutting again, so the tunnel can drain. A direction that carried almost nothing (upload while nothing seeds) is not capped.
- **150 to 400 ms:** the limits hold.
- **Under 150 ms:** the limits climb back to the ceiling within a few checks. Above the ceiling they rise only 5% every 30 seconds, and only while downloads actually use the room. A choke at a lower speed lowers the ceiling.

The guard does not let go when the tunnel recovers, because the next burst would fill it again. It forgets the ceiling after 6 hours without a choke. Floors: 256 KiB/s down, 64 KiB/s up.

The status at the top of the page and the debug report's `engine` command show what the guard is limiting. It works together with the [Disk guard](#disk-guard); when both limit downloads, the lower limit applies.

If the tunnel still drops, lower **Max connections** (100 to 150 suits most NAS models behind a VPN) and **Max active downloads** first; those set the load the guard starts from.

### Memory

Each downloading torrent caches the pieces it is still receiving until they are verified, and queues writes to disk. Both come from one budget for the whole engine: 128 MiB of cache, split across the downloading torrents (at most 32 MiB each, at least 4 MiB), plus a write queue of half each torrent's share. So memory stays about the same however many torrents download at once. If the disk cannot keep up with the writes, the [Disk guard](#disk-guard) lowers the download speed so this queue does not grow. Finished data is read back from disk, and the operating system's file cache does the rest. The container's memory figure includes that file cache, which the system frees when something needs the memory; the debug report's `memory` command shows it separately as *file (page cache)*.

### Disk guard

A fast link can bring in data faster than a busy disk writes it, for example a NAS with a 4-disk RAID5 array that also serves a media server. Received data then waits in memory, the engine stops asking peers for more, and seeding stalls behind the writes. The disk guard (Settings > Torrent Engine > Disk, on by default) does by itself what you would otherwise do by hand: it sets the download limit to what the disk actually writes.

Every 5 seconds the guard compares the data waiting for the disk with what the downloading torrents may hold:

1. **Disk behind.** When a torrent has stopped requesting until its backlog drains, or the backlog is at least half of what the downloading torrents may hold, it sets the download limit to about 90% of the measured disk write speed. It never goes below 1 MiB/s, so downloads keep moving.
2. **Disk keeping up.** After 3 healthy samples in a row (backlog under 20% of the allowance, no torrent waiting) it raises the limit by a quarter.
3. **Let go.** Once the limit is well above what the swarm delivers anyway, the guard drops it.

The guard combines with your own limits and with the [tunnel guard](#tunnel-guard): the tightest limit wins. While it limits downloads, the status at the top of the page says so and shows the limit and the measured write speed. The Disk writes line shows the current write speed and how much is waiting. The debug report's `engine` command lists the same under "disk guard".

Two more things keep uploads alive while downloads write:

- At most 4 disk writes are in flight at once across the whole engine. The rest wait in line and still count towards the backlog.
- Peers asking for data you are seeding are served by at most 16 disk reads at once, and by 1 while writes lag behind. Blocks still in the cache are sent without a disk read.

The Docker image sets `UV_THREADPOOL_SIZE=16` (Node's default is 4) so disk reads, resume saves and DNS lookups are not stuck behind a few slow writes. You do not need to set it yourself unless you run Arclight outside the image.

### Data checks

A full check reads and hashes every byte of a torrent. It runs when you add a torrent whose files already exist, when you press Recheck, when saved resume data no longer matches the files, and when a torrent resumes after an error. All of these share **Max simultaneous checks** (default 2) and wait in queue order. On spinning disks every extra check only adds seeking, so keep this at 1 or 2. Settings > Torrent Engine shows how many checks are running and waiting.

A torrent whose resume data still matches its files does not use a slot: it is accepted after a few file checks.

### Magnets without metadata

A magnet link has no file list until a peer sends it. If no peer has it, the torrent would wait for days. After **Magnet metadata timeout** minutes of active time (only time the torrent is running counts) the torrent fails with "no metadata after N minutes: no peers had this magnet". Arclight then handles it like any failed download: it is removed (when **Remove Failed** is on) and, with automatic re-download of failed downloads on (the default), the release is blocklisted and a different one is searched for. Set the timeout to 0 to wait forever. See [Magnet failed: no metadata](../TROUBLESHOOTING.md#magnet-no-metadata).

### Resume data and shutdown

The engine saves resume data (which pieces are verified, file sizes and times, half-written pieces) for every torrent every 5 minutes. It also saves a torrent about 30 seconds after new pieces were verified, but only torrents that changed. After a crash or a kill, the engine starts from the saved state, trusts it, and re-hashes only the pieces that were half written and the files that changed. Without that, a restart would re-check every torrent in full.

On a normal stop the engine finishes the writes in progress, saves resume data and tells the trackers it is stopping. This is limited to about 6 seconds. The supplied compose files set `stop_grace_period: 30s` for the `arclight` service so Docker waits long enough before it kills the container (its default is 10 seconds). If you wrote your own compose file, add the same line. See [Torrents recheck after a restart](../TROUBLESHOOTING.md#torrents-recheck-after-restart).

A torrent's progress counts only pieces that were verified, not data that is merely received.

### When the VPN is down

With Bind to VPN on and the VPN enabled, the engine enters **Lockdown** when the tunnel drops: every torrent is paused, and the sockets are bound to `127.0.0.1` so nothing can leak. Torrents resume automatically on reconnect. Details: [VPN](vpn.md) and [Paused by VPN kill switch](../TROUBLESHOOTING.md#paused-by-vpn-kill-switch).

## When something goes wrong

| Symptom | Where to look |
|---|---|
| Client test fails | Check host, port, SSL and login. In Docker, use the container name, not `localhost` |
| A torrent is stuck | [Download stuck](../TROUBLESHOOTING.md#download-stuck), [Stalled](../TROUBLESHOOTING.md#stalled), [No peers](../TROUBLESHOOTING.md#no-peers) |
| Downloads finish but do not import | [Import blocked or failed](../TROUBLESHOOTING.md#import-blocked-or-failed) |
| Everything paused | [Paused by VPN kill switch](../TROUBLESHOOTING.md#paused-by-vpn-kill-switch) |
| Downloads slow down on their own | [Downloads slow down on their own](../TROUBLESHOOTING.md#downloads-slow-down-on-their-own) |
| Magnet failed, no metadata | [Magnet failed: no metadata](../TROUBLESHOOTING.md#magnet-no-metadata) |
| Torrents recheck after a restart | [Torrents recheck after a restart](../TROUBLESHOOTING.md#torrents-recheck-after-restart) |
| The same release keeps coming back | [Same release keeps coming back](../TROUBLESHOOTING.md#same-release-keeps-coming-back) |
| Remote agent not answering | [Remote engine](../REMOTE-ENGINE.md) (Health) |

## Related

- [Tags and tag rules](tags.md) (tags limit which items this applies to; rules can add them automatically)
- [Indexers](indexers.md)
- [VPN](vpn.md)
- [Activity](activity.md)
- [Media management](media-management.md)
- [Remote engine](../REMOTE-ENGINE.md)
- [Folders and hardlinks](../getting-started/folders-and-hardlinks.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
