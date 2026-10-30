# Notifications

Arclight can tell you, or other apps, when something happens: a release was grabbed, a file was imported, a health check failed, someone made a request. This page covers Settings > Notifications (connections to Discord, Telegram, ntfy, email and more), the events you can pick, the Test button, and browser push notifications. Everyone benefits from at least one connection; the health events in particular tell you early when a download client, VPN or disk has a problem.

Three Notification connection types (Jellyfin, Emby and Plex) do a different job: they ask your media server to rescan after an import. Those are covered in [Media servers](media-servers.md).

## Where things live

| What | Where |
|---|---|
| Add, edit, test and delete connections | Settings > Notifications |
| Browser (web push) notifications, per user | Your profile page, "Show notifications in this browser" |
| Daily admin digest of pending requests and open issues | Settings > Requests, "Daily digest" |

## Adding a connection

1. Go to Settings > Notifications and press **Add connection**.
2. Choose a type (table below).
3. Give it a name, fill in the type's fields, and tick the events you want under **Notify on**.
4. Press **Test**. Arclight sends a test message and reports success or the reason it failed (for example `network` or `unauthorized`).
5. Save.

Connections can be switched off without deleting them. Editing a saved connection and pressing Test tests the values on screen, including unsaved edits. Secrets (tokens, passwords, webhook URLs) are never shown again after saving; leave the masked value in place to keep the stored one.

## Connection types

| Type | Delivers to | Fields (defaults in brackets) |
|---|---|---|
| Discord | A channel through a webhook, as rich embeds with poster, quality, size, links | Webhook URL (required: Channel settings > Integrations > Webhooks). Username, Avatar URL, Author (default: instance name). Fields shown on grab, import/upgrade and manual-interaction embeds: overview, rating, genres, quality, codecs, group, size, languages, subtitles, links, release, poster, fanart, indexer, custom formats, custom format score |
| Telegram | A chat, group or channel through a bot | Bot token (from @BotFather), Chat ID (negative for groups; @userinfobot finds yours), Topic ID (forum groups only), Send silently (off), Include link (on) |
| ntfy | Phones and desktops through ntfy | Server URL (`https://ntfy.sh`), Topics (required), Priority 1 to 5 (3), Tags, Click URL, Access token (preferred) or Username and Password |
| Gotify | Your Gotify server | Server URL, App token (from the Gotify Apps page), Priority 0 to 10 (5), Markdown (on) |
| Pushover | Pushover app | API token and User key (30 characters each), Devices (empty means all), Priority -2 to 2 (0), Retry (60 s) and Expire (3600 s) for emergency priority, Sound |
| Email | One or more addresses over SMTP | Host, Port (587), Security: None, STARTTLS, TLS (STARTTLS), Username and Password (blank means no authentication), From, To, CC, BCC, Subject prefix (`[Arclight]`) |
| Webhook | Any URL, as a JSON event | URL, Method POST or PUT (POST), Username and Password for basic auth, extra Headers (for an API key) |
| Custom Script | A program on the Arclight machine | Path (absolute), Arguments (split on spaces), Timeout (60000 ms, 1000 to 3600000). The event is passed as `ARCLIGHT_*` environment variables, starting with `ARCLIGHT_EVENT_TYPE`; lists are joined with `\|` |
| Jellyfin | Rescans a Jellyfin library | See [Media servers](media-servers.md) |
| Emby | Rescans an Emby library, optionally shows a message in Emby | See [Media servers](media-servers.md) |
| Plex Media Server | Rescans the matching Plex library folder | See [Media servers](media-servers.md) |

Custom Script runs with Arclight's own permissions. In Docker the script must exist inside the container. A script that hangs is killed after the timeout.

Which events each type can receive: Discord, Telegram, ntfy, Gotify, Pushover and Email handle every event except file renames. Webhook and Custom Script handle all events. Jellyfin and Plex handle only library changes (imports, upgrades, renames, deletions, subtitles, transcodes); Emby handles those too, and with "Notify" on it also handles grabs, imports, upgrades, health issues, application updates and manual-interaction events.

## Events (Notify on)

