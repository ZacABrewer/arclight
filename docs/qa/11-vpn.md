# VPN

This file covers Settings -> VPN: the three providers (Gluetun, WireGuard for Windows, Interface binding), saving and testing, Connect/Disconnect, the dashboard VPN card, forwarded-port syncing, leak detection, "Pause grabs when down" and the full kill-switch drill, plus how the built-in torrent engine reacts.
Prerequisites: signed in as an admin. Checks are tagged by environment. "Docker + VPN only" needs the compose stack `docker/docker-compose.yml` (Arclight, Gluetun with a Proton WireGuard key, qBittorrent in Gluetun's network) or `docker/docker-compose.builtin.yml` (Gluetun and Arclight, built-in engine only). "Native Windows only" needs Windows, the official WireGuard for Windows client installed, a WireGuard `.conf` file such as `C:\vpn\proton-nl.conf`, and Arclight started from an elevated (Administrator) PowerShell via `scripts\local-test.ps1` (http://localhost:17878).
Plain UI checks (VPN-01 to VPN-06) work in any environment. Environments without a VPN (including the NAS no-VPN layout) should leave VPN disabled; VPN-07 covers that.
For API-only checks, `<key>` is the API key shown at Settings -> Security and `<host>` is the Arclight address.

## Settings page basics

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| VPN-01 | Open Settings -> VPN on a fresh install. | Page "VPN" with a "Live status" card (buttons Refresh, and Connect/Disconnect only for WireGuard) and a "VPN" card with the form. Live status State shows a grey "Disabled" badge and "Last checked" shows "never" or a recent time. | |
| VPN-02 | Open the Provider drop-down. | Exactly three choices: "Gluetun (Docker)", "WireGuard for Windows (native)", "Interface binding (any OS)". | |
| VPN-03 | Choose Gluetun. | Fields appear: Control server URL (placeholder `http://localhost:8000`), API key (password field), Username, Password, plus the toggle "Sync forwarded port" ("Set qBittorrent's listening port to the forwarded port"). There is no "Public IP check URL" field for Gluetun. | |
| VPN-04 | Choose "WireGuard for Windows (native)". | Fields: "WireGuard config (.conf)", "wireguard.exe" (hint: empty means `C:\Program Files\WireGuard\wireguard.exe`), toggles "Auto-start" ("Install the tunnel service when it is not running") and "Kill switch" ("Stop grabs and torrent traffic when the tunnel drops"), and "Public IP check URL". Auto-start and Kill switch are on by default. | |
| VPN-05 | Choose "Interface binding (any OS)". | A single provider field "Adapter name" (hint: `"ProtonVPN" or "wg0"`) plus "Public IP check URL". | |
| VPN-06 | Type something in the Gluetun fields, switch the provider to WireGuard and back to Gluetun (without saving). | Your Gluetun entries are still there. Drafts are kept per provider while you stay on the page. | |
| VPN-07 | (Any environment without a VPN) Leave "Enable VPN monitoring" off, Save, and open the Dashboard. | No VPN card is shown on the Dashboard. Grabs are not held, and System -> Health shows no VPN item. | |

## Common settings

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| VPN-08 | Look at the rest of the form (any provider). | Toggles "Enable VPN monitoring" ("Watch the VPN and guard grabs") and "Pause grabs when down" ("Hold grabs while the VPN is down or leaking", on by default); text fields "Home public IP" (placeholder "optional") and "Poll interval (seconds)" (default 60); Test and Save buttons. | |
| VPN-09 | Set Poll interval to 5 and 5000, then Save. | Both are refused (valid range 10 to 3600 seconds). 10 and 3600 are accepted. Set it back to 60. | |
| VPN-10 | Set "Public IP check URL" (native providers) to the text "not a url" and Save. | Refused as an invalid URL. The default is `https://api.ipify.org?format=json`. | |
| VPN-11 | Set "Home public IP" to your real ISP address (look it up with a browser while NOT on the VPN), Save and reload. | The value is kept. Clearing the field and saving removes it. | |
| VPN-12 | Via API: `curl http://<host>/api/v1/settings/vpn -H "X-Api-Key: <key>"` after saving a Gluetun API key. | The reply shows the key masked as `********`, never the real key. Saving the form again unchanged keeps the stored key. | |

## Gluetun (Docker + VPN only)

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| VPN-13 | Choose Gluetun, enter Control server URL `http://localhost:8000` (Arclight shares Gluetun's network, so localhost is correct), enable monitoring and click Test. | A "Test result" section appears under the buttons showing State "Connected", a Public IP that is NOT your home IP, a Location (city, region, country) and a "Forwarded port" number. | |
| VPN-14 | Enter a wrong Control server URL (for example `http://localhost:9999`) and click Test. | The Test result shows State "Disconnected" and a "Problem" line describing the connection failure. Nothing is saved. | |
| VPN-15 | If your Gluetun control server requires an API key, leave API key empty and Test. | A "Problem" line mentions the request being unauthorized. Entering the key (sent as X-API-Key) fixes it. | |
| VPN-16 | Tick "Enable VPN monitoring" and click Save. Within a minute look at "Live status". | State is a green "Connected" with Public IP, Location and "Forwarded port <number> (synced to qBittorrent)". The row "Last checked" shows a recent time. | |
| VPN-17 | (Docker + VPN, qBittorrent client present) In qBittorrent's WebUI open Tools -> Options -> Connection. | "Port used for incoming connections" equals the forwarded port shown in Arclight, and "Use random port" is off. | |
| VPN-18 | Untick "Sync forwarded port", Save, restart Gluetun to get a new forwarded port and wait a minute or two. | Arclight shows the new forwarded port but qBittorrent's listening port is NOT changed. Re-tick the toggle, Save: qBittorrent is updated to the new port. | |
| VPN-19 | (builtin compose) Open Settings -> Torrent Engine with VPN connected. | "Listen port" in Live status shows the forwarded port with "(forwarded by VPN; configured 6881)". | |
| VPN-20 | Click "Refresh" in Live status. | The page re-checks immediately; "Last checked" updates to "just now" or a few seconds ago. | |

## Dashboard card and Health

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| VPN-21 | (VPN enabled) Open the Dashboard. | A card titled "VPN" with a badge (Connected / Disconnected / Leak) shows the same State, Public IP, Location and Forwarded port rows as Live status, and a "Settings" link that opens Settings -> VPN. | |
| VPN-22 | With the VPN down (see VPN-34), open System -> Health. | A red entry "VPN (gluetun) is enabled but not connected." (or with the provider name you use) appears, with an error detail where known. | |

## Leak detection

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| VPN-23 | Set "Home public IP" to the IP the VPN currently reports (copy it from Live status "Public IP") and Save. This simulates a leak. | Within a minute State becomes a yellow "Leak", a Problem line says "Public IP ... is your home IP: traffic is not going through the VPN.", and System -> Health shows a warning "Public IP ... matches your home IP". | |
| VPN-24 | While the leak is shown, open Search, run a search and click Grab on a release that matches a library item. | The grab is not sent: it is held. An entry appears in Activity -> Pending with the Reason "Download client unavailable". | |
| VPN-25 | Clear "Home public IP" (or set the real ISP address) and Save, then click Refresh. | State returns to "Connected". The held item leaves Pending and is grabbed on the next retry, or use "Grab now" in Activity -> Pending. | |

## Pause grabs when down

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| VPN-26 | With the VPN disconnected and "Pause grabs when down" on, grab a library-matched release from Search. | The release is held in Activity -> Pending (Reason "Download client unavailable") and nothing reaches the download client. The reason given is "The VPN is down or not protecting traffic; grabs are paused until it reconnects." | |
| VPN-27 | Untick "Pause grabs when down" (Gluetun or Interface binding), Save and grab again while the VPN is still down. | The grab is sent to the client normally (the guard is off). Re-tick the toggle afterwards. | |
| VPN-28 | Reconnect the VPN and wait for the next poll. | Held releases are grabbed automatically within a few minutes, or immediately with "Grab now". | |

## Kill-switch drill (full sequence)

Run this once on Docker + VPN with the built-in engine (VPN-29 to VPN-35), and once on Native Windows with WireGuard (VPN-36 to VPN-46). Have at least one large torrent downloading through the Built-in client first, and "Bind to VPN" ticked in Settings -> Torrent Engine.

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| VPN-29 | (Docker + VPN) Confirm normal state: Settings -> VPN shows "Connected"; Settings -> Torrent Engine shows State "Running", "VPN binding" = "connected - tunnel <address>", and a torrent is downloading with a non-zero Download rate. | All of those hold. | |
| VPN-30 | Stop the tunnel: run `docker stop gluetun` (this also takes Arclight offline if it shares Gluetun's network; if you cannot keep Arclight up, instead block the VPN by pausing the VPN in Gluetun's control server, or run the Native Windows drill below). | The VPN is seen as down within about a minute. | |
| VPN-31 | Watch Settings -> VPN. | State shows a red "Disconnected" with a Problem line. | |
| VPN-32 | Watch Settings -> Torrent Engine. | State changes to a red "Lockdown", the line "VPN down - all torrents paused, sockets bound to 127.0.0.1" appears, and the Download rate falls to 0. Torrents show as paused. | |
| VPN-33 | Try to grab a release from Search. | The grab is held (Activity -> Pending, "Download client unavailable"). Adding or resuming a torrent through the engine API is refused with the message "The VPN is down; torrents stay paused until it reconnects". | |
| VPN-34 | Open System -> Health and the Dashboard. | Health lists the red "VPN ... is enabled but not connected." item (check id VpnDisconnected); the Dashboard VPN card shows a "Disconnected" badge. | |
| VPN-35 | Bring the tunnel back (`docker start gluetun` and restart the stack if needed) and wait one to two minutes. | VPN State returns to "Connected"; the engine leaves Lockdown, shows "Running" and "VPN binding" connected again; torrents resume downloading on their own; the Health item disappears; held grabs are sent. | |

## Native Windows: WireGuard provider

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| VPN-36 | (Native Windows only) Start Arclight from a NON-elevated PowerShell, choose "WireGuard for Windows (native)", enter the .conf path and click Test. | The Test result shows a Problem such as "wg.exe needs administrator rights: run Arclight elevated or as a service." | |
| VPN-37 | (Native Windows only) Restart Arclight from an elevated (Run as administrator) PowerShell. Set "WireGuard config (.conf)" to `C:\vpn\proton-nl.conf`, leave "wireguard.exe" empty, Auto-start and Kill switch on, tick "Enable VPN monitoring", and click Test. | The Test result shows State "Connected" (the tunnel is installed and started if it was not running), Public IP different from your home IP, an Adapter row like "proton-nl 10.2.0.2", an Endpoint, a Last handshake time and Transfer in/out. | |
| VPN-38 | (Native Windows only) Enter a path to a file that does not exist, or one named `bad name!.conf`, and click Test. | Problem: "WireGuard config ... does not exist." or a message that the name is not usable (a .conf file name of 1 to 32 letters, digits or _=+.-). | |
| VPN-39 | (Native Windows only) Set "wireguard.exe" to a wrong path and click Test. | Problem: "WireGuard for Windows was not found at ... Install it from wireguard.com or set its path." | |
| VPN-40 | (Native Windows only) Click Save. Live status now shows Connect and Disconnect buttons next to Refresh. | The buttons are present only for the WireGuard provider. State is "Connected". | |
| VPN-41 | (Native Windows only) Click "Disconnect". | The tunnel service is removed (check `services.msc`: no `WireGuardTunnel$proton-nl`). State becomes "Disconnected" and, with Kill switch on, grabs are held. | |
| VPN-42 | (Native Windows only) Wait 5 or more minutes with Auto-start on, after the Disconnect. | The tunnel is NOT reinstalled automatically: a manual Disconnect pauses auto-start. | |
| VPN-43 | (Native Windows only) Click "Connect". | The tunnel service is installed and started again and State returns to "Connected" with a fresh handshake. | |
| VPN-44 | (Native Windows only) Kill switch drill: with a torrent downloading and Bind to VPN on, remove the tunnel outside Arclight (in an elevated prompt run `"C:\Program Files\WireGuard\wireguard.exe" /uninstalltunnelservice proton-nl`) while Auto-start is OFF. | Within seconds to a minute State becomes "Disconnected", Torrent Engine shows "Lockdown" and downloads stop, grabs are held in Activity -> Pending, and System -> Health shows the VpnDisconnected error. | |
| VPN-45 | (Native Windows only) Click "Connect" (or turn Auto-start on and wait up to 5 minutes). | Everything recovers as in VPN-35: Connected, engine Running, torrents resume, Health item cleared. | |
| VPN-46 | (Native Windows only) Turn the Kill switch toggle off, and also "Pause grabs when down" off, Save, then drop the tunnel. | Grabs are no longer held while the VPN is down (this is the unsafe configuration), but the VPN card still shows Disconnected. Turn both back on. | |

## Interface binding (any OS)

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| VPN-47 | Choose "Interface binding (any OS)", enter the adapter name of a VPN you run yourself (for example `ProtonVPN` or `wg0`), enable monitoring and click Test. | Test result shows State "Connected", an Adapter row with the name and its IPv4 address, and a Public IP. An unknown adapter name shows State "Disconnected" with a Problem line. | |
| VPN-48 | Save, then in Settings -> Torrent Engine tick "Bind to VPN". | "Bound address" in Live status becomes the adapter's IPv4 address. | |
| VPN-49 | Disconnect your VPN app. | Within a minute the VPN shows Disconnected, the engine goes to Lockdown (Bound address 127.0.0.1) and grabs are held, as in the kill-switch drill. Reconnect the app to recover. | |

## Events and live updates

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| VPN-50 | Open Settings -> VPN in one browser tab and the Dashboard in another, then change the VPN state (disconnect or reconnect). | Both tabs update on their own within moments, without a page refresh (the app reacts to the `vpn` live event). | |
| VPN-51 | Via API: `curl -X POST http://<host>/api/v1/vpn/refresh -H "X-Api-Key: <key>"` and `curl http://<host>/api/v1/vpn/status -H "X-Api-Key: <key>"`. | Both return a JSON status with `enabled`, `connected`, `publicIp`, `killSwitchEngaged`, `lastChecked` and so on. For Gluetun, `POST /api/v1/vpn/connect` is refused with "The gluetun provider does not manage the tunnel." | |
