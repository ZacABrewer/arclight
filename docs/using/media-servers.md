# Media servers: Jellyfin, Emby and Plex

Arclight is not a media server. It finds and organises your files, then your media server plays them. This page covers how Arclight talks to Jellyfin, Emby and Plex: the Settings > Media Servers list (used for request availability, watch-history retention and sign-in), and the Jellyfin, Emby and Plex connection types under Settings > Notifications that tell your server to rescan after an import. You need it if you want new files to show up in your server quickly, want requests to show "Available on <server>", or want your server's users to sign in to Arclight.

## Two places, two jobs

| Where | What it does |
|---|---|
| Settings > Media Servers | The list of servers Arclight can read from: is this title on the server, who watched what (retention), who may sign in |
| Settings > Notifications, type Jellyfin / Emby / Plex Media Server | Sends a "rescan this folder" message to the server after imports, upgrades, renames and deletions |

They are configured separately. For fast rescans you need the notification connection. For requests, retention and sign-in you need the media server entry. Using both for the same server is normal.

## Getting an API key or token

| Server | Where to get the credential |
|---|---|
| Jellyfin | Dashboard > API Keys > New. Give it the name Arclight |
| Emby | Dashboard > API Keys > New App Key |
| Plex | The owner's `X-Plex-Token`. Arclight asks for the token, not a username and password |

Keep tokens private. Arclight stores them in its database and never shows them again after saving; leave the masked value in place when you edit to keep the stored one.

## Settings > Media Servers

Press **Add media server**, fill in the form, press **Test**, then save. The test reports the server name, version and the movie and TV libraries it found (or "The server reports no movie or series libraries").

| Setting | Default | What it does |
|---|---|---|
| Kind | - | Jellyfin, Emby or Plex |
| Name | - | Your label, shown to users as "Available on <name>" |
| URL | - | Base address including any URL base, for example `http://jellyfin.example.com:8096`. In Docker, use the container name or the NAS address, not `localhost` |
| API key (Plex: X-Plex-Token) | empty | Credential from the table above |
| Enabled | On | Off keeps the entry but nothing uses it |
| Availability | On | Requests count as available once this server has the title |
| Retention | Off | Watch history from this server feeds retention rules |
| Library refresh | Off | Marks the server for post-import rescans (see the next section) |
| Sign-in | Off | Users may sign in to Arclight with their account on this server. The first enabled server with this on is used |
| Create users on sign-in | Off | A first sign-in creates a local Arclight account with the default permissions from Settings > Requests |

Buttons per server: **Test**, **Edit**, **Delete** (the entry is removed; linked Arclight user accounts keep their link). The page also has a sign-in and user import panel (Test sign-in server, Import users).

### What each use does

- **Availability.** When a request is made, Arclight asks every enabled server flagged for Availability whether it has the title, matched by TMDB, TVDB or IMDb id (Plex has no id search, so Arclight indexes its libraries). A match shows as "Available on <name>", and the request is marked available. See [Discover and requests](discover-and-requests.md).
- **Retention.** If you use retention rules, watch history from flagged servers decides what counts as watched.
- **Sign-in and user import.** See [Users and security](users-and-security.md). Imported accounts become Arclight users with the default permissions and sign in with their media server password. Use **Import users** to pick which server accounts to bring in; accounts already linked are marked as such.

## Library refresh: telling the server to rescan

After Arclight imports, upgrades, renames or deletes files, your server will not notice for a while unless it is told (or has real-time monitoring and can see the folder). To tell it, add a connection in Settings > Notifications: **Add connection** and pick Jellyfin, Emby or Plex Media Server. These connections only react to library changes: imports, upgrades, renames, deleted titles and files, downloaded subtitles and in-place transcodes. They do not send messages for grabs or health unless you use Emby's Notify option.

### Jellyfin and Emby

| Setting | Default | What it does |
|---|---|---|
| Host | - | Hostname or IP |
| Port | 8096 | Port |
| Use SSL | Off | HTTPS |
| URL base | empty | Sub-path when the server sits behind a reverse proxy sub-path |
| API key | - | From the Dashboard (see above) |
| Update library | On | Tell the server which folder changed, so it rescans only that. Off sends nothing |
| Notify (Emby only) | Off | Also show a notification in Emby for grabs, imports, upgrades, health issues, application updates and manual-interaction events |

How it rescans: Arclight sends the series or movie folder as a "modified" (or "deleted") update. If the event carries no folder path, it falls back to a full library refresh. The folder path must be the path **as the media server sees it**. If Arclight and your server mount the same folders at different paths (very common between containers), the server will not find the folder; keep the paths identical in both containers, see [Folders and hardlinks](../getting-started/folders-and-hardlinks.md).

### Plex Media Server

| Setting | Default | What it does |
|---|---|---|
| Host | - | Hostname or IP |
| Port | 32400 | Port |
| Use SSL | Off | HTTPS |
| Auth token | - | The owner's X-Plex-Token |

How it rescans: Arclight lists your Plex library sections, finds the TV or movie section whose folder contains the series or movie, and asks Plex to scan just that folder. If no section contains it, the notification fails with "No Plex TV library contains <path>" (or movie library). Fix this by making the library folders match what Arclight sees, or by adding the folder to the Plex library.

### Which events trigger a rescan

Switch on the same events as for any connection: On download (import), On upgrade, On rename, On series delete, On movie delete, On file delete. The connection form's Test button sends a test event and checks that the server answers.

> The "Library refresh" switch on the Media Servers page marks a server as a refresh target, but the rescans described here are sent by the notification connections. Set up a connection if you want rescans.

## Common problems

| Symptom | Likely cause |
|---|---|
| Test says unauthorized | Wrong API key or token, or the key was deleted in the server |
| Test says network or the server did not answer | Wrong host or port, or Arclight cannot reach the server. Behind a VPN, see [VPN](vpn.md): the server may be on your LAN, which the VPN firewall must allow (`FIREWALL_OUTBOUND_SUBNETS` in the shipped Docker setup) |
| New files do not appear in the server | No Notifications connection, event switches off, or path mismatch between Arclight and the server. Turn on real-time monitoring in the server as a fallback |
| Plex: "No library contains..." | The Plex library folders differ from the paths Arclight uses |
| Request never shows "Available" | Availability is off for that server, the server has no matching library, or the title has no external id Arclight can match |
| Nobody can sign in | No enabled server has Sign-in on. See [Users and security](users-and-security.md) |

## Related

- [Notifications](notifications.md)
- [Discover and requests](discover-and-requests.md)
- [Users and security](users-and-security.md)
- [Folders and hardlinks](../getting-started/folders-and-hardlinks.md)
- [Library](library.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