| Switch | Fires when | Notes |
|---|---|---|
| On grab | A release is sent to a download client | |
| On download | A download was imported into the library | New files only |
| On upgrade | An imported file replaces a worse one | |
| On rename | Files were renamed | Also fires when a transcode rule rewrites a file in place |
| On series add | A series was added to the library | |
| On movie add | A movie was added to the library | |
| On series delete | A series was deleted | Also used for retention sweep summaries |
| On movie delete | A movie was deleted | Also used for retention sweep summaries |
| On file delete | A file was deleted (including replaced by an upgrade) | |
| On health issue | A health check started failing | Errors only, unless "Include health warnings" is on. Also carries **Health scan found problems**: a library [health scan](health-scan.md) found new broken or wrong files (sent whatever their severity) |
| On health restored | A failing health check recovered | Same rule for warnings |
| On application update | Arclight was updated | |
| On manual interaction required | An import needs you (unknown series, unmatched file, and so on) | See [Activity](activity.md) |
| On request created | A new request needs attention | Sitewide: admins hear about every user's requests |
| On request approved | A request was approved | |
| On request declined | A request was declined | |
| On request available | A requested title is now available | Subtitle and audio language requests use the request events too (created, approved, declined, completed), with the language in the title, for example "The Matrix (Spanish subtitles)". They have no failed event |
| On issue created | A user reported a problem with a title | |
| On issue updated | An issue changed | |

Other settings on each connection:

| Setting | Default | What it does |
|---|---|---|
| Include health warnings | Off | Also send health Warnings. Errors are always sent when On health issue is on |
| Tags | none | Only notify for series and movies carrying a matching tag. Empty means all media. Events that are not about a title (health, updates, requests) always pass |
| Enable | On | Off keeps the connection but sends nothing |

The request and issue events include links to the item only when the application URL is set under Settings > Requests. Health notifications work the same way: their **More Info** link is an absolute address built from the Application URL and opens the matching entry in System > Health docs. With no Application URL set, the link is left out.

Which events to pick: a good starting set for a phone connection is On health issue, On health restored, On manual interaction required and On application update. Add On grab and On import only if you want a message per download; they can be chatty.

### Daily admin digest

Settings > Requests has a **Daily digest**: once a day at the **Digest time** (server local time, default 09:00 when enabled; off by default) Arclight sends a summary of pending requests and open issues. Nothing is sent if there is nothing pending. **Send digest now** sends one immediately. The digest goes to every connection that has On request created or On issue created switched on.

## Browser (web push) notifications

Separate from connections: each user can receive notifications in their own browser, with no third-party service.

1. Open your profile page and turn on **Show notifications in this browser**.
2. Allow notifications when the browser asks.
3. Choose what you want to hear about:
   - Requests: your requests are approved, declined or fail (new requests too if you manage them).
   - Availability: something you requested is ready to watch.
   - Issues: updates on issues you reported (new issues too if you manage them).
4. Press **Send test** to confirm. It reports how many browsers received it.

Notes: browser push needs HTTPS (or `localhost`). Open Arclight over HTTPS first, for example through a reverse proxy. If notifications are blocked for the site, allow them in the browser's site settings. On iPhone and iPad, add Arclight to the home screen first. Each browser you enable is its own subscription, and a subscription the browser has revoked is removed automatically.

## Quiet hours, download alerts and summaries

> Coming soon: download alerts (stalls, failures, low disk space) with quiet hours and a daily summary. This page will be updated when it ships. For now, connections send events as they happen at any time of day. To mute a connection, turn off its Enable switch or the events you do not want.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Test fails with `network` | Arclight cannot reach the service. In Docker, check DNS and that the container is allowed out. If Arclight runs behind the VPN, see [VPN](vpn.md) |
| Test fails with `unauthorized` | Wrong token, key or password |
| Test works but nothing arrives for real events | The event switch is off, the tag filter excludes the item, or health warnings are off while the issue is only a warning |
| Health notification has no More Info link | Set the Application URL under Settings > Requests |
| Email sends nothing | Check port and Security together: 587 with STARTTLS, 465 with TLS, 25 with None |

## Searching your connections

A search box sits above the connection cards once there is at least one. Every word you type has to match somewhere (in any order), case does not matter, and dots, dashes and underscores count as spaces. The count next to the box shows how many match ("2 of 9"), **Select all** then selects only the matching items, and Escape or **Clear search** shows everything again. The search is kept in the address (`?q=`). It matches the name, the connection type and the events that are switched on (for example `on grab`).

## Bulk actions

Every card has a checkbox. Tick one or more and a bar appears at the bottom of the screen with "N selected", **Select all N** and the actions for the selection: **Enable**, **Disable**, **Test** (sends a test message from each), **Add tag**, **Remove tag** and **Delete**. Deleting asks first and says how many items it removes. Each item is handled on its own, so one that fails (for example a test that does not connect, or a profile still in use) does not stop the rest; a message lists what worked and why the others did not, and the failed items stay selected. On a phone the actions sit in one **Actions** menu.

## Related

- [Tags and tag rules](tags.md) (tags limit which items this applies to; rules can add them automatically)
- [Media servers](media-servers.md)
- [Activity](activity.md)
- [Discover and requests](discover-and-requests.md)
- [System](system.md) (health checks)
- [Troubleshooting](../TROUBLESHOOTING.md)
