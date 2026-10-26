# Download Clients and the Torrent Engine

This file covers Settings -> Download Clients (add, test, edit, delete, test all, categories, priority, tags, remote path mappings, completed/failed handling), the queue behaviours that depend on a client, the Built-in torrent engine and Settings -> Torrent Engine.
Supported client kinds in this build are exactly seven: qBittorrent, Transmission, Deluge, rTorrent (torrent), SABnzbd, NZBGet (usenet) and Built-in (torrent). There is no Blackhole client.
Prerequisites: signed in as an admin. For the external client checks you need at least one real client reachable from Arclight (for example qBittorrent WebUI at `http://localhost:8080`, or a qBittorrent container in a Docker stack). Checks that need a usenet client or a specific client are marked; skip them if you do not run that client.
Test environment: Native (`scripts\local-test.ps1`, http://localhost:17878) covers the Built-in engine and any client you can reach from your PC. Docker and NAS runs are needed for remote path mapping and "Bind to VPN" checks (marked).
For API-only checks, `<key>` is the API key shown at Settings -> Security and `<host>` is `localhost:17878` (Native) or `<host>:7878` (Docker/NAS).

## Add a client: qBittorrent

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| DLC-01 | Open Settings -> Download Clients. | Page "Download Clients" with a "Test all" button (greyed out when there are no clients), a card grid with "+ Add download client", and a card "Remote path mappings" below. | |
| DLC-02 | Click "+ Add download client". | A dialog "Add download client" lists tiles with a protocol badge, torrent ones first: qBittorrent, Transmission, Deluge, rTorrent, Built-in, then usenet: SABnzbd, NZBGet. Each tile has a one-line description. | |
| DLC-03 | Click the qBittorrent tile. | Dialog "Add qBittorrent" opens with fields Name, Enable, Host (pre-filled "localhost"), Port (8080), Use SSL, Username, Password, Category (default "arclight"), plus advanced ones. | |
| DLC-04 | Tick "Show advanced". | More fields appear with an "advanced" tag: Client Priority (default 1), Remove Completed, Remove Failed, Tags, URL Base, Post-Import Category, Recent Priority, Older Priority, Initial State, Sequential Order, First and Last First, Content Layout. | |
| DLC-05 | Enter Name "qBittorrent", your Host/Port and the correct Username and Password, then click Test. | A green "Test passed" box shows "version 4.x.x (API 2.x)" (your real version numbers). | |
| DLC-06 | Change the password to a wrong value and click Test. | A red "Test failed" box shows an error message with a code in brackets. Nothing is saved. | |
| DLC-07 | Enter a Host that does not exist (for example `nohost.invalid`) and click Test. | "Test failed" with a connection error. The dialog stays open. | |
| DLC-08 | Fix the credentials and click Save. | The dialog closes. A card "qBittorrent" appears with a torrent badge, a green "enabled" badge, "qBittorrent - priority 1" and the address line `http://localhost:8080`. | |
| DLC-09 | In qBittorrent's own WebUI, check Categories after the first grab or after saving. | Arclight uses the category you entered ("arclight") for its downloads. Only torrents in this category are tracked in Arclight's queue. | |

## Other client kinds

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| DLC-10 | Open "+ Add download client" -> Transmission. | Dialog "Add Transmission" with Port 9091 and URL Base "/transmission/". The category fields are named Label and Post-Import Label; advanced shows Directory and Add Paused. (Transmission only.) | |
| DLC-11 | Open "+ Add download client" -> Deluge. | Dialog "Add Deluge" with Port 8112, a Password field and NO Username field, and labels named Label and Post-Import Label. (Deluge only.) | |
| DLC-12 | Open "+ Add download client" -> rTorrent. | Dialog "Add rTorrent" with URL Path default "RPC2". (rTorrent only.) | |
| DLC-13 | Open "+ Add download client" -> SABnzbd. | Dialog "Add SABnzbd" with an API Key field (preferred over Username and Password, which are advanced). The tile in the picker carries a usenet badge. (SABnzbd only.) | |
| DLC-14 | Open "+ Add download client" -> NZBGet. | Dialog "Add NZBGet" with Port 6789 and Username default "nzbget". (NZBGet only.) | |
| DLC-15 | For each client kind you actually run, fill in the correct values, click Test and then Save. | Each shows "Test passed" with a version, and a card with the right protocol badge (torrent or usenet) appears. | |

## Edit, disable, delete and test all

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| DLC-16 | Click the title of a client card. | The editor reopens titled "Edit <name>" with the stored values. The Password field does not show the real password (it is stored masked). | |
| DLC-17 | Untick "Enable" and Save. | The card is greyed out and its badge reads "disabled". Re-enable it afterwards. | |
| DLC-18 | Set the Client Priority (advanced) to 50 and then 51, 0. | 50 is accepted and the card reads "priority 50". 0 and 51 are refused (valid range 1 to 50, 1 is highest). Set it back to 1. | |
| DLC-19 | Add a second client of the same protocol with a different priority, then grab something (Search page -> Grab). | With different priorities the lower number (higher priority) client receives the download. With equal priorities clients are used in rotation. | |
| DLC-20 | Click "Test all" with one working and one broken client. | Each card shows a line: green "Test passed - version ..." or red "Test failed: <message>". | |
| DLC-21 | Open the editor of the broken client, click Delete. | A confirmation "Delete <name>?" appears. Confirm: the card disappears. Cancel: it stays. | |
| DLC-22 | Set a Tags value (click a tag chip, advanced) on a client and Save. | The client is then used only for series/movies with a matching tag. With no tags selected it is used for everything. | |

## Completed and failed download handling

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| DLC-23 | In a client editor with "Show advanced" on, read the "Remove Completed" and "Remove Failed" checkboxes. | Both are ticked by default. Help text: "Remove imported downloads from the client once they are allowed to be removed (seeding goals met)." and "Remove failed downloads from the client." | |
| DLC-24 | Set "Post-Import Category" to "arclight-done" (qBittorrent), Save, then let a download finish and import. | After the import the torrent in qBittorrent moves to category "arclight-done" instead of being removed (Remove Completed off) or is removed once seeding goals are met (Remove Completed on). | |
| DLC-25 | Check the server-wide handling switches via the API (there is no screen for them): `curl http://<host>/api/v1/settings/mediamanagement -H "X-Api-Key: <key>"`. | The reply contains `enableCompletedDownloadHandling` (default true) and `autoRedownloadFailed` (default true). | |
| DLC-26 | Cancel a download inside the external client (delete the torrent in qBittorrent) while it is still in Arclight's queue. | Within a minute or two the queue row shows a warning or failed state; with `autoRedownloadFailed` true Arclight blocklists that release and searches for another. A matching row appears in Activity -> History as a failed download. | |

## Remote path mappings

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| DLC-27 | On the Download Clients page scroll to "Remote path mappings" with no mappings defined. | The card shows "No mappings" and the text "Only needed when the download client sees paths differently from Arclight (e.g. Docker)." | |
| DLC-28 | Click "Add" in that card. | Dialog "Add remote path mapping" with Host (suggests your clients' hosts), Remote path ("The path as the download client reports it.") and Local path ("The same directory as Arclight sees it."). | |
| DLC-29 | Click Save with all fields empty. | An error "Host, remote path and local path are all required" appears and nothing is saved. | |
| DLC-30 | Enter Host "qbittorrent", Remote path "/downloads/", Local path "D:\Downloads\" (or the matching folder on your system) and Save. | A table row appears with Host, Remote path and Local path in code font and an "Edit" button. | |
| DLC-31 | (Docker/NAS) Put the qBittorrent container's download folder under a different path than Arclight's mount, add the matching mapping, then grab and complete a download. | The download imports into the library. Without the mapping the queue row shows a warning about a path that "may need a Remote Path Mapping" and the import does not happen. | |
| DLC-32 | Click "Edit" on a mapping, then "Delete" in the dialog. | The mapping row is removed. | |

## Queue behaviours that depend on clients

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| DLC-33 | Open Activity -> Queue after a grab sent to your client. | A row appears with the release title, the Client column showing your client's name, a progress bar and Time left. | |
| DLC-34 | Click "Remove" on the row and leave "Remove from download client" ticked, then confirm. | The row leaves the queue and the torrent also disappears from the external client. With the toggle off the torrent stays in the external client. | |
| DLC-35 | Stop the external client (close qBittorrent) and wait about a minute. | The queue row shows a warning or error state and System -> Health reports that the client is unavailable. Restart the client; the row recovers. | |

## Built-in engine: client and auto-registration

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| DLC-36 | On a brand-new install (empty config folder) start Arclight and open Settings -> Download Clients. | A client named "Built-in" already exists with a torrent badge, "Built-in - priority 1" and the line "built-in engine". | |
| DLC-37 | Delete the "Built-in" client and restart Arclight. | It is NOT re-created (auto-registration only runs once). It can be added again by hand from "+ Add download client" -> Built-in. | |
| DLC-38 | Click "+ Add download client" -> Built-in. | Dialog "Add Built-in" explains that engine-wide options are under Settings -> Torrent Engine. Fields: Name, Enable, Category (default "arclight"), Download Folder, Initial State, and advanced Post-Import Category, Category Folders, Seed Ratio Limit, Seed Time Limit (minutes). There is no Host or Port. | |
| DLC-39 | Under "Category Folders" click "Add category", type name "tv" and save path `D:\Media\Downloads\tv` (or `/downloads/tv`), then Save. | The row is kept after saving. "Remove" deletes a row. Fully empty rows are dropped on save. | |
| DLC-40 | Start Arclight with the environment variable `ARCLIGHT_TORRENT_ENGINE=0` (the older name `MEDIATRON_TORRENT_ENGINE=0` is still accepted) on a fresh config folder. | The engine does not start, and no "Built-in" client is auto-registered. Settings -> Torrent Engine shows State "Disabled". | |

## Settings -> Torrent Engine

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| DLC-41 | Open Settings -> Torrent Engine. | Page "Torrent Engine" with a "Live status" card (State, Listen port, Bound address, VPN binding, DHT nodes, Peers, Download, Upload, Torrents) and an "Engine" card with the settings form. State shows a green "Running". | |
| DLC-42 | Read the form fields. | Toggles: Enable engine, Auto-register client, DHT, Peer exchange, Bind to VPN. Numbers: Listen port (6881), Max connections (200), Max connections per torrent (50), Download limit (KiB/s) (0), Upload limit (KiB/s) (0), Max active downloads (3), Max active seeds (5), Default seed ratio, Default seed time (minutes). Text: Downloads folder, Resume data folder (read-only). | |
| DLC-43 | Set Listen port to 6999 and click Save. | A short confirmation appears, and after a few seconds "Listen port" in Live status shows 6999. | |
| DLC-44 | Enter 0 in Listen port or 70000 and Save. | The save is refused with a validation message (valid range 1 to 65535). | |
| DLC-45 | Set Download limit to 500 KiB/s, add a large torrent, and watch Download in Live status. | The download rate stays at or below roughly 500 KiB/s. Set it back to 0 (unlimited). | |
| DLC-46 | Set Max active downloads to 1 and add three torrents. | Only one downloads at a time; the others show as queued in the "Torrents" line (for example "1 downloading ... 2 queued"). Set it back to 3. | |
| DLC-47 | Enter Default seed ratio 1.0, Save, and let a torrent finish and seed (with no per-client override). | The torrent stops seeding once it reaches ratio 1.0. Clearing the field shows the placeholder "unlimited". | |
| DLC-48 | Set Default seed time to 1 (minute) and let a torrent seed. | Seeding stops after about a minute. Clear the field when done. | |
| DLC-49 | Untick DHT and PEX, Save, then watch "DHT nodes" in Live status. | DHT nodes drops to 0 after the engine restarts. Re-tick them afterwards. | |
| DLC-50 | Enter a Downloads folder (for example `D:\Torrents`) and Save. Add a torrent through the Built-in client. | Files are written under that folder (in a sub-folder named by category, for example `D:\Torrents\arclight`). The placeholder in the field normally shows the default folder in use. | |
| DLC-51 | Untick "Enable engine" and Save. | State changes to "Disabled" and torrents stop. Tick it again and Save: State returns to "Starting" then "Running". | |
| DLC-52 | (Docker + VPN only) Tick "Bind to VPN" with VPN enabled and connected (see 11-vpn.md). | "VPN binding" in Live status reads "connected - tunnel <address>" and "Bound address" shows the tunnel address instead of "all interfaces". | |
| DLC-53 | (Docker + VPN only) With Bind to VPN on, stop the tunnel. | State shows a red "Lockdown" and the line "VPN down - all torrents paused, sockets bound to 127.0.0.1". When the tunnel returns the engine resumes. | |

## Engine torrent actions

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| DLC-54 | Grab a torrent through the Built-in client, then open Activity -> Queue. | The row has a "Details" button (only rows downloaded by the Built-in engine have it). | |
| DLC-55 | Click "Details". | A dialog opens titled with the torrent name and tabs "General", "Peers (n)", "Trackers (n)", "Files (n)". General shows State, Progress, Size, Transferred, Ratio, Rates, ETA, Peers, Pieces, Save path, Category, Added, Completed, Private. The footer has Pause (or Resume), Recheck and Close. | |
| DLC-56 | Click "Pause". | The State changes to "paused" within a few seconds and the button becomes "Resume". Click Resume: it returns to downloading. | |
| DLC-57 | Click "Recheck". | State briefly shows "checking", then returns to its previous state with the same progress. | |
| DLC-58 | Open the "Files" tab on a multi-file torrent and change one file's priority to "Skip". | Priority options are Skip, Normal, High, Max. The skipped file stops downloading and the wanted size on General shrinks. | |
| DLC-59 | Open the "Peers" and "Trackers" tabs. | Peers shows address, client, source, flags and rates (or "No peers connected"). Trackers shows URL, tier, state and seeds/leechers (or "No trackers" for magnet/DHT only). | |
| DLC-60 | Move a torrent's data via API: `curl -X POST http://<host>/api/v1/torrent/<id>/move -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d "{\"savePath\":\"D:\\\\Torrents\\\\moved\"}"` (the id is the queue row's download id). | The reply is OK and the General tab's Save path changes to the new folder. | |
| DLC-61 | Click "Remove" on the queue row with "Remove from download client" ticked. | The torrent disappears from the engine (`GET /api/v1/torrent/torrents` no longer lists it). | |
