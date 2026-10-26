# Troubleshooting

Something is not working. This page is organised by what you see: find your symptom, confirm the cause, apply the fix. The second half explains every message on the Health page (System > Health), one section per check. If you are new to a word used here, see the [Glossary](GLOSSARY.md).

Contents:

- [First checks](#first-checks)
- [Symptoms](#symptoms): download stuck, paused by the VPN kill switch, stalled, no peers, import blocked or failed, nothing found, Cloudflare challenge, VPN will not connect, port forward not synced, permission denied, hardlinks not working, locked out, "does not match the contract", container keeps restarting, slow engine start
- [Health checks](#health-checks): all 42, with a table of anchors
- [Still stuck](#still-stuck)

---

## First checks

Do these four things before anything else. They answer most questions in under two minutes.

1. **System > Health.** Read every line. Each finding has a "How to fix" link that opens the matching section further down this page (also available in the app under System > Health docs). Press **Run checks** to refresh after a change. Red items (errors) first, then yellow (warnings).
2. **Activity > Queue.** Click the row of the download in question. The state label (for example "Stalled", "No peers", "Paused · VPN kill switch", "Import blocked") and the sentence under it say what Arclight thinks is wrong. The **Timeline** in the details lists what happened and when.
3. **System > Status.** Shows version, uptime, the config and database paths, whether Docker was detected, the torrent engine state and VPN lockdown, and indexer failures.
4. **System > Logs.** Set **Minimum level** to Warn, use **Search logs** for the title, indexer or client name, and use **Live tail** while you repeat the problem.

### How to read the logs

| Where | What you get |
|---|---|
| System > Logs, "Log entries" | The recent in-memory log. Filter by level (Trace, Debug, Info, Warn, Error, Fatal; "Warn and above" shows warn, error and fatal), search the message text, and see the component that wrote it. Newest first. |
| System > Logs, "Log files" | The rotating log files on disk, with size and last-written time. They live in `<config>/logs/` (`/config/logs/` in Docker). |
| System > Logs, **Live tail** | New entries appear as they happen. Pause it to read. |
| Docker | `docker logs arclight` shows the same output plus start-up errors that happen before the web UI exists. Add `--tail 200` to limit it. For the VPN: `docker logs gluetun`. |

To get more detail, set `ARCLIGHT_LOG_LEVEL` to `debug` (allowed values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`; default `info`), restart, repeat the problem, then set it back. In Docker, add it under `environment:` in your compose file.

### Debug bundle

Arclight does not have a one-click debug bundle. Instead collect these by hand (see [Still stuck](#still-stuck)): the Health page, the queue item's details, the last 200 log lines, and your version from System > Status. Remove API keys, tokens, passkeys and public IPs before sharing anything.

---

## Symptoms

<a id="download-stuck"></a>
### Download stuck at X%

**What you see:** a queue row sits at the same percentage and does not move.

**Cause:** one of three things. The download is stalled (no data for a while), it is paused by the VPN kill switch, or it simply has no peers. Each has its own state label in Activity > Queue.

**How to confirm:** open Activity > Queue and read the state label on the row.

| Label on the row | Go to |
|---|---|
| Stalled | [Stalled](#stalled) |
| Paused · VPN kill switch | [Paused by the VPN kill switch](#paused-by-vpn-kill-switch) |
| No peers | [No peers](#no-peers) |
| Queued | Not stuck: the engine runs a limited number of downloads at once (Settings > Torrent Engine, "Max active downloads"). It starts when a slot frees up. |
| Paused | Paused by you (in Arclight or in the client). Press resume. |
| Fetching metadata | A magnet link is waiting for peers to send the file list. See [No peers](#no-peers). |
| Checking files | The engine is verifying data already on disk. Wait. See [Slow engine start](#slow-engine-start). |
| Client unreachable | The download client does not answer. See [unable-to-communicate-with-download-client](#unable-to-communicate-with-download-client). |
| Disk full | See [download-disk-space-full](#download-disk-space-full). |

**Fix:** follow the linked section. If the row says "Downloading" and shows speed, it is not stuck, only slow.

---

<a id="paused-by-vpn-kill-switch"></a>
### Paused by the VPN kill switch

**What you see:** downloads show "Paused · VPN kill switch", a banner at the top of the queue says "Downloads are paused by the VPN kill switch", and System > Status shows "Lockdown".

**Cause:** the VPN is down, leaking (your public IP equals your home IP), or has not been checked yet. To protect your IP, the built-in torrent engine pauses every torrent and listens only on 127.0.0.1. This is working as designed. Torrents you paused yourself stay paused; the rest resume on their own when the VPN is back.

**How to confirm:**

- Settings > VPN shows "Disconnected" or "Leaking", with an error text when there is one.
- The queue banner gives the reason ("VPN down", "VPN kill switch engaged", "VPN leak", or "Waiting for the first VPN check") and how many torrents will resume.
- Log line when the VPN returns: `torrent engine resumed after VPN reconnect`.
- The Health page shows [torrent-engine-lockdown](#torrent-engine-lockdown) and usually [vpn-disconnected](#vpn-disconnected).

**Fix:**

1. Fix the VPN first: see [VPN will not connect](#vpn-wont-connect).
2. If the VPN is really up but Arclight says it is down, Arclight cannot read the VPN status. For Gluetun check the control URL and API key in Settings > VPN (see [vpn-disconnected](#vpn-disconnected)).
3. If it flips on and off repeatedly, see [vpn-kill-switch-flapping](#vpn-kill-switch-flapping).
4. If you do not want this protection, you can turn off the VPN integration or the kill switch under Settings > VPN. Only do that if you accept torrent traffic leaving through your home connection.

The other kill-switch effect is that grabs (sending a release to a client) are held while the VPN is down or leaking. That is the **Pause grabs when down** option in Settings > VPN (on by default).

---

<a id="stalled"></a>
### Stalled

**What you see:** the row says "Stalled", the sentence reads "No new data received for N+ minutes", and the Health page shows [download-stalled](#download-stalled).

**Cause:** the download received no new bytes for longer than the stall threshold. The usual reasons are that every seeder is gone, the engine cannot reach the peers that exist (port or VPN trouble), or the connection is down. Downloads that are paused, queued, checking, fetching metadata or paused by the kill switch are never flagged.

**How to confirm:**

- Activity > Queue, open the row: **Last data**, **Swarm** (seeds and leechers the trackers report), **Connected** peers and the **Timeline** ("Stalled" entry with the percentage and peer count at the time; "Moving again" when data resumes).
- Settings > Media Management, "Stalled download after" (default 10 minutes; 0 turns the check off).

**Fix:**

1. Check the swarm. If the trackers report 0 seeds, nobody can finish the file. Remove it from the queue with **Add to blocklist** ticked so Arclight searches for a different release.
2. If seeds exist but no peers connect, see [No peers](#no-peers).
3. If many downloads stall at once, look at the VPN and the listening port: [Paused by the VPN kill switch](#paused-by-vpn-kill-switch), [Port forward not synced](#port-forward-not-synced).
4. If a slow-but-alive swarm is flagged too eagerly, raise "Stalled download after".

> Coming soon: stall auto-recovery and "try another release" (Arclight automatically blocklisting a stalled release and grabbing the next best one). This page will be updated when it ships. Today you do this by hand as in step 1.

---

<a id="no-peers"></a>
### No peers

**What you see:** the row says "No peers" ("No peers connected yet", plus how many seeds the trackers report), or a magnet link sits on "Fetching metadata".

**Cause:** the engine has found nobody to talk to. Typical reasons:

- The torrent is dead or very unpopular (the trackers report 0 seeds).
- The VPN is down, so the engine is locked down (see above).
- Incoming connections are impossible: no forwarded port, or the listening port is blocked. Outgoing connections still work, so you get fewer peers, not none.
- You are on a private tracker and the tracker rejected the announce (passkey, ratio or account problem). DHT and peer exchange are not used for private torrents.
- A transport setting is switched off. If both TCP and uTP are off, no peer can connect at all (Settings > Torrent Engine warns about this).

**How to confirm:**

- Open the row in Activity > Queue, then **Info**: peers, seeds, trackers (and their last announce result) and **Next announce**.
- Settings > Torrent Engine > "Torrent engine status": "Engine running", "Listening port", "Connected peers", "DHT nodes", "Bound address".
- Health: [torrent-engine-not-listening](#torrent-engine-not-listening), [torrent-engine-not-on-vpn](#torrent-engine-not-on-vpn).

**Fix:**

1. Wait a few minutes after a restart; peers take a moment to arrive.
2. Make sure the VPN is connected and has a forwarded port: [Port forward not synced](#port-forward-not-synced).
3. In Settings > Torrent Engine check that TCP (or uTP) is on, DHT and peer exchange are on for public torrents, and the "Peer encryption" setting is not "Required" unless you mean it (fewer peers can connect).
4. For private trackers open the tracker rows in the details and read the tracker message; fix the account or passkey on the indexer.
5. If the torrent has no seeds, blocklist it and let Arclight pick another release.

---

<a id="import-blocked-or-failed"></a>
### Import blocked or failed

**What you see:** the download finished, but the row says "Import blocked" (or "Waiting for import" for hours), or History shows an import failure. The show or movie does not appear in your library.

**Cause:** Arclight could not match, move or hardlink the finished files. The row shows the exact reason; the common ones are:

| Reason shown | What it means | Fix |
|---|---|---|
| No matching episode / movie | The files could not be matched to a title. | Use **Manual import** (Activity > Manual import), pick the title for each file. |
| Sample or no video files | The download holds only samples or non-video files. | Blocklist the release and search again. |
| Not an upgrade | You already have this quality or better. | Remove the row; nothing to do. |
| Not enough free space | The root folder is below the free-space rule. | Free space, or lower "Minimum free space" in Settings > Media Management (default 100 MB). Then press **Retry import**. |
| Download folder not found | The client reports a path Arclight cannot see. | See [bad-remote-path-mapping](#bad-remote-path-mapping) and [docker-bad-remote-path-mapping](#docker-bad-remote-path-mapping). |
| Permission denied | Arclight cannot read the download or write the library. | See [Permission denied on folders](#permission-denied). |

The wording of these messages can differ slightly by version; the row is the authority.

**How to confirm:** Activity > Queue, open the row and read the Timeline ("Import blocked" with the message). Failed imports also appear in Activity > History. Blocked imports are retried automatically; **Retry import** forces it.

**Fix:** apply the fix for the reason shown, then press **Retry import**, or import by hand under Activity > Manual import. If a download waits for more than six hours, the Health page adds [downloads-awaiting-manual-import](#downloads-awaiting-manual-import).

---

<a id="nothing-found"></a>
### Nothing found when searching

**What you see:** Interactive search returns no results, or automatic search never grabs anything for a missing episode or movie.

**Cause and checks, in the order they usually bite:**

1. **No indexer is enabled for that kind of search.** An indexer has separate switches for RSS, automatic search and interactive search. Health shows [no-indexers-enabled](#no-indexers-enabled), [no-indexers-available-with-automatic-search-enabled](#no-indexers-available-with-automatic-search-enabled) or [no-indexers-available-with-interactive-search-enabled](#no-indexers-available-with-interactive-search-enabled).
2. **All indexers are backing off after failures.** See [indexers-are-unavailable-due-to-failures](#indexers-are-unavailable-due-to-failures).
3. **A site is behind Cloudflare.** See [Cloudflare challenge](#cloudflare-challenge).
4. **The title is not monitored,** or has no air date yet, so it is not Wanted. Check the title in the Library and the lists under Wanted.
5. **Results exist but are rejected.** Interactive search lists them with the reason (quality not allowed, below the cutoff, size, custom format score, not enough seeders, blocklisted). Fix the profile or accept the release by hand.
6. **The title is named differently by the indexer** (alternate titles, anime numbering). Check the series type and alternate names.

**How to confirm:** Settings > Indexers: press **Test** on each indexer and read the error. Indexers > Stats shows queries and failures per indexer. In Interactive search look for rejected rows before concluding that nothing exists.

**Fix:** follow the numbered item that applies.

---

<a id="cloudflare-challenge"></a>
### Cloudflare challenge / indexer failing

**What you see:** an indexer fails its Test with a 403 or 503, a message about a challenge, or Health shows [indexers-are-unavailable-due-to-failures](#indexers-are-unavailable-due-to-failures).

**Cause:** the indexer's site is protected by Cloudflare (or a similar service) and wants a browser to prove it is human. Arclight can send those requests through a challenge solver. In Docker the bundled FlareSolverr container does this. On a native install the built-in solver drives a browser installed on the machine. Solvers are attached to an indexer through an Indexer Proxy of type FlareSolverr and matched by tag.

**How to confirm:**

- Settings > Indexers: the Test error mentions a challenge or a 403/503.
- Settings > Indexer Proxies: is there a FlareSolverr entry ("FlareSolverr (bundled)" or "Built-in solver"), and does the indexer carry the same tag?
- Settings > Challenge Solver: for a native install, is a browser found ("No browser found" means it is not)?
- Docker: `docker compose ps` shows whether the `flaresolverr` container is running.
- Health: [flaresolverr-unreachable](#flaresolverr-unreachable).

**Fix:**

1. Make the solver reachable (see [flaresolverr-unreachable](#flaresolverr-unreachable)).
2. Give the indexer the proxy: edit the indexer, add the proxy's tag (the auto-registered solvers use the tag `cloudflare`).
3. Press **Test** again. Some sites rotate protections; if one keeps failing, check the solver log (`docker logs flaresolverr`) and try again later.
4. In the compose files with a VPN, FlareSolverr shares the VPN's network so its IP matches Arclight's. Do not move it out of that network or the site may block the mismatch.

More detail: [Cloudflare and other browser challenges](CLOUDFLARE.md).

---

<a id="vpn-wont-connect"></a>
### VPN will not connect

**What you see:** Settings > VPN shows "Disconnected" with an error, Health shows [vpn-disconnected](#vpn-disconnected), downloads are paused by the kill switch.

**Cause:** depends on the provider type you chose under Settings > VPN.

| Provider | Typical causes |
|---|---|
| Gluetun (Docker) | The `gluetun` container itself is not connected (bad Proton WireGuard key, wrong server country, missing `/dev/net/tun` or `NET_ADMIN`); Arclight cannot reach or authenticate to Gluetun's control server (wrong "Control server URL", missing or wrong API key). |
| WireGuard for Windows (native) | Arclight is not running elevated (Administrator), the `.conf` path is wrong, or the tunnel service cannot start. |
| Interface binding (any OS) | The adapter name does not match what the OS reports. |

**How to confirm:**

- Gluetun: `docker logs gluetun`. A healthy start ends with a public IP line; an auth error means the key is wrong. `docker compose ps` shows its health.
- A 401 or 403 from the control server means Gluetun needs an API key: generate one with `scripts/gluetun-auth.sh` (or `.ps1`), put it in `.env` as `GLUETUN_API_KEY`, and recreate the containers. In Settings > VPN the same key goes into the API key field.
- Settings > VPN shows Public IP, Last handshake (WireGuard), Last checked and any error text.
- Press **Test** on the VPN page; "The test failed" comes with the reason.

**Fix:**

1. Gluetun: fix the key or country in `.env` (`PROTON_WIREGUARD_KEY`, `VPN_COUNTRIES`), then `docker compose up -d`. After Gluetun is recreated, the containers that share its network (Arclight, FlareSolverr, and qBittorrent if you use it) must be recreated too; `docker compose up -d` does this.
2. Control server: use `http://localhost:8000` when Arclight shares Gluetun's network (the default in the provided compose files); otherwise use Gluetun's container name and port.
3. Windows: start Arclight from an elevated session and check the `.conf` path.
4. The "Public IP check URL" is only used by the native providers. If the VPN is up but the check fails, change it to another IP echo service.
5. See [vpn-leak](#vpn-leak) if the VPN connects but the public IP is still your home IP.

More detail: [VPN](using/vpn.md).

---

<a id="port-forward-not-synced"></a>
### Port forward not synced

**What you see:** Settings > VPN shows no "Port forward" value, or (if you use qBittorrent) qBittorrent keeps its old listening port, and downloads have few peers.

**Cause:** the VPN did not hand out a forwarded port, or Arclight could not pass it on.

- With Gluetun, port forwarding must be on (`VPN_PORT_FORWARDING=on` in the provided compose files). For Proton the WireGuard configuration must have NAT-PMP (port forwarding) enabled and you must connect to a P2P-capable server.
- Arclight reads the port from Gluetun's control server and, if **Sync forwarded port** is on (default), sets qBittorrent's listening port to it (relevant only if you use qBittorrent). This applies to Gluetun and to qBittorrent clients only.
- The built-in torrent engine does not need syncing: when Bind to VPN is on it moves its listener to the forwarded port by itself. Settings > Torrent Engine then shows "Listening port" as "forwarded by VPN".

**How to confirm:**

- Settings > VPN: the "Port forward" field.
- Log lines: `forwarded port synced to download clients` (success), `forwarded port sync failed` (error; Arclight retries after a wait).
- Gluetun log: look for the port line (`docker logs gluetun`).

**Fix:**

1. Enable NAT-PMP on the Proton config, pick a P2P server, set `VPN_PORT_FORWARDING=on`.
2. In Settings > VPN make sure "Sync forwarded port" is on and (if you use qBittorrent) the qBittorrent client passes **Test** in Settings > Download Clients.
3. Wait one poll interval (default 60 seconds) after a change.

---

<a id="permission-denied"></a>
### Permission denied on folders

**What you see:** Health shows [root-folder-not-writable](#root-folder-not-writable), [permissions-error](#permissions-error) or [docker-puid-pgid-mismatch](#docker-puid-pgid-mismatch); imports fail; the container cannot create files.

**Cause:** the user Arclight runs as does not own, or cannot write, the folder. In Docker that user is set by `PUID` and `PGID` in `.env` (default 1000 and 1000), the same convention linuxserver images use. On a NAS, the folders are often owned by a different user.

**How to confirm:**

- Find the owner of the share: `ls -ln /path/to/data` (the first two numbers after the permissions are the uid and gid).
- Compare with `PUID`/`PGID` in `.env`. Find your own with `id -u` and `id -g`.
- Health shows which folder is affected. For the config folder the message names the uid and gid it runs as and the folder's owner.

**Fix:**

1. Set `PUID` and `PGID` in `.env` to the user that owns the media and download folders, then `docker compose up -d`. The container's start script sets ownership of `/config` for you.
2. Or change the folder ownership to match: `chown -R <uid>:<gid> /path/to/data`.
3. Make sure any external client you use (qBittorrent, for example) runs with the same PUID/PGID, so the files it writes can be read and hardlinked.
4. Optional: Settings > Media Management > "Set permissions" lets Arclight apply a mode (default 755 for folders; files get the same without execute bits) and group to imported files.

---

<a id="hardlinks-not-working"></a>
### Hardlinks not working / imports are slow / double disk space

**What you see:** imports take a long time (a full copy of every file), the same episode takes twice the space (once in the downloads folder and once in the library), free space drops fast, or a title stops seeding after import. A hardlink lets one file appear in two places while using the disk once, instantly, so you can keep seeding. Health may show [hard-links-not-possible](#hard-links-not-possible).

**Cause:** Linux cannot hard-link across two different mounts, even when both mounts are folders on the same disk. The provided compose files mount one share, `${DATA_ROOT}:/data`, with `/data/downloads`, `/data/media/tv` and `/data/media/movies` inside it, and Arclight's root folders are `/data/media/tv` and `/data/media/movies`. If your setup has separate mounts instead (for example the old `/downloads`, `/tv` and `/movies`, or downloads on another volume or share), every import must copy the file: slow, double disk space, and seeding from the library copy breaks. When a hardlink is not possible, Arclight silently falls back to copying (the option is "Use hardlinks instead of copy", default on). Other reasons:

- Downloads and library are on different volumes or network shares.
- The share does not support hardlinks (some network mounts).
- "Use hardlinks instead of copy" is off in Settings > Media Management.
- If you use qBittorrent, it saves somewhere outside the shared mount.

**How to confirm:**

- Settings > Media Management: is "Use hardlinks instead of copy" on?
- Health: [hard-links-not-possible](#hard-links-not-possible).
- Compare the mounts: `docker inspect arclight` (look at `Mounts`): downloads and the media folders must be inside the same single mount (`/data`).
- On the host: `stat -c %d <file>` prints the device id; downloads and library must give the same number. `ls -li` shows the inode first; a hardlinked pair has the same inode and a link count of 2 or more.
- `du -sh` of the downloads folder and the library together is about twice what the library alone uses.

**Fix: use one share.**

1. Set the compose `DATA_ROOT` (in `.env`) to one share that holds everything, for example `/path/to/data`, laid out as `downloads/`, `media/tv/` and `media/movies/`, and mount it as `${DATA_ROOT}:/data`.
2. If you are moving from separate mounts: stop the stack (`docker compose down`), move the existing folders into that one share (same filesystem, so the move is instant), change the volume lines to the single `/data` mount, and start the stack again.
3. Edit the root folders to the new paths (Settings > Media Management, `/data/media/tv` and `/data/media/movies`), and set the built-in engine's downloads folder (Settings > Torrent Engine > "Downloads folder") to `/data/downloads`. The engine defaults to `/data/downloads` when `/data` exists; older installs keep `/downloads` until you change it.
4. If you use qBittorrent: set the default save path to `/data/downloads` (Options > Downloads), so no remote path mapping is needed.
5. Run a library rescan (refresh and scan the titles) so Arclight picks the files up at the new paths.
6. Turn on "Use hardlinks instead of copy".

Files already imported by copy stay duplicated until you delete the download copy or re-import. Step-by-step layout: [Folders and hardlinks](getting-started/folders-and-hardlinks.md).

---

<a id="locked-out"></a>
### Cannot log in / locked out

**What you see:** the login page rejects you, says "too many failed logins; try again later", or you are sent back to the login page in a loop.

**Cause:**

- **Too many failures.** After 10 failed logins from one address within 15 minutes, further attempts are refused for the rest of that window. The counter is kept in memory, so restarting Arclight also clears it.
- **Wrong or forgotten password.** There is no command-line password reset.
- **Login loop behind a reverse proxy.** The session cookie is `al_session` (it is marked Secure when the request arrived over https). The proxy must forward `X-Forwarded-Proto` and must not strip cookies.
- **Authentication method.** Settings > Security chooses the method (Forms, Basic or None) and whether local addresses may skip sign-in.

**How to confirm:** the error text on the login page; System > Logs (if you can still reach it from a local address or API key) for login messages.

**Fix:**

1. Wait 15 minutes, or restart the container.
2. Another admin can reset your password under Settings > Security ("Reset password").
3. Only admin and no password: restore a database backup from before the change (System > Backups; the files are in `<config>/backups/`), or stop Arclight, move `arclight.db` aside and run the first-run wizard again. That loses settings, not media files.
4. Reverse proxy: forward `X-Forwarded-Proto` and keep cookies; browse via the same URL each time.

---

<a id="does-not-match-the-contract"></a>
### Page shows "does not match the contract"

**What you see:** a page shows an error like `Response from /... does not match the contract (N issues)`.

**Cause:** the web app in your browser and the Arclight server disagree about the shape of the data. This happens when the two are different versions: an update just ran and your browser still holds the old web app (Arclight installs a service worker that caches the app), or a reverse proxy or CDN is serving an old copy of the web files or caching `/api` responses.

**How to confirm:** System > Status shows the server version; compare it with System > Updates. If a hard refresh fixes it, it was a stale cache.

**Fix:**

1. Hard refresh (Ctrl+F5, or Cmd+Shift+R). On mobile or an installed app, close it fully and reopen.
2. If it persists, clear the site data for the Arclight address in your browser (this also removes the cached app).
3. Make sure your reverse proxy does not cache `/api/*` and is not serving a leftover copy of the web files.
4. After updating, make sure the container really restarted with the new image (`docker compose pull && docker compose up -d`).
5. If it happens on one page only, report it as a bug (see [Still stuck](#still-stuck)) with the path from the error.

---

<a id="container-restarting"></a>
### Container keeps restarting

**What you see:** `docker compose ps` shows `arclight` as restarting or unhealthy; the web UI never comes up.

**Cause and how to confirm:** read the container log first: `docker logs --tail 100 arclight`.

| Log shows | Cause |
|---|---|
| `chown` or "Operation not permitted"/"Read-only file system" right after the start line | The start script sets ownership of `/config` and stops if that fails. This happens on NFS shares with root squash, read-only mounts, or a config path the NAS refuses to chown. Use a normal local folder for the config location. |
| Errors about the database or "unable to open" | The config folder is not writable or its disk is full. See [docker-puid-pgid-mismatch](#docker-puid-pgid-mismatch) and [config-disk-space-low](#config-disk-space-low). |
| "address already in use" | Port 7878 (or 8080 for the optional qBittorrent) is taken. Change the published port, or in the VPN stack remember the ports are published on the `gluetun` container. |
| Nothing wrong, container stays "starting" | With the VPN stack, `arclight` waits for `gluetun` to be healthy. If Gluetun cannot connect, nothing else starts. See [VPN will not connect](#vpn-wont-connect). |

The container health check calls `/api/v1/system/ping` and allows 20 seconds to start; a slow NAS can need longer after an update.

**Fix:** apply the fix for the log line, then `docker compose up -d`. If the network address range collides with another Docker network, set `ARCLIGHT_SUBNET`, `ARCLIGHT_SUBNET_DYNAMIC` and `WHISPER_IP` in `.env` and run `docker compose down` once.

---

<a id="slow-engine-start"></a>
### Slow engine start

**What you see:** after a restart, downloads sit on "Checking files" or paused for a minute or more, or the engine is not listening yet.

**Cause:** three normal start-up delays:

- **File check.** The built-in engine verifies the data already on disk for every torrent before continuing. The queue says "The built-in engine is starting up and checking the files already on disk". Large libraries on slow NAS disks take the longest.
- **First VPN check.** With the VPN integration on, the engine starts locked down ("Waiting for the first VPN check") and opens only once the VPN has been checked and is healthy. The default check interval is 60 seconds.
- **Gluetun not ready.** In the VPN stack Arclight waits for Gluetun to be healthy (it has a 60-second start period).

**How to confirm:** Settings > Torrent Engine > status shows "Starting", "Lockdown" or "Engine running"; System > Status shows Torrents and Lockdown.

**Fix:** usually nothing; wait. If it never leaves lockdown see [Paused by the VPN kill switch](#paused-by-vpn-kill-switch). If every restart is slow, check that the resume data folder (`<config>/torrents/`) is on a healthy disk, and do not point the downloads folder at a slow network share. You can lower the VPN "Poll interval" (minimum 10 seconds) to shorten the first-check wait.

---

## Health checks

System > Health runs 42 kinds of check, plus one more (hard-links-not-possible) that arrives with a pending change. Each finding is an error (something is broken) or a warning (something needs attention). The **How to fix** link on a finding opens its section here, and the same text is in the app under System > Health docs. Where two findings share a check id, the section says when each appears.

**Anchor table**

| Anchor | Check id (source) | Severity | Short meaning |
|---|---|---|---|
| [config-disk-space-low](#config-disk-space-low) | ConfigDiskSpace | warning | Under 1 GiB free where the database lives |
| [root-folder-low-free-space](#root-folder-low-free-space) | RootFolderFreeSpace | warning | A root folder has under 1 GiB free |
| [no-download-client-is-available](#no-download-client-is-available) | DownloadClientCheck | warning | No download client enabled |
| [remote-engine-unreachable](#remote-engine-unreachable) | RemoteEngineUnreachable | error | Remote engine agent does not answer |
| [unable-to-communicate-with-download-client](#unable-to-communicate-with-download-client) | DownloadClientCheck | error | A download client does not answer |
| [download-client-removes-completed-downloads](#download-client-removes-completed-downloads) | DownloadClientRemovesCompletedCheck | warning | Client deletes finished downloads itself |
| [bad-remote-path-mapping](#bad-remote-path-mapping) | RemotePathMappingCheck | error | Remote client path missing or invalid here |
| [docker-bad-remote-path-mapping](#docker-bad-remote-path-mapping) | RemotePathMappingCheck | error | Client path not visible in the container |
| [bad-download-client-settings](#bad-download-client-settings) | RemotePathMappingCheck | error | Local client path invalid for this OS |
| [permissions-error](#permissions-error) | RemotePathMappingCheck | error | Download folder exists but is not readable |
| [downloads-awaiting-manual-import](#downloads-awaiting-manual-import) | ImportPendingCheck | warning | Finished downloads waiting over 6 hours |
| [flaresolverr-unreachable](#flaresolverr-unreachable) | FlareSolverrUnreachable | warning | Challenge solver does not answer |
| [notifications-misconfigured](#notifications-misconfigured) | NotificationConfigCheck | warning | Notification settings no longer valid |
| [notifications-are-unavailable-due-to-failures](#notifications-are-unavailable-due-to-failures) | NotificationStatusCheck | warning or error | Notification deliveries keep failing |
| [no-root-folders](#no-root-folders) | RootFolderCheck | warning | No root folder configured |
| [missing-root-folder](#missing-root-folder) | RootFolderCheck | error | A root folder path does not exist |
| [root-folder-not-writable](#root-folder-not-writable) | RootFolderCheck | error | Arclight cannot write to a root folder |
| [empty-root-folder](#empty-root-folder) | RootFolderCheck | warning | Root folder with titles is empty on disk |
| [library-mount-ro](#library-mount-ro) | MountCheck | error | Library filesystem is read-only |
| [cannot-write-recycle-bin](#cannot-write-recycle-bin) | RecyclingBinCheck | error | Recycle bin missing or read-only |
| [tmdb-api-key-missing](#tmdb-api-key-missing) | MetadataSourceCheck | error | No TMDB API key |
| [docker-puid-pgid-mismatch](#docker-puid-pgid-mismatch) | DockerPermissionsCheck | error | Container user cannot write /config |
| [torrent-engine-failed](#torrent-engine-failed) | TorrentEngine | error | Built-in engine failed to start |
| [torrent-engine-not-listening](#torrent-engine-not-listening) | TorrentEngine | warning | Engine has no listening port |
| [torrent-engine-not-on-vpn](#torrent-engine-not-on-vpn) | TorrentEngine | warning | Engine is not bound to the VPN address |
| [vpn-disconnected](#vpn-disconnected) | VpnDisconnected | error | VPN enabled but not connected |
| [vpn-leak](#vpn-leak) | VpnDisconnected | warning | Public IP equals your home IP |
| [no-indexers-enabled](#no-indexers-enabled) | IndexerCheck | error | No indexer has any search switched on |
| [indexers-are-unavailable-due-to-failures](#indexers-are-unavailable-due-to-failures) | IndexerStatusCheck, IndexerLongTermStatusCheck, IndexerRssCheck, IndexerSearchCheck | error or warning | Indexers backing off after failures |
| [no-indexers-available-with-rss-sync-enabled](#no-indexers-available-with-rss-sync-enabled) | IndexerRssCheck | error | No indexer has RSS on |
| [no-indexers-available-with-automatic-search-enabled](#no-indexers-available-with-automatic-search-enabled) | IndexerSearchCheck | warning | No indexer has automatic search on |
| [no-indexers-available-with-interactive-search-enabled](#no-indexers-available-with-interactive-search-enabled) | IndexerSearchCheck | warning | No indexer has interactive search on |
| [feed-stale](#feed-stale) | FeedStale | warning | A data feed stopped syncing |
| [update-available](#update-available) | UpdateAvailable | warning | New Arclight version published |
| [container-updates-available](#container-updates-available) | ContainerUpdatesAvailable | warning | Labelled containers have newer images |
| [ffprobe-missing](#ffprobe-missing) | FfprobeMissing | warning | ffprobe not found |
| [orphan-files-found](#orphan-files-found) | OrphanFilesFound | warning | 25+ video files not in the library |
| [hard-links-not-possible](#hard-links-not-possible) | (pending, see section) | warning | Download folder and a root folder are on different mounts |
| [download-disk-space-full](#download-disk-space-full) | DownloadDiskSpace | error | Active downloads will not fit on disk |
| [download-disk-space-low](#download-disk-space-low) | DownloadDiskSpace | warning | Downloads will leave the disk nearly full |
| [download-stalled](#download-stalled) | DownloadStalled | warning | A download stopped receiving data |
| [torrent-engine-lockdown](#torrent-engine-lockdown) | TorrentEngineLockdown | warning | VPN kill switch paused the engine |
| [vpn-kill-switch-flapping](#vpn-kill-switch-flapping) | VpnKillSwitchFlapping | warning | Kill switch engaged 3+ times in an hour |

**Disk space**

<a id="config-disk-space-low"></a>
### Config volume is low on space

Source: `ConfigDiskSpace` (warning).

**Meaning:** less than 1 GiB is free on the volume that holds the config folder: the database (`arclight.db`), logs, backups and torrent resume data. A full disk makes the database unable to write, which can corrupt a run or stop Arclight working.

**How to confirm:** System > Status > Paths shows the config folder; the Health message shows the free space. On the host, `df -h <config folder>`.

**Fix:** free space on that volume or move the config folder to a larger disk. Lower log and backup retention (System > Backups > Backup settings). Backups are in `<config>/backups/` unless you chose another folder.

<a id="root-folder-low-free-space"></a>
### Root folder is low on space

Source: `RootFolderFreeSpace` (warning).

**Meaning:** a library root folder has less than 1 GiB free, so imports into it will fail. Root folders that do not exist are reported by [missing-root-folder](#missing-root-folder) instead.

**How to confirm:** Settings > Media Management > root folders shows free space per path ("Free space on ..."). The Health message lists each folder with what is left.

**Fix:** free space on that disk, or add another root folder (Settings > Media Management > Add root folder) and move titles to it.

<a id="hard-links-not-possible"></a>
### Hard links aren't possible between the download folder and a root folder

Source: not final yet (the check is in progress). Expected to be a warning. It will exist in the app after the pending change merges, so the "How to fix" link and the Health docs page will only show it from that version on; the section below already applies.

**Meaning:** the download folder and a root folder are on different mounts or filesystems. Imports then cannot create hard links and must copy every file: slow, double disk space, and seeding breaks after import.

**How to confirm:** the Health finding names the folders. Otherwise compare the device ids with `stat -c %d <download folder> <root folder>` (they must match), or compare the mounts in `docker inspect arclight`: both folders must be inside the same mount.

**Fix:** put downloads and media under one share and mount it once (`${DATA_ROOT}:/data`, with `/data/downloads` and `/data/media/...`). Migration steps: [Hardlinks not working](#hardlinks-not-working) and [Folders and hardlinks](getting-started/folders-and-hardlinks.md).

<a id="download-disk-space-full"></a>
### Downloads will not fit on disk

Source: `DownloadDiskSpace` (error).

**Meaning:** the active downloads in one download folder still need more bytes than the volume has free. They will stop with a disk error before they finish. The Health message says how many downloads, which folder, and how much is needed versus free. Affected queue rows show "Disk full" with the shortfall.

**How to confirm:** Activity > Queue, filter for "Disk full" rows; `df -h` on the download volume.

**Fix:** free space on the download volume, or move the download folder to a larger disk. Remove or pause downloads you do not need from the queue.

> Coming soon: a disk-space guard that pauses or holds new downloads automatically before the disk fills. This page will be updated when it ships. The health check above already warns you today.

<a id="download-disk-space-low"></a>
### Downloads will leave the disk almost full

Source: `DownloadDiskSpace` (warning).

**Meaning:** once the active downloads finish, less than the minimum free space would be left on the volume. Imports may then be refused. The limit is Settings > Media Management > "Minimum free space" (default 100 MB).

**How to confirm:** the Health message gives the free space expected after the downloads finish and the minimum.

**Fix:** free space on the download volume, or lower the minimum free space setting if you are sure.

**Download clients and paths**

<a id="no-download-client-is-available"></a>
### No download client is available

Source: `DownloadClientCheck` (warning).

**Meaning:** no download client is enabled, so grabbed releases have nowhere to go.

**How to confirm:** Settings > Download Clients is empty or every client is disabled.

**Fix:** enable the built-in torrent engine (Settings > Torrent Engine, "Enable engine"; it adds a "Built-in" client on first start unless `ARCLIGHT_TORRENT_ENGINE=0`) or add an external client such as qBittorrent, Transmission, SABnzbd or NZBGet under Settings > Download Clients, then press **Test**.

<a id="unable-to-communicate-with-download-client"></a>
### Download client does not answer

Source: `DownloadClientCheck` (error).

**Meaning:** the last connection to the first failing client did not work: wrong host or port, wrong credentials, or the client is down. The Health message names the client and the error.

**How to confirm:** Settings > Download Clients, press **Test** on the client; the error text is shown. Queue rows for it say "Client unreachable".

**Fix:** check the client is running and reachable from Arclight (same Docker network, or the same VPN network when you use the Gluetun stack, where the client address is `localhost`). Fix host, port or credentials in Settings > Download Clients and press **Test**.

<a id="remote-engine-unreachable"></a>
### Remote engine is unreachable

Source: `RemoteEngineUnreachable` (error).

**Meaning:** Arclight cannot reach the agent of a Remote Engine download client. Downloads on that engine are not tracked or imported until it answers again. One finding per engine.

**How to confirm:** the Health message includes the engine name, its address and the error. Settings > Download Clients > **Test**.

**Fix:** check the agent is running on the remote host and that its port is reachable from Arclight (firewall, VPN, Docker network). Press **Test** on the client. Setup details: [Remote engine](REMOTE-ENGINE.md).

<a id="download-client-removes-completed-downloads"></a>
### Download client removes completed downloads

Source: `DownloadClientRemovesCompletedCheck` (warning).

**Meaning:** the client is set to delete finished downloads on its own, possibly before Arclight has imported them. The import then fails with "no files found".

**How to confirm:** the Health message names the client. In the client's own settings look for "remove when finished" or a seeding-limit action of "remove".

**Fix:** turn off "remove when finished" (and the seeding-limit remove action) in the client, and let Arclight remove downloads after import instead.

<a id="bad-remote-path-mapping"></a>
### Remote path mapping is wrong or missing

Source: `RemotePathMappingCheck` (error).

**Meaning:** a download client on another machine (or one Arclight does not treat as local) reports a download folder that either is not a valid path on this system, or does not exist where Arclight runs. This is the classic "client says /downloads/tv, Arclight sees /data/downloads/tv" mismatch.

**How to confirm:** the Health message shows the path the client reports. Settings > Download Clients, remote path mappings card, lists the current mappings.

**Fix:** add a remote path mapping from the client's path to the same folder as Arclight sees it (host, remote path, local path), or make both containers mount the downloads folder at the same path (the provided compose files mount one share at `/data` in both, with downloads in `/data/downloads`, so no mapping is needed).

<a id="docker-bad-remote-path-mapping"></a>
### Download folder is not mounted in the container

Source: `RemotePathMappingCheck` (error).

**Meaning:** Arclight runs in Docker and the folder the client reports does not exist inside the Arclight container.

**How to confirm:** `docker exec arclight ls <path from the message>`. The message shows the path.

**Fix:** mount the downloads folder into both containers at the same path (for example `/data`, with the client saving to `/data/downloads`). Or add a remote path mapping.

<a id="bad-download-client-settings"></a>
### Local download client reports an invalid path

Source: `RemotePathMappingCheck` (error).

**Meaning:** a client on this machine places downloads in a path that is not valid for this operating system (for example a Linux path on Windows).

**How to confirm:** the Health message shows the path and the OS it expected.

**Fix:** fix the download folder in the client's own settings.

<a id="permissions-error"></a>
### Download folder is not readable

Source: `RemotePathMappingCheck` (error).

**Meaning:** the folder exists but the user running Arclight cannot read it.

**How to confirm:** `ls -ln` on the folder and compare the owner with the user Arclight runs as. See [Permission denied on folders](#permission-denied).

**Fix:** give the Arclight user (PUID/PGID in Docker) read and write access to the downloads folder.

<a id="downloads-awaiting-manual-import"></a>
### Downloads wait for manual import

Source: `ImportPendingCheck` (warning).

**Meaning:** finished downloads could not be matched or imported automatically for more than 6 hours. The wait is counted from when Arclight first saw the item pending, so a restart starts the clock again.

**How to confirm:** Activity > Queue rows with "Import blocked" or "Waiting for import". The Health message lists the titles.

**Fix:** open Activity > Manual import, pick the series or movie for each file and import. For the usual reasons see [Import blocked or failed](#import-blocked-or-failed).

**Challenge solver, notifications, metadata**

<a id="flaresolverr-unreachable"></a>
### Challenge solver is unreachable

Source: `FlareSolverrUnreachable` (warning).

**Meaning:** a FlareSolverr-type indexer proxy (the bundled container, an external one, or the built-in solver) does not answer, so Cloudflare-protected indexers fail. One finding per solver.

**How to confirm:** Settings > Indexer Proxies, **Test** on the proxy; the Health message includes the error.

**Fix:**

- Docker: check the `flaresolverr` container is running (`docker compose ps`) and shares the network Arclight uses.
- Native: open Settings > Challenge Solver, make sure a browser is found, then press **Detect now** and **Test**.
- Delete stale solver proxies under Settings > Indexer Proxies.

See also [Cloudflare challenge](#cloudflare-challenge).

<a id="notifications-misconfigured"></a>
### Notifications are misconfigured

Source: `NotificationConfigCheck` (warning).

**Meaning:** the stored settings of one or more enabled notification connections no longer validate, for example after an upgrade changed a field.

**How to confirm:** the Health message lists the connection names.

**Fix:** open each listed connection in Settings > Notifications, fix the highlighted fields and save.

<a id="notifications-are-unavailable-due-to-failures"></a>
### Notifications keep failing

Source: `NotificationStatusCheck` (error when all enabled connections are failing, warning when only some are).

**Meaning:** deliveries failed several times in a row: the service is down, the webhook was deleted or the token was revoked.

**How to confirm:** the Health message lists the failing connections. Settings > Notifications, press **Test**; the error is shown.

**Fix:** press **Test** on the notification to see the error, then update its credentials or URL.

<a id="tmdb-api-key-missing"></a>
### TMDB API key is missing

Source: `MetadataSourceCheck` (error).

**Meaning:** without a TMDB key Arclight cannot look up series and movies or refresh metadata, and you cannot add titles.

**How to confirm:** Settings > General has no key, and `ARCLIGHT_TMDB_API_KEY` is not set.

**Fix:** create a free API key at themoviedb.org and enter it in Settings > General, or set `ARCLIGHT_TMDB_API_KEY`.

**Root folders and library storage**

<a id="no-root-folders"></a>
### No root folders

Source: `RootFolderCheck` (warning).

**Meaning:** series and movies need a root folder to be added to.

**How to confirm:** Settings > Media Management shows no root folders.

**Fix:** add at least one root folder for TV and one for movies (Settings > Media Management > Add root folder). In the provided Docker stacks they are `/data/media/tv` and `/data/media/movies`.

<a id="missing-root-folder"></a>
### Root folder is missing

Source: `RootFolderCheck` (error).

**Meaning:** a root folder path does not exist: an unmounted drive, a changed volume, or a typo. The message lists every missing path.

**How to confirm:** `docker exec arclight ls <path>`; on the host check the mount.

**Fix:** mount the drive or fix the Docker volume, or remove the root folder and move its titles. This check reports only the first problem it finds, so more may appear after you fix this one.

<a id="root-folder-not-writable"></a>
### Root folder is not writable

Source: `RootFolderCheck` (error).

**Meaning:** Arclight cannot create files in the root folder, so imports fail.

**How to confirm:** the Health message lists the folders. See [Permission denied on folders](#permission-denied).

**Fix:** give the Arclight user (PUID/PGID in Docker) write access to the folder. If the filesystem is read-only, see [library-mount-ro](#library-mount-ro).

<a id="empty-root-folder"></a>
### Root folder is empty

Source: `RootFolderCheck` (warning).

**Meaning:** a root folder that has titles in the library contains nothing on disk. Usually a mount that failed and left an empty mount point. Dangerous because Arclight could then think everything was deleted.

**How to confirm:** list the folder on the host and in the container.

**Fix:** check the drive or network share is mounted before Arclight starts (start order, `depends_on`, or delay the container until the NAS volume is up). Do not run library clean-ups until it is back.

<a id="library-mount-ro"></a>
### Library mount is read-only

Source: `MountCheck` (error).

**Meaning:** the filesystem holding a library path is mounted read-only. The message shows the mount point and the root folder on it.

**How to confirm:** `mount | grep <mount point>` shows `ro`; or the Docker volume has `:ro`.

**Fix:** remount it read-write, or drop the `:ro` flag from the Docker volume. A filesystem that went read-only after errors needs a disk check on the NAS.

<a id="cannot-write-recycle-bin"></a>
### Recycle bin is not writable

Source: `RecyclingBinCheck` (error).

**Meaning:** deleted and replaced files are moved to the recycle bin, and that folder does not exist or is read-only.

**How to confirm:** the Health message shows the path (Settings > Media Management, recycle bin path).

**Fix:** create the folder with write access for the Arclight user, or clear the recycle bin setting (then deleted files are removed permanently).

<a id="docker-puid-pgid-mismatch"></a>
### Container user cannot write the config volume

Source: `DockerPermissionsCheck` (error, Docker only).

**Meaning:** PUID/PGID do not own the `/config` volume. The message gives the uid and gid Arclight runs as and the folder's owner.

**How to confirm:** `ls -ln` on the host config folder; `id -u` and `id -g` for your user.

**Fix:** set PUID and PGID in `.env` to the owner of the config folder (`id -u`, `id -g`), or `chown` the folder, then `docker compose up -d`.

**Torrent engine and VPN**

<a id="torrent-engine-failed"></a>
### Built-in torrent engine failed to start

Source: `TorrentEngine` (error).

**Meaning:** the engine could not start, usually because its listening port is taken or its folders are not writable. The message includes the reason.

**How to confirm:** Settings > Torrent Engine > status; System > Logs for the start-up error.

**Fix:** pick another listening port (Settings > Torrent Engine > "Listen port") or fix folder permissions on the downloads folder and the resume data folder (`<config>/torrents/`), then restart.

<a id="torrent-engine-not-listening"></a>
### Torrent engine is not listening

Source: `TorrentEngine` (warning).

**Meaning:** the engine is enabled but has no listening port, so no incoming connections are possible. That slows downloads and seeding.

**How to confirm:** Settings > Torrent Engine > status shows "not listening".

**Fix:** check the listening port, and forward it on the router or through the VPN ([Port forward not synced](#port-forward-not-synced)).

<a id="torrent-engine-not-on-vpn"></a>
### Torrent engine is not bound to the VPN

Source: `TorrentEngine` (warning).

**Meaning:** torrent traffic can leave outside the tunnel. The VPN is on and has an adapter address, but the engine is bound to something else (the message shows the address it is bound to and the tunnel address).

**How to confirm:** Settings > Torrent Engine > status: "Bound address" and "Bind to VPN".

**Fix:** turn on "Bind to VPN" for the torrent engine (Settings > Torrent Engine). With Gluetun in Docker the engine shares Gluetun's network, so this finding mostly concerns native installs.

<a id="vpn-disconnected"></a>
### VPN is down

Source: `VpnDisconnected` (error).

**Meaning:** VPN monitoring is on and the tunnel is not connected. Grabs are paused if "Pause grabs when down" is on, and the built-in engine is locked down.

**How to confirm:** Settings > VPN > Connection and the error text.

**Fix:** check the Gluetun or WireGuard logs and credentials, then press Refresh on the VPN page. Full steps: [VPN will not connect](#vpn-wont-connect).

<a id="vpn-leak"></a>
### Traffic is not going through the VPN

Source: `VpnDisconnected` (warning).

**Meaning:** the public IP equals your home IP (the "Home public IP" you entered in Settings > VPN), so traffic bypasses the tunnel. Grabs pause and the engine locks down.

**How to confirm:** Settings > VPN shows "Leaking" with the matching IP. If your home IP changed (ISP), the stored value may simply be out of date.

**Fix:** make Arclight and the download client use the VPN (`network_mode: service:gluetun` or interface binding). If your own IP changed, update or clear "Home public IP".

<a id="torrent-engine-lockdown"></a>
### Torrent engine is locked down by the VPN kill switch

Source: `TorrentEngineLockdown` (warning).

**Meaning:** the VPN is down, leaking or not checked yet, so the built-in engine paused every torrent and only listens on 127.0.0.1. They resume on their own when the VPN reconnects. The message gives the reason, the start time and how many torrents are paused.

**How to confirm:** the queue banner, System > Status "Lockdown", Settings > Torrent Engine "Lockdown".

**Fix:** check the VPN status under Settings > VPN and the VPN container or connection. If the VPN is actually up, check that Arclight can reach its status endpoint (for Gluetun, the control server). See [Paused by the VPN kill switch](#paused-by-vpn-kill-switch).

<a id="vpn-kill-switch-flapping"></a>
### VPN kill switch keeps engaging

Source: `VpnKillSwitchFlapping` (warning).

**Meaning:** the kill switch paused the engine 3 or more times within an hour. Each time every torrent stops, so downloads crawl or appear to hang.

**How to confirm:** the queue banner shows the count; System > Logs around the times.

**Fix:** check the VPN connection for drops (provider, server, container restarts). If the VPN stays up, its status checks are failing: look for slow or timed-out status replies in the logs, and consider a longer poll interval or a different server.

**Indexers**

<a id="no-indexers-enabled"></a>
### No indexers enabled

Source: `IndexerCheck` (error).

**Meaning:** no indexer has RSS, automatic search or interactive search switched on, so searches and RSS have nowhere to look.

**How to confirm:** Settings > Indexers is empty or every indexer has all three switches off.

**Fix:** add an indexer from the catalogue or a Torznab/Newznab endpoint.

<a id="indexers-are-unavailable-due-to-failures"></a>
### Indexers are backing off after failures

Sources: `IndexerStatusCheck` (failing for under 6 hours), `IndexerLongTermStatusCheck` (over 6 hours), `IndexerRssCheck` and `IndexerSearchCheck` (when every RSS or search-capable indexer is in back-off).

**Meaning:** indexers failed repeatedly and are skipped until their back-off ends: site down, rate limit, bad key, or a browser challenge. Severity is an error when all enabled indexers are affected and a warning when only some are.

**How to confirm:** the message names the indexers. Settings > Indexers: press **Test** on each one and read the error. Indexers > Stats shows failure counts.

**Fix:** press Test on the indexer to see the error and correct the URL, key or account. Sites behind Cloudflare need a challenge solver ([Cloudflare challenge](#cloudflare-challenge)). The back-off ends on its own; a successful Test clears it faster.

<a id="no-indexers-available-with-rss-sync-enabled"></a>
### No indexer has RSS enabled

Source: `IndexerRssCheck` (error).

**Meaning:** new releases are not grabbed automatically.

**How to confirm:** no enabled indexer has RSS on.

**Fix:** enable RSS on at least one indexer.

<a id="no-indexers-available-with-automatic-search-enabled"></a>
### No indexer has automatic search enabled

Source: `IndexerSearchCheck` (warning).

**Meaning:** missing episodes and movies are never searched for automatically.

**How to confirm:** no enabled indexer has automatic search on.

**Fix:** enable automatic search on at least one indexer.

<a id="no-indexers-available-with-interactive-search-enabled"></a>
### No indexer has interactive search enabled

Source: `IndexerSearchCheck` (warning).

**Meaning:** interactive search returns nothing.

**How to confirm:** no enabled indexer has interactive search on.

**Fix:** enable interactive search on at least one indexer.

**Feeds, updates, tools**

<a id="feed-stale"></a>
### A data feed stopped updating

Source: `FeedStale` (warning).

**Meaning:** an enabled data feed (TRaSH guides, indexer definitions, and similar) has gone three sync intervals without a successful sync, or has never synced. The message includes the last error.

**How to confirm:** System > Feeds lists each feed, its state and the last error.

**Fix:** check the last error: usually the feed host is unreachable or rate-limiting. Open System > Feeds to see which feed is stale, then press **Sync now** on its settings page once the host is back.

<a id="update-available"></a>
### A new Arclight version is available

Source: `UpdateAvailable` (warning). Shown only while update checks and "notify on update" are on in Settings > Updates.

**Meaning:** a newer release is published on the configured channel.

**How to confirm:** System > Updates shows the running and latest versions.

**Fix:**

- Docker: `docker compose pull && docker compose up -d` (or turn on automatic updates).
- Windows or native: download the new release from GitHub and run it.

Back up first (System > Backups). Details: [Updating](getting-started/updating.md).

<a id="container-updates-available"></a>
### Container updates are available

Source: `ContainerUpdatesAvailable` (warning).

**Meaning:** a container labelled `arclight.autoupdate=true` (in the provided compose files: gluetun, flaresolverr, and qbittorrent and whisper when enabled) runs an older image than its registry offers.

**How to confirm:** Settings > Updates lists the containers and which have updates.

**Fix:** press **Update now** under Settings > Updates, or set the mode to automatic (it then updates inside the configured window). Updating from the app needs the Docker socket to be mounted; without it, run `docker compose pull && docker compose up -d`.

<a id="ffprobe-missing"></a>
### ffprobe was not found

Source: `FfprobeMissing` (warning).

**Meaning:** media analysis needs ffprobe (part of ffmpeg). Without it files get no codec, HDR, audio or subtitle track details, and sample detection by runtime is off. Files stay queued for analysis.

**How to confirm:** System > Tasks shows "ffprobe not found. Files stay queued."

**Fix:**

- Docker: the image ships ffmpeg; check you are not overriding `PATH`.
- Native: install ffmpeg and put it on `PATH`, or set `ARCLIGHT_FFPROBE` to the ffprobe binary.
- Restart Arclight, then press **Analyze** on a title or run the AnalyzeMedia task under System > Tasks.

<a id="orphan-files-found"></a>
### Video files are not in the library

Source: `OrphanFilesFound` (warning).

**Meaning:** the last orphan scan found 25 or more video files in your root folders that no library item points at.

**How to confirm:** Library > Hygiene lists them.

**Fix:** open Library > Hygiene and map each orphan to its series or movie, or delete it. Run **Scan now** afterwards to clear the warning.

**Stalled downloads**

<a id="download-stalled"></a>
### A download stopped receiving data

Source: `DownloadStalled` (warning).

**Meaning:** a download got no new data for longer than the stall threshold (Settings > Media Management, "Stalled download after", default 10 minutes, 0 = off). Usually the release has no seeders left or the client cannot reach peers. The message lists up to five titles and since when.

**How to confirm:** Activity > Queue rows marked "Stalled"; open one for the state reason and Timeline.

**Fix:** open the download in the queue: the state reason and timeline say what happened (no peers, kill switch, client errors). If no seeders are left, remove it with **Add to blocklist** so a different release is searched for. More in [Stalled](#stalled).

> Coming soon: stall auto-recovery and "try another release". This page will be updated when it ships.

---

## Still stuck

Before opening a bug report or asking for help, collect:

1. **Version and install type.** System > Status: version, platform, Docker yes/no. How you run it (compose file name, NAS model, native Windows).
2. **What you expected and what happened,** in two sentences, plus exact steps to repeat it.
3. **The Health page.** Copy the findings (or a screenshot of System > Health).
4. **The queue item** (if it is about a download): its state label, the sentence under it and the Timeline from the details panel.
5. **The last 200 log lines** around the problem, with the level at Debug if you can reproduce it (`ARCLIGHT_LOG_LEVEL=debug`, restart, repeat). From Docker: `docker logs --tail 200 arclight`. For VPN problems add `docker logs --tail 100 gluetun`.
6. **Relevant settings,** described in words or screenshots: which indexer, which client, the VPN provider type, your folder layout (what is mounted where).
7. **What you already tried.**

Remove before sharing: API keys, passkeys, WireGuard private keys, webhook URLs, passwords, your public IP, and anything from `.env` except the folder paths and PUID/PGID.

Known gaps in the product are listed in [Known limitations](qa/99-known-limitations.md).

## Related

- [Glossary](GLOSSARY.md)
- [FAQ](FAQ.md)
- [System pages (Status, Tasks, Logs, Backups, Health)](using/system.md)
- [VPN](using/vpn.md)
- [Download clients and the torrent engine](using/download-clients.md)
- [Indexers](using/indexers.md)
- [Folders and hardlinks](getting-started/folders-and-hardlinks.md)
- [Cloudflare and other browser challenges](CLOUDFLARE.md)
- [Remote engine](REMOTE-ENGINE.md)
